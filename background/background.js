const DEFAULT_SETTINGS = {
  hideAiImages: true,
  action: "blur",
  deepScan: true,
  tagReal: true,
  customAiDomains: [],
  visualDetection: false, // on-device ML classifier — opt-in, large one-time download + CPU cost
};

// Must match offscreen.js's own MODEL_CACHE_NAME/MODEL_URL exactly — Cache Storage is scoped
// per extension origin, so background.js (and options.js) can reach the same cache entry
// offscreen.js wrote to without any message-passing, as long as the names line up by hand.
const MODEL_CACHE_NAME = "realview-visual-model-v1";
const MODEL_URL = "https://huggingface.co/LPX55/detection-model-1-ONNX/resolve/main/onnx/model_uint8.onnx";
const MODEL_REPO = "LPX55/detection-model-1-ONNX";
const MODEL_UPDATE_ALARM = "realview-check-model-update";

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => chrome.storage.sync.set(stored));

  chrome.contextMenus.create({
    id: "realview-flag-ai",
    title: "Real View: Flag this image as AI-generated",
    contexts: ["image"],
  });
  chrome.contextMenus.create({
    id: "realview-flag-real",
    title: "Real View: Mark this image as a real photo",
    contexts: ["image"],
  });

  chrome.alarms.create(MODEL_UPDATE_ALARM, { periodInMinutes: 60 * 24 });
  checkForModelUpdate();

  // Fresh install only, never on an update — the metadata/domain checks have a real, structural gap
  // (a lot of AI art has no source link or metadata to check at all) that only the
  // opt-in visual model can close. Surface that once, upfront, rather than leaving
  // people to stumble on the Options page and never learn it exists.
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
  }
});

// Service workers don't stay alive between browser launches — re-arm the alarm on startup
// too, in case it was somehow cleared (Chrome does persist alarms across restarts normally,
// this is just a cheap belt-and-braces check).
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get(MODEL_UPDATE_ALARM, (existing) => {
    if (!existing) chrome.alarms.create(MODEL_UPDATE_ALARM, { periodInMinutes: 60 * 24 });
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MODEL_UPDATE_ALARM) checkForModelUpdate();
});

// Compares the visual model's current HF commit hash against the last one we saw. First-ever
// check just establishes a baseline (nothing to compare against yet) — only a later check
// that finds a *different* hash flags an update, surfaced as a banner in Options rather than
// anything silently auto-downloaded (that download is ~320MB and worth an explicit choice).
async function checkForModelUpdate() {
  try {
    const res = await fetch(`https://huggingface.co/api/models/${MODEL_REPO}`);
    if (!res.ok) return;
    const data = await res.json();
    const latestSha = data && data.sha;
    if (!latestSha) return;

    const stored = await chrome.storage.local.get({ modelKnownSha: null });
    const checkedAt = Date.now();
    if (!stored.modelKnownSha) {
      await chrome.storage.local.set({ modelKnownSha: latestSha, modelCheckedAt: checkedAt });
    } else if (stored.modelKnownSha !== latestSha) {
      await chrome.storage.local.set({
        modelUpdateAvailable: true,
        modelLatestSha: latestSha,
        modelCheckedAt: checkedAt,
      });
    } else {
      await chrome.storage.local.set({ modelCheckedAt: checkedAt });
    }
  } catch {
    // offline, HF unreachable, etc. — just try again at the next alarm, no user-facing error
  }
}

// Closes the offscreen document (dropping the in-memory session) and clears the cached model
// bytes, so "delete" actually frees the ~320MB rather than just forgetting the setting.
async function deleteVisualModel() {
  clearTimeout(offscreenIdleTimer);
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing.length) await chrome.offscreen.closeDocument();
  } catch {}
  resetOffscreenReady();
  const deleted = await caches.delete(MODEL_CACHE_NAME);
  await chrome.storage.local.remove([
    "visualDetectionBreadcrumbs",
    "visualDetectionError",
    "visualDetectionErrorAt",
    "visualModelDownloadProgress",
  ]);
  return deleted;
}

// Personal exact-URL overrides — the seed for a future shared/crowdsourced list, but for
// now just yours. Matched by exact image URL, so it catches the *same* re-served image
// (e.g. one you keep seeing reposted) rather than anything about its domain or metadata.
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "realview-flag-ai" && info.menuItemId !== "realview-flag-real") return;
  if (!info.srcUrl) return;

  const flagAsAi = info.menuItemId === "realview-flag-ai";
  const addKey = flagAsAi ? "userFlaggedAi" : "userFlaggedReal";
  const removeKey = flagAsAi ? "userFlaggedReal" : "userFlaggedAi";

  const stored = await chrome.storage.local.get({ userFlaggedAi: [], userFlaggedReal: [] });
  const addSet = new Set(stored[addKey]);
  addSet.add(info.srcUrl);
  const removeSet = new Set(stored[removeKey]);
  removeSet.delete(info.srcUrl);

  await chrome.storage.local.set({ [addKey]: Array.from(addSet), [removeKey]: Array.from(removeSet) });
});

// The offscreen document is where the visual AI-detection model lives (see offscreen/offscreen.js).
// It's used instead of running inference here because the service worker gets killed after ~30s
// idle — incompatible with holding a large loaded model across a browsing session. Only the
// background service worker/extension pages can create one; a content script cannot.
let creatingOffscreenDocument; // in-flight creation promise, guards concurrent callers

// createDocument()'s promise resolving only means the document EXISTS, not that offscreen.js
// has finished importing transformers.js and registered its own onMessage listener — sending a
// message immediately after can race ahead of that and fail with "Could not establish
// connection. Receiving end does not exist." So background waits for an explicit ready signal
// offscreen.js sends right after it registers its listener, not just document creation.
let offscreenReadyResolve;
let offscreenReadyPromise = new Promise((resolve) => { offscreenReadyResolve = resolve; });

function resetOffscreenReady() {
  offscreenReadyPromise = new Promise((resolve) => { offscreenReadyResolve = resolve; });
}

// The offscreen document holds the ~320MB model + WASM runtime resident in RAM (and, during
// inference, active CPU) for as long as it exists — unlike the background service worker, it
// is NOT auto-evicted on idle. Left alone, it sits in memory for the entire browser session
// after the very first classification. Closing it after a lull frees that back up; re-opening
// is cheap (the model bytes are already in Cache Storage, so it's a re-init, not a re-download).
const OFFSCREEN_IDLE_CLOSE_MS = 5 * 60 * 1000;
let offscreenIdleTimer = null;

function scheduleOffscreenIdleClose() {
  clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(() => {
    chrome.offscreen.closeDocument().catch(() => {});
    resetOffscreenReady();
  }, OFFSCREEN_IDLE_CLOSE_MS);
}

// Fetches the ~320MB model into Cache Storage from the background service worker, not the
// offscreen document — a service worker isn't a Document, so it isn't subject to the
// cross-origin-embedder-policy this extension now sets (needed to unlock multi-threaded WASM
// in the offscreen document, see below). offscreen.js only ever reads this cache entry; it
// never fetches the model itself. Cache Storage is shared across both by extension origin.
let cachingModel = null;
async function ensureModelCached() {
  const cache = await caches.open(MODEL_CACHE_NAME);
  if (await cache.match(MODEL_URL)) return;
  if (!cachingModel) {
    cachingModel = fetchModelWithProgress(cache);
  }
  await cachingModel;
  cachingModel = null;
}

// Reading res.clone() independently alongside the response cache.put() consumes (an earlier
// version of this function) turned out to be unsafe for a body this large: concurrently
// reading two clones of the same ~320MB response in a service worker let the progress-tracking
// side "win the race" while the side actually meant for Cache Storage silently ended up empty —
// confirmed in testing (progress reported all 322MB read, yet offscreen.js's cache.match() came
// back with nothing). So this is a single pass instead: one reader pulls bytes from the network
// exactly once, tallies them for progress, and re-emits them unchanged through a pass-through
// stream that's what actually gets cached. cache.put() never sees two competing consumers.
async function fetchModelWithProgress(cache) {
  await chrome.storage.local.set({ visualModelDownloadProgress: { loaded: 0, total: 0, done: false } });
  const res = await fetch(MODEL_URL);
  const total = Number(res.headers.get("Content-Length")) || 0;

  if (!res.body || !total) {
    // No streamable body, or the CDN omitted Content-Length — cache it directly, just
    // without a meaningful percentage to show.
    await cache.put(MODEL_URL, res);
    await chrome.storage.local.set({ visualModelDownloadProgress: { loaded: total, total, done: true } });
    return;
  }

  let loaded = 0;
  let lastReported = 0;
  const reader = res.body.getReader();
  const passthrough = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      loaded += value.byteLength;
      if (loaded - lastReported > total * 0.01) {
        lastReported = loaded;
        chrome.storage.local.set({ visualModelDownloadProgress: { loaded, total, done: false } });
      }
      controller.enqueue(value);
    },
  });

  await cache.put(MODEL_URL, new Response(passthrough, { headers: res.headers }));
  await chrome.storage.local.set({ visualModelDownloadProgress: { loaded: total, total, done: true } });
}

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length === 0) {
    if (!creatingOffscreenDocument) {
      creatingOffscreenDocument = chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["WORKERS"],
        justification:
          "Runs an on-device ML model (transformers.js/onnxruntime-web) to classify image pixels for the optional visual AI-detection feature. Needs a persistent document since the WASM runtime and model shouldn't be reloaded every ~30s service-worker eviction.",
      });
    }
    await creatingOffscreenDocument;
    creatingOffscreenDocument = null;
  }

  // Generous timeout — first run downloads a ~300MB model, which can take a while depending
  // on connection speed. Later calls resolve near-instantly since the model is cached and
  // the document/session already exist.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("offscreen document did not signal ready in time")), 900000));
  await Promise.race([offscreenReadyPromise, timeout]);
  scheduleOffscreenIdleClose();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.visualDetection && changes.visualDetection.newValue === false) {
    clearTimeout(offscreenIdleTimer);
    chrome.offscreen.closeDocument().catch(() => {});
    resetOffscreenReady();
  }
});

chrome.action.setBadgeBackgroundColor({ color: "#8FE3C0" });

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") chrome.action.setBadgeText({ text: "", tabId });
});

// Fetch just enough of the file (metadata lives near the front) via the background
// service worker, which — unlike a content script — isn't bound by the page's CORS
// policy for origins covered by host_permissions.
async function fetchBytes(src) {
  const res = await fetch(src, { headers: { Range: "bytes=0-131071" } });
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Full (not range-limited) fetch for the visual classifier, which needs to decode the whole
// image rather than just read a header. Done here, not in the offscreen document, for the same
// cross-origin-isolation reason as ensureModelCached() above — most image hosts don't send a
// Cross-Origin-Resource-Policy header, and this document's COEP would otherwise block the fetch
// outright. Chunked string-building avoids blowing the call stack that `String.fromCharCode(...bytes)`
// hits on anything but small arrays.
async function fetchImageBytesBase64(src) {
  const res = await fetch(src);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const BLOCKLIST_URL = "https://raw.githubusercontent.com/laylavish/uBlockOrigin-HUGE-AI-Blocklist/main/list.txt";

// The bundled snapshot (content/ai-domains-data.js) goes stale — the source list's own
// header says it "expires" in about a day. This pulls a current copy into local storage
// (too big for the 100KB storage.sync quota) so detection stays current between releases.
async function refreshBlocklist() {
  const res = await fetch(BLOCKLIST_URL);
  const text = await res.text();
  const fragments = new Set();
  const regex = /href\*="([^"]+)"/g;
  let m;
  while ((m = regex.exec(text))) fragments.add(m[1].toLowerCase());
  const list = Array.from(fragments);
  const updatedAt = Date.now();
  await chrome.storage.local.set({ refreshedAiBlocklist: list, refreshedAiBlocklistUpdatedAt: updatedAt });
  return { count: list.length, updatedAt };
}

// Fallback for Pinterest pins the passive network-observer (pinterest-hook.js) never saw a
// fresh request for — e.g. pins served from Pinterest's own client cache. Requests the pin's
// own public detail page (the same page a user would see clicking it) and reads the same
// embedded JSON Pinterest itself uses, since service workers have no DOMParser to work with.
async function resolvePinterestPin(pinId, origin) {
  const res = await fetch(`${origin}/pin/${pinId}/`);
  const html = await res.text();
  const match = html.match(/<script id="__PWS_INITIAL_PROPS__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return { link: null };
  const data = JSON.parse(match[1]);
  const pin = data && data.initialReduxState && data.initialReduxState.pins && data.initialReduxState.pins[pinId];
  return { link: pin && typeof pin.link === "string" ? pin.link : null };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "realview-offscreen-ready") {
    offscreenReadyResolve();
    return;
  }

  if (msg.type === "realview-offscreen-error") {
    chrome.storage.local.set({ visualDetectionError: msg.error, visualDetectionErrorAt: Date.now() });
    return;
  }

  if (msg.type === "realview-offscreen-breadcrumb") {
    chrome.storage.local.get({ visualDetectionBreadcrumbs: [] }, (local) => {
      const list = [...local.visualDetectionBreadcrumbs, msg.step].slice(-20);
      chrome.storage.local.set({ visualDetectionBreadcrumbs: list });
    });
    return;
  }

  if (msg.type === "realview-fetch-bytes") {
    fetchBytes(msg.src)
      .then((base64) => sendResponse({ ok: true, base64 }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "realview-refresh-blocklist") {
    refreshBlocklist()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "realview-resolve-pinterest-pin") {
    resolvePinterestPin(msg.pinId, msg.origin)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ link: null }));
    return true;
  }

  if (msg.type === "realview-flagged-count" && sender.tab) {
    chrome.action.setBadgeText({ text: String(msg.count), tabId: sender.tab.id });
  }

  if (msg.type === "realview-classify-visual") {
    // Model caching, image fetch, and offscreen-document readiness are independent of each
    // other — run them concurrently rather than one after another.
    Promise.all([ensureModelCached(), fetchImageBytesBase64(msg.src), ensureOffscreenDocument()])
      .then(([, imageBase64]) =>
        chrome.runtime.sendMessage({ type: "realview-offscreen-classify", imageBase64 })
      )
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ verdict: null, error: String(err) }));
    return true;
  }

  // Explicit user-triggered warm-up when opting into visual detection from Options, so the
  // ~300MB model download has a clear, deliberate trigger point rather than silently kicking
  // off on whatever tab happens to hit the fallback path first.
  if (msg.type === "realview-warm-visual-model") {
    // Clear any error/breadcrumbs left over from a previous failed attempt first — otherwise
    // a stale visualDetectionError from last time would keep showing as broken in Options even
    // after this retry succeeds, since nothing else clears it on a normal re-enable.
    chrome.storage.local
      .remove(["visualDetectionError", "visualDetectionErrorAt", "visualDetectionBreadcrumbs"])
      .then(() => Promise.all([ensureModelCached(), ensureOffscreenDocument()]))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === "realview-delete-visual-model") {
    deleteVisualModel()
      .then((deleted) => sendResponse({ ok: true, deleted }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Options page "Check now" button — same check the daily alarm runs, just on demand.
  if (msg.type === "realview-check-model-update") {
    checkForModelUpdate()
      .then(() => chrome.storage.local.get({ modelUpdateAvailable: false, modelCheckedAt: null }))
      .then((local) => sendResponse({ ok: true, ...local }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // "Update now" in Options: adopt the newer version as the known-good baseline, drop the
  // stale cached weights, and (if the feature is already on) re-warm immediately so the new
  // model downloads right away instead of waiting for the next time it's needed.
  if (msg.type === "realview-apply-model-update") {
    (async () => {
      const local = await chrome.storage.local.get({ modelLatestSha: null });
      await deleteVisualModel();
      await chrome.storage.local.set({
        modelKnownSha: local.modelLatestSha,
        modelUpdateAvailable: false,
      });
      const settings = await chrome.storage.sync.get({ visualDetection: false });
      if (settings.visualDetection) await Promise.all([ensureModelCached(), ensureOffscreenDocument()]);
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});
