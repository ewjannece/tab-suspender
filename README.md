# Tab Suspender

Automatically suspends idle tabs to save memory, with per-domain timers, a
whitelist, and a snapshot of the page so you remember what was there.

## Install (unpacked, for development)

1. Open `chrome://extensions` in Chrome (or Edge, or another Chromium browser).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `tab-suspender` folder.
4. Pin the extension icon to your toolbar if you'd like quick access.

## How it works

- Tabs are tracked by "last active" time. When a tab goes idle past its
  timeout, it's navigated to a local `suspended.html` page instead of being
  closed — click "Click to reload tab" (or the screenshot) to instantly
  restore the original page. Options → "Restore suspended tabs when clicked"
  (off by default) skips that click: switching to a suspended tab restores
  it immediately.
- Suspended tabs show a "zzz" icon (`icons/zzz.svg`) in the tab strip instead
  of the original site's favicon, so they're recognizable at a glance. The
  original favicon still appears inside the placeholder page itself, over
  the screenshot.
- Right before a tab loses focus, a compressed screenshot of it is captured
  and cached, so the suspended placeholder shows what the page looked like.
- Clicking the toolbar icon opens a small popup with the default timeout,
  the "suspend audio/video tabs", "suspend pinned tabs", and "restore
  suspended tabs when clicked" toggles, a whitelist toggle for the current
  site, and a "View suspended tabs" button that opens (or focuses, if
  already open) the **Suspended Tabs** dashboard as a regular tab — every
  currently-suspended tab with its screenshot, a restore/close per tab,
  "Restore all", "Suspend all other tabs", and the global auto-suspend toggle.
- If a browser restart (crash or ordinary) brings back suspended tabs, the
  dashboard opens (or focuses) automatically so restoring them in bulk is
  right there. This covers both ways Chrome brings tabs back: immediately
  via "continue where you left off", or whenever you click the "Restore
  pages?" bubble (which can be seconds or minutes later, since that's a
  manual click, not something on a timer) — there's no API for an extension
  to tell a crash-recovered startup apart from a normal one, so this
  triggers on either, whenever suspended placeholders actually show up,
  for up to 5 minutes after startup.
- Each domain can have its own timeout (Options → "Per-domain timers", or
  right-click a page → "Never suspend this site"). Domains not explicitly
  configured fall back to the global default timeout.
- The whitelist (Options page) marks domains that are never auto-suspended —
  useful for things like video calls, docs you're actively editing, etc.
  Setting a domain's timer to "Never" automatically adds it to the whitelist.
  Two more one-click ways to manage it: the toolbar popup's whitelist toggle
  (adds/removes an exact entry for the current tab's domain — a toggle
  that's only "on but locked" if the site is covered by a broader wildcard
  or path rule instead, since removing those safely needs the Options page)
  and the "Never suspend this site" link on a suspended tab's placeholder
  page (whitelists it and restores it).
- **Session preservation**: when a tab is suspended, its scroll position and
  any in-progress form input (text fields, checkboxes, selects — matched by
  name/id, so this is best-effort on pages that re-render their DOM) are
  captured and automatically replayed once you restore it. Cookies,
  localStorage, and sessionStorage are untouched either way, since suspending
  only navigates the tab rather than closing it.
- Two options (Options page → General) skip auto-suspending a tab outright:
  **"Suspend tabs playing audio or video"** (off by default) and **"Suspend
  tabs with unsaved form data"** (off by default) — leave them unchecked to
  never auto-suspend a tab that's mid-call/mid-playback or has input you
  haven't submitted yet.

## Files

- `manifest.json` — extension manifest (MV3)
- `background.js` — service worker: alarms, activity tracking, screenshot
  capture, suspend/restore logic, context menu, message handling
- `settings.js` — shared storage helpers (whitelist matching, per-domain
  timeout lookup) used by the background worker, popup, and options page
- `suspended.html` / `suspended.js` — the placeholder page shown for
  suspended tabs: cached screenshot, restore button, and a "Never suspend
  this site" link
- `popup.html` / `popup.js` — the toolbar's dropdown popup
  (`action.default_popup` in the manifest): default timeout, "suspend
  audio/video", "suspend pinned tabs", and "restore on click" toggles, a
  whitelist toggle for the current site, and a button that opens the
  suspended-tabs dashboard
- `manage.html` / `manage.js` — the "Suspended Tabs" dashboard tab, opened
  from the popup's button (or focused if already open) and also linked from
  the Options page. Lists every suspended tab (screenshot, restore/close,
  "restore all") plus the global auto-suspend toggle and a "suspend all
  other tabs" button.
- `options.html` / `options.js` — full settings page: general options,
  per-domain timer table, whitelist editor (with bulk import)
- `icons/` — toolbar/extension icons

## Notes & limitations

- Screenshots are only reliably captured for the tab that currently has
  focus (a Chrome API limitation), so they're taken opportunistically
  whenever a tab is active (on activation, focus, and page load). A tab that
  never became active during this browser session may show "No preview
  available" the first time.
- Screenshots are cached in `chrome.storage.session`, so they're cleared when
  the browser fully closes (not persisted to disk).
- `chrome://` and `chrome-extension://` pages are never suspended, since they
  can't be discarded/navigated the same way regular tabs can.
- Suspended tabs (and their captured session state) survive reloading or
  updating this extension — Chrome force-closes any open
  `chrome-extension://` tab when that happens, so the suspended-tab list is
  kept in `chrome.storage.local` and reconciled on the next startup,
  recreating anything that went missing.
- Session-state restore is best-effort: it can only see plain `<input>`,
  `<textarea>`, and `<select>` elements (not custom/contenteditable widgets),
  and on JavaScript-heavy pages it retries for a couple of seconds after load
  in case the form DOM renders late, but isn't guaranteed to find a field if
  the page's structure changed since it was suspended.
