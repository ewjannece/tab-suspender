// manage.js — runs inside manage.html, the "Suspended Tabs" dashboard tab.
// Opened by clicking the toolbar icon (see background.js's
// chrome.action.onClicked, which focuses an existing dashboard tab or
// creates one — no popup is used) and also reachable from the Options page.
//
// Note: settings.js is not imported here (same reasoning as the old
// popup.js this absorbed: this can load as a classic <script>), so the small
// bits of settings logic needed for the quick site controls are inlined.

const grid = document.getElementById("grid");
const emptyState = document.getElementById("emptyState");
const subtitle = document.getElementById("subtitle");
const restoreAllBtn = document.getElementById("restoreAllBtn");
const suspendAllBtn = document.getElementById("suspendAllBtn");
const autoSuspendToggle = document.getElementById("autoSuspendToggle");

let refreshQueued = false;

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return url;
  }
}

function timeAgo(ts) {
  if (!ts) return "unknown time";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ---------- suspended tabs grid ----------

async function loadTabs() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_SUSPENDED_TABS" });
  return resp?.tabs || [];
}

function render(tabs) {
  // Longest-idle (oldest suspended) first, so the biggest memory wins float to the top.
  tabs.sort((a, b) => (a.suspendedAt || 0) - (b.suspendedAt || 0));

  subtitle.textContent = tabs.length
    ? `${tabs.length} tab${tabs.length === 1 ? "" : "s"} suspended`
    : "Nothing suspended right now";
  restoreAllBtn.disabled = tabs.length === 0;
  emptyState.hidden = tabs.length !== 0;

  grid.innerHTML = "";
  for (const tab of tabs) {
    const card = document.createElement("div");
    card.className = "card tab-card";

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (tab.thumb) {
      const img = document.createElement("img");
      img.src = tab.thumb;
      img.alt = "";
      thumb.appendChild(img);
    } else {
      thumb.textContent = "No preview";
    }
    thumb.title = "Restore this tab";
    thumb.addEventListener("click", () => restoreTab(tab.tabId));

    const body = document.createElement("div");
    body.className = "card-body";
    body.innerHTML = `
      <div class="card-title-row">
        ${tab.favicon ? `<img src="${escapeHtml(tab.favicon)}" alt="" />` : ""}
        <span class="card-title" title="${escapeHtml(tab.title)}">${escapeHtml(tab.title)}</span>
      </div>
      <div class="card-meta">${escapeHtml(hostOf(tab.url))}</div>
      <div class="card-meta">Suspended ${timeAgo(tab.suspendedAt)}</div>
      <div class="card-actions">
        <button class="restore-btn">Restore</button>
        <button class="danger close-btn">Close</button>
      </div>
    `;
    body.querySelector(".restore-btn").addEventListener("click", () => restoreTab(tab.tabId));
    body.querySelector(".close-btn").addEventListener("click", () => closeTab(tab.tabId));

    card.appendChild(thumb);
    card.appendChild(body);
    grid.appendChild(card);
  }
}

async function refresh() {
  const tabs = await loadTabs();
  render(tabs);
}

// Coalesce bursts of tab events (e.g. "restore all" firing many updates at
// once) into a single re-render on the next tick.
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    refresh();
  }, 150);
}

async function restoreTab(tabId) {
  await chrome.runtime.sendMessage({ type: "RESTORE_SUSPENDED_TAB", tabId });
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  scheduleRefresh();
}

async function closeTab(tabId) {
  await chrome.runtime.sendMessage({ type: "CLOSE_SUSPENDED_TAB", tabId });
  scheduleRefresh();
}

restoreAllBtn.addEventListener("click", async () => {
  restoreAllBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: "RESTORE_ALL_SUSPENDED" });
  scheduleRefresh();
});

suspendAllBtn.addEventListener("click", async () => {
  suspendAllBtn.disabled = true;
  suspendAllBtn.textContent = "Suspending…";
  await chrome.runtime.sendMessage({ type: "SUSPEND_ALL_OTHER" });
  suspendAllBtn.disabled = false;
  suspendAllBtn.textContent = "Suspend other tabs";
  scheduleRefresh();
});

// Keep the list live as tabs get suspended/restored/closed elsewhere.
chrome.tabs.onUpdated.addListener(scheduleRefresh);
chrome.tabs.onRemoved.addListener(scheduleRefresh);
chrome.tabs.onCreated.addListener(scheduleRefresh);

// ---------- quick controls (global toggle + settings link) ----------

async function initQuickControls() {
  const settingsResp = await chrome.storage.sync.get({ autoSuspendEnabled: true });
  autoSuspendToggle.checked = settingsResp.autoSuspendEnabled;
}

autoSuspendToggle.addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ autoSuspendEnabled: e.target.checked });
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refresh();
initQuickControls();
