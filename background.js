/**
 * VK Шифратор — Background Service Worker
 * Routes popup ↔ content messages and manages badge state.
 */

// ── Badge update ──────────────────────────────────────────────────────────────

function updateBadge() {
  chrome.storage.local.get(['vkEncChats'], data => {
    const chats   = data.vkEncChats || {};
    const anyOn   = Object.values(chats).some(c => c.enabled);
    const anyChat = Object.keys(chats).length > 0;

    if (anyOn) {
      chrome.action.setBadgeText({ text: 'ON' });
      chrome.action.setBadgeBackgroundColor({ color: '#4bb34b' });
    } else if (anyChat) {
      chrome.action.setBadgeText({ text: '···' });
      chrome.action.setBadgeBackgroundColor({ color: '#ffa000' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  });
}

chrome.storage.onChanged.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);

// ── Route popup → content messages ───────────────────────────────────────────
// The popup sends certain messages that need to be forwarded to the content script
// because the popup can't directly call content-script functions.
// (VKE_TOGGLE, VKE_RESET_CHAT, VKE_HS_START, VKE_HS_CANCEL, VKE_HS_ACCEPT,
//  VKE_FP_CONFIRM, VKE_SET_PASSPHRASE, VKE_GET_STATE)

const FORWARD_TO_CONTENT = new Set([
  'VKE_TOGGLE','VKE_RESET_CHAT','VKE_HS_START','VKE_HS_CANCEL',
  'VKE_HS_ACCEPT','VKE_FP_CONFIRM','VKE_SET_PASSPHRASE','VKE_GET_STATE'
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages from content script (has tab sender) going to popup:
  // VKE_STATE — just let them through (popup is listening directly)

  // Messages from popup (no tab) that need forwarding to active tab's content script:
  if (FORWARD_TO_CONTENT.has(msg.type) && !sender.tab) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
      }
    });
  }

  return false; // no async response needed
});

