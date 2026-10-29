// ===================== WA Sheet — popup.js =====================
// Wizard state
const state = {
  step: "source",
  source: "manual",       // manual | excel | gsheet | group
  sourceLabel: "Manual entry",
  columns: [],             // array of column names (from header row)
  rows: [],                // array of objects {col: value}
  selectedRowIdx: new Set(),
  phoneCol: null,
  messageCol: null,
  messageTemplate: "",
  countryCode: "91",
  randomDelayEnabled: false,
  randomDelaySeconds: 30,
  unsubscribeEnabled: false,
  unsubscribeText: "Reply STOP to unsubscribe.",
  timestampEnabled: false,
  skipUnsubscribers: false,
  unsubscriberNumbers: "",
  batchSize: 0,
  batchPauseSeconds: 30,
  mediaFile: null,         // {name, type, size, mediaKey, totalChunks} — actual bytes live in chrome.storage.local
  mediaProcessing: false,  // true while a large file is still being chunked into storage
  delaySeconds: 5,
  safetyModeEnabled: true,
  safetyMinDelay: 15,
  safetyRandomDelay: 30,
  safetyMaxPerHour: 20,
  safetyMaxPerDay: 100,
  safetyBatchSize: 10,
  safetyBatchPause: 300,
  safetyFailureLimit: 3,
  campaign: null           // built right before sending
};
const UNSUBSCRIBERS_STORAGE_KEY = "wa_sheet_unsubscribers";

const $ = (id) => document.getElementById(id);
const qs = (sel, root=document) => root.querySelector(sel);
const qsa = (sel, root=document) => Array.from(root.querySelectorAll(sel));

// --------------------- WhatsApp connection status ---------------------
async function refreshWaStatus() {
  chrome.runtime.sendMessage({ action: "getWaStatus" }, (resp) => {
    const dot = $("waDot");
    const text = $("waStatusText");
    if (chrome.runtime.lastError || !resp) {
      dot.className = "dot dot-off";
      text.textContent = "WhatsApp Web not detected";
      return;
    }
    if (resp.connected) {
      dot.className = "dot dot-on";
      text.textContent = "WhatsApp Web connected";
    } else {
      dot.className = "dot dot-off";
      text.textContent = resp.tabOpen ? "Waiting for WhatsApp Web to load…" : "Open WhatsApp Web to connect";
    }
  });
}

// --------------------- Step navigation ---------------------
const STEP_ORDER = ["source", "mapping", "message", "review", "sending"];

function goToStep(step) {
  state.step = step;
  qsa(".panel").forEach(p => p.classList.add("hidden"));
  $(`panel-${step}`).classList.remove("hidden");

  qsa(".step").forEach(s => {
    s.classList.remove("active", "done");
    const idx = STEP_ORDER.indexOf(s.dataset.step);
    const curIdx = STEP_ORDER.indexOf(step);
    if (idx < curIdx) s.classList.add("done");
    if (idx === curIdx) s.classList.add("active");
  });
}

qsa("[data-back]").forEach(btn => {
  btn.addEventListener("click", () => goToStep(btn.dataset.back));
});

// --------------------- STEP 1: SOURCE ---------------------
qsa(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    qsa(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    state.source = tab.dataset.source;
    ["manual", "excel", "gsheet", "group"].forEach(s => {
      $(`source-${s}`).classList.toggle("hidden", s !== state.source);
    });
    if (state.source === "group") {
      loadGroups();
    }
  });
});

// -- WhatsApp groups (multi-select; sends directly to groups) --
let availableGroups = [];
let selectedGroupKeys = new Set();
let groupSyncInFlight = false;

function groupKey(group) {
  return String(group.id || group.name || "");
}

function showGroupError(message) {
  const errorEl = $("groupImportError");
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
}

function updateGroupSelectionUi() {
  const count = selectedGroupKeys.size;
  $("groupContactCount").textContent = `${count} group${count === 1 ? "" : "s"} selected`;
  $("groupContinueBtn").disabled = count === 0;
  $("groupSelectAllBtn").disabled = availableGroups.length === 0;
  $("groupClearBtn").disabled = count === 0;
}

function renderGroupList() {
  const list = $("groupList");
  list.innerHTML = "";
  if (!availableGroups.length) {
    list.innerHTML = '<p class="hint">No groups detected. Open WhatsApp Web on the Chats screen, clear its search, and click Refresh Groups.</p>';
    updateGroupSelectionUi();
    return;
  }

  availableGroups.forEach((group, index) => {
    const key = groupKey(group);
    const label = document.createElement("label");
    label.className = "group-check-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedGroupKeys.has(key);
    checkbox.dataset.index = String(index);
    const name = document.createElement("span");
    name.textContent = group.name;
    label.append(checkbox, name);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedGroupKeys.add(key);
      else selectedGroupKeys.delete(key);
      updateGroupSelectionUi();
    });
    list.appendChild(label);
  });
  updateGroupSelectionUi();
}

function loadGroups() {
  if (groupSyncInFlight) return;
  groupSyncInFlight = true;
  const button = $("groupLoadBtn");
  const errorEl = $("groupImportError");
  errorEl.classList.add("hidden");
  button.disabled = true;
  button.textContent = "Loading…";

  chrome.runtime.sendMessage({ action: "getGroupChats" }, (response) => {
    groupSyncInFlight = false;
    button.disabled = false;
    button.textContent = "Refresh Groups";
    if (chrome.runtime.lastError || !response?.ok) {
      availableGroups = [];
      selectedGroupKeys.clear();
      renderGroupList();
      showGroupError(response?.error || chrome.runtime.lastError?.message || "Open WhatsApp Web first.");
      return;
    }

    const unique = new Map();
    (response.groups || []).forEach(group => {
      if (group?.name) unique.set(groupKey(group), group);
    });
    availableGroups = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
    const validKeys = new Set(availableGroups.map(groupKey));
    selectedGroupKeys = new Set([...selectedGroupKeys].filter(key => validKeys.has(key)));
    renderGroupList();
    if (!availableGroups.length) {
      showGroupError("No WhatsApp groups were detected. Clear the WhatsApp chat search, keep the Chats list open, then refresh again.");
    }
  });
}

$("groupLoadBtn").addEventListener("click", loadGroups);
$("groupSelectAllBtn").addEventListener("click", () => {
  selectedGroupKeys = new Set(availableGroups.map(groupKey));
  renderGroupList();
});
$("groupClearBtn").addEventListener("click", () => {
  selectedGroupKeys.clear();
  renderGroupList();
});

$("groupContinueBtn").addEventListener("click", () => {
  const selectedGroups = availableGroups.filter(group => selectedGroupKeys.has(groupKey(group)));
  if (!selectedGroups.length) return;
  state.source = "group";
  state.sourceLabel = `${selectedGroups.length} WhatsApp group${selectedGroups.length === 1 ? "" : "s"}`;
  state.columns = ["group"];
  state.rows = selectedGroups.map(group => ({ group: group.name, groupId: group.id || "" }));
  state.phoneCol = null;
  state.messageCol = null;
  state.selectedRowIdx = new Set(state.rows.map((_, i) => i));
  buildMessageStep();
  goToStep("message");
});

// -- Manual entry --
$("manualContinueBtn").addEventListener("click", () => {
  const raw = $("manualNumbers").value.trim();
  if (!raw) { alert("Enter at least one phone number."); return; }
  const numbers = raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  state.sourceLabel = "Manual entry";
  state.columns = ["phone"];
  state.rows = numbers.map(n => ({ phone: n }));
  state.phoneCol = "phone";
  state.messageCol = null;
  state.selectedRowIdx = new Set(state.rows.map((_, i) => i));
  buildMappingStep();
  goToStep("mapping");
});

// -- Excel / CSV upload --
const dropzone = $("dropzone");
const fileInput = $("fileInput");
$("selectFileBtn").addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleSpreadsheetFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) handleSpreadsheetFile(fileInput.files[0]);
});

function handleSpreadsheetFile(file) {
  if (file.size > 10 * 1024 * 1024) { alert("File exceeds 10 MB limit."); return; }
  $("fileChosenName").textContent = `Selected: ${file.name}`;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: "array" });
      loadWorkbookFirstSheet(workbook);
      state.sourceLabel = file.name;
      goToStep("mapping");
    } catch (err) {
      alert("Could not read this file: " + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function loadWorkbookFirstSheet(workbook) {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!json.length) { alert("This sheet appears to be empty."); return; }
  state.columns = Object.keys(json[0]);
  state.rows = json;
  state.selectedRowIdx = new Set(state.rows.map((_, i) => i));
  state.phoneCol = guessPhoneColumn(state.columns);
  state.messageCol = "";
  buildMappingStep();
}

function guessPhoneColumn(cols) {
  const lower = cols.map(c => c.toLowerCase());
  const idx = lower.findIndex(c => /phone|mobile|number|whatsapp|contact/.test(c));
  return idx >= 0 ? cols[idx] : cols[0];
}

// -- Google Sheet --
$("gsheetLoadBtn").addEventListener("click", async () => {
  const url = $("gsheetUrl").value.trim();
  const errEl = $("gsheetError");
  errEl.classList.add("hidden");
  if (!url) { showGsheetError("Paste a Google Sheet link first."); return; }

  const csvUrl = toGvizCsvUrl(url);
  if (!csvUrl) { showGsheetError("That doesn't look like a valid Google Sheets link."); return; }

  $("gsheetLoadBtn").textContent = "Loading…";
  try {
    const res = await fetch(csvUrl);
    if (!res.ok) throw new Error("Sheet is not shared publicly, or the link is wrong.");
    const csvText = await res.text();
    const workbook = XLSX.read(csvText, { type: "string" });
    loadWorkbookFirstSheet(workbook);
    state.sourceLabel = "Google Sheet";
    goToStep("mapping");
  } catch (err) {
    showGsheetError(err.message || "Could not load that sheet. Make sure sharing is set to 'Anyone with the link'.");
  } finally {
    $("gsheetLoadBtn").textContent = "Load Sheet";
  }
});

function showGsheetError(msg) {
  const el = $("gsheetError");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function toGvizCsvUrl(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return null;
  const id = m[1];
  let gid = "0";
  const gidMatch = url.match(/[?#&]gid=(\d+)/);
  if (gidMatch) gid = gidMatch[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

// --------------------- STEP 2: MAPPING + RECIPIENT PICKER ---------------------
function buildMappingStep() {
  const phoneSel = $("phoneColSelect");
  const msgSel = $("messageColSelect");
  const countryCodeInput = $("countryCode");
  phoneSel.innerHTML = "";
  msgSel.innerHTML = `<option value="">— none, use composed message —</option>`;

  state.columns.forEach(col => {
    const o1 = document.createElement("option");
    o1.value = col; o1.textContent = col;
    if (col === state.phoneCol) o1.selected = true;
    phoneSel.appendChild(o1);

    const o2 = document.createElement("option");
    o2.value = col; o2.textContent = col;
    if (col === state.messageCol) o2.selected = true;
    msgSel.appendChild(o2);
  });

  phoneSel.onchange = () => {
    state.phoneCol = phoneSel.value;
    updateDuplicateButton();
  };
  msgSel.onchange = () => { state.messageCol = msgSel.value; };
  countryCodeInput.value = state.countryCode;
  countryCodeInput.oninput = () => {
    state.countryCode = countryCodeInput.value.replace(/\D/g, "").slice(0, 4);
    countryCodeInput.value = state.countryCode;
  };

  $("removeDuplicatesBtn").onclick = removeDuplicateRows;

  renderRowsTable();
  updateDuplicateButton();
}

$("exportContactsBtn")?.addEventListener("click", exportContacts);

function renderRowsTable(filter = "") {
  const table = $("rowsTable");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";

  const headRow = document.createElement("tr");
  headRow.innerHTML = `<th></th>` + state.columns.map(c => `<th>${escapeHtml(c)}</th>`).join("");
  thead.appendChild(headRow);

  const f = filter.toLowerCase();
  state.rows.forEach((row, idx) => {
    const rowText = Object.values(row).join(" ").toLowerCase();
    if (f && !rowText.includes(f)) return;
    const tr = document.createElement("tr");
    const checked = state.selectedRowIdx.has(idx) ? "checked" : "";
    tr.innerHTML = `<td><input type="checkbox" class="row-check" data-idx="${idx}" ${checked}></td>` +
      state.columns.map(c => `<td>${escapeHtml(String(row[c] ?? ""))}</td>`).join("");
    tbody.appendChild(tr);
  });

  $("rowCount").textContent = state.rows.length;
  updateSelectedCount();
  updateDuplicateButton();

  qsa(".row-check").forEach(cb => {
    cb.addEventListener("change", () => {
      const idx = Number(cb.dataset.idx);
      if (cb.checked) state.selectedRowIdx.add(idx);
      else state.selectedRowIdx.delete(idx);
      updateSelectedCount();
      syncSelectAllCheckbox();
    });
  });
}

function updateSelectedCount() {
  $("selectedCount").textContent = state.selectedRowIdx.size;
}

function syncSelectAllCheckbox() {
  $("selectAllRows").checked = state.selectedRowIdx.size === state.rows.length;
}

function findDuplicateRowIndexes() {
  if (!state.phoneCol || !["excel", "group"].includes(state.source)) return [];
  const seen = new Set();
  const duplicateIndexes = [];
  state.rows.forEach((row, index) => {
    const phone = normalizeRecipientPhone(String(row[state.phoneCol] ?? ""));
    if (!phone) return;
    if (seen.has(phone)) duplicateIndexes.push(index);
    else seen.add(phone);
  });
  return duplicateIndexes;
}

function updateDuplicateButton() {
  const button = $("removeDuplicatesBtn");
  if (!button) return;
  const duplicateCount = findDuplicateRowIndexes().length;
  button.textContent = duplicateCount
    ? `Remove duplicates (${duplicateCount})`
    : "No duplicates";
  button.classList.toggle("hidden", !["excel", "group"].includes(state.source));
  button.disabled = duplicateCount === 0;
}

function removeDuplicateRows() {
  const duplicateIndexes = new Set(findDuplicateRowIndexes());
  if (!duplicateIndexes.size) return;

  const nextRows = [];
  const nextSelected = new Set();
  state.rows.forEach((row, oldIndex) => {
    if (duplicateIndexes.has(oldIndex)) return;
    const nextIndex = nextRows.length;
    nextRows.push(row);
    if (state.selectedRowIdx.has(oldIndex)) nextSelected.add(nextIndex);
  });

  state.rows = nextRows;
  state.selectedRowIdx = nextSelected;
  renderRowsTable($("rowSearch").value);
}

$("selectAllRows").addEventListener("change", (e) => {
  if (e.target.checked) {
    state.selectedRowIdx = new Set(state.rows.map((_, i) => i));
  } else {
    state.selectedRowIdx.clear();
  }
  renderRowsTable($("rowSearch").value);
});

$("rowSearch").addEventListener("input", (e) => renderRowsTable(e.target.value));

$("mappingContinueBtn").addEventListener("click", () => {
  if (!state.phoneCol) { alert("Choose the phone number column."); return; }
  if (state.selectedRowIdx.size === 0) { alert("Select at least one recipient."); return; }
  buildMessageStep();
  goToStep("message");
});

// --------------------- STEP 3: MESSAGE ---------------------
function buildMessageStep() {
  const chipsWrap = $("variableChips");
  chipsWrap.innerHTML = "";
  state.columns.forEach(col => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `{{${col}}}`;
    chip.addEventListener("click", () => insertAtCursor($("messageTemplate"), `{{${col}}}`));
    chipsWrap.appendChild(chip);
  });
  $("messageTemplate").value = state.messageTemplate;
  $("messageTemplate").disabled = !!state.messageCol;
  $("messageTemplate").placeholder = state.messageCol
    ? `Using the "${state.messageCol}" column as the message for each row.`
    : "Hi {{name}}, ...";
}

function insertAtCursor(el, text) {
  const start = el.selectionStart, end = el.selectionEnd;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.focus();
  el.selectionStart = el.selectionEnd = start + text.length;
}

$("attachMediaToggle").addEventListener("change", (e) => {
  $("mediaBox").classList.toggle("hidden", !e.target.checked);
  if (!e.target.checked) clearStoredMedia();
});
$("mediaInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // Drop any previously-stored attachment before storing the new one, so we
  // never leave an orphaned blob behind in chrome.storage.local.
  await clearStoredMedia();

  state.mediaProcessing = true;
  $("mediaChosenName").textContent = `Reading ${file.name}…`;
  $("messageContinueBtn").disabled = true;

  let mediaKey = null;
  let totalChunks = 0;
  try {
    const dataUrl = await fileToDataUrl(file);
    mediaKey = "wa_sheet_media_" + Date.now();

    // IMPORTANT: the raw media bytes never travel through chrome.runtime /
    // chrome.tabs messaging — Chrome hard-caps any single message at 64MiB,
    // and that's hit fast by a video once base64-encoded (~33% bigger than
    // the original file). We also don't write it to chrome.storage.local in
    // one giant call — a single multi-hundred-MB write is slow and, in
    // testing, can silently fail or leave the popup racing ahead before the
    // write finishes. Instead we split it into small chunks and write them
    // one at a time, reporting progress, and only mark the attachment ready
    // once every chunk is confirmed written.
    totalChunks = await storeMediaChunked(mediaKey, dataUrl, (done, total) => {
      $("mediaChosenName").textContent = `Processing ${file.name}… ${Math.round((done / total) * 100)}%`;
    });

    state.mediaFile = { name: file.name, type: file.type, size: file.size, mediaKey, totalChunks };
    $("mediaChosenName").textContent = `Attached: ${file.name} (${formatBytes(file.size)})`;
  } catch (err) {
    if (mediaKey) await removeStoredMediaChunks(mediaKey, totalChunks);
    state.mediaFile = null;
    $("mediaChosenName").textContent = "";
    alert("Could not attach this file: " + err.message);
  } finally {
    state.mediaProcessing = false;
    $("messageContinueBtn").disabled = false;
  }
});

function formatBytes(n) {
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Could not read the file (it may be too large for the browser to load)."));
    r.readAsDataURL(file);
  });
}

// Writes a big base64 data URL into chrome.storage.local as a series of
// small chunks instead of one giant value — keeps every individual
// chrome.storage.local.set() call small and reliable no matter how large
// the source file is (tested up to 170MB+ videos). Layout:
//   `${mediaKey}_meta`      -> {name, type, size, totalChunks}
//   `${mediaKey}_chunk_${i}` -> chunk of the data URL string
// chrome.storage.local limits each value to roughly 8 KiB, even when
// unlimitedStorage is enabled. Keep room for JSON/key overhead.
const MEDIA_CHUNK_SIZE = 6000; // base64/data-URL characters per chunk
async function storeMediaChunked(mediaKey, dataUrl, onProgress) {
  const totalChunks = Math.max(1, Math.ceil(dataUrl.length / MEDIA_CHUNK_SIZE));
  for (let i = 0; i < totalChunks; i++) {
    const chunk = dataUrl.slice(i * MEDIA_CHUNK_SIZE, (i + 1) * MEDIA_CHUNK_SIZE);
    await chrome.storage.local.set({ [`${mediaKey}_chunk_${i}`]: chunk });
    if (onProgress) onProgress(i + 1, totalChunks);
  }
  await chrome.storage.local.set({ [`${mediaKey}_meta`]: { totalChunks, complete: true } });
  return totalChunks;
}

// Remove every chunk + the meta key for a stored media blob. Safe to call
// even if nothing was stored.
async function removeStoredMediaChunks(mediaKey, totalChunks) {
  const keys = [`${mediaKey}_meta`];
  for (let i = 0; i < (totalChunks || 0); i++) keys.push(`${mediaKey}_chunk_${i}`);
  try { await chrome.storage.local.remove(keys); } catch {}
}

// Remove any media blob we previously wrote to chrome.storage.local and
// clear it from wizard state.
async function clearStoredMedia() {
  if (state.mediaFile && state.mediaFile.mediaKey) {
    await removeStoredMediaChunks(state.mediaFile.mediaKey, state.mediaFile.totalChunks);
  }
  state.mediaFile = null;
}

$("messageContinueBtn").addEventListener("click", () => {
  if (state.mediaProcessing) {
    alert("Still processing the attached file — please wait for it to finish before continuing.");
    return;
  }
  state.messageTemplate = $("messageTemplate").value;
  if (!state.messageCol && !state.messageTemplate.trim() && !state.mediaFile) {
    alert("Write a message, map a message column, or attach media.");
    return;
  }
  buildReviewStep();
  goToStep("review");
});

// --------------------- STEP 4: REVIEW ---------------------
function buildReviewStep() {
  $("summaryCount").textContent = state.selectedRowIdx.size;
  $("summarySource").textContent = state.sourceLabel || (state.source === "manual" ? "Manual entry" : state.source);
  $("summaryMedia").textContent = state.mediaFile ? state.mediaFile.name : "No";

  // WhatsApp compresses/rejects photos & videos sent as regular media once
  // they're over ~16MB — attaching as a Document instead avoids that (up to
  // 2GB, no compression, just no inline preview). content.js already
  // switches to the Document picker automatically for anything this size;
  // this note just explains why to avoid confusion.
  const mediaNote = $("summaryMediaNote");
  if (mediaNote) {
    if (state.mediaFile && state.mediaFile.size > 16 * 1024 * 1024) {
      mediaNote.textContent = `This file is ${formatBytes(state.mediaFile.size)} — WhatsApp only allows ~16MB for inline photos/videos, so it'll be sent as a Document instead (full quality, no inline preview).`;
      mediaNote.classList.remove("hidden");
    } else {
      mediaNote.classList.add("hidden");
    }
  }

  const firstIdx = [...state.selectedRowIdx][0];
  const firstRow = state.rows[firstIdx] || {};
  $("previewBox").textContent = renderMessageForRow(firstRow) || "(no text — media only)";
  $("delaySeconds").value = state.delaySeconds;
  $("safetyModeToggle").checked = state.safetyModeEnabled;
  $("safetySettings").classList.toggle("hidden", !state.safetyModeEnabled);
  $("safetyMinDelay").value = state.safetyMinDelay;
  $("safetyRandomDelay").value = state.safetyRandomDelay;
  $("safetyMaxPerHour").value = state.safetyMaxPerHour;
  $("safetyMaxPerDay").value = state.safetyMaxPerDay;
  $("safetyBatchSize").value = state.safetyBatchSize;
  $("safetyBatchPause").value = state.safetyBatchPause;
  $("safetyFailureLimit").value = state.safetyFailureLimit;
  $("randomDelayToggle").checked = state.randomDelayEnabled;
  $("randomDelaySeconds").value = state.randomDelaySeconds;
  $("unsubscribeToggle").checked = state.unsubscribeEnabled;
  $("unsubscribeText").value = state.unsubscribeText;
  $("unsubscribeText").classList.toggle("hidden", !state.unsubscribeEnabled);
  $("timestampToggle").checked = state.timestampEnabled;
  $("skipUnsubscribersToggle").checked = state.skipUnsubscribers;
  $("unsubscriberNumbers").value = state.unsubscriberNumbers;
  $("unsubscriberNumbers").classList.toggle("hidden", !state.skipUnsubscribers);
  $("batchSize").value = state.batchSize;
  $("batchPauseSeconds").value = state.batchPauseSeconds;
}

function renderMessageForRow(row) {
  const baseMessage = state.messageCol
    ? String(row[state.messageCol] ?? "")
    : state.messageTemplate.replace(/\{\{(.*?)\}\}|\{([^{}]+)\}/g, (_, doubleKey, singleKey) => {
    const key = doubleKey || singleKey;
    const k = key.trim();
    return row[k] !== undefined ? String(row[k]) : "";
  });
  const additions = [];
  if (state.unsubscribeEnabled && state.unsubscribeText.trim()) additions.push(state.unsubscribeText.trim());
  if (state.timestampEnabled) additions.push(formatCampaignTimestamp());
  return [baseMessage.trim(), ...additions].filter(Boolean).join("\n\n");
}

function formatCampaignTimestamp() {
  if (!state.campaignTimestamp) state.campaignTimestamp = new Date().toLocaleString();
  return state.campaignTimestamp;
}

function syncReviewSettingsFromUi() {
  state.delaySeconds = Math.max(2, Number($("delaySeconds").value) || 5);
  state.safetyModeEnabled = $("safetyModeToggle").checked;
  state.safetyMinDelay = Math.min(600, Math.max(10, Number($("safetyMinDelay").value) || 15));
  state.safetyRandomDelay = Math.min(600, Math.max(5, Number($("safetyRandomDelay").value) || 30));
  state.safetyMaxPerHour = Math.min(200, Math.max(1, Number($("safetyMaxPerHour").value) || 20));
  state.safetyMaxPerDay = Math.min(1000, Math.max(1, Number($("safetyMaxPerDay").value) || 100));
  state.safetyBatchSize = Math.min(100, Math.max(1, Number($("safetyBatchSize").value) || 10));
  state.safetyBatchPause = Math.min(7200, Math.max(30, Number($("safetyBatchPause").value) || 300));
  state.safetyFailureLimit = Math.min(20, Math.max(1, Number($("safetyFailureLimit").value) || 3));
  state.randomDelayEnabled = $("randomDelayToggle").checked;
  state.randomDelaySeconds = Math.min(600, Math.max(2, Number($("randomDelaySeconds").value) || 30));
  state.unsubscribeEnabled = $("unsubscribeToggle").checked;
  state.unsubscribeText = $("unsubscribeText").value;
  state.timestampEnabled = $("timestampToggle").checked;
  state.skipUnsubscribers = $("skipUnsubscribersToggle").checked;
  state.unsubscriberNumbers = $("unsubscriberNumbers").value;
  state.batchSize = Math.min(1000, Math.max(0, Number($("batchSize").value) || 0));
  state.batchPauseSeconds = Math.min(3600, Math.max(0, Number($("batchPauseSeconds").value) || 0));
}

$("safetyModeToggle").addEventListener("change", (e) => {
  state.safetyModeEnabled = e.target.checked;
  $("safetySettings").classList.toggle("hidden", !state.safetyModeEnabled);
});

$("delaySeconds").addEventListener("change", (e) => {
  state.delaySeconds = Math.max(2, Number(e.target.value) || 5);
});

$("randomDelayToggle").addEventListener("change", (e) => {
  state.randomDelayEnabled = e.target.checked;
});
$("randomDelaySeconds").addEventListener("change", (e) => {
  state.randomDelaySeconds = Math.min(600, Math.max(2, Number(e.target.value) || 30));
  e.target.value = state.randomDelaySeconds;
});
$("unsubscribeToggle").addEventListener("change", (e) => {
  state.unsubscribeEnabled = e.target.checked;
  $("unsubscribeText").classList.toggle("hidden", !state.unsubscribeEnabled);
});
$("unsubscribeText").addEventListener("input", (e) => {
  state.unsubscribeText = e.target.value;
});
$("timestampToggle").addEventListener("change", (e) => {
  state.timestampEnabled = e.target.checked;
});
$("skipUnsubscribersToggle").addEventListener("change", (e) => {
  state.skipUnsubscribers = e.target.checked;
  $("unsubscriberNumbers").classList.toggle("hidden", !state.skipUnsubscribers);
});
$("unsubscriberNumbers").addEventListener("input", (e) => {
  state.unsubscriberNumbers = e.target.value;
});

// --------------------- STEP 5: SEND ---------------------
$("startSendBtn").addEventListener("click", async () => {
  // Read the controls again here so a campaign cannot use stale settings from
  // when the Review step was first opened.
  syncReviewSettingsFromUi();
  state.campaignTimestamp = state.timestampEnabled ? new Date().toLocaleString() : null;
  const unsubscribeSet = state.skipUnsubscribers ? parsePhoneList(state.unsubscriberNumbers) : new Set();
  if (state.skipUnsubscribers) {
    await chrome.storage.local.set({
      [UNSUBSCRIBERS_STORAGE_KEY]: [...unsubscribeSet]
    });
  }

  // Only ever pass the {name, type, mediaKey} reference here, never the
  // dataUrl itself — the actual bytes stay in chrome.storage.local and are
  // shared by every row via mediaKey, so this campaign object (and every
  // chrome.runtime/chrome.tabs message built from it) stays tiny regardless
  // of video size or row count.
  const mediaRef = state.mediaFile
    ? { name: state.mediaFile.name, type: state.mediaFile.type, size: state.mediaFile.size, mediaKey: state.mediaFile.mediaKey, totalChunks: state.mediaFile.totalChunks }
    : null;

  const queue = [...state.selectedRowIdx].map((idx, i) => {
    const row = state.rows[idx];
    if (state.source === "group") {
      return {
        id: i,
        destinationType: "group",
        groupName: String(row.group || "").trim(),
        groupId: String(row.groupId || ""),
        phone: `Group: ${String(row.group || "").trim()}`,
        message: renderMessageForRow(row),
        media: mediaRef,
        status: "pending"
      };
    }
    const phone = normalizeRecipientPhone(String(row[state.phoneCol] ?? ""));
    return {
      id: i,
      destinationType: "phone",
      phone,
      message: renderMessageForRow(row),
      media: mediaRef,
      status: "pending"
    };
  }).filter(item => item.destinationType === "group"
    ? item.groupName
    : item.phone && !unsubscribeSet.has(item.phone));

  if (!queue.length) {
    alert(state.source === "group" ? "Select at least one valid group." : "No valid phone numbers in the selected rows.");
    return;
  }

  const campaign = {
    id: "camp_" + Date.now(),
    queue,
    index: 0,
    delaySeconds: state.safetyModeEnabled ? Math.max(state.delaySeconds, state.safetyMinDelay) : state.delaySeconds,
    randomDelayEnabled: state.safetyModeEnabled ? true : state.randomDelayEnabled,
    randomDelaySeconds: state.safetyModeEnabled
      ? Math.max(state.randomDelayEnabled ? state.randomDelaySeconds : 0, state.safetyRandomDelay)
      : (state.randomDelayEnabled ? state.randomDelaySeconds : 0),
    batchSize: state.safetyModeEnabled
      ? (!state.batchSize ? state.safetyBatchSize : Math.min(state.batchSize, state.safetyBatchSize))
      : state.batchSize,
    batchPauseSeconds: state.safetyModeEnabled
      ? Math.max(state.batchPauseSeconds, state.safetyBatchPause)
      : state.batchPauseSeconds,
    safetyEnabled: state.safetyModeEnabled,
    safetyMaxPerHour: state.safetyMaxPerHour,
    safetyMaxPerDay: state.safetyMaxPerDay,
    safetyFailureLimit: state.safetyFailureLimit,
    consecutiveFailures: 0,
    pauseReason: "",
    status: "running",
    createdAt: Date.now(),
    timestamp: state.campaignTimestamp || null,
    mediaKey: mediaRef ? mediaRef.mediaKey : null,           // so background.js can clean up storage on reset
    mediaTotalChunks: mediaRef ? mediaRef.totalChunks : 0
  };
  state.campaign = campaign;

  chrome.runtime.sendMessage({ action: "startCampaign", campaign }, () => {
    if (chrome.runtime.lastError) {
      alert("Could not start sending: " + chrome.runtime.lastError.message);
      return;
    }
    goToStep("sending");
    renderResultsTable(queue);
  });
});

function parsePhoneList(raw) {
  return new Set(String(raw || "").split(/[\n,;]/).map(value => normalizeRecipientPhone(value.trim())).filter(Boolean));
}

function downloadText(filename, text, mimeType = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function exportContacts() {
  if (!state.rows.length) return;
  const lines = [state.columns.map(csvCell).join(",")];
  state.rows.forEach(row => lines.push(state.columns.map(column => csvCell(row[column])).join(",")));
  downloadText("wa-sheet-contacts.csv", lines.join("\r\n"), "text/csv;charset=utf-8");
}

function exportReport() {
  const campaign = state.campaign;
  if (!campaign || !campaign.queue?.length) return;
  const lines = [["Phone", "Status", "Message", "Error", "Warning"].map(csvCell).join(",")];
  campaign.queue.forEach(item => lines.push([item.phone, item.status, item.message, item.error, item.warning].map(csvCell).join(",")));
  downloadText(`wa-sheet-report-${campaign.id || Date.now()}.csv`, lines.join("\r\n"), "text/csv;charset=utf-8");
}

$("exportReportBtn").addEventListener("click", exportReport);

function normalizePhone(raw) {
  return raw.replace(/[^\d]/g, "");
}

function normalizeRecipientPhone(raw) {
  const digits = normalizePhone(raw);
  if (digits.length === 10 && state.countryCode) return state.countryCode + digits;
  return digits;
}

function applyStatusToPill(pill, item) {
  const status = item.status || "pending";
  const label = status[0].toUpperCase() + status.slice(1);
  pill.textContent = label;
  pill.className = "status-pill status-" + status + (status === "sent" && item.warning ? " status-warning" : "");
  const reason = status === "failed" ? item.error : (status === "sent" ? item.warning : null);
  if (reason) {
    pill.title = reason;
    pill.style.cursor = "help";
    pill.onclick = () => alert(reason);
  } else {
    pill.title = "";
    pill.style.cursor = "";
    pill.onclick = null;
  }
}

function renderResultsTable(queue) {
  $("progressTotal").textContent = queue.length;
  const tbody = $("resultsTable").querySelector("tbody");
  tbody.innerHTML = queue.map(item => {
    const status = item.status || "pending";
    const label = status[0].toUpperCase() + status.slice(1);
    return `
    <tr id="result-row-${item.id}">
      <td>${item.id + 1}</td>
      <td>${escapeHtml(item.phone)}</td>
      <td><span class="status-pill status-${status}" id="status-${item.id}">${label}</span></td>
      <td class="result-error" id="error-${item.id}">${escapeHtml(item.error || "")}</td>
    </tr>
  `;
  }).join("");
  queue.forEach(item => {
    const pill = $(`status-${item.id}`);
    if (pill) applyStatusToPill(pill, item);
  });
  updateProgressUI(queue);
}

function updateProgressUI(queue) {
  const sent = queue.filter(q => q.status === "sent").length;
  const failed = queue.filter(q => q.status === "failed").length;
  $("progressSent").textContent = sent;
  $("progressFailed").textContent = failed;
  const pct = Math.round(((sent + failed) / queue.length) * 100) || 0;
  $("progressFill").style.width = pct + "%";
}

function updateSendControls(campaignObj) {
  const status = campaignObj.status;
  const notice = $("safetyNotice");
  if (campaignObj.pauseReason) {
    notice.textContent = campaignObj.pauseReason;
    notice.classList.remove("hidden");
  } else {
    notice.classList.add("hidden");
  }
  if (status === "completed" || status === "stopped") {
    $("pauseBtn").classList.add("hidden");
    $("resumeBtn").classList.add("hidden");
    $("stopBtn").classList.add("hidden");
  } else if (status === "paused") {
    $("pauseBtn").classList.add("hidden");
    $("resumeBtn").classList.remove("hidden");
    $("stopBtn").classList.remove("hidden");
  } else {
    $("pauseBtn").classList.remove("hidden");
    $("resumeBtn").classList.add("hidden");
    $("stopBtn").classList.remove("hidden");
  }
}

$("pauseBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "pauseCampaign" });
  $("pauseBtn").classList.add("hidden");
  $("resumeBtn").classList.remove("hidden");
});
$("resumeBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "resumeCampaign" });
  $("resumeBtn").classList.add("hidden");
  $("pauseBtn").classList.remove("hidden");
});
$("stopBtn").addEventListener("click", () => {
  if (confirm("Stop this campaign? Progress so far will be kept in the results list.")) {
    chrome.runtime.sendMessage({ action: "stopCampaign" });
  }
});
$("newCampaignBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "resetCampaign" }, () => {
    location.reload();
  });
});

// Listen for progress updates pushed from background.js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "campaignSafetyPause" && state.campaign) {
    state.campaign.status = "paused";
    state.campaign.pauseReason = msg.reason || "Campaign paused by safety controls.";
    updateSendControls(state.campaign);
    return;
  }
  if (msg.action === "campaignProgress" && state.campaign) {
    const item = state.campaign.queue.find(q => q.id === msg.item.id);
    if (item) {
      item.status = msg.item.status;
      item.error = msg.item.error;
      item.warning = msg.item.warning;
    }
    const pill = $(`status-${msg.item.id}`);
    if (pill) {
      applyStatusToPill(pill, msg.item);
    }
    const errorCell = $(`error-${msg.item.id}`);
    if (errorCell) errorCell.textContent = msg.item.error || "";
    updateProgressUI(state.campaign.queue);

    const allDone = state.campaign.queue.every(q => q.status === "sent" || q.status === "failed");
    if (allDone) {
      state.campaign.status = "completed";
      updateSendControls(state.campaign);
    }
  }
});

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[m]));
}

// --------------------- Init: rehydrate an in-progress campaign ---------------------
(function init() {
  refreshWaStatus();
  setInterval(refreshWaStatus, 3000);

  chrome.storage.local.get(UNSUBSCRIBERS_STORAGE_KEY).then(data => {
    const saved = Array.isArray(data[UNSUBSCRIBERS_STORAGE_KEY]) ? data[UNSUBSCRIBERS_STORAGE_KEY] : [];
    if (saved.length) {
      state.unsubscriberNumbers = saved.join("\n");
      const input = $("unsubscriberNumbers");
      if (input) input.value = state.unsubscriberNumbers;
    }
  }).catch(() => {});

  chrome.runtime.sendMessage({ action: "getCampaignState" }, (resp) => {
    if (resp && resp.campaign && resp.campaign.status !== "idle") {
      state.campaign = resp.campaign;
      goToStep("sending");
      renderResultsTable(resp.campaign.queue);
      updateSendControls(resp.campaign);
    }
  });
})();
