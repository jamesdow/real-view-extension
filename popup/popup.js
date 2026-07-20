const DEFAULT_SETTINGS = {
  hideAiImages: false,
  action: "blur",
  deepScan: true,
  tagReal: true,
  customAiDomains: [],
  visualDetection: false,
};

const siteToggle = document.getElementById("siteToggle");
const siteLabel = document.getElementById("siteLabel");
const siteSub = document.getElementById("siteSub");
const aiRow = document.getElementById("aiRow");
const aiToggle = document.getElementById("aiToggle");
const countLabel = document.getElementById("countLabel");
const segmentedRow = document.getElementById("actionSegmented");
const segButtons = document.querySelectorAll(".seg-btn");
const visualNudge = document.getElementById("visualNudge");
const nudgeCount = document.getElementById("nudgeCount");
const nudgeEnableBtn = document.getElementById("nudgeEnableBtn");

function setActiveSeg(value) {
  segButtons.forEach((b) => b.classList.toggle("active", b.dataset.value === value));
}

// Paused sites still show their hideAiImages/action settings (nothing was reset), just
// dimmed and inert — flipping the site toggle back on picks up exactly where you left off.
function setDependentRowsEnabled(enabled) {
  [aiRow, segmentedRow].forEach((row) => {
    row.classList.toggle("row-disabled", !enabled);
  });
  aiToggle.disabled = !enabled;
  segButtons.forEach((b) => (b.disabled = !enabled));
}

let currentHostname = null;

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;

  try {
    currentHostname = tab.url ? new URL(tab.url).hostname : null;
  } catch {
    currentHostname = null;
  }

  if (currentHostname) siteLabel.textContent = currentHostname;
  else siteLabel.textContent = "This page";

  chrome.storage.local.get({ disabledSites: [] }, (local) => {
    // No hostname (chrome:// pages, new tab, etc.) — there's nothing to scan here anyway,
    // so just show the switch as inert rather than implying a real toggle exists.
    if (!currentHostname) {
      siteToggle.checked = false;
      siteToggle.disabled = true;
      siteSub.textContent = "Not an active webpage";
      setDependentRowsEnabled(false);
      return;
    }
    const isPaused = local.disabledSites.includes(currentHostname);
    siteToggle.checked = !isPaused;
    siteSub.textContent = isPaused ? "Paused on this site" : "Scanning active";
    setDependentRowsEnabled(!isPaused);
    if (!isPaused) maybeShowVisualNudge(tab.id);
  });

  chrome.action.getBadgeText({ tabId: tab.id }, (text) => {
    if (text) countLabel.textContent += ` · ${text} flagged`;
  });
});

// Nudges toward the visual model specifically where it would actually help right now —
// a page with several images the metadata/domain checks couldn't resolve — rather than nagging on
// every page regardless of whether enabling it would change anything here.
function maybeShowVisualNudge(tabId) {
  chrome.storage.sync.get({ visualDetection: false }, (settings) => {
    if (settings.visualDetection) return; // already on, nothing to nudge toward
    chrome.tabs.sendMessage(tabId, { type: "realview-get-page-stats" }, (stats) => {
      if (chrome.runtime.lastError || !stats || stats.unresolved < 3) return;
      nudgeCount.textContent = stats.unresolved;
      visualNudge.style.display = "";
    });
  });
}

nudgeEnableBtn.addEventListener("click", () => {
  const confirmed = window.confirm(
    "This downloads a ~320MB machine-learning model the first time (cached afterward) and uses more CPU per image. Nothing is ever uploaded — everything runs on your device. Continue?"
  );
  if (!confirmed) return;
  chrome.storage.sync.set({ visualDetection: true }, () => {
    chrome.runtime.sendMessage({ type: "realview-warm-visual-model" });
    visualNudge.style.display = "none";
  });
});

siteToggle.addEventListener("change", () => {
  if (!currentHostname) return;
  chrome.storage.local.get({ disabledSites: [] }, (local) => {
    const set = new Set(local.disabledSites);
    if (siteToggle.checked) set.delete(currentHostname);
    else set.add(currentHostname);
    chrome.storage.local.set({ disabledSites: Array.from(set) }, () => {
      siteSub.textContent = siteToggle.checked ? "Scanning active" : "Paused on this site";
      setDependentRowsEnabled(siteToggle.checked);
    });
  });
});

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  aiToggle.checked = settings.hideAiImages;
  setActiveSeg(settings.action);
  countLabel.textContent = settings.hideAiImages
    ? `Hiding AI images (${settings.action})`
    : "Showing everything";
});

aiToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ hideAiImages: aiToggle.checked });
  countLabel.textContent = aiToggle.checked ? "Hiding AI images" : "Showing everything";
});

segButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    setActiveSeg(btn.dataset.value);
    chrome.storage.sync.set({ action: btn.dataset.value });
  });
});

document.getElementById("optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
