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
  closed — click it to instantly restore the original page.
- Right before a tab loses focus, a compressed screenshot of it is captured
  and cached, so the suspended placeholder shows what the page looked like.
- Clicking the toolbar icon opens (or focuses, if already open) the
  **Suspended Tabs** dashboard as a regular tab — every currently-suspended
  tab with its screenshot, a restore/close per tab, "Restore all", "Suspend
  all other tabs", and the global auto-suspend toggle. It's not a dropdown
  popup; it's the same page you'd get from the Options page link.
- Each domain can have its own timeout (Options → "Per-domain timers", or
  right-click a page → "Never suspend this site"). Domains not explicitly
  configured fall back to the global default timeout.
- The whitelist (Options page) marks domains that are never auto-suspended —
  useful for things like video calls, docs you're actively editing, etc.
  Setting a domain's timer to "Never" automatically adds it to the whitelist.
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
  suspended tabs, including the cached screenshot and restore button
- `manage.html` / `manage.js` — the "Suspended Tabs" dashboard tab. Opened by
  the toolbar icon click handler in `background.js`
  (`chrome.action.onClicked` — no `default_popup` is set, so this always
  fires) and also linked from the Options page. Lists every suspended tab
  (screenshot, restore/close, "restore all") plus the global auto-suspend
  toggle and a "suspend all other tabs" button.
- `options.html` / `options.js` — full settings page: general options,
  per-domain timer table, whitelist editor (with bulk import)
- `icons/` — toolbar/extension icons
- `popup.html` / `popup.js` — **unused**, kept for reference. This was the
  toolbar's dropdown popup at one point; the toolbar icon now opens
  `manage.html` as a tab instead (see above). Safe to remove.

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
