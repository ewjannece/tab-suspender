// popup.js
// Note: settings.js is not imported here directly (popups can use <script>
// tags for classic scripts too), so we inline the small bits of logic we need
// via chrome.storage directly to avoid depending on background.js internals.

let currentHost = null;

function matchesEntry(host, entry) {
  const clean = entry.split("/")[0].toLowerCase();
  if (clean.startsWith("*.")) {
    const base = clean.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === clean || host.endsWith("." + clean);
}

async function load() {
  const stored = await chrome.storage.sync.get({
    defaultTimeout: 30,
    suspendAudible: false,
    suspendPinned: false,
    restoreOnActivate: false,
    whitelist: []
  });

  document.getElementById("defaultTimeout").value = stored.defaultTimeout;
  document.getElementById("suspendAudible").checked = stored.suspendAudible;
  document.getElementById("suspendPinned").checked = stored.suspendPinned;
  document.getElementById("restoreOnActivate").checked = stored.restoreOnActivate;

  await initWhitelistButton(stored.whitelist);
}

async function initWhitelistButton(whitelist) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url || "";
  try {
    currentHost = new URL(tabUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    currentHost = null;
  }

  const siteName = document.getElementById("whitelistSiteName");
  const toggle = document.getElementById("whitelistToggle");

  // The label always reads "Whitelist domain" — the actual domain shows up
  // as a hover tooltip instead, so the row stays static like the other
  // toggles rather than having its label text change under the user.

  // Always show this row rather than hiding it outright when there's no
  // usable site (chrome:// pages, New Tab, other extensions' pages, etc.) —
  // a disabled toggle with a reason is easier to notice than a section that
  // just silently isn't there.
  if (!currentHost || (!tabUrl.startsWith("http://") && !tabUrl.startsWith("https://"))) {
    siteName.title = "No site to whitelist";
    toggle.checked = false;
    toggle.disabled = true;
    toggle.title = siteName.title;
    return;
  }

  siteName.title = currentHost;

  // The toggle only ever adds/removes an exact hostname entry (see
  // WHITELIST_HOST / UNWHITELIST_HOST in background.js). If this host is
  // only whitelisted via a broader rule (a "*.example.com" wildcard or an
  // "example.com/path" prefix), show it as on but not toggleable here —
  // turning it "off" couldn't remove that rule without risking silently
  // un-whitelisting whatever else the rule covers, so that stays an Options
  // page edit.
  const exactMatch = whitelist.includes(currentHost);
  const coveredByBroaderRule = !exactMatch && whitelist.some((entry) => matchesEntry(currentHost, entry));

  toggle.checked = exactMatch || coveredByBroaderRule;
  toggle.disabled = coveredByBroaderRule;
  toggle.title = coveredByBroaderRule
    ? `${currentHost} — covered by a wildcard/path rule, edit in Options to remove`
    : currentHost;
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

document.getElementById("restoreOnActivate").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ restoreOnActivate: e.target.checked });
});

document.getElementById("whitelistToggle").addEventListener("change", async (e) => {
  if (!currentHost) return;
  const type = e.target.checked ? "WHITELIST_HOST" : "UNWHITELIST_HOST";
  await chrome.runtime.sendMessage({ type, host: currentHost });
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
