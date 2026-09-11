// popup.js
// Note: settings.js is not imported here directly (popups can use <script>
// tags for classic scripts too), so we inline the small bits of logic we need
// via chrome.storage directly to avoid depending on background.js internals.

let currentHost = null;
let currentTabUrl = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabUrl = tab?.url || "";
  try {
    currentHost = new URL(currentTabUrl).hostname.replace(/^www\./, "");
  } catch (e) {
    currentHost = null;
  }

  const settingsResp = await chrome.storage.sync.get({
    autoSuspendEnabled: true,
    domainRules: {},
    whitelist: []
  });

  document.getElementById("autoSuspendToggle").checked = settingsResp.autoSuspendEnabled;

  const domainLabel = document.getElementById("currentDomain");
  const timeoutSelect = document.getElementById("domainTimeoutSelect");

  if (!currentHost || (!currentTabUrl.startsWith("http://") && !currentTabUrl.startsWith("https://"))) {
    domainLabel.textContent = "this page";
    timeoutSelect.disabled = true;
  } else {
    domainLabel.textContent = currentHost;
    const isWhitelisted = settingsResp.whitelist.some((entry) => matchesEntry(currentHost, entry));
    const rule = settingsResp.domainRules[currentHost];
    if (isWhitelisted || rule === 0) {
      timeoutSelect.value = "0";
    } else if (rule !== undefined) {
      timeoutSelect.value = String(rule);
    } else {
      timeoutSelect.value = "default";
    }
  }

  const countResp = await chrome.runtime.sendMessage({ type: "GET_SUSPENDED_COUNT" });
  document.getElementById("suspendedCount").textContent = `${countResp?.count ?? 0} tab(s) suspended`;
}

function matchesEntry(host, entry) {
  const clean = entry.split("/")[0].toLowerCase();
  if (clean.startsWith("*.")) {
    const base = clean.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === clean || host.endsWith("." + clean);
}

document.getElementById("autoSuspendToggle").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ autoSuspendEnabled: e.target.checked });
});

document.getElementById("domainTimeoutSelect").addEventListener("change", async (e) => {
  if (!currentHost) return;
  const value = e.target.value;
  const settingsResp = await chrome.storage.sync.get({ domainRules: {}, whitelist: [] });
  const domainRules = { ...settingsResp.domainRules };
  let whitelist = [...settingsResp.whitelist];

  // remove any existing whitelist entry for this exact host first
  whitelist = whitelist.filter((entry) => entry.split("/")[0].toLowerCase() !== currentHost);

  if (value === "default") {
    delete domainRules[currentHost];
  } else if (value === "0") {
    domainRules[currentHost] = 0;
    whitelist.push(currentHost);
  } else {
    domainRules[currentHost] = parseInt(value, 10);
  }

  await chrome.storage.sync.set({ domainRules, whitelist });
});

document.getElementById("suspendAllBtn").addEventListener("click", async () => {
  const btn = document.getElementById("suspendAllBtn");
  btn.textContent = "Suspending…";
  btn.disabled = true;
  await chrome.runtime.sendMessage({ type: "SUSPEND_ALL_OTHER" });
  window.close();
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("suspendedCount").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("manage.html") });
  window.close();
});

init();
