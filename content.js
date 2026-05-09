/**
 * VK Шифратор — Content Script (v2)
 * Per-chat ECDH encryption with in-chat panel.
 * VK converts 🔐 emoji to <img alt="🔐" class="Emoji">, so after the img
 * the text node contains only the suffix: "ENC:…", "HS-INIT:…", "HS-ACK:…"
 */

(() => {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────
  const HS_INIT_PREFIX  = 'HS-INIT:';
  const HS_ACK_PREFIX   = 'HS-ACK:';
  const ENC_TEXT_PREFIX = 'ENC:';
  const ENC_EMOJI       = '\u{1F510}';   // 🔐
  const STORAGE_KEY     = 'vkEncChats';

  /** Empty / default chat config. */
  const EMPTY_CFG = () => ({
    state:       'none',
    enabled:     false,
    myPubKey:    '',
    myPrivKey:   null,
    theirPubKey: '',
    passphrase:  '',
    fingerprint: ''
  });

  // ── Runtime state ─────────────────────────────────────────────────────────
  let currentChatId    = null;  // peer ID from URL
  let currentChatState = null;  // ChatConfig object
  let panelEl          = null;  // injected panel DOM node
  let scanning         = false; // decrypt re-entrancy guard

  // ── Storage helpers ───────────────────────────────────────────────────────

  function loadChatState(chatId) {
    return new Promise(resolve => {
      chrome.storage.local.get([STORAGE_KEY], data => {
        const chats = data[STORAGE_KEY] || {};
        resolve(chats[chatId] ? { ...EMPTY_CFG(), ...chats[chatId] } : EMPTY_CFG());
      });
    });
  }

  function saveChatState(chatId, cfg) {
    return new Promise(resolve => {
      chrome.storage.local.get([STORAGE_KEY], data => {
        const chats = data[STORAGE_KEY] || {};
        chats[chatId] = cfg;
        chrome.storage.local.set({ [STORAGE_KEY]: chats }, resolve);
      });
    });
  }

  function deleteChatState(chatId) {
    return new Promise(resolve => {
      chrome.storage.local.get([STORAGE_KEY], data => {
        const chats = data[STORAGE_KEY] || {};
        delete chats[chatId];
        chrome.storage.local.set({ [STORAGE_KEY]: chats }, resolve);
      });
    });
  }

  // ── Chat ID extraction ────────────────────────────────────────────────────

  function getCurrentChatId() {
    const url = location.href;
    let m = url.match(/[?&]sel=([^&#]+)/);
    if (m) return m[1];
    m = url.match(/\/im\/convo\/(\d+)/);
    if (m) return m[1];
    return null;
  }

  // ── Panel creation ────────────────────────────────────────────────────────

  function createPanel() {
    const el = document.createElement('div');
    el.id = 'vke-panel';
    el.innerHTML =
      '<div class="vke-row">' +
        '<span id="vke-ico" class="vke-ico">🔓</span>' +
        '<span id="vke-txt" class="vke-txt">Шифрование не настроено</span>' +
        '<span id="vke-fp-sm" class="vke-fp-sm" title="Safety Numbers" style="display:none"></span>' +
        '<div  id="vke-actions" style="display:flex;gap:6px;align-items:center;flex-shrink:0"></div>' +
      '</div>' +
      '<div id="vke-fp-row" class="vke-col" style="display:none">' +
        '<span style="font-size:11px;color:var(--vkui--color_text_secondary,#818c99)">' +
          'Сверьте эмодзи с собеседником вне ВКонтакте:' +
        '</span>' +
        '<span id="vke-fp" class="vke-fp"></span>' +
      '</div>';
    return el;
  }

  function updatePanel() {
    if (!panelEl) return;
    const cs = currentChatState || EMPTY_CFG();

    const ico     = panelEl.querySelector('#vke-ico');
    const txt     = panelEl.querySelector('#vke-txt');
    const fpSm    = panelEl.querySelector('#vke-fp-sm');
    const actions = panelEl.querySelector('#vke-actions');
    const fpRow   = panelEl.querySelector('#vke-fp-row');
    const fp      = panelEl.querySelector('#vke-fp');

    panelEl.className = '';
    panelEl.id = 'vke-panel';
    fpRow.style.display = 'none';
    fpSm.style.display  = 'none';
    actions.innerHTML   = '';

    function mkBtn(label, cls, handler) {
      const b = document.createElement('button');
      b.className = 'vke-btn ' + cls;
      b.innerHTML = label;
      b.addEventListener('click', handler);
      return b;
    }

    switch (cs.state) {
      case 'none':
        panelEl.classList.add('vke-panel--off');
        ico.textContent = '🔓';
        txt.textContent = 'Шифрование не настроено';
        actions.appendChild(mkBtn('🤝 Рукопожатие', 'vke-btn--blue', doStartHandshake));
        break;

      case 'initiated':
        panelEl.classList.add('vke-panel--wait');
        ico.textContent = '⏳';
        txt.textContent = 'Ожидание ответа…';
        actions.appendChild(mkBtn('Отменить', 'vke-btn--ghost', doCancelHandshake));
        break;

      case 'received':
        panelEl.classList.add('vke-panel--wait');
        ico.textContent = '🔑';
        txt.textContent = 'Входящий запрос шифрования';
        actions.appendChild(mkBtn('✓ Принять',   'vke-btn--blue',  doAcceptHandshake));
        actions.appendChild(mkBtn('✕ Отклонить', 'vke-btn--ghost', doCancelHandshake));
        break;

      case 'verifying':
        panelEl.classList.add('vke-panel--wait');
        ico.textContent = '🔑';
        txt.textContent = 'Сверьте эмодзи:';
        fpRow.style.display = '';
        fp.textContent = cs.fingerprint || '';
        actions.appendChild(mkBtn('✓ Совпадают',    'vke-btn--green', doConfirmFingerprint));
        actions.appendChild(mkBtn('✕ Не совпадают', 'vke-btn--red',   doCancelHandshake));
        break;

      case 'active': {
        const on = cs.enabled;
        panelEl.classList.add(on ? 'vke-panel--on' : 'vke-panel--off');
        ico.textContent = on ? '🔒' : '🔓';
        txt.textContent = on ? 'Шифрование активно' : 'Шифрование выключено';
        if (cs.fingerprint) {
          fpSm.style.display = '';
          fpSm.textContent   = cs.fingerprint;
        }
        const tog = document.createElement('label');
        tog.className = 'vke-toggle';
        tog.innerHTML = '<input type="checkbox"' + (on ? ' checked' : '') + '>' +
                        '<span class="vke-toggle-track"></span>';
        tog.querySelector('input').addEventListener('change', doToggle);
        actions.appendChild(tog);
        actions.appendChild(mkBtn('↺', 'vke-btn--ghost vke-btn--sm', doReset));
        break;
      }
    }
  }

  /** Inject / re-inject the panel right after ConvoHeader. */
  function ensurePanel() {
    if (!currentChatId) {
      if (panelEl && panelEl.parentNode) panelEl.remove();
      panelEl = null;
      return;
    }
    const header = document.querySelector('.ConvoHeader');
    if (!header) return;
    if (!panelEl) panelEl = createPanel();
    if (header.nextSibling !== panelEl) {
      header.insertAdjacentElement('afterend', panelEl);
    }
    updatePanel();
  }

  // ── Handshake actions ─────────────────────────────────────────────────────

  async function doStartHandshake() {
    if (!currentChatId) return;
    try {
      const kp      = await VKCrypto.generateECDHKeyPair();
      const pubB64  = await VKCrypto.exportPublicKeyB64(kp.publicKey);
      const privJWK = await VKCrypto.exportPrivateKeyJWK(kp.privateKey);

      currentChatState = { ...EMPTY_CFG(), state: 'initiated', myPubKey: pubB64, myPrivKey: privJWK };
      await saveChatState(currentChatId, currentChatState);
      updatePanel();
      sendTextToChat(ENC_EMOJI + HS_INIT_PREFIX + pubB64);
    } catch (e) {
      console.error('[VK Enc] doStartHandshake:', e);
      showToast('Ошибка запуска рукопожатия');
    }
  }

  async function doAcceptHandshake() {
    if (!currentChatId || !currentChatState?.theirPubKey) return;
    try {
      const kp          = await VKCrypto.generateECDHKeyPair();
      const pubB64      = await VKCrypto.exportPublicKeyB64(kp.publicKey);
      const privJWK     = await VKCrypto.exportPrivateKeyJWK(kp.privateKey);
      const passphrase  = await VKCrypto.computePassphrase(kp.privateKey, currentChatState.theirPubKey);
      const fingerprint = await VKCrypto.fingerprintEmojis(pubB64, currentChatState.theirPubKey);

      currentChatState = { ...currentChatState, state: 'verifying', myPubKey: pubB64, myPrivKey: privJWK, passphrase, fingerprint };
      await saveChatState(currentChatId, currentChatState);
      updatePanel();
      sendTextToChat(ENC_EMOJI + HS_ACK_PREFIX + pubB64);
    } catch (e) {
      console.error('[VK Enc] doAcceptHandshake:', e);
      showToast('Ошибка принятия рукопожатия');
    }
  }

  async function doCancelHandshake() {
    if (!currentChatId) return;
    currentChatState = EMPTY_CFG();
    await saveChatState(currentChatId, currentChatState);
    updatePanel();
    clearDecryptedMarks();
  }

  async function doConfirmFingerprint() {
    if (!currentChatId) return;
    currentChatState = { ...currentChatState, state: 'active', enabled: true };
    await saveChatState(currentChatId, currentChatState);
    updatePanel();
    scheduleDecrypt();
  }

  async function doToggle() {
    if (!currentChatId) return;
    currentChatState = { ...currentChatState, enabled: !currentChatState.enabled };
    await saveChatState(currentChatId, currentChatState);
    updatePanel();
  }

  async function doReset() {
    if (!currentChatId) return;
    if (!confirm('Сбросить ключ шифрования для этого чата?')) return;
    await deleteChatState(currentChatId);
    currentChatState = EMPTY_CFG();
    updatePanel();
    clearDecryptedMarks();
  }

  // ── VK input interaction ──────────────────────────────────────────────────

  function findInput() {
    const selectors = [
      'span.ComposerInput__input',
      'span.ConvoComposer__input',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]'
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function setInputText(input, text) {
    input.focus();
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  }

  function simulateEnter(input) {
    ['keydown', 'keypress', 'keyup'].forEach(type => {
      input.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
    });
  }

  function sendTextToChat(text) {
    const input = findInput();
    if (!input) { console.warn('[VK Enc] No input element found'); return; }
    input.focus();
    setInputText(input, text);
    setTimeout(() => simulateEnter(input), 80);
  }

  // ── Handshake message detection ───────────────────────────────────────────

  async function scanForHandshakeMessages() {
    if (!currentChatId) return;
    const cs = currentChatState;
    if (!cs) return;

    // Only scan non-outgoing stacks (incoming messages)
    const stacks = document.querySelectorAll('.ConvoStack:not(.ConvoStack--out)');

    for (const stack of stacks) {
      const containers = stack.querySelectorAll('.MessageText, .MessagePreview');
      for (const container of containers) {
        if (container.dataset.vkeHsProcessed) continue;

        const result = extractHsContent(container);
        if (!result) continue;

        container.dataset.vkeHsProcessed = '1';

        if (result.type === 'hs-init' && (cs.state === 'none' || cs.state === 'active')) {
          currentChatState = { ...EMPTY_CFG(), state: 'received', theirPubKey: result.pubKey };
          await saveChatState(currentChatId, currentChatState);
          updatePanel();
          showToast('🔑 Входящий запрос шифрования');

        } else if (result.type === 'hs-ack' && cs.state === 'initiated') {
          try {
            const privKey     = await VKCrypto.importPrivateKeyJWK(cs.myPrivKey);
            const passphrase  = await VKCrypto.computePassphrase(privKey, result.pubKey);
            const fingerprint = await VKCrypto.fingerprintEmojis(cs.myPubKey, result.pubKey);

            currentChatState = { ...cs, state: 'verifying', theirPubKey: result.pubKey, passphrase, fingerprint };
            await saveChatState(currentChatId, currentChatState);
            updatePanel();
            showToast('🔑 Сверьте эмодзи с собеседником');
          } catch (e) {
            console.error('[VK Enc] HS-ACK processing error:', e);
          }
        }
      }
    }
  }

  function extractHsContent(container) {
    const nodes = container.childNodes;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];

      // Pattern: <img alt="🔐"> followed by a text node "HS-INIT:..." or "HS-ACK:..."
      if (node.nodeType === Node.ELEMENT_NODE &&
          node.tagName === 'IMG' &&
          node.alt && node.alt.includes(ENC_EMOJI)) {
        const next = nodes[i + 1];
        if (next && next.nodeType === Node.TEXT_NODE) {
          const txt = next.textContent.trimStart();
          if (txt.startsWith(HS_INIT_PREFIX))
            return { type: 'hs-init', pubKey: txt.slice(HS_INIT_PREFIX.length).trim() };
          if (txt.startsWith(HS_ACK_PREFIX))
            return { type: 'hs-ack', pubKey: txt.slice(HS_ACK_PREFIX.length).trim() };
        }
      }

      // Fallback: plain text node with full prefix (emoji not converted to img)
      if (node.nodeType === Node.TEXT_NODE) {
        const txt = node.textContent;
        const ii = txt.indexOf(ENC_EMOJI + HS_INIT_PREFIX);
        if (ii >= 0)
          return { type: 'hs-init', pubKey: txt.slice(ii + ENC_EMOJI.length + HS_INIT_PREFIX.length).trim() };
        const ai = txt.indexOf(ENC_EMOJI + HS_ACK_PREFIX);
        if (ai >= 0)
          return { type: 'hs-ack', pubKey: txt.slice(ai + ENC_EMOJI.length + HS_ACK_PREFIX.length).trim() };
      }
    }
    return null;
  }

  // ── Decryption ────────────────────────────────────────────────────────────

  async function decryptAllMessages() {
    if (!currentChatState?.passphrase) return;
    if (scanning) return;
    scanning = true;
    try {
      const containers = document.querySelectorAll('.MessageText, .MessagePreview');
      for (const c of containers) {
        if (c.dataset.vkEncDone) continue;
        await tryDecryptContainer(c);
      }
    } finally {
      scanning = false;
    }
  }

  async function tryDecryptContainer(container) {
    let encPayload = null;
    const nodes = container.childNodes;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];

      if (node.nodeType === Node.ELEMENT_NODE &&
          node.tagName === 'IMG' &&
          node.alt && node.alt.includes(ENC_EMOJI)) {
        const next = nodes[i + 1];
        if (next && next.nodeType === Node.TEXT_NODE) {
          const txt = next.textContent.trimStart();
          if (txt.startsWith(ENC_TEXT_PREFIX)) {
            encPayload = ENC_EMOJI + txt;
            break;
          }
        }
        continue;
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const txt = node.textContent;
        const idx = txt.indexOf(ENC_EMOJI + ENC_TEXT_PREFIX);
        if (idx >= 0) { encPayload = txt.slice(idx); break; }
      }
    }

    if (!encPayload) return;
    container.dataset.vkEncDone = '1';

    const plaintext = await VKCrypto.decrypt(encPayload, currentChatState.passphrase);

    if (plaintext !== null) {
      const wrap = document.createElement('span');
      wrap.className = 'vke-dec';

      const textSpan = document.createElement('span');
      textSpan.textContent = plaintext;

      const badge = document.createElement('span');
      badge.className = 'vke-badge vke-badge--ok';
      badge.textContent = ' \u{1F513}'; // 🔓
      badge.title = 'Расшифровано VK Шифратором';

      wrap.appendChild(textSpan);
      wrap.appendChild(badge);
      container.innerHTML = '';
      container.appendChild(wrap);
    } else {
      if (!container.querySelector('.vke-badge--locked')) {
        const badge = document.createElement('span');
        badge.className = 'vke-badge vke-badge--locked';
        badge.textContent = ' \u{1F510}'; // 🔐
        badge.title = 'Зашифровано — неверный или отсутствующий ключ';
        container.appendChild(badge);
        container.classList.add('vke-locked');
      }
    }
  }

  function clearDecryptedMarks() {
    document.querySelectorAll('[data-vk-enc-done]').forEach(el => delete el.dataset.vkEncDone);
    document.querySelectorAll('[data-vke-hs-processed]').forEach(el => delete el.dataset.vkeHsProcessed);
    document.querySelectorAll('.vke-dec').forEach(el => el.parentNode?.removeChild(el));
    document.querySelectorAll('.vke-badge').forEach(el => el.parentNode?.removeChild(el));
    document.querySelectorAll('.vke-locked').forEach(el => el.classList.remove('vke-locked'));
  }

  // ── Outgoing message interception ─────────────────────────────────────────

  function setupSendInterceptor() {
    document.addEventListener('keydown', async e => {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey) return;
      if (!shouldEncrypt()) return;
      const input = findInput();
      if (!input || !isInputActive(input)) return;
      const text = (input.innerText || input.textContent || '').trim();
      if (!text || text.startsWith(ENC_EMOJI)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      await encryptAndSend(input, text, 'enter');
    }, true);

    document.addEventListener('click', async e => {
      if (!shouldEncrypt()) return;
      const sendBtn = e.target.closest(
        '[class*="ConvoComposer__sendButton"],[class*="sendButton"],[class*="SendButton"]'
      );
      if (!sendBtn) return;
      const input = findInput();
      if (!input) return;
      const text = (input.innerText || input.textContent || '').trim();
      if (!text || text.startsWith(ENC_EMOJI)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      await encryptAndSend(input, text, sendBtn);
    }, true);
  }

  function shouldEncrypt() {
    return !!(currentChatState?.enabled && currentChatState?.passphrase);
  }

  function isInputActive(input) {
    return document.activeElement === input || input.contains(document.activeElement);
  }

  async function encryptAndSend(input, text, trigger) {
    try {
      const encrypted = await VKCrypto.encrypt(text, currentChatState.passphrase);
      setInputText(input, encrypted);
      await new Promise(r => setTimeout(r, 80));
      if (trigger === 'enter') simulateEnter(input);
      else trigger.click(); // sendBtn
      scheduleDecrypt();
    } catch (e) {
      console.error('[VK Enc] Encryption error:', e);
    }
  }

  function scheduleDecrypt() {
    setTimeout(() => { decryptAllMessages(); scanForHandshakeMessages(); }, 500);
    setTimeout(decryptAllMessages, 1500);
  }

  // ── URL / chat navigation ─────────────────────────────────────────────────

  async function onChatChange() {
    const newId = getCurrentChatId();
    if (newId === currentChatId) return;
    currentChatId    = newId;
    currentChatState = null;
    clearDecryptedMarks();
    if (newId) currentChatState = await loadChatState(newId);
    ensurePanel();
    if (currentChatState?.passphrase) scheduleDecrypt();
    scanForHandshakeMessages();
  }

  function startURLWatcher() {
    let lastURL = location.href;
    setInterval(() => {
      if (location.href !== lastURL) { lastURL = location.href; onChatChange(); }
    }, 400);
    const origPush = history.pushState.bind(history);
    history.pushState = function (...args) { origPush(...args); setTimeout(onChatChange, 60); };
    window.addEventListener('popstate', () => setTimeout(onChatChange, 60));
  }

  // ── MutationObserver ──────────────────────────────────────────────────────

  function setupMutationObserver() {
    let decryptTimer = null;
    let panelTimer   = null;

    const observer = new MutationObserver(mutations => {
      let needsDecrypt = false;
      let needsPanel   = false;

      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.classList?.contains('ConvoHeader') || node.querySelector?.('.ConvoHeader'))
            needsPanel = true;
          const text = node.innerText || node.textContent || '';
          if (text.includes(ENC_TEXT_PREFIX) || text.includes(HS_INIT_PREFIX) || text.includes(HS_ACK_PREFIX))
            needsDecrypt = true;
          if (node.querySelector?.('.MessageText, .MessagePreview'))
            needsDecrypt = true;
        }
      }

      if (needsPanel)   { clearTimeout(panelTimer);   panelTimer   = setTimeout(ensurePanel, 350); }
      if (needsDecrypt) { clearTimeout(decryptTimer); decryptTimer = setTimeout(() => { decryptAllMessages(); scanForHandshakeMessages(); }, 200); }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Popup communication ───────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'VKE_GET_STATE':
          sendResponse({ chatId: currentChatId, config: currentChatState, onPage: location.href.includes('vk.com/im') });
          break;
        case 'VKE_HS_START':   await doStartHandshake();      break;
        case 'VKE_HS_CANCEL':
        case 'VKE_HS_DECLINE': await doCancelHandshake();     break;
        case 'VKE_HS_ACCEPT':  await doAcceptHandshake();     break;
        case 'VKE_FP_CONFIRM': await doConfirmFingerprint();  break;
        case 'VKE_TOGGLE':     await doToggle();               break;
        case 'VKE_RESET_CHAT':
          if (!msg.chatId || msg.chatId === currentChatId) await doReset();
          break;
      }
    })();
    return true;
  });

  // Keep in-memory state in sync when storage changes (e.g. from popup)
  chrome.storage.onChanged.addListener(changes => {
    if (!changes[STORAGE_KEY] || !currentChatId) return;
    const fresh = (changes[STORAGE_KEY].newValue || {})[currentChatId];
    if (fresh) { currentChatState = { ...EMPTY_CFG(), ...fresh }; updatePanel(); }
  });

  // ── Toast notification ────────────────────────────────────────────────────

  function showToast(text) {
    let el = document.getElementById('vke-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vke-toast';
      el.className = 'vke-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('vke-toast--show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('vke-toast--show'), 2500);
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  async function init() {
    setupSendInterceptor();
    setupMutationObserver();
    startURLWatcher();
    await onChatChange();
    setInterval(ensurePanel, 4000);
    setInterval(() => {
      if (currentChatState?.passphrase) decryptAllMessages();
      scanForHandshakeMessages();
    }, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
