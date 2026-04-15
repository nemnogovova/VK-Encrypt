/**
 * VK Шифратор — Background Service Worker
 * Manages extension lifecycle and badge state.
 */

chrome.storage.onChanged.addListener((changes) => {
  updateBadge();
});

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

function updateBadge() {
  chrome.storage.local.get(['vkEncKey', 'vkEncEnabled'], (data) => {
    const active = data.vkEncKey && data.vkEncEnabled;
    chrome.action.setBadgeText({ text: active ? 'ON' : '' });
    chrome.action.setBadgeBackgroundColor({
      color: active ? '#4bb34b' : '#999'
    });
  });
}
