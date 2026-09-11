// popup.js
// Note: settings.js is not imported here directly (popups can use <script>
// tags for classic scripts too), so we inline the small bits of logic we need
// via chrome.storage directly to avoid depending on background.js internals.

async function load() {
  const stored = await chrome.storage.sync.get({
    defaultTimeout: 30,
    suspendAudible: false,
    suspendPinned: false
  });

  document.getElementById("defaultTimeout").value = stored.defaultTimeout;
  document.getElementById("suspendAudible").checked = stored.suspendAudible;
  document.getElementById("suspendPinned").checked = stored.suspendPinned;
}

document.getElementById("defaultTimeout").addEventListener("change", async (e) => {
  const v = Math.max(1, Math.min(1440, parseInt(e.target.value, 10) || 30));
  e.target.value = v;
  await chrome.storage.sync.set({ defaultTimeout: v });
});

document.getElementById("suspendAudible").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ suspendAudible: e.target.checked });
});

document.getElementById("suspendPinned").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ suspendPinned: e.target.checked });
});

document.getElementById("viewSuspendedBtn").addEventListener("click", async () => {
  const manageUrl = chrome.runtime.getURL("manage.html");
  const existing = await chrome.tabs.query({ url: manageUrl });
  if (existing.length > 0 && existing[0].id !== undefined) {
    await chrome.tabs.update(existing[0].id, { active: true }).catch(() => {});
    await chrome.windows.update(existing[0].windowId, { focused: true }).catch(() => {});
  } else {
    await chrome.tabs.create({ url: manageUrl }).catch(() => {});
  }
  window.close();
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

load();
