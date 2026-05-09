/**
 * VK Шифратор — Content Script
 * Per-chat AES-GCM encryption with ECDH handshake support.
 *
 * Storage: chrome.storage.local → vkEncChats: { [chatId]: ChatConfig }
 * ChatConfig: { enabled, passphrase, handshake: { state, myPubKey, myPrivKey, theirPubKey, fingerprint } }
 *
 * Handshake messages sent through VK chat (🔐 becomes <img alt="🔐"> in DOM):
 *   Initiate : 🔐HS:INIT:<pubKeyBase64>
 *   Accept   : 🔐HS:ACPT:<pubKeyBase64>
 */

(() => {
  'use strict';

  const ENC_EMOJI      = '\u{1F510}';       // 🔐
  const ENC_TEXT_TAG   = 'ENC:';
  const HS_TEXT_TAG    = 'HS:';
  const ENC_FULL_PFX   = ENC_EMOJI + ENC_TEXT_TAG;
  const HS_FULL_PFX    = ENC_EMOJI + HS_TEXT_TAG;

  // ── State ────────────────────────────────────────────────────────────────
  let currentChatId  = null;
  let currentConfig  = null;
  let allChats       = {};
  let panelEl        = null;
  let scanTimer      = null;
  let isScanning     = false;
  let lastUrl        = '';
  let panelObserver  = null;

  // ── Chat ID ──────────────────────────────────────────────────────────────

  function getChatId() {
    const url   = new URL(location.href);
    const sel   = url.searchParams.get('sel');
    const peer  = url.searchParams.get('peer');
    if (sel)  return sel;
    if (peer) return peer;
    const hashMatch = location.hash.match(/[?&](?:sel|peer)=([^&]+)/);
    if (hashMatch) return hashMatch[1];
    return null;
  }

  function isOnIMPage() {
    return location.hostname === 'vk.com' &&
      (location.pathname === '/im' || location.pathname.startsWith('/im/'));
  }

  // ── Storage ──────────────────────────────────────────────────────────────

  function loadAllChats(cb) {
    chrome.storage.local.get(['vkEncChats'], d => {
      allChats = d.vkEncChats || {};
      cb();
    });
  }

  function saveAllChats(cb) {
    chrome.storage.local.set({ vkEncChats: allChats }, cb);
  }

  function getConfig(chatId) {
    return allChats[chatId] || null;
  }

  function setConfig(chatId, config, cb) {
    allChats[chatId] = config;
    saveAllChats(cb || (() => {}));
  }

  function defaultConfig() {
    return {
      enabled: false,
      passphrase: '',
      handshake: { state: 'none', myPubKey: '', myPrivKey: '', theirPubKey: '', fingerprint: '' }
    };
  }

  // ── Navigation detection ─────────────────────────────────────────────────

  function onUrlChange() {
    const newId = getChatId();
    if (newId === currentChatId && location.href === lastUrl) return;
    lastUrl       = location.href;
    currentChatId = newId;

    loadAllChats(() => {
      currentConfig = getConfig(currentChatId);
      removePanel();
      if (isOnIMPage() && currentChatId) {
        schedulePanel();
        scheduleDecrypt();
        scheduleScan();
      } else {
        if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
      }
      notifyPopup();
    });
  }

  function watchNavigation() {
    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState    = (...a) => { origPush(...a);    onUrlChange(); };
    history.replaceState = (...a) => { origReplace(...a); onUrlChange(); };
    window.addEventListener('popstate', onUrlChange);
    setInterval(() => { if (location.href !== lastUrl) onUrlChange(); }, 800);
  }

  // ── Panel injection ──────────────────────────────────────────────────────

  const HEADER_SELS = [
    '[class*="ConvoHeader__root"]',
    '[class*="ChatHeader__root"]',
    '[class*="MessengerHeader"]',
    '[class*="im_chat_header"]',
    '[class*="ImChat__header"]',
  ];
  const CONTENT_SELS = [
    '[class*="LayoutWrapper__content"]',
    '[class*="MessengerLayout__right"]',
    '[class*="im-page-in"]',
    '#page_body',
  ];

  function schedulePanel() {
    let n = 0;
    const try_ = () => {
      if (n++ > 30) return;
      if (!tryInjectPanel()) setTimeout(try_, 300);
    };
    try_();
  }

  function tryInjectPanel() {
    if (!currentChatId || !isOnIMPage()) return false;
    if (panelEl && document.body.contains(panelEl)) { updatePanel(); return true; }

    buildPanel();

    for (const sel of HEADER_SELS) {
      const h = document.querySelector(sel);
      if (h && h.parentNode) {
        h.parentNode.insertBefore(panelEl, h.nextSibling);
        watchPanelRemoval();
        updatePanel();
        return true;
      }
    }
    for (const sel of CONTENT_SELS) {
      const c = document.querySelector(sel);
      if (c) {
        c.insertBefore(panelEl, c.firstChild);
        watchPanelRemoval();
        updatePanel();
        return true;
      }
    }
    return false;
  }

  function buildPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.id = 'vke-panel';
  }

  function removePanel() {
    if (panelObserver) { panelObserver.disconnect(); panelObserver = null; }
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    panelEl = null;
  }

  function watchPanelRemoval() {
    if (panelObserver) panelObserver.disconnect();
    if (!panelEl || !panelEl.parentNode) return;
    panelObserver = new MutationObserver(() => {
      if (!document.body.contains(panelEl)) {
        panelObserver.disconnect(); panelObserver = null; panelEl = null;
        setTimeout(schedulePanel, 300);
      }
    });
    panelObserver.observe(panelEl.parentNode, { childList: true });
  }

  function updatePanel() {
    if (!panelEl) return;
    const cfg = currentConfig;
    const hs  = cfg && cfg.handshake;
    let html  = '';

    if (!cfg || !hs || hs.state === 'none') {
      html = `
        <div class="vke-row">
          <span class="vke-ico vke-ico--off">🔓</span>
          <span class="vke-txt">Шифрование не настроено</span>
          <button class="vke-btn vke-btn--blue" id="vke-hs">Рукопожатие</button>
        </div>`;
    } else if (hs.state === 'initiated') {
      html = `
        <div class="vke-row">
          <span class="vke-ico">🤝</span>
          <span class="vke-txt">Ожидаем ответа от собеседника…</span>
          <button class="vke-btn vke-btn--ghost" id="vke-cancel">Отменить</button>
        </div>`;
    } else if (hs.state === 'received') {
      html = `
        <div class="vke-col">
          <div class="vke-row">
            <span class="vke-ico">🤝</span>
            <span class="vke-txt"><b>Входящий запрос шифрования</b></span>
          </div>
          <div class="vke-row vke-row--btns">
            <button class="vke-btn vke-btn--blue"  id="vke-accept">Принять</button>
            <button class="vke-btn vke-btn--ghost" id="vke-decline">Отклонить</button>
          </div>
        </div>`;
    } else if (hs.state === 'verifying') {
      html = `
        <div class="vke-col">
          <div class="vke-row">
            <span class="vke-ico">🔑</span>
            <span class="vke-txt">Сверьте эмодзи с собеседником <b>вне ВКонтакте</b>:</span>
          </div>
          <div class="vke-fp" title="Safety Numbers — должны совпасть у обоих">${hs.fingerprint}</div>
          <div class="vke-row vke-row--btns">
            <button class="vke-btn vke-btn--green"  id="vke-confirm">✓ Совпадают</button>
            <button class="vke-btn vke-btn--red"    id="vke-mismatch">✕ Не совпадают</button>
          </div>
        </div>`;
    } else if (hs.state === 'active') {
      const on = cfg.enabled;
      html = `
        <div class="vke-row">
          <span class="vke-ico ${on ? 'vke-ico--on' : 'vke-ico--off'}">${on ? '🔒' : '🔓'}</span>
          <span class="vke-txt ${on ? 'vke-txt--on' : ''}">${on ? 'Шифрование активно' : 'Шифрование выключено'}</span>
          <span class="vke-fp-sm" title="Safety Numbers: ${hs.fingerprint}">${hs.fingerprint}</span>
          <button class="vke-btn vke-btn--ghost" id="vke-toggle">${on ? 'Выкл' : 'Вкл'}</button>
          <button class="vke-btn vke-btn--ghost vke-btn--sm" id="vke-reset" title="Сбросить ключ">↺</button>
        </div>`;
    }

    panelEl.innerHTML = html;
    panelEl.className = 'vke-panel' + (cfg && cfg.enabled ? ' vke-panel--on' : ' vke-panel--off');

    const $ = id => panelEl.querySelector('#' + id);
    $('vke-hs')?.addEventListener('click',      startHandshake);
    $('vke-cancel')?.addEventListener('click',  cancelHandshake);
    $('vke-accept')?.addEventListener('click',  acceptHandshake);
    $('vke-decline')?.addEventListener('click', declineHandshake);
    $('vke-confirm')?.addEventListener('click', confirmFingerprint);
    $('vke-mismatch')?.addEventListener('click',mismatchFingerprint);
    $('vke-toggle')?.addEventListener('click',  toggleEncryption);
    $('vke-reset')?.addEventListener('click',   resetChat);
  }

  // ── Handshake logic ──────────────────────────────────────────────────────

  async function startHandshake() {
    if (!currentChatId) return;
    const kp  = await VKCrypto.generateECDHKeyPair();
    const cfg = currentConfig || defaultConfig();
    cfg.handshake  = { state: 'initiated', myPubKey: kp.publicKey, myPrivKey: kp.privateKey, theirPubKey: '', fingerprint: '' };
    cfg.enabled    = false;
    cfg.passphrase = '';
    currentConfig  = cfg;
    setConfig(currentChatId, cfg);
    updatePanel();
    sendMessage(VKCrypto.buildHandshakeMessage('INIT', kp.publicKey));
  }

  function cancelHandshake() {
    if (!currentChatId) return;
    const cfg = currentConfig || defaultConfig();
    cfg.handshake  = defaultConfig().handshake;
    cfg.passphrase = '';
    cfg.enabled    = false;
    currentConfig  = cfg;
    setConfig(currentChatId, cfg);
    updatePanel();
  }

  async function acceptHandshake() {
    if (!currentChatId || !currentConfig) return;
    const hs = currentConfig.handshake;
    if (hs.state !== 'received' || !hs.theirPubKey) return;
    const kp          = await VKCrypto.generateECDHKeyPair();
    const passphrase  = await VKCrypto.deriveSharedPassphrase(kp.privateKey, hs.theirPubKey);
    const fingerprint = await VKCrypto.computeFingerprint(kp.publicKey, hs.theirPubKey);
    currentConfig.handshake  = { state: 'verifying', myPubKey: kp.publicKey, myPrivKey: kp.privateKey, theirPubKey: hs.theirPubKey, fingerprint };
    currentConfig.passphrase = passphrase;
    currentConfig.enabled    = false;
    setConfig(currentChatId, currentConfig);
    updatePanel();
    sendMessage(VKCrypto.buildHandshakeMessage('ACPT', kp.publicKey));
  }

  function declineHandshake() { cancelHandshake(); }

  function confirmFingerprint() {
    if (!currentChatId || !currentConfig) return;
    if (currentConfig.handshake.state !== 'verifying') return;
    currentConfig.handshake.state = 'active';
    currentConfig.enabled = true;
    setConfig(currentChatId, currentConfig);
    updatePanel();
    scheduleScan();
    scheduleDecrypt();
    notifyPopup();
  }

  function mismatchFingerprint() {
    cancelHandshake();
    showToast('⚠️ Ключи не совпали — возможна атака подмены. Соединение сброшено.');
  }

  function toggleEncryption() {
    if (!currentChatId || !currentConfig) return;
    currentConfig.enabled = !currentConfig.enabled;
    setConfig(currentChatId, currentConfig);
    updatePanel();
    scheduleScan();
    scheduleDecrypt();
    notifyPopup();
  }

  function resetChat() {
    if (!currentChatId) return;
    if (!confirm('Сбросить ключ шифрования для этого чата?')) return;
    cancelHandshake();
  }

  // Scan DOM for incoming handshake messages
  async function checkForHandshakeMessages() {
    const containers = document.querySelectorAll('.MessageText, .MessagePreview');
    for (const c of containers) {
      if (c.dataset.vkHsProcessed) continue;
      const hs = extractHsFromContainer(c);
      if (!hs) continue;
      c.dataset.vkHsProcessed = '1';
      await handleIncomingHandshake(hs.type, hs.pubKey, c);
    }
  }

  function extractHsFromContainer(container) {
    for (let i = 0; i < container.childNodes.length; i++) {
      const node = container.childNodes[i];
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG' &&
          node.alt && node.alt.includes(ENC_EMOJI)) {
        const next = container.childNodes[i + 1];
        if (next && next.nodeType === Node.TEXT_NODE) {
          const txt = next.textContent.trimStart();
          if (txt.startsWith(HS_TEXT_TAG)) {
            const body  = txt.slice(HS_TEXT_TAG.length);
            const colon = body.indexOf(':');
            if (colon >= 0) return { type: body.slice(0, colon), pubKey: body.slice(colon + 1).trim() };
          }
        }
      }
      if (node.nodeType === Node.TEXT_NODE && node.textContent.includes(HS_FULL_PFX)) {
        const parsed = VKCrypto.parseHandshake(node.textContent.trim());
        if (parsed) return parsed;
      }
    }
    return null;
  }

  async function handleIncomingHandshake(type, theirPubKey, container) {
    if (!currentChatId) return;
    renderHsMessage(container, type);
    const cfg = currentConfig || defaultConfig();
    const hs  = cfg.handshake;

    if (type === 'INIT') {
      if (hs.state === 'none') {
        cfg.handshake = { state: 'received', myPubKey: '', myPrivKey: '', theirPubKey, fingerprint: '' };
        cfg.passphrase = ''; cfg.enabled = false;
        currentConfig  = cfg;
        setConfig(currentChatId, cfg);
        updatePanel();
      }
    } else if (type === 'ACPT') {
      if (hs.state !== 'initiated') return;
      const passphrase  = await VKCrypto.deriveSharedPassphrase(hs.myPrivKey, theirPubKey);
      const fingerprint = await VKCrypto.computeFingerprint(hs.myPubKey, theirPubKey);
      cfg.handshake = { state: 'verifying', myPubKey: hs.myPubKey, myPrivKey: hs.myPrivKey, theirPubKey, fingerprint };
      cfg.passphrase = passphrase; cfg.enabled = false;
      currentConfig = cfg;
      setConfig(currentChatId, cfg);
      updatePanel();
    }
  }

  function renderHsMessage(container, type) {
    const isInit = type === 'INIT';
    const wrap   = document.createElement('span');
    wrap.className = 'vke-hs-msg';
    wrap.innerHTML =
      `<span class="vke-hs-ico">${isInit ? '🤝' : '✅'}</span>` +
      `<span class="vke-hs-lbl">${isInit ? 'Запрос шифрования' : 'Ключи переданы'}</span>`;
    container.textContent = '';
    container.appendChild(wrap);
  }

  // ── Message sending ──────────────────────────────────────────────────────

  function findInput() {
    const sels = [
      'span.ComposerInput__input','span.ConvoComposer__input',
      '[contenteditable="true"][role="textbox"]','.im_editable',
      '[contenteditable="true"][class*="im-chat-input"]',
      '.im-page [contenteditable="true"]',
    ];
    for (const s of sels) { const el = document.querySelector(s); if (el) return el; }
    return null;
  }

  function getInputText(el) {
    return (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? el.value : (el.innerText || el.textContent);
  }

  function setInputText(el, text) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.focus();
      const sel = window.getSelection(), r = document.createRange();
      r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  }

  function simulateEnter(el) {
    ['keydown','keypress','keyup'].forEach(t =>
      el.dispatchEvent(new KeyboardEvent(t, { key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true }))
    );
  }

  function sendMessage(text) {
    const el = findInput();
    if (!el) return;
    setInputText(el, text);
    setTimeout(() => simulateEnter(el), 80);
  }

  // ── Send interceptor ─────────────────────────────────────────────────────

  function isFocused(el) {
    return document.activeElement === el || el.contains(document.activeElement);
  }

  function setupSendInterceptor() {
    document.addEventListener('keydown', async e => {
      if (!currentConfig?.enabled || !currentConfig?.passphrase) return;
      if (e.key !== 'Enter' || e.shiftKey) return;
      const el = findInput();
      if (!el || !isFocused(el)) return;
      const text = getInputText(el);
      if (!text?.trim() || text.trim().startsWith(ENC_FULL_PFX) || text.trim().startsWith(HS_FULL_PFX)) return;
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      try {
        const enc = await VKCrypto.encrypt(text.trim(), currentConfig.passphrase);
        setInputText(el, enc);
        await new Promise(r => setTimeout(r, 100));
        simulateEnter(el);
        postSendScans();
      } catch (err) { console.error('[VKE] encrypt error', err); }
    }, true);

    document.addEventListener('click', async e => {
      if (!currentConfig?.enabled || !currentConfig?.passphrase) return;
      const btn = e.target.closest(
        '[class*="ConvoComposer__sendButton"],[class*="ConvoComposer__buttonIcon--submit"],' +
        '[class*="im-send-btn"],[data-testid="msg_send_button"],[class*="SendButton"]'
      );
      if (!btn) return;
      const el = findInput();
      if (!el) return;
      const text = getInputText(el);
      if (!text?.trim() || text.trim().startsWith(ENC_FULL_PFX) || text.trim().startsWith(HS_FULL_PFX)) return;
      e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
      try {
        const enc = await VKCrypto.encrypt(text.trim(), currentConfig.passphrase);
        setInputText(el, enc);
        await new Promise(r => setTimeout(r, 100));
        btn.click();
        postSendScans();
      } catch (err) { console.error('[VKE] encrypt error', err); }
    }, true);
  }

  function postSendScans() {
    [400, 1200, 3000].forEach(t => setTimeout(decryptAllMessages, t));
  }

  // ── Decryption ───────────────────────────────────────────────────────────

  function scheduleDecrypt() { setTimeout(decryptAllMessages, 300); }

  function scheduleScan() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = setInterval(() => {
      decryptAllMessages();
      checkForHandshakeMessages();
    }, 2000);
  }

  async function decryptAllMessages() {
    if (!currentConfig?.enabled || !currentConfig?.passphrase) {
      checkForHandshakeMessages();
      return;
    }
    if (isScanning) return;
    isScanning = true;
    try {
      for (const c of document.querySelectorAll('.MessageText, .MessagePreview')) {
        if (c.closest('.vke-dec') || c.closest('.vke-locked') || c.dataset.vkEncProcessed) continue;
        await tryDecrypt(c);
      }
      checkForHandshakeMessages();
    } finally { isScanning = false; }
  }

  async function tryDecrypt(container) {
    let encNode = null;
    for (let i = 0; i < container.childNodes.length; i++) {
      const n = container.childNodes[i];
      if (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'IMG' && n.alt?.includes(ENC_EMOJI)) {
        const nxt = container.childNodes[i + 1];
        if (nxt?.nodeType === Node.TEXT_NODE && nxt.textContent.trimStart().startsWith(ENC_TEXT_TAG)) {
          encNode = nxt; break;
        }
      }
      if (n.nodeType === Node.TEXT_NODE && n.textContent.includes(ENC_FULL_PFX)) { encNode = n; break; }
    }
    if (!encNode) return;

    const raw = encNode.textContent.trimStart();
    let payload;
    if (raw.startsWith(ENC_TEXT_TAG)) {
      const m = raw.slice(ENC_TEXT_TAG.length).match(/^[A-Za-z0-9+/=]+/);
      if (!m) return;
      payload = ENC_FULL_PFX + m[0];
    } else {
      const idx = raw.indexOf(ENC_FULL_PFX);
      const m   = idx >= 0 ? raw.slice(idx + ENC_FULL_PFX.length).match(/^[A-Za-z0-9+/=]+/) : null;
      if (!m) return;
      payload = ENC_FULL_PFX + m[0];
    }

    const plaintext = await VKCrypto.decrypt(payload, currentConfig.passphrase);
    container.dataset.vkEncProcessed = '1';

    if (plaintext !== null) {
      const wrap = document.createElement('span');
      wrap.className = 'vke-dec';
      const t = document.createElement('span');
      t.textContent = plaintext;
      const b = document.createElement('span');
      b.className = 'vke-badge vke-badge--ok';
      b.title = 'Расшифровано · VK Шифратор';
      b.textContent = '🔓';
      wrap.append(t, b);
      container.textContent = '';
      container.appendChild(wrap);
    } else {
      const b = document.createElement('span');
      b.className = 'vke-badge vke-badge--locked';
      b.title = 'Зашифровано — нет ключа для этого чата';
      b.textContent = '🔐';
      container.appendChild(b);
      container.classList.add('vke-locked');
    }
  }

  // ── MutationObserver ─────────────────────────────────────────────────────

  function setupMutationObserver() {
    let deb = null;
    const obs = new MutationObserver(mutations => {
      let needsScan = false;
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (needsScan) break;
          const txt = n.nodeType === Node.TEXT_NODE
            ? n.textContent
            : (n.innerText || n.textContent || '');
          if (txt.includes(ENC_TEXT_TAG) || txt.includes(HS_TEXT_TAG) ||
              n.querySelector?.('.MessageText, .MessagePreview')) {
            needsScan = true;
          }
        }
        if (needsScan) break;
      }
      if (needsScan) {
        clearTimeout(deb);
        deb = setTimeout(() => { decryptAllMessages(); checkForHandshakeMessages(); }, 150);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'vke-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('vke-toast--show'), 10);
    setTimeout(() => { t.classList.remove('vke-toast--show'); setTimeout(() => t.remove(), 400); }, 4500);
  }

  // ── Popup communication ───────────────────────────────────────────────────

  function notifyPopup() {
    chrome.runtime.sendMessage({ type: 'VKE_STATE', chatId: currentChatId, config: currentConfig, allChats }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'VKE_GET_STATE')   notifyPopup();
    if (msg.type === 'VKE_HS_START')    startHandshake();
    if (msg.type === 'VKE_HS_CANCEL')   cancelHandshake();
    if (msg.type === 'VKE_HS_ACCEPT')   acceptHandshake();
    if (msg.type === 'VKE_FP_CONFIRM')  confirmFingerprint();
    if (msg.type === 'VKE_TOGGLE' && currentChatId && currentConfig) {
      currentConfig.enabled = !currentConfig.enabled;
      setConfig(currentChatId, currentConfig);
      updatePanel(); scheduleScan(); notifyPopup();
    }
    if (msg.type === 'VKE_RESET_CHAT' && msg.chatId) {
      delete allChats[msg.chatId];
      saveAllChats();
      if (msg.chatId === currentChatId) {
        currentConfig = null; updatePanel();
        if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
      }
    }
    if (msg.type === 'VKE_SET_PASSPHRASE' && msg.chatId && msg.passphrase) {
      const cfg = allChats[msg.chatId] || defaultConfig();
      cfg.passphrase = msg.passphrase; cfg.enabled = true; cfg.handshake.state = 'active';
      setConfig(msg.chatId, cfg);
      if (msg.chatId === currentChatId) {
        currentConfig = cfg; updatePanel(); scheduleScan(); scheduleDecrypt();
      }
    }
  });

  chrome.storage.onChanged.addListener(changes => {
    if (changes.vkEncChats) {
      allChats = changes.vkEncChats.newValue || {};
      currentConfig = getConfig(currentChatId);
      updatePanel(); scheduleScan();
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    watchNavigation();
    setupSendInterceptor();
    setupMutationObserver();
    onUrlChange();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
