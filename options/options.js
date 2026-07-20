const DEFAULT_SETTINGS = {
  hideAiImages: false,
  action: "blur",
  deepScan: true,
  tagReal: true,
  customAiDomains: [],
  visualDetection: false,
};

const els = {
  deepScan: document.getElementById("deepScan"),
  tagReal: document.getElementById("tagReal"),
  customAiDomains: document.getElementById("customAiDomains"),
  visualDetection: document.getElementById("visualDetection"),
};

chrome.storage.sync.get(DEFAULT_SETTINGS, (s) => {
  els.deepScan.checked = s.deepScan;
  els.tagReal.checked = s.tagReal;
  els.customAiDomains.value = (s.customAiDomains || []).join("\n");
  els.visualDetection.checked = s.visualDetection;
});

document.getElementById("saveBtn").addEventListener("click", () => {
  const customAiDomains = els.customAiDomains.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  chrome.storage.sync.set(
    {
      deepScan: els.deepScan.checked,
      tagReal: els.tagReal.checked,
      customAiDomains,
    },
    () => {
      const note = document.getElementById("savedNote");
      note.textContent = "Saved";
      note.classList.add("show");
      setTimeout(() => note.classList.remove("show"), 1500);
    }
  );
});

const blocklistStatus = document.getElementById("blocklistStatus");
const refreshBlocklistBtn = document.getElementById("refreshBlocklistBtn");

function describeBlocklistStatus() {
  chrome.storage.local.get({ refreshedAiBlocklist: [], refreshedAiBlocklistUpdatedAt: null }, (local) => {
    if (!local.refreshedAiBlocklistUpdatedAt) {
      blocklistStatus.textContent = "Using the bundled snapshot only — hasn't been refreshed yet.";
      return;
    }
    const when = new Date(local.refreshedAiBlocklistUpdatedAt).toLocaleString();
    blocklistStatus.textContent = `${local.refreshedAiBlocklist.length} refreshed entries, last updated ${when}.`;
  });
}

describeBlocklistStatus();

refreshBlocklistBtn.addEventListener("click", () => {
  refreshBlocklistBtn.disabled = true;
  refreshBlocklistBtn.textContent = "Refreshing…";
  chrome.runtime.sendMessage({ type: "realview-refresh-blocklist" }, (res) => {
    refreshBlocklistBtn.disabled = false;
    refreshBlocklistBtn.textContent = "Refresh AI blocklist now";
    if (res && res.ok) describeBlocklistStatus();
    else blocklistStatus.textContent = "Refresh failed — check your connection and try again.";
  });
});

const flaggedStatus = document.getElementById("flaggedStatus");

function describeFlaggedStatus() {
  chrome.storage.local.get({ userFlaggedAi: [], userFlaggedReal: [] }, (local) => {
    flaggedStatus.textContent =
      `${local.userFlaggedAi.length} flagged as AI, ${local.userFlaggedReal.length} marked as real.`;
  });
}

describeFlaggedStatus();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.userFlaggedAi || changes.userFlaggedReal)) describeFlaggedStatus();
});

document.getElementById("clearFlagsBtn").addEventListener("click", () => {
  chrome.storage.local.set({ userFlaggedAi: [], userFlaggedReal: [] }, describeFlaggedStatus);
});

const visualStatus = document.getElementById("visualStatus");

function describeVisualStatus() {
  chrome.storage.local.get(
    { visualDetectionError: null, visualDetectionBreadcrumbs: [] },
    (local) => {
      if (local.visualDetectionError) {
        visualStatus.textContent = "Something went wrong loading the model — falling back to the free signals above. Try turning this off and back on.";
        return;
      }
      const steps = local.visualDetectionBreadcrumbs;
      const last = steps[steps.length - 1] || "";
      if (!els.visualDetection.checked) {
        visualStatus.textContent = "";
      } else if (last.includes("ready sent")) {
        visualStatus.textContent = "Model loaded and ready.";
      } else if (last.includes("fetching model bytes")) {
        visualStatus.textContent = "Downloading the model (first time only, ~320MB)…";
      } else if (last) {
        visualStatus.textContent = "Starting up…";
      } else {
        visualStatus.textContent = "";
      }
    }
  );
}

describeVisualStatus();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.visualDetectionBreadcrumbs || changes.visualDetectionError)) describeVisualStatus();
});

els.visualDetection.addEventListener("change", () => {
  if (!els.visualDetection.checked) {
    chrome.storage.sync.set({ visualDetection: false });
    describeVisualStatus();
    return;
  }
  const confirmed = window.confirm(
    "This downloads a ~320MB machine-learning model the first time (cached afterward) and uses more CPU per image. Nothing is ever uploaded — everything runs on your device. Continue?"
  );
  if (!confirmed) {
    els.visualDetection.checked = false;
    return;
  }
  chrome.storage.sync.set({ visualDetection: true }, () => {
    visualStatus.textContent = "Starting up…";
    chrome.runtime.sendMessage({ type: "realview-warm-visual-model" });
  });
});

const deleteModelBtn = document.getElementById("deleteModelBtn");
const checkModelUpdateBtn = document.getElementById("checkModelUpdateBtn");
const modelManageStatus = document.getElementById("modelManageStatus");
const modelUpdateBanner = document.getElementById("modelUpdateBanner");
const applyModelUpdateBtn = document.getElementById("applyModelUpdateBtn");

function describeModelUpdateBanner() {
  chrome.storage.local.get({ modelUpdateAvailable: false }, (local) => {
    modelUpdateBanner.style.display = local.modelUpdateAvailable ? "" : "none";
  });
}

describeModelUpdateBanner();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.modelUpdateAvailable) describeModelUpdateBanner();
});

deleteModelBtn.addEventListener("click", () => {
  const confirmed = window.confirm(
    "Delete the downloaded visual-detection model? This frees the ~320MB it's using. Turning the feature back on will re-download it."
  );
  if (!confirmed) return;
  deleteModelBtn.disabled = true;
  modelManageStatus.textContent = "Deleting…";
  chrome.runtime.sendMessage({ type: "realview-delete-visual-model" }, (res) => {
    deleteModelBtn.disabled = false;
    if (res && res.ok) {
      chrome.storage.sync.set({ visualDetection: false });
      els.visualDetection.checked = false;
      modelManageStatus.textContent = "Model deleted. Turn the feature back on above to re-download it.";
    } else {
      modelManageStatus.textContent = "Couldn't delete the model — try again.";
    }
  });
});

checkModelUpdateBtn.addEventListener("click", () => {
  checkModelUpdateBtn.disabled = true;
  modelManageStatus.textContent = "Checking…";
  chrome.runtime.sendMessage({ type: "realview-check-model-update" }, (res) => {
    checkModelUpdateBtn.disabled = false;
    if (!res || !res.ok) {
      modelManageStatus.textContent = "Couldn't reach Hugging Face — try again later.";
      return;
    }
    modelManageStatus.textContent = res.modelUpdateAvailable
      ? "A newer model version is available."
      : "You're on the latest model version.";
    describeModelUpdateBanner();
  });
});

applyModelUpdateBtn.addEventListener("click", () => {
  applyModelUpdateBtn.disabled = true;
  modelManageStatus.textContent = "Updating…";
  chrome.runtime.sendMessage({ type: "realview-apply-model-update" }, (res) => {
    applyModelUpdateBtn.disabled = false;
    modelManageStatus.textContent = res && res.ok
      ? "Updated. The new model will download the next time it's needed."
      : "Couldn't apply the update — try again.";
    describeModelUpdateBanner();
  });
});
