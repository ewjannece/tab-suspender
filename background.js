// background.js — MV3 service worker
importScripts("settings.js");

const ALARM_NAME = "check-idle-tabs";
const ALARM_PERIOD_MINUTES = 1;

// In-memory caches, mirrored into chrome.storage.session (survives service
// worker restarts, cleared on browser close) via setLastActive() below.
const lastActiveByTab = new Map(); // tabId -> epoch ms
const screenshotByTab = new Map(); // tabId -> { dataUrl, title, favIconUrl, capturedAt }
const sidByTab = new Map(); // tabId -> sid, for the suspended-tab-survival tracking below
const pendingRestoreByTab = new Map(); // tabId -> sid, set while a tracked tab is navigating back from suspended.html

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  // Re-creating the same ids without clearing first throws "duplicate id"
  // (a runtime.lastError) on every reload/update, since Chrome persists
  // context menu items across those events.
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "suspend-tab",
    title: "Suspend this tab",
    contexts: ["page"]
  });
  chrome.contextMenus.create({
    id: "whitelist-domain",
    title: "Never suspend this site",
    contexts: ["page"]
  });
  // Reloading/updating the extension force-closes every tab pointing at
  // chrome-extension://<id>/* (that's exactly what suspended.html tabs
  // are) before this listener even runs. Recreate any that went missing.
  await reviveOrphanedSuspendedTabs();
  await primeActiveTimestamps();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  // Note: no reviveOrphanedSuspendedTabs() here — on a real browser restart,
  // Chrome's own session restore already reopens each suspended.html tab at
  // its saved URL. Running our reconciliation here too could race against
  // that (tabs not yet restored when we check) and create duplicates.
  await primeActiveTimestamps();
});

async function primeActiveTimestamps() {
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  for (const tab of tabs) {
    if (tab.id !== undefined) await setLastActive(tab.id, now);
  }
}

// Persist to chrome.storage.session so idle timestamps survive the service
// worker being killed and restarted. MV3 tears down idle workers after
// ~30s of inactivity, and the suspend check only runs once a minute — so
// without this, the worker was almost always restarting between checks,
// wiping the in-memory map and resetting every tab's idle clock back to
// "now" each time. That's why auto-suspend effectively never fired.
async function setLastActive(tabId, ts) {
  lastActiveByTab.set(tabId, ts);
  await chrome.storage.session.set({ [`active:${tabId}`]: ts }).catch(() => {});
}

// Backfills lastActiveByTab from chrome.storage.session for any tab id
// missing after a worker restart. Tabs we've truly never seen are left
// for the caller to default (typically to "now").
async function hydrateLastActive(tabIds) {
  const missing = tabIds.filter((id) => !lastActiveByTab.has(id));
  if (missing.length === 0) return;
  const keys = missing.map((id) => `active:${id}`);
  const stored = await chrome.storage.session.get(keys).catch(() => ({}));
  for (const id of missing) {
    const ts = stored[`active:${id}`];
    if (typeof ts === "number") lastActiveByTab.set(id, ts);
  }
}

// ---------- suspended-tab survival tracking ----------
//
// suspended.html tabs live at chrome-extension://<id>/suspended.html, so
// Chrome force-closes every one of them whenever this extension reloads or
// updates (it tears down the old extension instance's pages before the new
// instance even starts). chrome.storage.local persists across that reload
// (only an uninstall clears it), so we keep a durable record of every
// suspended tab there, keyed by a random "sid" embedded in its URL, and
// reconcile against it on startup — any sid with no matching live tab gets
// its suspended tab recreated instead of just vanishing.

async function rememberSuspendedTab(tabId, sid, record) {
  sidByTab.set(tabId, sid);
  await chrome.storage.session.set({ [`sid:${tabId}`]: sid }).catch(() => {});
  const { suspendedTabs = {} } = await chrome.storage.local.get("suspendedTabs").catch(() => ({ suspendedTabs: {} }));
  suspendedTabs[sid] = record;
  await chrome.storage.local.set({ suspendedTabs }).catch(() => {});
}

// Called whenever a tracked tab closes or navigates away from suspended.html
// (i.e. it was genuinely restored/closed by the user, not force-closed by a
// reload) so we stop tracking it and don't resurrect it later.
async function forgetSuspendedTab(tabId) {
  let sid = sidByTab.get(tabId);
  if (!sid) {
    const key = `sid:${tabId}`;
    const stored = await chrome.storage.session.get(key).catch(() => ({}));
    sid = stored[key];
  }
  sidByTab.delete(tabId);
  chrome.storage.session.remove(`sid:${tabId}`).catch(() => {});
  if (!sid) return;

  const { suspendedTabs = {} } = await chrome.storage.local.get("suspendedTabs").catch(() => ({ suspendedTabs: {} }));
  if (suspendedTabs[sid]) {
    delete suspendedTabs[sid];
    await chrome.storage.local.set({ suspendedTabs }).catch(() => {});
  }
}

async function reviveOrphanedSuspendedTabs() {
  const { suspendedTabs = {} } = await chrome.storage.local.get("suspendedTabs").catch(() => ({ suspendedTabs: {} }));
  const sids = Object.keys(suspendedTabs);
  if (sids.length === 0) return;

  const suspendedPrefix = chrome.runtime.getURL("suspended.html");
  const tabs = await chrome.tabs.query({});
  const liveSids = new Set();
  for (const t of tabs) {
    if (!t.url || !t.url.startsWith(suspendedPrefix) || t.id === undefined) continue;
    const sid = new URL(t.url).searchParams.get("sid");
    if (!sid) continue;
    liveSids.add(sid);
    sidByTab.set(t.id, sid);
    chrome.storage.session.set({ [`sid:${t.id}`]: sid }).catch(() => {});
  }

  for (const sid of sids) {
    if (!liveSids.has(sid)) await recreateSuspendedTab(sid, suspendedTabs[sid]);
  }
}

async function recreateSuspendedTab(sid, record) {
  const params = new URLSearchParams({
    url: record.url,
    title: record.title,
    favicon: record.favicon,
    suspendedAt: String(record.suspendedAt || Date.now()),
    sid
  });
  const suspendedUrl = chrome.runtime.getURL(`suspended.html?${params.toString()}`);
  const createOpts = { url: suspendedUrl, active: false, pinned: !!record.pinned };

  const windowStillOpen = record.windowId !== undefined &&
    (await chrome.windows.get(record.windowId).then(() => true).catch(() => false));
  if (windowStillOpen) {
    createOpts.windowId = record.windowId;
    if (typeof record.index === "number") createOpts.index = record.index;
  }

  const created = await chrome.tabs.create(createOpts).catch(() => null);
  if (created && created.id !== undefined) {
    sidByTab.set(created.id, sid);
    chrome.storage.session.set({ [`sid:${created.id}`]: sid }).catch(() => {});

    // The screenshot cache is keyed by tabId, which just changed — re-seed it
    // under the new id from the durable copy saved at suspend time, otherwise
    // the preview would show "No preview available" until the tab is
    // suspended again.
    if (record.thumb) {
      const shotRecord = {
        dataUrl: record.thumb,
        title: record.title || "",
        favIconUrl: record.favicon || "",
        capturedAt: record.suspendedAt || Date.now()
      };
      screenshotByTab.set(created.id, shotRecord);
      chrome.storage.session.set({ [`shot:${created.id}`]: shotRecord }).catch(() => {});
    }
  }
}

// ---------- activity tracking ----------

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await setLastActive(tabId, Date.now());
  // captureVisibleTab only ever works on the tab that's currently visible,
  // so we capture the tab that just became active (not the outgoing one —
  // by the time this listener runs, previousTabId is no longer active and
  // can no longer be captured). This keeps a reasonably fresh screenshot
  // cached for every tab while it's in view, ready for whenever it's later
  // suspended in the background.
  await captureTab(tabId).catch(() => {});

  await maybeRestoreOnActivate(tabId);
});

// If "restoreOnActivate" is on, clicking a suspended tab restores it right
// away instead of waiting for a click on its "reload" button. Cheap early
// exit for the common case (activating a normal tab) before touching
// storage: only tabs currently showing suspended.html are ever candidates.
async function maybeRestoreOnActivate(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const info = tab ? parseSuspendedTab(tab) : null;
  if (!info || !info.url) return;

  const settings = await getSettings();
  if (!settings.restoreOnActivate) return;

  await chrome.tabs.update(tabId, { url: info.url }).catch(() => {});
}

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeTab && activeTab.id !== undefined) {
      await setLastActive(activeTab.id, Date.now());
      await captureTab(activeTab.id).catch(() => {});
    }
  } catch (e) {
    /* window may have closed */
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A tracked suspended tab whose URL is no longer suspended.html was
  // genuinely restored (clicked "restore", address bar edit, etc.) rather
  // than force-closed by a reload. Mark it pending: once the new page
  // finishes loading we replay its saved scroll/form state, then stop
  // tracking it so it isn't recreated by reviveOrphanedSuspendedTabs().
  if (
    tab.url &&
    sidByTab.has(tabId) &&
    !pendingRestoreByTab.has(tabId) &&
    !tab.url.startsWith(chrome.runtime.getURL("suspended.html"))
  ) {
    pendingRestoreByTab.set(tabId, sidByTab.get(tabId));
  }

  if (changeInfo.status === "complete") {
    setLastActive(tabId, Date.now());
    if (tab.active) captureTab(tabId).catch(() => {});

    if (pendingRestoreByTab.has(tabId)) {
      const sid = pendingRestoreByTab.get(tabId);
      pendingRestoreByTab.delete(tabId);
      restoreSessionState(tabId, sid).finally(() => forgetSuspendedTab(tabId));
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastActiveByTab.delete(tabId);
  screenshotByTab.delete(tabId);
  chrome.storage.session.remove([`shot:${tabId}`, `active:${tabId}`]).catch(() => {});
  pendingRestoreByTab.delete(tabId);
  forgetSuspendedTab(tabId);
});

// ---------- screenshot capture ----------

async function captureTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.url || !tab.active) return;
  if (!tab.url.startsWith("http://") && !tab.url.startsWith("https://")) return;

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "jpeg",
    quality: 40
  }).catch(() => null);
  if (!dataUrl) return;

  const record = {
    dataUrl,
    title: tab.title || "",
    favIconUrl: tab.favIconUrl || "",
    capturedAt: Date.now()
  };
  screenshotByTab.set(tabId, record);
  // Mirror to session storage (small quota, so keep JPEGs compressed & low-res).
  chrome.storage.session.set({ [`shot:${tabId}`]: record }).catch(() => {});
}

// ---------- page activity inspection (for the "skip auto-suspend" options) ----------

// Runs inside the page (main frame + iframes) to report whether it has
// playing media and/or form fields the user has actually edited.
function inspectPageActivity() {
  const mediaPlaying = Array.from(document.querySelectorAll("video, audio")).some(
    (el) => !el.paused && !el.ended && el.currentTime > 0
  );

  const skipTypes = new Set(["hidden", "submit", "button", "reset", "file"]);
  const formsUnsaved = Array.from(document.querySelectorAll("input, textarea, select")).some((el) => {
    if (el.disabled) return false;
    const type = (el.type || "").toLowerCase();
    if (skipTypes.has(type)) return false;
    if (el.tagName === "SELECT") {
      const def = Array.from(el.options).find((o) => o.defaultSelected);
      return (def ? def.value : "") !== el.value;
    }
    if (type === "checkbox" || type === "radio") return el.checked !== el.defaultChecked;
    if (type === "password") return !!el.value; // no safe default to compare against
    return el.value !== el.defaultValue;
  });

  return { mediaPlaying, formsUnsaved };
}

async function inspectTabActivity(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: inspectPageActivity
    });
    return {
      mediaPlaying: results.some((r) => r.result && r.result.mediaPlaying),
      formsUnsaved: results.some((r) => r.result && r.result.formsUnsaved)
    };
  } catch (e) {
    return { mediaPlaying: false, formsUnsaved: false }; // restricted page (chrome://, PDF viewer, Web Store, etc.)
  }
}

// tab.audible only reflects actual sound output, so a muted video call or a
// silent/background video wouldn't be caught by it alone — that's why this
// also runs inspectTabActivity's mediaPlaying check when suspendAudible is off.
async function shouldSkipAutoSuspend(tab, settings) {
  if (!settings.suspendAudible && tab.audible) return true;

  const needsMediaCheck = !settings.suspendAudible;
  const needsFormCheck = !settings.suspendUnsavedForms;
  if (!needsMediaCheck && !needsFormCheck) return false; // both options allow it unconditionally

  const { mediaPlaying, formsUnsaved } = await inspectTabActivity(tab.id);
  if (needsMediaCheck && mediaPlaying) return true;
  if (needsFormCheck && formsUnsaved) return true;
  return false;
}

// ---------- session state (scroll position + form data) ----------

// Runs inside the page at suspend time to snapshot scroll position and any
// form field the user has actually typed into/selected (matched by name,
// falling back to id, falling back to tag+position — same key scheme
// applyPageState() below uses to match fields back up after restore).
function grabPageState() {
  function keyFor(el, index) {
    if (el.name) return `name:${el.tagName}:${el.name}`;
    if (el.id) return `id:${el.id}`;
    return `idx:${el.tagName}:${index}`;
  }

  const fields = [];
  Array.from(document.querySelectorAll("input, textarea, select")).forEach((el, index) => {
    const type = (el.type || "").toLowerCase();
    if (el.disabled || type === "hidden" || type === "password" || type === "file") return;
    const key = keyFor(el, index);
    if (el.tagName === "SELECT") {
      fields.push({ key, kind: "value", value: el.value });
    } else if (type === "checkbox" || type === "radio") {
      fields.push({ key, kind: "checked", value: el.checked });
    } else if (el.value) {
      fields.push({ key, kind: "value", value: el.value });
    }
  });

  return { scrollX: window.scrollX, scrollY: window.scrollY, fields };
}

// Runs inside the page after it's been restored to replay a captured
// grabPageState() snapshot. Retries briefly since client-rendered pages may
// not have built their form DOM yet right when the load "complete" event fires.
function applyPageState(state) {
  if (!state) return;

  function keyFor(el, index) {
    if (el.name) return `name:${el.tagName}:${el.name}`;
    if (el.id) return `id:${el.id}`;
    return `idx:${el.tagName}:${index}`;
  }

  function nativeSetter(el) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, "value")?.set;
  }

  function apply() {
    const byKey = new Map((state.fields || []).map((f) => [f.key, f]));
    let matched = 0;
    Array.from(document.querySelectorAll("input, textarea, select")).forEach((el, index) => {
      const f = byKey.get(keyFor(el, index));
      if (!f) return;
      matched++;
      if (f.kind === "checked") {
        el.checked = f.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const setter = nativeSetter(el);
        if (setter) setter.call(el, f.value);
        else el.value = f.value;
        // Dispatched via the native setter trick above so framework-controlled
        // inputs (React, etc.) pick up the change through their own listeners.
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    return matched;
  }

  apply();
  window.scrollTo(state.scrollX || 0, state.scrollY || 0);
  // A couple of delayed retries for SPAs that render their form fields
  // shortly after the initial page load finishes.
  setTimeout(apply, 400);
  setTimeout(() => {
    apply();
    window.scrollTo(state.scrollX || 0, state.scrollY || 0);
  }, 1200);
}

async function captureSessionState(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: grabPageState
    });
    return (results[0] && results[0].result) || null;
  } catch (e) {
    return null; // restricted page — nothing to capture
  }
}

async function restoreSessionState(tabId, sid) {
  const { suspendedTabs = {} } = await chrome.storage.local.get("suspendedTabs").catch(() => ({ suspendedTabs: {} }));
  const state = suspendedTabs[sid] && suspendedTabs[sid].sessionState;
  if (!state) return;
  await chrome.scripting
    .executeScript({ target: { tabId }, func: applyPageState, args: [state] })
    .catch(() => {}); // restricted page — nothing we can do
}

// ---------- suspend logic ----------

async function checkAndSuspendTabs() {
  const settings = await getSettings();
  if (!settings.autoSuspendEnabled) return;

  const tabs = await chrome.tabs.query({});
  const now = Date.now();

  // The service worker may have just been restarted, wiping the in-memory
  // map — backfill from chrome.storage.session before trusting it.
  await hydrateLastActive(tabs.map((t) => t.id).filter((id) => id !== undefined));

  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue;
    if (tab.active) {
      // Keep the screenshot cache fresh for tabs currently in view.
      captureTab(tab.id).catch(() => {});
      continue;
    }
    if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue;
    if (tab.url.startsWith(chrome.runtime.getURL("suspended.html"))) continue; // already suspended
    if (!settings.suspendPinned && tab.pinned) continue;

    if (isWhitelisted(tab.url, settings.whitelist)) continue;

    const timeoutMinutes = getTimeoutForUrl(tab.url, settings);
    if (timeoutMinutes === 0) continue; // 0 = never suspend for this domain

    const lastActive = lastActiveByTab.get(tab.id) ?? now;
    const idleMs = now - lastActive;
    if (idleMs < timeoutMinutes * 60 * 1000) continue;

    // Only pay for the (relatively expensive) page-activity check on tabs
    // that are actually about to be suspended, not every idle candidate.
    if (await shouldSkipAutoSuspend(tab, settings)) continue;

    await suspendTab(tab.id);
  }
}

async function suspendTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.url) return;
  if (tab.url.startsWith(chrome.runtime.getURL("suspended.html"))) return;

  // Grab a last-chance screenshot if we don't already have a recent one
  // (covers tabs that went idle without ever losing focus in this session).
  if (!screenshotByTab.has(tabId) && tab.active) {
    await captureTab(tabId).catch(() => {});
  }

  // Snapshot scroll position + in-progress form input so restoreSessionState()
  // can put it back once the tab is restored. Note: cookies, localStorage,
  // and sessionStorage are untouched by any of this — they're preserved
  // automatically since we only navigate the tab, never close it.
  const sessionState = await captureSessionState(tabId);

  // Also copy the screenshot into the durable record (rather than leaving it
  // only in the tabId-keyed cache), so a revived tab after an extension
  // reload/update — which gets a brand new tabId — still has its preview.
  const thumb = await getScreenshotDataUrl(tabId);

  const sid = crypto.randomUUID();
  const suspendedAt = Date.now();
  const params = new URLSearchParams({
    url: tab.url,
    title: tab.title || tab.url,
    favicon: tab.favIconUrl || "",
    suspendedAt: String(suspendedAt),
    sid
  });
  const suspendedUrl = chrome.runtime.getURL(`suspended.html?${params.toString()}`);

  await rememberSuspendedTab(tabId, sid, {
    url: tab.url,
    title: tab.title || tab.url,
    favicon: tab.favIconUrl || "",
    suspendedAt,
    pinned: tab.pinned,
    windowId: tab.windowId,
    thumb,
    index: tab.index,
    sessionState
  });

  await chrome.tabs.update(tabId, { url: suspendedUrl }).catch(() => {});
}

// Returns { url, title, favicon, suspendedAt } parsed back out of a
// suspended.html tab's own URL, or null if tab isn't one of ours.
function parseSuspendedTab(tab) {
  const suspendedPrefix = chrome.runtime.getURL("suspended.html");
  if (!tab.url || !tab.url.startsWith(suspendedPrefix)) return null;
  const qs = new URL(tab.url).searchParams;
  return {
    url: qs.get("url") || "",
    title: qs.get("title") || qs.get("url") || "",
    favicon: qs.get("favicon") || "",
    suspendedAt: Number(qs.get("suspendedAt")) || null,
    sid: qs.get("sid") || null
  };
}

async function getScreenshotDataUrl(tabId) {
  const key = `shot:${tabId}`;
  const stored = await chrome.storage.session.get(key).catch(() => ({}));
  const record = stored[key] || screenshotByTab.get(tabId) || null;
  return record ? record.dataUrl : null;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkAndSuspendTabs();
  }
});

// Note: no chrome.action.onClicked listener here — the toolbar icon has a
// default_popup (popup.html) again, and Chrome never dispatches onClicked
// when a popup is set. The popup's own "View suspended tabs" button opens
// manage.html instead (see popup.js).

// ---------- context menu actions ----------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id === undefined) return;
  if (info.menuItemId === "suspend-tab") {
    await suspendTab(tab.id);
  } else if (info.menuItemId === "whitelist-domain") {
    const host = getHostnameSafe(tab.url);
    if (!host) return;
    const settings = await getSettings();
    if (!settings.whitelist.includes(host)) {
      const whitelist = [...settings.whitelist, host];
      await saveSettings({ whitelist });
    }
  }
});

// ---------- messaging (popup / suspended page) ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_SCREENSHOT": {
        const key = `shot:${message.tabId}`;
        const stored = await chrome.storage.session.get(key);
        sendResponse(stored[key] || screenshotByTab.get(message.tabId) || null);
        break;
      }
      case "SUSPEND_TAB": {
        await suspendTab(message.tabId);
        sendResponse({ ok: true });
        break;
      }
      case "SUSPEND_ALL_OTHER": {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const settings = await getSettings();
        for (const t of tabs) {
          if (t.active || t.id === undefined || !t.url) continue;
          if (!settings.suspendPinned && t.pinned) continue;
          if (isWhitelisted(t.url, settings.whitelist)) continue;
          if (await shouldSkipAutoSuspend(t, settings)) continue;
          await suspendTab(t.id);
        }
        sendResponse({ ok: true });
        break;
      }
      case "WHITELIST_HOST": {
        const settings = await getSettings();
        if (!settings.whitelist.includes(message.host)) {
          await saveSettings({ whitelist: [...settings.whitelist, message.host] });
        }
        sendResponse({ ok: true });
        break;
      }
      case "GET_SUSPENDED_COUNT": {
        const tabs = await chrome.tabs.query({});
        const suspendedPrefix = chrome.runtime.getURL("suspended.html");
        const count = tabs.filter((t) => t.url && t.url.startsWith(suspendedPrefix)).length;
        sendResponse({ count });
        break;
      }
      case "GET_SUSPENDED_TABS": {
        const tabs = await chrome.tabs.query({});
        const results = [];
        for (const t of tabs) {
          if (t.id === undefined) continue;
          const info = parseSuspendedTab(t);
          if (!info) continue;
          results.push({
            tabId: t.id,
            windowId: t.windowId,
            index: t.index,
            ...info,
            thumb: await getScreenshotDataUrl(t.id)
          });
        }
        sendResponse({ tabs: results });
        break;
      }
      case "RESTORE_SUSPENDED_TAB": {
        const tab = await chrome.tabs.get(message.tabId).catch(() => null);
        const info = tab ? parseSuspendedTab(tab) : null;
        if (info && info.url) {
          await chrome.tabs.update(message.tabId, { url: info.url }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      case "CLOSE_SUSPENDED_TAB": {
        await chrome.tabs.remove(message.tabId).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case "RESTORE_ALL_SUSPENDED": {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
          if (t.id === undefined) continue;
          const info = parseSuspendedTab(t);
          if (info && info.url) {
            await chrome.tabs.update(t.id, { url: info.url }).catch(() => {});
          }
        }
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse(null);
    }
  })();
  return true; // keep the message channel open for the async response
});
