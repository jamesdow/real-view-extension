// Runs inside the offscreen document — an extension-page context that (unlike the
// background service worker) isn't killed after ~30s idle, so it's where the visual
// AI-detection model lives for as long as the feature stays enabled.
//
// Model: haywoodsloan/ai-image-detector-deploy (SwinV2-base), via its community ONNX
// conversion LPX55/detection-model-1-ONNX, uint8 variant (322MB). Chosen after empirically
// testing three candidates against a 25-image hand-built set — see README for the comparison.
// No license is listed on either repo, credited in the README regardless.
//
// Runs on RAW onnxruntime-web, not transformers.js — transformers.js's model registry has no
// Swin/SwinV2 support at all (confirmed against 4.2.0, the latest published version), so its
// pipeline() abstraction can't run this architecture. Preprocessing/postprocessing below are
// hand-rolled from the values in the model's preprocessor_config.json (256x256, ImageNet
// mean/std, bicubic-equivalent resize) and validated during model selection against a Python
// onnxruntime reference implementation on the same 25 test images.
//
// WebGPU was tried as a faster backend and reverted — InferenceSession.create() with the
// webgpu execution provider stalled indefinitely inside this offscreen document (not even a
// slow success, a genuine hang with no classifications ever completing). Not worth the
// instability, or the ~26MB it would add to the always-downloaded extension package.
//
// Multi-threaded WASM is the actual speedup instead. It needs this document to be
// cross-origin isolated (see manifest.json's cross_origin_embedder_policy), which in turn
// means every fetch() this document makes must either be same-origin or carry a
// Cross-Origin-Resource-Policy header — true of neither the model file nor arbitrary
// third-party images. So this document no longer fetches either of those itself:
// background.js fetches and Cache-Storage-caches the model (a service worker isn't a
// Document, so COEP doesn't apply to it), and it fetches each image's bytes too, handing
// them here as base64 over a normal runtime message instead of a URL to fetch.
const MODEL_URL = "https://huggingface.co/LPX55/detection-model-1-ONNX/resolve/main/onnx/model_uint8.onnx";
const MODEL_CACHE_NAME = "realview-visual-model-v1";
const INPUT_SIZE = 256;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
const ID2LABEL = { 0: "artificial", 1: "real" };
const CONFIDENCE_THRESHOLD = 0.65;

function breadcrumb(step) {
  chrome.runtime.sendMessage({ type: "realview-offscreen-breadcrumb", step });
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Cache Storage, not transformers.js's built-in caching (which we no longer use). Read-only
// here — background.js's ensureModelCached() is what actually populates this entry, running
// concurrently with this document's own startup (WASM import + env config). On a first-ever
// install those two are NOT the same order of magnitude — WASM import takes ~seconds, a
// ~320MB download takes minutes — so this polls rather than checking once, giving the
// download real time to land instead of failing the instant this document happens to be first.
async function fetchModelBytes() {
  const cache = await caches.open(MODEL_CACHE_NAME);
  // Kept under background.js's own 15-minute "offscreen document did not signal ready in time"
  // timeout (ensureOffscreenDocument()) — this needs to give up and report its own specific
  // error first, rather than getting cut off by that generic one.
  const maxAttempts = 168; // ~14 minutes at 5s apart — real headroom for a slow connection
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const cached = await cache.match(MODEL_URL);
    if (cached) return cached.arrayBuffer();
    breadcrumb(`waiting for model download (attempt ${attempt + 1})`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("model still not in Cache Storage after waiting — background.js's download may have failed or stalled");
}

async function preprocessImage(imageBase64, Tensor) {
  const bytes = base64ToBytes(imageBase64);
  const blob = new Blob([bytes]);
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: INPUT_SIZE,
    resizeHeight: INPUT_SIZE,
    resizeQuality: "high",
  });
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE); // RGBA, row-major

  const plane = INPUT_SIZE * INPUT_SIZE;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    chw[i] = (data[i * 4] / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]; // R plane
    chw[plane + i] = (data[i * 4 + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1]; // G plane
    chw[2 * plane + i] = (data[i * 4 + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2]; // B plane
  }
  return new Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((x) => x / sum);
}

let sessionPromise = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "realview-offscreen-classify") {
    if (!sessionPromise) {
      sendResponse({ verdict: null, error: "model failed to load — see realview-offscreen-error" });
      return;
    }
    sessionPromise
      .then(async ({ session, Tensor }) => {
        const input = await preprocessImage(msg.imageBase64, Tensor);
        const inputName = session.inputNames[0];
        const outputName = session.outputNames[0];
        const results = await session.run({ [inputName]: input });
        const probs = softmax(Array.from(results[outputName].data));
        const idx = probs.indexOf(Math.max(...probs));
        const label = ID2LABEL[idx];
        const score = probs[idx];
        if (score < CONFIDENCE_THRESHOLD) return { verdict: null };
        if (label === "artificial") {
          return { verdict: "ai", reason: `On-device visual model, ${Math.round(score * 100)}% confidence` };
        }
        if (label === "real") {
          return { verdict: "real", reason: `On-device visual model, ${Math.round(score * 100)}% confidence` };
        }
        return { verdict: null };
      })
      .then((verdict) => sendResponse(verdict))
      .catch((err) => sendResponse({ verdict: null, error: String(err) }));
    return true;
  }
});

// Dynamic import (not static) so this whole block can be wrapped in try/catch — a static
// import that throws would silently prevent the onMessage listener above from ever
// registering, with no way to see why.
(async () => {
  try {
    breadcrumb("importing ort.wasm.min.mjs");
    const { InferenceSession, Tensor, env } = await import("../lib/transformers/ort.wasm.min.mjs");
    breadcrumb("import done");

    // Vendored runtime, not fetched from a CDN at runtime (Chrome Web Store bans remotely-hosted
    // executable code) — only the model *weights* are fetched (by background.js now, see above)
    // and cached via the Cache Storage API, which is the sanctioned "data, not code" exception.
    env.wasm.wasmPaths = chrome.runtime.getURL("lib/transformers/");
    // Real multi-threading now that this document is cross-origin isolated (manifest.json) —
    // capped at 4 rather than every available core, since intra-op thread scheduling overhead
    // eats into the gains well before that on typical hardware.
    env.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4));
    breadcrumb(`env configured (numThreads=${env.wasm.numThreads})`);

    breadcrumb("reading cached model bytes");
    const modelBytes = await fetchModelBytes();
    breadcrumb(`model bytes ready (${modelBytes.byteLength} bytes)`);

    const session = await InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
    breadcrumb("session created");
    sessionPromise = Promise.resolve({ session, Tensor });

    chrome.runtime.sendMessage({ type: "realview-offscreen-ready" });
    breadcrumb("ready sent");
  } catch (err) {
    breadcrumb("caught error: " + String(err));
    chrome.runtime.sendMessage({ type: "realview-offscreen-ready" }); // unblock ensureOffscreenDocument() regardless
    chrome.runtime.sendMessage({ type: "realview-offscreen-error", error: String(err && err.stack ? err.stack : err) });
  }
})();
