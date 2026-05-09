/**
 * VK Шифратор — Background Service Worker (v2)
 * Manages badge state based on per-chat encryption configs.
 */

chrome.storage.onChanged.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);

function updateBadge() {
  chrome.storage.local.get(['vkEncChats'], data => {
    const chats = data.vkEncChats || {};
    const activeCount = Object.values(chats)
      .filter(c => c.state === 'active' && c.enabled).length;

    if (activeCount > 0) {
      chrome.action.setBadgeText({ text: String(activeCount) });
      chrome.action.setBadgeBackgroundColor({ color: '#4bb34b' });
    } else {
      const hasKeys = Object.values(chats).some(c => c.state === 'active');
      chrome.action.setBadgeText({ text: hasKeys ? 'OFF' : '' });
      chrome.action.setBadgeBackgroundColor({ color: '#99a2ad' });
    }
  });
}
