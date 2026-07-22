const enableBtn = document.getElementById("enableBtn");
const laterLink = document.getElementById("laterLink");
const status = document.getElementById("status");

const modelProgressWrap = document.getElementById("modelProgressWrap");
const modelProgressFill = document.getElementById("modelProgressFill");
const modelProgressPct = document.getElementById("modelProgressPct");

function describeModelDownloadProgress() {
  chrome.storage.local.get({ visualModelDownloadProgress: null }, (local) => {
    const p = local.visualModelDownloadProgress;
    if (!p || p.done || !p.total) {
      modelProgressWrap.style.display = "none";
      return;
    }
    const pct = Math.min(100, Math.round((p.loaded / p.total) * 100));
    modelProgressWrap.style.display = "";
    modelProgressFill.style.width = pct + "%";
    modelProgressPct.textContent = pct + "%";
  });
}

// Download finishing (visualModelDownloadProgress.done) isn't quite "ready to classify" —
// offscreen.js still has to import the WASM runtime and build an inference session after
// the bytes land. So this only claims "ready" once that "ready sent" breadcrumb actually
// arrives; in between it says so explicitly rather than going silent.
function describeStatus() {
  chrome.storage.local.get(
    { visualDetectionError: null, visualDetectionBreadcrumbs: [], visualModelDownloadProgress: null },
    (local) => {
      if (local.visualDetectionError) {
        status.textContent = "Something went wrong loading the model — you can retry from the Options page.";
        return;
      }
      const last = local.visualDetectionBreadcrumbs[local.visualDetectionBreadcrumbs.length - 1] || "";
      const p = local.visualModelDownloadProgress;
      if (last.includes("ready sent")) {
        status.textContent = "Done — the model is downloaded and ready.";
      } else if (p && p.done) {
        status.textContent = "Download complete — finishing setup…";
      } else if (p && p.total) {
        status.textContent = "Downloading the model now — this tab can be closed, it'll keep going in the background.";
      } else {
        status.textContent = "Starting up…";
      }
    }
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.visualModelDownloadProgress) describeModelDownloadProgress();
  if (changes.visualModelDownloadProgress || changes.visualDetectionBreadcrumbs || changes.visualDetectionError) {
    describeStatus();
  }
});

enableBtn.addEventListener("click", () => {
  enableBtn.disabled = true;
  enableBtn.textContent = "Starting…";
  chrome.storage.sync.set({ visualDetection: true }, () => {
    chrome.runtime.sendMessage({ type: "realview-warm-visual-model" });
    enableBtn.textContent = "Enabled";
    describeStatus();
    describeModelDownloadProgress();
  });
});

laterLink.addEventListener("click", (e) => {
  e.preventDefault();
  window.close();
});
