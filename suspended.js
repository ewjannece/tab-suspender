// suspended.js — runs inside suspended.html

const params = new URLSearchParams(location.search);
const originalUrl = params.get("url") || "";
const title = params.get("title") || originalUrl;
const favicon = params.get("favicon") || "";

document.title = title ? `${title} (suspended)` : "Tab suspended";
document.getElementById("pageTitle").textContent = title;

// This only sets the favicon shown in the overlay on the screenshot preview,
// not the browser tab's own icon — that stays the "zzz" icon set in
// suspended.html's <link rel="icon">, so suspended tabs are recognizable at
// a glance in the tab strip instead of looking identical to the live page.
if (favicon) {
  document.getElementById("favicon-img").src = favicon;
} else {
  document.getElementById("favicon-img").style.visibility = "hidden";
}

function restore() {
  if (originalUrl) location.href = originalUrl;
}

document.getElementById("restoreBtn").addEventListener("click", restore);
document.getElementById("shotFrame").addEventListener("click", restore);

// "Never suspend this site" — whitelist the domain this tab was suspended
// from, then restore it, same as the identically-named right-click context
// menu action but reachable right from the placeholder that's annoying you.
let originalHost = null;
try {
  originalHost = originalUrl ? new URL(originalUrl).hostname.toLowerCase().replace(/^www\./, "") : null;
} catch (e) {
  originalHost = null;
}

if (originalHost) {
  const whitelistLink = document.getElementById("whitelistLink");
  whitelistLink.hidden = false;
  whitelistLink.addEventListener("click", async (e) => {
    e.stopPropagation();
    await chrome.runtime.sendMessage({ type: "WHITELIST_HOST", host: originalHost });
    restore();
  });
}

// Fetch the cached screenshot for this tab via the background worker.
chrome.tabs.getCurrent((tab) => {
  if (!tab || tab.id === undefined) return;
  chrome.runtime.sendMessage({ type: "GET_SCREENSHOT", tabId: tab.id }, (record) => {
    const placeholder = document.getElementById("placeholder");
    if (record && record.dataUrl) {
      const img = document.createElement("img");
      img.src = record.dataUrl;
      img.alt = title;
      placeholder.replaceWith(img);
      const ago = timeAgo(record.capturedAt);
      document.getElementById("meta").textContent = `Suspended to save memory · snapshot from ${ago}`;
    }
  });
});

function timeAgo(ts) {
  if (!ts) return "earlier";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
