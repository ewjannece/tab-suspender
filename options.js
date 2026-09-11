// options.js

const DEFAULTS = {
  autoSuspendEnabled: true,
  defaultTimeout: 30,
  suspendPinned: false,
  suspendAudible: false,
  suspendUnsavedForms: false,
  restoreOnActivate: false,
  domainRules: {},
  whitelist: []
};

let state = { ...DEFAULTS };

function timeoutLabel(mins) {
  if (mins === 0) return "Never";
  if (mins < 60) return `${mins} min`;
  if (mins % 60 === 0) return `${mins / 60} hr`;
  return `${mins} min`;
}

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  state = { ...DEFAULTS, ...stored };

  document.getElementById("autoSuspendEnabled").checked = state.autoSuspendEnabled;
  document.getElementById("defaultTimeout").value = state.defaultTimeout;
  document.getElementById("suspendPinned").checked = state.suspendPinned;
  document.getElementById("suspendAudible").checked = state.suspendAudible;
  document.getElementById("suspendUnsavedForms").checked = state.suspendUnsavedForms;
  document.getElementById("restoreOnActivate").checked = state.restoreOnActivate;

  renderDomainTable();
  renderWhitelistTable();
}

async function persist() {
  await chrome.storage.sync.set(state);
  showToast();
}

function showToast() {
  const toast = document.getElementById("saveToast");
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 1200);
}

function renderDomainTable() {
  const body = document.getElementById("domainTableBody");
  const empty = document.getElementById("domainEmpty");
  body.innerHTML = "";
  const entries = Object.entries(state.domainRules);
  empty.style.display = entries.length ? "none" : "block";

  for (const [domain, mins] of entries) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(domain)}</td>
      <td>${timeoutLabel(mins)}</td>
      <td class="actions"><button class="danger" data-domain="${escapeHtml(domain)}">Remove</button></td>
    `;
    tr.querySelector("button").addEventListener("click", () => {
      delete state.domainRules[domain];
      renderDomainTable();
      persist();
    });
    body.appendChild(tr);
  }
}

function renderWhitelistTable() {
  const body = document.getElementById("whitelistTableBody");
  const empty = document.getElementById("whitelistEmpty");
  body.innerHTML = "";
  empty.style.display = state.whitelist.length ? "none" : "block";

  state.whitelist.forEach((entry, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(entry)}</td>
      <td class="actions"><button class="danger" data-idx="${idx}">Remove</button></td>
    `;
    tr.querySelector("button").addEventListener("click", () => {
      state.whitelist.splice(idx, 1);
      renderWhitelistTable();
      persist();
    });
    body.appendChild(tr);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function cleanDomainInput(raw) {
  let v = raw.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "");
  v = v.replace(/\/$/, "");

  // Strip a leading "www." from the host part only (not from "*.example.com"
  // wildcards, and not from any path prefix after a "/"), so a rule typed as
  // "www.example.com" still matches — settings.js normalizes tab hostnames
  // the same way before comparing against these entries.
  const slashIdx = v.indexOf("/");
  let host = slashIdx === -1 ? v : v.slice(0, slashIdx);
  const rest = slashIdx === -1 ? "" : v.slice(slashIdx);
  if (!host.startsWith("*.")) {
    host = host.replace(/^www\./, "");
  }
  return host + rest;
}

// ---- general settings listeners ----

document.getElementById("autoSuspendEnabled").addEventListener("change", (e) => {
  state.autoSuspendEnabled = e.target.checked;
  persist();
});
document.getElementById("defaultTimeout").addEventListener("change", (e) => {
  const v = Math.max(1, Math.min(1440, parseInt(e.target.value, 10) || 30));
  state.defaultTimeout = v;
  e.target.value = v;
  persist();
});
document.getElementById("suspendPinned").addEventListener("change", (e) => {
  state.suspendPinned = e.target.checked;
  persist();
});
document.getElementById("suspendAudible").addEventListener("change", (e) => {
  state.suspendAudible = e.target.checked;
  persist();
});
document.getElementById("suspendUnsavedForms").addEventListener("change", (e) => {
  state.suspendUnsavedForms = e.target.checked;
  persist();
});
document.getElementById("restoreOnActivate").addEventListener("change", (e) => {
  state.restoreOnActivate = e.target.checked;
  persist();
});

// ---- domain rules ----

document.getElementById("addDomainBtn").addEventListener("click", () => {
  const input = document.getElementById("newDomainInput");
  const domain = cleanDomainInput(input.value);
  if (!domain) return;
  const mins = parseInt(document.getElementById("newDomainTimeout").value, 10);
  state.domainRules[domain] = mins;
  input.value = "";
  renderDomainTable();
  persist();
});
document.getElementById("newDomainInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addDomainBtn").click();
});

// ---- whitelist ----

document.getElementById("addWhitelistBtn").addEventListener("click", () => {
  const input = document.getElementById("newWhitelistInput");
  const entry = cleanDomainInput(input.value);
  if (!entry || state.whitelist.includes(entry)) return;
  state.whitelist.push(entry);
  input.value = "";
  renderWhitelistTable();
  persist();
});
document.getElementById("newWhitelistInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("addWhitelistBtn").click();
});

document.getElementById("importBulkBtn").addEventListener("click", () => {
  const textarea = document.getElementById("bulkWhitelistInput");
  const lines = textarea.value.split("\n").map((l) => cleanDomainInput(l)).filter(Boolean);
  let added = 0;
  for (const line of lines) {
    if (!state.whitelist.includes(line)) {
      state.whitelist.push(line);
      added++;
    }
  }
  textarea.value = "";
  renderWhitelistTable();
  if (added > 0) persist();
});

load();
