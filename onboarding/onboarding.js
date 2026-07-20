const enableBtn = document.getElementById("enableBtn");
const laterLink = document.getElementById("laterLink");
const status = document.getElementById("status");

enableBtn.addEventListener("click", () => {
  enableBtn.disabled = true;
  enableBtn.textContent = "Starting…";
  chrome.storage.sync.set({ visualDetection: true }, () => {
    chrome.runtime.sendMessage({ type: "realview-warm-visual-model" });
    status.textContent = "Downloading the model now — this tab can be closed, it'll keep going in the background.";
    enableBtn.textContent = "Enabled";
  });
});

laterLink.addEventListener("click", (e) => {
  e.preventDefault();
  window.close();
});
