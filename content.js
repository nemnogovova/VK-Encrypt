/**
 * VK Шифратор — Content Script
 * VK converts 🔐 emoji to <img alt="🔐" class="Emoji">, so text nodes
 * only contain "ENC:base64..." without the emoji prefix.
 * We detect encrypted messages by finding text nodes starting with "ENC:"
 * preceded by an emoji <img> with alt="🔐".
 */

(() => {
  'use strict';

  const ENC_TEXT_PREFIX = 'ENC:';
  const ENC_EMOJI = '\u{1F510}'; // 🔐
  const ENC_FULL_PREFIX = ENC_EMOJI + ENC_TEXT_PREFIX; // used when encrypting outbound

  let encryptionKey = '';
  let encryptionEnabled = false;
  let scanTimer = null;
  let indicatorEl = null;

  // ===== Settings Management =====

  function loadSettings(callback) {
    chrome.storage.local.get(['vkEncKey', 'vkEncEnabled'], (data) => {
      encryptionKey = data.vkEncKey || '';
      encryptionEnabled = !!data.vkEncEnabled;
      updateIndicator();
      if (callback) callback();
      scheduleScan();
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'VK_ENC_SETTINGS_UPDATED') {
      loadSettings(() => decryptAllMessages());
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.vkEncKey) encryptionKey = changes.vkEncKey.newValue || '';
    if (changes.vkEncEnabled) encryptionEnabled = !!changes.vkEncEnabled.newValue;
    updateIndicator();
    decryptAllMessages();
    scheduleScan();
  });

  // ===== Periodic Scan =====

  function scheduleScan() {
    if (scanTimer) clearInterval(scanTimer);
    if (encryptionEnabled && encryptionKey) {
      scanTimer = setInterval(decryptAllMessages, 2000);
    }
  }

  // ===== Message Interception (Outgoing) =====

  function findMessageInput() {
    const selectors = [
      'span.ComposerInput__input',
      'span.ConvoComposer__input',
      '[contenteditable="true"][role="textbox"]',
      '.im_editable',
      '[contenteditable="true"][class*="im-chat-input"]',
      '.im-page [contenteditable="true"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function isInputFocused(input) {
    return document.activeElement === input || input.contains(document.activeElement);
  }

  function getInputText(input) {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.value;
    return input.innerText || input.textContent;
  }

  function setInputText(input, text) {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeSetter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      input.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, text);
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, data: text, inputType: 'insertText'
      }));
    }
  }

  function simulateEnter(input) {
    ['keydown', 'keypress', 'keyup'].forEach(type => {
      input.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    });
  }

  function setupSendInterceptor() {
    // Enter key intercept
    document.addEventListener('keydown', async (e) => {
      if (!encryptionEnabled || !encryptionKey) return;
      if (e.key !== 'Enter' || e.shiftKey) return;

      const input = findMessageInput();
      if (!input || !isInputFocused(input)) return;

      const text = getInputText(input);
      if (!text || text.trim().length === 0) return;
      if (text.trim().startsWith(ENC_FULL_PREFIX)) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();

      try {
        const encrypted = await VKCrypto.encrypt(text.trim(), encryptionKey);
        setInputText(input, encrypted);
        await new Promise(r => setTimeout(r, 100));
        simulateEnter(input);
        schedulePostSendScans();
      } catch (err) {
        console.error('[VK Шифратор] Encryption error:', err);
      }
    }, true);

    // Send button click intercept
    document.addEventListener('click', async (e) => {
      if (!encryptionEnabled || !encryptionKey) return;

      const sendBtn = e.target.closest(
        '[class*="ConvoComposer__sendButton"], [class*="ConvoComposer__buttonIcon--submit"],' +
        '[class*="im-send-btn"], [class*="im-chat-input--send"],' +
        '[data-testid="msg_send_button"], [class*="SendButton"], [class*="send_btn"]'
      );
      if (!sendBtn) return;

      const input = findMessageInput();
      if (!input) return;

      const text = getInputText(input);
      if (!text || text.trim().length === 0) return;
      if (text.trim().startsWith(ENC_FULL_PREFIX)) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();

      try {
        const encrypted = await VKCrypto.encrypt(text.trim(), encryptionKey);
        setInputText(input, encrypted);
        await new Promise(r => setTimeout(r, 100));
        sendBtn.click();
        schedulePostSendScans();
      } catch (err) {
        console.error('[VK Шифратор] Encryption error:', err);
      }
    }, true);
  }

  function schedulePostSendScans() {
    setTimeout(decryptAllMessages, 400);
    setTimeout(decryptAllMessages, 1000);
    setTimeout(decryptAllMessages, 2500);
  }

  // ===== Message Decryption =====

  let isScanning = false;

  async function decryptAllMessages() {
    if (!encryptionEnabled || !encryptionKey) return;
    if (isScanning) return;
    isScanning = true;

    try {
      // Strategy: find all .MessageText and .MessagePreview span elements
      // that contain encrypted content. VK renders:
      //   <span class="MessageText"><img alt="🔐" class="Emoji ...">ENC:base64</span>
      // The text node after the <img> starts with "ENC:"
      const containers = document.querySelectorAll(
        '.MessageText, .MessagePreview'
      );

      for (const container of containers) {
        if (container.closest('.vk-enc-decrypted-wrap')) continue;
        if (container.closest('.vk-enc-locked-wrap')) continue;
        if (container.dataset.vkEncProcessed) continue;

        await tryDecryptContainer(container);
      }
    } finally {
      isScanning = false;
    }
  }

  async function tryDecryptContainer(container) {
    // Check if this container has encrypted content.
    // VK renders emoji as <img alt="🔐">, so the full text won't contain 🔐
    // in a single text node. We look for the pattern:
    //   <img alt="🔐" class="Emoji ...">  followed by text node starting with "ENC:"

    // Method 1: Check child nodes for <img alt="🔐"> + "ENC:" text node pair
    let emojiImg = null;
    let encTextNode = null;

    for (let i = 0; i < container.childNodes.length; i++) {
      const node = container.childNodes[i];

      // Check for emoji img
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG' &&
          node.alt && node.alt.includes(ENC_EMOJI)) {
        // Next sibling should be the ENC: text
        const next = container.childNodes[i + 1];
        if (next && next.nodeType === Node.TEXT_NODE &&
            next.textContent.trimStart().startsWith(ENC_TEXT_PREFIX)) {
          emojiImg = node;
          encTextNode = next;
          break;
        }
      }

      // Also check text that might contain the full prefix directly
      // (fallback for cases where emoji wasn't converted to img)
      if (node.nodeType === Node.TEXT_NODE &&
          node.textContent.includes(ENC_FULL_PREFIX)) {
        encTextNode = node;
        break;
      }
    }

    if (!encTextNode) return;

    // Extract the base64 payload
    const rawText = encTextNode.textContent.trimStart();
    let encPayload;
    if (rawText.startsWith(ENC_TEXT_PREFIX)) {
      const afterPrefix = rawText.slice(ENC_TEXT_PREFIX.length);
      const base64Match = afterPrefix.match(/^[A-Za-z0-9+/=]+/);
      if (!base64Match) return;
      encPayload = ENC_FULL_PREFIX + base64Match[0];
    } else if (rawText.includes(ENC_FULL_PREFIX)) {
      const idx = rawText.indexOf(ENC_FULL_PREFIX);
      const after = rawText.slice(idx + ENC_FULL_PREFIX.length);
      const base64Match = after.match(/^[A-Za-z0-9+/=]+/);
      if (!base64Match) return;
      encPayload = ENC_FULL_PREFIX + base64Match[0];
    } else {
      return;
    }

    // Try to decrypt
    const plaintext = await VKCrypto.decrypt(encPayload, encryptionKey);

    // Mark as processed to avoid re-processing
    container.dataset.vkEncProcessed = '1';

    if (plaintext !== null) {
      // Successfully decrypted
      const wrapper = document.createElement('span');
      wrapper.className = 'vk-enc-decrypted-wrap';
      wrapper.dataset.vkOriginal = encPayload;

      const textSpan = document.createElement('span');
      textSpan.className = 'vk-enc-text';
      textSpan.textContent = plaintext;

      const badge = document.createElement('span');
      badge.className = 'vk-enc-badge vk-enc-badge--ok';
      badge.textContent = ' \u{1F513}'; // 🔓
      badge.title = 'Расшифровано VK Шифратором';

      wrapper.appendChild(textSpan);
      wrapper.appendChild(badge);

      // Replace container contents
      container.textContent = '';
      container.appendChild(wrapper);
    } else {
      // Can't decrypt — show lock badge
      const badge = document.createElement('span');
      badge.className = 'vk-enc-badge vk-enc-badge--locked';
      badge.textContent = ' \u{1F510}'; // 🔐
      badge.title = 'Зашифровано — неверный ключ';

      // Keep original content, just add the badge
      container.appendChild(badge);
      container.classList.add('vk-enc-locked-wrap');
    }
  }

  // ===== Status Indicator =====

  function addStatusIndicator() {
    if (document.getElementById('vk-enc-indicator')) return;
    indicatorEl = document.createElement('div');
    indicatorEl.id = 'vk-enc-indicator';
    updateIndicator();
    document.body.appendChild(indicatorEl);
  }

  function updateIndicator() {
    if (!indicatorEl) return;
    if (encryptionEnabled && encryptionKey) {
      indicatorEl.textContent = '\u{1F512}'; // 🔒
      indicatorEl.className = 'active';
      indicatorEl.title = 'VK Шифратор: АКТИВНО';
    } else {
      indicatorEl.textContent = '\u{1F513}'; // 🔓
      indicatorEl.className = 'inactive';
      indicatorEl.title = 'VK Шифратор: ВЫКЛЮЧЕНО';
    }
  }

  // ===== MutationObserver =====

  function setupMutationObserver() {
    let debounceTimer = null;

    const observer = new MutationObserver((mutations) => {
      if (!encryptionEnabled || !encryptionKey) return;

      let needsScan = false;
      for (const m of mutations) {
        if (needsScan) break;
        for (const node of m.addedNodes) {
          if (needsScan) break;
          if (node.nodeType === Node.TEXT_NODE) {
            if (node.textContent && node.textContent.includes(ENC_TEXT_PREFIX)) {
              needsScan = true;
            }
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if added element or its descendants contain encrypted text
            if (node.querySelector && node.querySelector('.MessageText, .MessagePreview')) {
              needsScan = true;
            }
            const text = node.innerText || node.textContent || '';
            if (text.includes(ENC_TEXT_PREFIX)) {
              needsScan = true;
            }
          }
        }
      }

      if (needsScan) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(decryptAllMessages, 200);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // ===== Init =====

  function init() {
    loadSettings(() => {
      setupSendInterceptor();
      setupMutationObserver();
      addStatusIndicator();
      decryptAllMessages();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
