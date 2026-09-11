// settings.js
// Shared storage helpers used by background.js, popup.js, and options.js.
// Loaded via importScripts() in the service worker, and via <script> tags
// in the popup/options pages, so it must not use ES module import/export.

const DEFAULT_SETTINGS = {
  autoSuspendEnabled: true,
  defaultTimeout: 30, // minutes. 0 = never auto-suspend by default.
  suspendPinned: false,
  suspendAudible: false,
  suspendUnsavedForms: false, // false = skip auto-suspending tabs with unsaved (in-progress) form input
  domainRules: {
    // hostname (or "*.example.com") -> minutes. 0 = never suspend (whitelisted).
    "meet.google.com": 0,
    "zoom.us": 0
  },
  whitelist: [
    // plain hostnames, "*.example.com" wildcards, or "host/path/prefix" entries
    "meet.google.com",
    "zoom.us"
  ]
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function saveSettings(partial) {
  await chrome.storage.sync.set(partial);
}

function normalizeHostname(hostname) {
  return hostname.replace(/^www\./, "").toLowerCase();
}

function hostMatchesEntry(hostname, entry) {
  const host = normalizeHostname(hostname);
  const cleanEntry = entry.toLowerCase();
  if (cleanEntry.startsWith("*.")) {
    const base = cleanEntry.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === cleanEntry || host.endsWith("." + cleanEntry);
}

// Whitelist supports optional path-prefix entries like "example.com/some/path"
function isWhitelisted(url, whitelist) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return true; // can't parse (e.g. chrome:// pages) -> never touch it
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;

  return whitelist.some((entry) => {
    if (entry.includes("/")) {
      const slashIdx = entry.indexOf("/");
      const entryHost = entry.slice(0, slashIdx);
      const entryPath = entry.slice(slashIdx);
      return hostMatchesEntry(parsed.hostname, entryHost) && parsed.pathname.startsWith(entryPath);
    }
    return hostMatchesEntry(parsed.hostname, entry);
  });
}

// Returns timeout in minutes for a given URL, checking domainRules (exact then
// wildcard/suffix match) before falling back to the global default.
function getTimeoutForUrl(url, settings) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (e) {
    return 0; // can't parse -> treat like an unrecognized/whitelisted URL, never suspend
  }
  const host = normalizeHostname(hostname);

  if (Object.prototype.hasOwnProperty.call(settings.domainRules, host)) {
    return settings.domainRules[host];
  }
  for (const [ruleDomain, timeout] of Object.entries(settings.domainRules)) {
    if (hostMatchesEntry(host, ruleDomain)) {
      return timeout;
    }
  }
  return settings.defaultTimeout;
}

function getHostnameSafe(url) {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch (e) {
    return null;
  }
}
