// ===================== WA Sheet — background.js (MV3 service worker) =====================

const WA_URL_BASE = "https://web.whatsapp.com";
const STORAGE_KEY = "wa_sheet_campaign";
const KEEPALIVE_ALARM = "wa_sheet_keepalive";
const SEND_HISTORY_KEY = "wa_sheet_send_history";

let campaign = null;          // in-memory copy of the active campaign
let sending = false;          // guard against overlapping loops

// ---------- persistence ----------
async function saveCampaign() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: campaign });
  } catch (err) {
    // Most likely cause: storage quota exceeded (e.g. a large media file
    // duplicated across many queue rows). Don't let this silently kill the
    // send loop — log it so it shows up if someone inspects the service
    // worker console, and keep going; the in-memory `campaign` object is
    // still authoritative for the rest of this run.
    console.error("WA Sheet: failed to persist campaign state:", err);
  }
}
async function loadCampaign() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  campaign = data[STORAGE_KEY] || null;
  return campaign;
}

// ---------- keepalive so the service worker doesn't sleep mid-campaign ----------
function ensureKeepAlive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
}
function clearKeepAlive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // no-op tick — just keeps the service worker alive during a campaign
  }
});

// ---------- WhatsApp Web tab helpers ----------
async function findWaTab() {
  const tabs = await chrome.tabs.query({ url: `${WA_URL_BASE}/*` });
  return tabs[0] || null;
}

async function ensureWaTab() {
  let tab = await findWaTab();
  if (!tab) {
    tab = await chrome.tabs.create({ url: WA_URL_BASE, active: false });
    await waitForTabComplete(tab.id);
    await sleep(4000); // give WhatsApp Web's SPA time to boot
  }
  return tab;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function navigateToChat(tabId, phone) {
  const complete = waitForTabComplete(tabId);
  await chrome.tabs.update(tabId, {
    url: `${WA_URL_BASE}/send?phone=${encodeURIComponent(phone)}`
  });
  await complete;

  // The URL can finish loading before WhatsApp's SPA has mounted the compose
  // UI. Give the content script a bounded opportunity to become ready.
  for (let i = 0; i < 20; i++) {
    if (await pingContentScript(tabId)) return;
    await sleep(1000);
  }
  throw new Error("WhatsApp Web did not finish opening the recipient chat.");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pingContentScript(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { action: "ping" });
    return !!(resp && resp.ready);
  } catch {
    return false;
  }
}

// ---------- WA connection status (used by popup header) ----------
async function getWaStatus() {
  const tab = await findWaTab();
  if (!tab) return { tabOpen: false, connected: false };
  const connected = await pingContentScript(tab.id);
  return { tabOpen: true, connected };
}

async function getGroupMembers(groupName) {
  const tab = await findWaTab();
  if (!tab) return { ok: false, error: "Open WhatsApp Web and the group you want to import first." };
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "getGroupMembers", groupName: groupName || "" });
    return response || { ok: false, error: "WhatsApp Web did not respond. Refresh the WhatsApp tab and try again." };
  } catch {
    return { ok: false, error: "WhatsApp Web is not ready. Refresh the tab, open the group info panel, and try again." };
  }
}

async function getGroupChats() {
  const tab = await findWaTab();
  if (!tab) return { ok: false, error: "Open WhatsApp Web first so the group list can be loaded." };
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "getGroupChats" });
    return response || { ok: false, error: "WhatsApp Web did not respond. Refresh the tab and try again." };
  } catch {
    return { ok: false, error: "WhatsApp Web is not ready. Refresh the tab and try again." };
  }
}

// ---------- responsible sending safeguards ----------
async function getRecentSendHistory() {
  const data = await chrome.storage.local.get(SEND_HISTORY_KEY);
  const now = Date.now();
  const history = Array.isArray(data[SEND_HISTORY_KEY]) ? data[SEND_HISTORY_KEY] : [];
  const recent = history.filter(timestamp => Number(timestamp) > now - 24 * 60 * 60 * 1000);
  if (recent.length !== history.length) {
    await chrome.storage.local.set({ [SEND_HISTORY_KEY]: recent });
  }
  return recent;
}

async function recordSuccessfulSend() {
  const history = await getRecentSendHistory();
  history.push(Date.now());
  await chrome.storage.local.set({ [SEND_HISTORY_KEY]: history });
}

async function checkSafetyAllowance(activeCampaign) {
  if (!activeCampaign?.safetyEnabled) return { allowed: true };
  const history = await getRecentSendHistory();
  const now = Date.now();
  const hourCount = history.filter(timestamp => timestamp > now - 60 * 60 * 1000).length;
  const dayCount = history.length;
  const hourlyLimit = Math.max(1, Number(activeCampaign.safetyMaxPerHour) || 20);
  const dailyLimit = Math.max(hourlyLimit, Number(activeCampaign.safetyMaxPerDay) || 100);
  if (dayCount >= dailyLimit) {
    return {
      allowed: false,
      reason: `Safety pause: the extension reached its ${dailyLimit}-message rolling 24-hour limit. Resume after older sends leave the 24-hour window.`
    };
  }
  if (hourCount >= hourlyLimit) {
    const hourHistory = history.filter(timestamp => timestamp > now - 60 * 60 * 1000).sort((a, b) => a - b);
    const retryMinutes = Math.max(1, Math.ceil((hourHistory[0] + 60 * 60 * 1000 - now) / 60000));
    return {
      allowed: false,
      reason: `Safety pause: the extension reached its ${hourlyLimit}-message hourly limit. Wait about ${retryMinutes} minute(s), then Resume.`
    };
  }
  return { allowed: true };
}

async function safetyPause(reason) {
  if (!campaign) return;
  campaign.status = "paused";
  campaign.pauseReason = reason;
  await saveCampaign();
  chrome.runtime.sendMessage({ action: "campaignSafetyPause", reason }).catch(() => {});
}

// ---------- campaign engine ----------
async function startCampaign(newCampaign) {
  campaign = newCampaign;
  campaign.status = "running";
  await saveCampaign();
  ensureKeepAlive();
  runLoop();
}

async function pauseCampaign() {
  if (campaign) {
    campaign.status = "paused";
    await saveCampaign();
  }
}

async function resumeCampaign() {
  if (campaign) {
    campaign.status = "running";
    campaign.pauseReason = "";
    await saveCampaign();
    runLoop();
  }
}

async function stopCampaign() {
  if (campaign) {
    campaign.status = "stopped";
    await saveCampaign();
  }
  clearKeepAlive();
}

async function resetCampaign() {
  // Clean up every chunk of the media blob we wrote to chrome.storage.local
  // for this campaign (see popup.js) — otherwise attachments left behind by
  // past campaigns just sit in storage forever.
  if (campaign && campaign.mediaKey) {
    const keys = [`${campaign.mediaKey}_meta`];
    for (let i = 0; i < (campaign.mediaTotalChunks || 0); i++) keys.push(`${campaign.mediaKey}_chunk_${i}`);
    try { await chrome.storage.local.remove(keys); } catch {}
  }
  campaign = null;
  clearKeepAlive();
  await chrome.storage.local.remove(STORAGE_KEY);
}

function broadcastProgress(item) {
  chrome.runtime.sendMessage({ action: "campaignProgress", item }).catch(() => {});
}

async function runLoop() {
  if (sending) return; // already running
  sending = true;
  try {
    const tab = await ensureWaTab();

    // Wait (with timeout) for the content script + WhatsApp UI to be ready
    let ready = false;
    for (let i = 0; i < 15; i++) {
      ready = await pingContentScript(tab.id);
      if (ready) break;
      await sleep(2000);
    }
    if (!ready) {
      markAllRemainingFailed("WhatsApp Web did not load in time. Open web.whatsapp.com, scan the QR code, then Resume.");
      sending = false;
      return;
    }

    while (campaign && campaign.status === "running" && campaign.index < campaign.queue.length) {
      const safetyCheck = await checkSafetyAllowance(campaign);
      if (!safetyCheck.allowed) {
        await safetyPause(safetyCheck.reason);
        break;
      }

      const item = campaign.queue[campaign.index];
      item.status = "sending";
      broadcastProgress(item);

      let result;
      try {
        if (item.destinationType === "group") {
          // Groups cannot be opened with WhatsApp's ?phone= deep link. Ask the
          // content script to locate/open the selected group in the chat list.
          result = await chrome.tabs.sendMessage(tab.id, {
            action: "sendGroupMessage",
            groupName: item.groupName,
            groupId: item.groupId || "",
            message: item.message,
            media: item.media || null
          });
        } else {
          await navigateToChat(tab.id, item.phone);
          result = await chrome.tabs.sendMessage(tab.id, {
            action: "sendMessage",
            phone: item.phone,
            message: item.message,
            media: item.media || null
          });
        }
      } catch (err) {
        result = { success: false, error: "content script unreachable: " + err.message };
      }

      item.status = result && result.success ? "sent" : "failed";
      item.error = result && result.error;
      item.warning = result && result.warning;
      broadcastProgress(item);

      if (item.status === "sent") {
        campaign.consecutiveFailures = 0;
        if (campaign.safetyEnabled) await recordSuccessfulSend();
      } else {
        campaign.consecutiveFailures = (Number(campaign.consecutiveFailures) || 0) + 1;
      }

      campaign.index += 1;
      await saveCampaign();

      if (campaign.safetyEnabled && item.status === "failed") {
        const failureLimit = Math.max(1, Number(campaign.safetyFailureLimit) || 3);
        if (campaign.consecutiveFailures >= failureLimit && campaign.index < campaign.queue.length) {
          await safetyPause(`Safety pause: ${campaign.consecutiveFailures} consecutive sends failed. Check WhatsApp and the failure details before resuming.`);
          break;
        }
      }

      if (campaign.status !== "running") break;
      const baseDelay = Math.max(2, Number(campaign.delaySeconds) || 5);
      const randomExtra = campaign.randomDelayEnabled
        ? Math.random() * Math.max(0, Number(campaign.randomDelaySeconds) || 0)
        : 0;
      await sleep((baseDelay + randomExtra) * 1000);

      const completedCount = campaign.index;
      const batchSize = Math.max(0, Number(campaign.batchSize) || 0);
      if (batchSize && completedCount < campaign.queue.length && completedCount % batchSize === 0) {
        await sleep(Math.max(0, Number(campaign.batchPauseSeconds) || 0) * 1000);
      }
    }

    if (campaign && campaign.index >= campaign.queue.length) {
      campaign.status = "completed";
      await saveCampaign();
      clearKeepAlive();
    }
  } finally {
    sending = false;
  }
}

function markAllRemainingFailed(reason) {
  if (!campaign) return;
  for (let i = campaign.index; i < campaign.queue.length; i++) {
    campaign.queue[i].status = "failed";
    campaign.queue[i].error = reason;
    broadcastProgress(campaign.queue[i]);
  }
  campaign.status = "stopped";
  saveCampaign();
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // Always let the initial storage rehydration finish first, so it can
    // never race with / overwrite a campaign that a command below is about
    // to start, pause, resume, or stop.
    await initialLoadPromise;

    switch (msg.action) {
      case "getWaStatus":
        sendResponse(await getWaStatus());
        break;
      case "getGroupMembers":
        sendResponse(await getGroupMembers(msg.groupName));
        break;
      case "getGroupChats":
        sendResponse(await getGroupChats());
        break;
      case "startCampaign":
        await startCampaign(msg.campaign);
        sendResponse({ ok: true });
        break;
      case "pauseCampaign":
        await pauseCampaign();
        sendResponse({ ok: true });
        break;
      case "resumeCampaign":
        await resumeCampaign();
        sendResponse({ ok: true });
        break;
      case "stopCampaign":
        await stopCampaign();
        sendResponse({ ok: true });
        break;
      case "resetCampaign":
        await resetCampaign();
        sendResponse({ ok: true });
        break;
      case "getCampaignState":
        sendResponse({ campaign });
        break;
      default:
        sendResponse(null);
    }
  })();
  return true; // keep the message channel open for the async response
});

// Rehydrate campaign reference on service worker (re)start. Every message
// handler above awaits this same promise so a slow storage read can never
// land after (and clobber) a campaign started by a later message.
const initialLoadPromise = loadCampaign();
