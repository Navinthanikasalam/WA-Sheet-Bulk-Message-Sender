// ===================== WA Sheet — content.js =====================
// Runs inside web.whatsapp.com. Responds to a "ping" to report readiness,
// and on page load checks chrome.storage.local for a pending send job
// (set by background.js right before it navigates this tab to a
// https://web.whatsapp.com/send?phone=...&text=... deep link).

const PENDING_KEY = "wa_sheet_pending_job";
const SELECTOR_TIMEOUT_MS = 25000;

// ---------- generic wait-for-element helper ----------
function waitForSelector(selector, timeout = SELECTOR_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timed out waiting for ${selector}`));
    }, timeout);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- poll-until helper (for conditions CSS selectors can't express) ----------
function waitForCondition(fn, timeout = 8000, interval = 200) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let result;
      try { result = fn(); } catch { result = null; }
      if (result) return resolve(result);
      if (Date.now() - start > timeout) return reject(new Error("Timed out waiting for condition"));
      setTimeout(tick, interval);
    };
    tick();
  });
}

// ---------- find a visible clickable element by its accessible label/text ----------
// Falls back for whenever WhatsApp's classes/data-icons change but the
// on-screen wording ("Attach", "Photos & videos", "Document"...) doesn't.
function findVisibleByLabel(patterns) {
  const nodes = document.querySelectorAll('button, div[role="button"], span[role="button"], li, a');
  for (const el of nodes) {
    if (!(el.offsetParent || el.getClientRects().length)) continue; // must be visible
    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.textContent ||
      ""
    ).trim();
    if (!label) continue;
    if (patterns.some(re => re.test(label))) return el;
  }
  return null;
}

// WhatsApp Web's DOM structure/classes change often. These selectors target
// stable aria-label / data-testid hooks where possible, WITH generous
// fallback lists — update here first if WhatsApp ships a redesign and
// sends stop being detected. sendMediaMessage() below also falls back to
// text-based element matching (findVisibleByLabel) when CSS selectors miss,
// since that survives most markup/class churn.
const SEL = {
  sendButton: 'button[aria-label="Send"], span[data-icon="send"], span[data-icon="wds-ic-send-filled"]',
  composeBox: [
    '#main footer div[contenteditable="true"]',
    '#main footer [contenteditable="true"]',
    '#main footer textarea',
    '#main footer [role="textbox"]',
    '#main [data-testid="conversation-compose-box-input"]',
    '#main div[contenteditable="true"][aria-placeholder*="Type a message" i]',
    '#main div[contenteditable="true"][aria-label*="Type a message" i]',
    '#main div[contenteditable="true"][data-tab="10"]'
  ].join(', '),
  attachButton: [
    'div[title="Attach"]',
    'button[aria-label="Attach"]',
    'div[aria-label="Attach"]',
    'span[data-icon="clip"]',
    'span[data-icon="plus"]',
    'span[data-icon="plus-rounded"]',
    'button[title="Attach"]'
  ].join(', '),
  // Any hidden <input type=file>; we further filter by accept-type in JS
  // rather than baking the accept string into the selector, since WhatsApp
  // has changed the exact accept list (and its order) more than once.
  fileInputs: 'input[type="file"]',
  invalidNumberDialog: 'div[data-animate-modal-popup="true"]',
  captionBox: 'div[contenteditable="true"][data-tab="10"], div[contenteditable="true"][aria-label="Add a caption"], div[contenteditable="true"][aria-label="Add a caption…"]',
  chatHeader: 'header div[data-testid="conversation-header"], header'
};

// ---------- readiness ping ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "ping") {
    // "ready" once WhatsApp's own app shell (the side pane) has rendered
    const appReady = !!document.querySelector('#app, #pane-side, div[data-testid="chat-list"]');
    sendResponse({ ready: appReady });
    return true;
  }
  if (msg.action === "getGroupMembers") {
    getVisibleGroupMembers(msg.groupName).then(sendResponse);
    return true;
  }
  if (msg.action === "getGroupChats") {
    getVisibleGroupChats().then(sendResponse);
    return true;
  }
  if (msg.action === "sendMessage") {
    handleSendRequest(msg).then(sendResponse);
    return true; // async
  }
  if (msg.action === "sendGroupMessage") {
    handleGroupSendRequest(msg).then(sendResponse);
    return true; // async
  }
});

async function getVisibleGroupChats() {
  const groups = [];
  const seen = new Set();

  // WhatsApp provides an explicit Groups filter above the chat list. Using it
  // is much more reliable than guessing whether each row is a group from
  // icons/classes (which regularly change and may not expose a @g.us id).
  const groupsFilter = findChatFilter(/^groups?$/i);
  if (!groupsFilter) {
    return {
      ok: false,
      error: "The WhatsApp Groups filter was not found. Make sure the left Chats panel is open, then refresh WhatsApp Web and try again."
    };
  }
  groupsFilter.click();
  await sleep(900);

  const scanRows = () => {
    const rows = getChatListRows();
    rows.forEach(row => {
      const name = getChatRowName(row);
      if (!name || /^(archived|communities?|status|channels?)$/i.test(name)) return;
      const idNode = row.matches('[data-id]') ? row : row.querySelector('[data-id]');
      const idSource = idNode?.getAttribute("data-id") || "";
      const idMatch = idSource.match(/([\w.-]+@g\.us)/i);
      const id = idMatch ? idMatch[1] : "";
      const key = id || name.toLocaleLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        groups.push({ name, id });
      }
    });
  };

  scanRows();

  // WhatsApp virtualizes long lists: only mounted rows exist in the DOM.
  // Scroll every genuinely scrollable element in/under #pane-side and scan
  // after every viewport so old/off-screen groups are mounted and collected.
  const pane = document.querySelector('#pane-side, [data-testid="chat-list"]');
  const scrollContainers = pane ? [pane, ...pane.querySelectorAll('*')].filter(el => {
    if (!isVisibleElement(el)) return false;
    const style = getComputedStyle(el);
    return el.scrollHeight > el.clientHeight + 20 &&
      (/(auto|scroll)/.test(style.overflowY) || el === pane);
  }) : [];

  // Prefer the container with the largest scrollable range; nested wrappers
  // often report tiny ranges that are unrelated to the chat list.
  scrollContainers.sort((a, b) =>
    (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
  );
  const scroller = scrollContainers[0] || pane;
  if (scroller) {
    const originalTop = scroller.scrollTop;
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(300);
    scanRows();

    let previousTop = -1;
    let safety = 0;
    while (safety++ < 250) {
      const step = Math.max(scroller.clientHeight * 0.8, 240);
      const nextTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight - scroller.clientHeight);
      if (nextTop <= scroller.scrollTop || scroller.scrollTop === previousTop) break;
      previousTop = scroller.scrollTop;
      scroller.scrollTop = nextTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(260);
      scanRows();
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        await sleep(350);
        scanRows();
        break;
      }
    }
    scroller.scrollTop = originalTop;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  }

  // Return WhatsApp to its normal All view. Group sending later uses Search,
  // which is most dependable when no filter remains active.
  const allFilter = findChatFilter(/^all$/i);
  if (allFilter) {
    allFilter.click();
    await sleep(350);
  }

  return { ok: true, groups };
}

function findChatFilter(textPattern) {
  const side = document.querySelector('#side') || document.body;
  const candidates = Array.from(side.querySelectorAll(
    'button, [role="button"], [role="tab"], [aria-pressed]'
  )).filter(isVisibleElement);
  return candidates.find(el => {
    const text = (el.textContent || el.getAttribute("aria-label") || "").trim();
    return textPattern.test(text);
  }) || null;
}

function getChatListRows() {
  const roots = Array.from(document.querySelectorAll('#pane-side, [data-testid="chat-list"]'));
  const candidates = roots.flatMap(root => Array.from(root.querySelectorAll(
    '[role="listitem"], [role="row"], [role="gridcell"], [data-testid="cell-frame-container"]'
  )));
  return [...new Set(candidates.map(node =>
    node.closest('[role="listitem"], [role="row"], [data-testid="cell-frame-container"]') || node
  ))].filter(row => isVisibleElement(row) && getChatRowName(row));
}

function getChatRowName(row) {
  // A title attribute normally contains the complete chat name (including
  // emoji). Reading the first nested dir=auto node can return only the first
  // text fragment, e.g. "Fam" instead of "Fam💜🌊✨".
  const titled = [...row.querySelectorAll(
    '[data-testid="cell-frame-title"] [title], [data-testid="cell-frame-title"][title], span[title][dir="auto"], [title][dir="auto"]'
  )]
    .map(node => (node.getAttribute("title") || "").trim())
    .filter(value => value && !/^ic[-_]/i.test(value) && !/^(photo|video|document|sticker)$/i.test(value));
  if (titled.length) return titled[0];

  const preferred = [...row.querySelectorAll('[data-testid="cell-frame-title"] [dir="auto"], [dir="auto"]')]
    .map(node => (node.textContent || "").trim())
    .filter(value => value && !/^ic[-_]/i.test(value));
  if (preferred.length) return preferred[0];
  const candidates = [...row.querySelectorAll('[title], [aria-label]')]
    .map(node => node.getAttribute("title") || node.getAttribute("aria-label") || node.textContent || "")
    .map(value => value.trim())
    .filter(value => value && !/^ic[-_]/i.test(value) && !/^(close|group info|more|menu|search|back|forward|profile details)$/i.test(value));
  return candidates[0] || "";
}

async function getVisibleGroupMembers(groupName = "") {
  let panel = findParticipantPanel();
  if (!panel && groupName) {
    const opened = await openSelectedGroupInfo(groupName);
    if (opened) panel = await waitForCondition(findParticipantPanel, 10000).catch(() => null);
  }
  if (!panel) return { ok: false, error: "Open the group info panel first so its participant list is visible." };

  const members = new Map();
  panel.querySelectorAll('a[href*="phone="], a[href*="wa.me"], [data-id]').forEach(el => {
    const value = el.getAttribute("href") || el.getAttribute("data-id") || "";
    const phone = extractContactPhone(value);
    if (phone) {
      const row = el.closest('[role="listitem"], [data-testid*="cell-frame"], [data-id]') || el.parentElement;
      const name = getParticipantName(row, phone);
      members.set(phone, { phone, name });
    }
  });

  if (!members.size) {
    const text = panel.textContent || "";
    (text.match(/(?:\+?\d[\d\s().-]{6,18}\d)/g) || []).forEach(value => {
      const digits = value.replace(/\D/g, "");
      if (digits.length >= 7 && digits.length <= 15) members.set(digits, { phone: digits, name: "" });
    });
  }

  const detectedGroupName = panel.querySelector('header, [role="heading"]')?.textContent?.trim() || groupName;
  return { ok: true, groupName: detectedGroupName, members: [...members.values()] };
}

function findParticipantPanel() {
  const containers = Array.from(document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], [data-testid*="drawer"], aside, section'
  )).filter(isVisibleElement);
  const labeled = containers.filter(container => /participants|group info/i.test(container.textContent || ""));
  const withMembers = containers.filter(container =>
    container.querySelector('a[href*="phone="], a[href*="wa.me"], [data-id*="@c.us"], [data-id*="@g.us"]')
  );
  if (labeled.length) return labeled.sort((a, b) => a.textContent.length - b.textContent.length)[0];
  if (withMembers.length) return withMembers.sort((a, b) => a.textContent.length - b.textContent.length)[0];

  const memberId = Array.from(document.querySelectorAll('[data-id*="@c.us"], [data-id*="@g.us"], a[href*="phone="], a[href*="wa.me"]'))
    .find(isVisibleElement);
  return memberId?.closest('[role="region"], [role="dialog"], aside, section') || null;
}

function getParticipantName(row, phone) {
  if (!row) return "";
  const values = [...row.querySelectorAll('[dir="auto"], span, div')]
    .map(node => (node.textContent || "").trim())
    .filter(value => value && value !== phone && !/^\+?[\d\s().-]+$/.test(value))
    .filter(value => !/^(admin|you|message|add participant|search)$/i.test(value));
  return values.sort((a, b) => a.length - b.length)[0] || "";
}

function extractContactPhone(value) {
  const source = String(value || "");
  if (/@g\.us/i.test(source)) return "";
  const explicit = source.match(/(?:phone=|wa\.me\/)(\+?\d{7,15})/i);
  if (explicit) return explicit[1].replace(/\D/g, "");
  const jid = source.match(/(?:^|[_:/])([1-9]\d{6,14})@c\.us/i);
  if (jid) return jid[1];
  const digits = source.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : "";
}

async function openSelectedGroupInfo(groupName) {
  const rows = Array.from(document.querySelectorAll(
    '#pane-side [role="listitem"], #pane-side [role="gridcell"], [data-testid="cell-frame-container"], [data-testid="chat-list"] [role="listitem"]'
  )).filter(isVisibleElement);
  const row = rows.find(candidate => {
    const label = getChatRowName(candidate);
    return label === groupName || label.includes(groupName);
  });
  if (!row) return false;
  row.click();
  await sleep(800);

  const header = await waitForCondition(() => {
    const exact = Array.from(document.querySelectorAll(
      'header [data-testid="conversation-header"], [data-testid="conversation-header"], header'
    )).filter(isVisibleElement).find(candidate => (candidate.textContent || "").includes(groupName));
    return exact || Array.from(document.querySelectorAll(
      'header [data-testid="conversation-header"], [data-testid="conversation-header"]'
    )).filter(isVisibleElement).at(-1) || null;
  }, 8000).catch(() => null);
  if (!header) return false;
  const headerButton = header.querySelector('button, [role="button"], [tabindex="0"]') || header;
  headerButton.click();
  const panelOpened = await waitForCondition(() => Array.from(document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], [data-testid="contact-info-drawer"], [data-testid*="drawer"]'
  )).some(isVisibleElement), 8000).catch(() => false);
  return !!panelOpened;
}

async function handleSendRequest({ phone, message, media }) {
  try {
    await openChatByPhone(phone);
    if (media) {
      const result = await sendMediaMessage(media, message);
      if (message && result && result.captionAttached === false) {
        return { success: true, warning: result.warning || "Media sent, but the caption text could not be attached." };
      }
      return { success: true };
    } else {
      await sendTextMessage(message);
      return { success: true };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}


async function handleGroupSendRequest({ groupName, groupId, message, media }) {
  try {
    await openGroupChat(groupName, groupId);
    if (media) {
      const result = await sendMediaMessage(media, message);
      if (message && result && result.captionAttached === false) {
        return { success: true, warning: result.warning || "Media sent, but the caption text could not be attached." };
      }
      return { success: true };
    }
    await sendTextMessage(message);
    return { success: true };
  } catch (err) {
    return { success: false, error: `Group ${groupName}: ${err.message}` };
  }
}

function chatRows() {
  return getChatListRows();
}

function rowMatchesGroup(row, groupName, groupId) {
  const dataId = row.getAttribute("data-id") || row.querySelector("[data-id]")?.getAttribute("data-id") || "";
  if (groupId && dataId.includes(groupId)) return true;
  const label = getChatRowName(row);
  return label === groupName;
}

function findChatSearchBox() {
  const candidates = Array.from(document.querySelectorAll(
    '#side input, #side [contenteditable="true"], input[aria-label*="Search" i], [contenteditable="true"][aria-label*="Search" i]'
  )).filter(isVisibleElement);
  return candidates.find(el => {
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`;
    return /search/i.test(label) && !el.closest("footer");
  }) || null;
}

function setSearchText(box, text) {
  box.focus();
  if (box.tagName === "INPUT" || box.tagName === "TEXTAREA") {
    const proto = box.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(box, text); else box.value = text;
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  } else {
    replaceEditableText(box, text);
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
}

async function openGroupChat(groupName, groupId = "") {
  if (!groupName) throw new Error("No group name was provided.");

  // If this group is already open, do not disturb WhatsApp's UI.
  if (currentChatMatches(groupName) && findVisibleComposeBox()) return;

  const search = findChatSearchBox();
  if (search) {
    setSearchText(search, groupName);
    await sleep(1200);
  }

  let row = chatRows().find(candidate => rowMatchesGroup(candidate, groupName, groupId));
  if (!row) {
    const containers = Array.from(document.querySelectorAll('#pane-side, [data-testid="chat-list"]'));
    for (const container of containers) {
      for (let top = 0; top <= container.scrollHeight && !row; top += Math.max(container.clientHeight, 250)) {
        container.scrollTop = top;
        container.dispatchEvent(new Event("scroll", { bubbles: true }));
        await sleep(180);
        row = chatRows().find(candidate => rowMatchesGroup(candidate, groupName, groupId));
      }
      if (row) break;
    }
  }
  if (!row) throw new Error("Could not find this group in WhatsApp Search. Refresh the group list and try again.");

  // WhatsApp often attaches its React click handler to an inner focusable
  // cell rather than the outer role=row/listitem wrapper. A plain row.click()
  // therefore looks successful to JavaScript but opens nothing. Activate the
  // best inner target and send real pointer/mouse events as a fallback.
  activateChatRow(row);

  let opened = await waitForCondition(() =>
    currentChatMatches(groupName) && findVisibleComposeBox(), 15000
  ).catch(() => null);

  // Some builds select the first exact Search result only when Enter is
  // pressed. Retry that path before reporting failure.
  if (!opened && search) {
    search.focus();
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    search.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    opened = await waitForCondition(() =>
      currentChatMatches(groupName) && findVisibleComposeBox(), 10000
    ).catch(() => null);
  }

  if (!opened) {
    const title = getCurrentChatTitle();
    if (currentChatMatches(groupName) && !findVisibleComposeBox()) {
      throw new Error("The group opened, but WhatsApp's message box was not available. Check that you are still a participant and allowed to send messages.");
    }
    throw new Error(`The group chat did not open${title ? ` (WhatsApp stayed on “${title}”)` : ""}.`);
  }
}

function activateChatRow(row) {
  row.scrollIntoView({ block: "center", inline: "nearest" });
  const target = row.querySelector(
    '[data-testid="cell-frame-container"], [role="button"][tabindex], [tabindex="0"], [tabindex="-1"]'
  ) || row;
  const rect = target.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.left + Math.max(1, rect.width / 2),
    clientY: rect.top + Math.max(1, rect.height / 2),
    button: 0,
    buttons: 1
  };
  try { target.dispatchEvent(new PointerEvent("pointerdown", init)); } catch {}
  target.dispatchEvent(new MouseEvent("mousedown", init));
  try { target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 })); } catch {}
  target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
  target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
  try { target.click(); } catch {}
}

function getCurrentChatTitleCandidates() {
  const main = document.querySelector('#main') || document;
  const headers = Array.from(main.querySelectorAll(
    'header, [data-testid="conversation-header"], [role="banner"]'
  )).filter(isVisibleElement);
  const values = [];
  for (const header of headers) {
    const preferred = header.querySelectorAll(
      '[data-testid="conversation-info-header-chat-title"], ' +
      '[data-testid="conversation-header"] [dir="auto"], ' +
      '[data-testid*="chat-title"]'
    );
    for (const el of preferred) {
      values.push(el.getAttribute("title") || el.textContent || "");
    }
    for (const el of header.querySelectorAll('[title], [dir="auto"]')) {
      values.push(el.getAttribute("title") || el.textContent || "");
    }
    values.push(header.textContent || "");
  }
  const ignored = /^(profile details|search|menu|more|voice call|video call|click here for contact info)$/i;
  return [...new Set(values.map(value => String(value).replace(/\s+/g, " ").trim()))]
    .filter(value => value && !ignored.test(value));
}

function getCurrentChatTitle() {
  return getCurrentChatTitleCandidates()[0] || "";
}

function normalizeChatName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function currentChatMatches(groupName) {
  const expected = normalizeChatName(groupName);
  if (!expected) return false;
  return getCurrentChatTitleCandidates().some(candidate => {
    const actual = normalizeChatName(candidate);
    return actual === expected || actual.includes(expected) || expected.includes(actual);
  });
}

function findVisibleComposeBox() {
  return Array.from(document.querySelectorAll(SEL.composeBox)).find(isVisibleElement) || null;
}

// ---------- open a chat without a full page reload ----------
async function openChatByPhone(phone) {
  // background.js navigates the tab to WhatsApp's supported click-to-chat URL
  // before sending. Waiting here is intentionally passive: clicking a hidden
  // wa.me link from the page is blocked or ignored in several WhatsApp builds.
  await waitForSelector(SEL.composeBox, SELECTOR_TIMEOUT_MS);
}

// ---------- send plain text ----------
async function sendTextMessage(message) {
  if (!message) return; // media-only message with no caption is fine
  const box = await waitForSelector(SEL.composeBox);
  box.focus();
  insertTextIntoContentEditable(box, message);
  await sleep(300);
  const sendBtn = await waitForCondition(() => findVisibleSendButton(document), 8000);
  sendBtn.click();
  await sleep(500);
}

// ---------- send media (+ optional caption) ----------
// Two failure modes we've seen in practice:
//  1) The attach click silently grabs the WRONG <input type="file"> (WhatsApp
//     can have other hidden file inputs on the page unrelated to the chat,
//     e.g. profile-photo upload) — nothing visibly happens, no error is
//     thrown, and the item gets marked "sent" even though it wasn't.
//  2) The "caption box" selector coincidentally matches the MAIN chat
//     compose box instead of the media-preview's caption field, so the
//     caption text ends up typed into the regular chat as an un-sent draft.
// The fix: never trust "some element matched a selector" as proof of
// success. Require (a) the file input we use to be a genuinely NEW node
// that appeared as a result of our own click sequence, (b) a real media
// preview panel to open before we do anything else, (c) caption + send
// button lookups to be scoped strictly inside that preview panel, and
// (d) the preview panel to actually CLOSE after we click Send before we
// report success.
async function sendMediaMessage(media, caption) {
  // WhatsApp compresses/rejects photos & videos sent through the regular
  // "Photos & videos" picker once they're over ~16MB. Sending as a Document
  // instead skips that compression entirely and allows up to ~2GB — so for
  // any file over that threshold we deliberately go through the Document
  // picker even if it's an image/video, regardless of what the old
  // mime-type-only check would have picked. The file still arrives, it just
  // won't get an inline chat preview.
  const WHATSAPP_INLINE_MEDIA_LIMIT = 16 * 1024 * 1024;
  const tooBigForInlineMedia = (media.size || 0) > WHATSAPP_INLINE_MEDIA_LIMIT;
  const isDoc = tooBigForInlineMedia || !/^image\/|^video\//.test(media.type || "");
  const input = await findFileInput(isDoc);
  if (!input) {
    throw new Error(
      isDoc
        ? "STAGE:attach — Could not open the Document picker (WhatsApp Web's attach menu may have changed)."
        : "STAGE:attach — Could not open the Photos & videos picker (WhatsApp Web's attach menu may have changed)."
    );
  }

  const dialogsBefore = new Set(document.querySelectorAll('div[role="dialog"]'));
  const blobMediaBefore = new Set(document.querySelectorAll('img[src^="blob:"], video[src^="blob:"]'));
  const editorsBefore = new Set(document.querySelectorAll('div[contenteditable="true"], textarea, [role="textbox"]'));

  const resolvedDataUrl = await resolveMediaDataUrl(media);
  const file = await dataUrlToFile(resolvedDataUrl, media.name, media.type);
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("input", { bubbles: true }));

  // Require proof a real preview actually opened before doing anything else.
  let previewEl;
  try {
    previewEl = await waitForCondition(
      () => findNewPreviewContainer(dialogsBefore, blobMediaBefore),
      10000
    );
  } catch {
    throw new Error(
      "STAGE:preview — File was selected but no media preview appeared. " +
      "The attach most likely targeted the wrong element on the page — nothing was sent."
    );
  }

  dismissLanguageDialog();

  let captionAttached = !caption; // no caption requested = nothing to attach
  if (caption) {
    try {
      const capBox = await waitForCondition(
        () => findCaptionBox(previewEl, editorsBefore),
        12000
      );
      capBox.focus();
      replaceEditableText(capBox, caption);
      await sleep(1200);
      captionAttached = editableContainsText(capBox, caption);
    } catch {
      captionAttached = false;
    }
  }

  const sendBtn = await waitForCondition(
    () => {
      dismissLanguageDialog();
      return findVisibleSendButton(previewEl) || findMediaSendButton();
    },
    6000
  ).catch(() => null);
  if (!sendBtn) {
    throw new Error("STAGE:send — Media preview opened but no Send button was found inside it. Nothing was sent.");
  }
  sendBtn.click();

  // Confirm that the media Send control disappears after the click. The
  // normal text composer may remain mounted while a media preview is open,
  // so its presence alone is not evidence that the attachment was sent.
  //
  // The wait itself has to scale with file size. A big video keeps the
  // preview open — showing an upload progress ring — for as long as the
  // actual upload takes, which for a 100–200MB file over a normal
  // connection can be well over a minute. A fixed short timeout here was
  // giving up and reporting "Failed" while WhatsApp was still genuinely
  // mid-upload (and would go on to send fine seconds later) — that's not a
  // real failure, just impatience on our part.
  try {
    await waitForCondition(() => {
      return !findVisibleSendButton(previewEl) && !findMediaSendButton();
    }, confirmTimeoutForSize(media.size));
  } catch {
    throw new Error("STAGE:confirm — Clicked Send but couldn't confirm the media preview closed. Check WhatsApp directly — it may have actually sent (large files can take a while to upload); if not, retry.");
  }
  await sleep(300);

  if (caption && !captionAttached) {
    throw new Error("STAGE:caption — WhatsApp did not accept the complete message in the media caption field. Nothing was sent.");
  }
  return { captionAttached: true };
}

// Roughly budgets upload time by file size so we don't give up on a large
// video while it's still genuinely uploading. Assumes a conservative upload
// speed floor (~300KB/s) and adds headroom, with sane min/max bounds.
function confirmTimeoutForSize(sizeBytes) {
  const MIN_TIMEOUT = 9000;      // small files / no media: keep the old snappy behavior
  const MAX_TIMEOUT = 6 * 60 * 1000; // 6 minutes ceiling, even for very large files
  const BYTES_PER_MS_FLOOR = 300 * 1024 / 1000; // ~300KB/s worst case
  if (!sizeBytes) return MIN_TIMEOUT;
  const estimated = (sizeBytes / BYTES_PER_MS_FLOOR) + 15000; // + fixed buffer for UI settling
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, estimated));
}

// Finds the panel that opened as a direct result of our attach action, so
// caption/send lookups can be scoped to it instead of the whole page.
function findNewPreviewContainer(dialogsBefore, blobMediaBefore) {
  // Look for a genuinely NEW blob media element — important for chats that
  // already contain sent images/videos (e.g. a self-chat used for repeated
  // testing), where "any blob media on the page" would already be true
  // before we even attach anything.
  const newBlobMedia = Array.from(document.querySelectorAll('img[src^="blob:"], video[src^="blob:"]'))
    .find(el => !blobMediaBefore.has(el));
  if (newBlobMedia) {
    // Climb a few ancestors to reach a container that likely also holds
    // the caption box and send button, not just the bare <img>/<video>.
    let el = newBlobMedia;
    for (let i = 0; i < 6 && el.parentElement; i++) el = el.parentElement;
    return el;
  }

  const newDialog = Array.from(document.querySelectorAll('div[role="dialog"]')).find(d =>
    !dialogsBefore.has(d) && !isLanguageDialog(d)
  );
  if (newDialog) return newDialog;

  // Some WhatsApp builds reuse the same preview dialog and render the
  // selected video without a new blob element. A visible Send control outside
  // the normal text footer is still reliable evidence that the media preview
  // opened, and gives us a container for the caption lookup.
  const mediaSend = findMediaSendButton();
  if (mediaSend) {
    let el = mediaSend;
    for (let i = 0; i < 6 && el.parentElement; i++) el = el.parentElement;
    return el;
  }
  return null;
}

function findVisibleSendButton(root) {
  const candidates = Array.from(root.querySelectorAll(
    'button[aria-label="Send"], [role="button"][aria-label="Send"], ' +
    'span[data-icon="send"], span[data-icon="wds-ic-send-filled"]'
  ));
  for (const candidate of candidates) {
    if (!(candidate.offsetParent || candidate.getClientRects().length)) continue;
    const clickable = candidate.closest('button, [role="button"]') || candidate;
    if (clickable.disabled || clickable.getAttribute("aria-disabled") === "true") continue;
    return clickable;
  }
  return null;
}

function findMediaSendButton() {
  const candidates = Array.from(document.querySelectorAll(
    'button[aria-label="Send"], [role="button"][aria-label="Send"], ' +
    'span[data-icon="send"], span[data-icon="wds-ic-send-filled"]'
  ));
  for (const candidate of candidates) {
    if (!isVisibleElement(candidate)) continue;
    const clickable = candidate.closest('button, [role="button"]') || candidate;
    if (isNormalComposeBox(clickable) || clickable.closest("footer") && !hasMediaPreview(clickable)) continue;
    return clickable;
  }
  return null;
}

function hasMediaPreview(el) {
  let parent = el;
  for (let i = 0; i < 8 && parent; i++, parent = parent.parentElement) {
    if (parent.querySelector('img[src^="blob:"], video[src^="blob:"], [data-testid*="media"]')) return true;
  }
  return false;
}

function findCaptionBox(previewEl, editorsBefore = new Set()) {
  const scopedCandidates = [
    ...previewEl.querySelectorAll(SEL.captionBox),
    ...previewEl.querySelectorAll('div[contenteditable="true"], textarea, [role="textbox"]')
  ];
  const candidates = [...new Set(scopedCandidates)];
  const newEditors = Array.from(document.querySelectorAll('div[contenteditable="true"], textarea, [role="textbox"]'))
    .filter(el => !editorsBefore.has(el));
  const mediaRelated = [...candidates, ...newEditors].find(el => {
    if (!isVisibleElement(el)) return false;
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`;
    const captionLike = hasMediaPreview(el) || /caption|add a caption/i.test(label);
    if (newEditors.includes(el) && captionLike) return true;
    return !isNormalComposeBox(el) && captionLike;
  });
  if (mediaRelated) return mediaRelated;
  return candidates.find(el => {
    const visible = isVisibleElement(el);
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`;
    return visible && !isNormalComposeBox(el) && /caption|add a caption/i.test(label);
  }) || null;
}

function isVisibleElement(el) {
  return !!(el && (el.offsetParent || el.getClientRects().length));
}

function isNormalComposeBox(el) {
  const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`;
  return el.matches('footer [contenteditable="true"][data-tab]:not([data-tab="10"])') ||
    el.closest('[data-testid="conversation-compose-box-input"]') ||
    /type a message/i.test(label) ||
    (el.closest("footer") && !/caption|add a caption/i.test(label) && !el.matches('[data-tab="10"]'));
}

function isLanguageDialog(el) {
  return /language change required|rtl \(right-to-left\)/i.test(el.textContent || "");
}

function dismissLanguageDialog() {
  const dialog = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]'))
    .find(el => {
      const visible = el.offsetParent || el.getClientRects().length;
      return visible && isLanguageDialog(el);
    });
  if (!dialog) return;
  const button = Array.from(dialog.querySelectorAll('button, [role="button"]'))
    .find(el => /^(got it|okay|ok|close)$/i.test((el.textContent || el.getAttribute("aria-label") || "").trim()));
  if (button) button.click();
}

function editableContainsText(el, text) {
  return normalizeEditableText(el.value || el.textContent || el.innerText || "")
    .includes(normalizeEditableText(text));
}

function normalizeEditableText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function clearEditable(el) {
  if ("value" in el && el.tagName !== "DIV") {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(el, "");
    else el.value = "";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    return;
  }
  el.focus();
  document.execCommand("selectAll", false);
  document.execCommand("delete", false);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
}

function insertTextIntoEditable(el, text) {
  if ("value" in el && el.tagName !== "DIV") {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  el.focus();
  document.execCommand("selectAll", false);
  document.execCommand("insertText", false, text);
}

function replaceEditableText(el, text) {
  el.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand("delete", false);
  document.execCommand("insertText", false, text);
}

// Try, in order: (1) click Attach, (2) click the matching menu item
// ("Photos & videos" / "Document"), (3) use whichever <input type="file">
// is genuinely NEW as a result of that — never an input that already
// existed on the page before we touched anything, since WhatsApp Web can
// have unrelated hidden file inputs (e.g. profile photo upload) that would
// otherwise get grabbed by mistake and silently no-op.
async function findFileInput(isDoc) {
  const before = new Set(document.querySelectorAll(SEL.fileInputs));

  const attachBtn = await waitForSelector(SEL.attachButton, 15000).catch(() => null)
    || findVisibleByLabel([/^attach$/i]);
  if (!attachBtn) return null;
  attachBtn.click();
  await sleep(500);

  const menuPatterns = isDoc
    ? [/document/i]
    : [/^photos?\s*(?:&|and)\s*videos?$/i, /^gallery$/i, /^photos?$/i, /^videos?$/i];

  let menuItem = null;
  try {
    menuItem = await waitForCondition(() => findVisibleByLabel(menuPatterns), 4000);
  } catch {
    menuItem = null;
  }
  if (menuItem) {
    menuItem.click();
    await sleep(500);
  }

  const isCompatibleInput = (input) => {
    const accept = (input.getAttribute("accept") || "").toLowerCase();
    if (isDoc) return /pdf|document|msword|officedocument/.test(accept);
    // Never accept a generic or sticker/profile input for regular media.
    return /image\//.test(accept) || /video\//.test(accept) || accept === "image/*" || accept === "video/*";
  };
  const inputs = () => Array.from(document.querySelectorAll(SEL.fileInputs));
  const pickNewMatching = () => inputs().find(input => !before.has(input) && isCompatibleInput(input)) || null;
  const pickMatching = () => inputs().find(isCompatibleInput) || null;
  try {
    return await waitForCondition(() => pickNewMatching() || pickMatching(), 6000);
  } catch {
    return null;
  }
}

function insertTextIntoContentEditable(el, text) {
  // WhatsApp's compose box is a contenteditable React component; the most
  // reliable way to get it to register text is to dispatch input events
  // line by line (execCommand still works in Chrome for this purpose).
  el.focus();
  document.execCommand("insertText", false, text);
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

async function dataUrlToFile(dataUrl, filename, mimeType) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: mimeType || blob.type });
}

// The actual media bytes are never sent through chrome.runtime/chrome.tabs
// messaging (that has a hard 64MiB per-message cap in Chrome, which a video
// blows past instantly once base64-encoded). popup.js instead writes the
// bytes once into chrome.storage.local, split into small chunks, and only
// ever passes a {name, type, size, mediaKey, totalChunks} reference through
// messages. This reads the chunks back out here, one at a time (not in one
// big batched call — that would just reintroduce the same large-payload
// risk on the read side), and reassembles them right before attaching.
async function resolveMediaDataUrl(media) {
  if (media.dataUrl) return media.dataUrl; // legacy/unchunked shape, just in case
  if (!media.mediaKey) {
    throw new Error("STAGE:attach — No media data was provided (missing storage key).");
  }
  const totalChunks = media.totalChunks || 1;
  let dataUrl = "";
  for (let i = 0; i < totalChunks; i++) {
    const key = `${media.mediaKey}_chunk_${i}`;
    const stored = await chrome.storage.local.get(key);
    const chunk = stored[key];
    if (typeof chunk !== "string") {
      throw new Error(`STAGE:attach — Media data was incomplete in storage (missing part ${i + 1}/${totalChunks}, it may have been cleared before sending).`);
    }
    dataUrl += chunk;
  }
  return dataUrl;
}
