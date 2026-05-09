/**
 * VK Шифратор — Popup Script
 */

document.addEventListener('DOMContentLoaded', () => {

  // ── State from content script ──────────────────────────────────────────
  let state = {
    chatId:   null,
    config:   null,
    allChats: {},
    onPage:   false
  };

  // ── Element refs ──────────────────────────────────────────────────────
  const el = id => document.getElementById(id);

  const STATES = ['nopage','nochat','none','initiated','received','verifying','active'];

  function showState(name) {
    STATES.forEach(s => el('state-' + s)?.classList.add('hidden'));
    el('state-' + name)?.classList.remove('hidden');
  }

  // ── Render ────────────────────────────────────────────────────────────

  function render() {
    renderCurrentChat();
    renderChatsList();
  }

  function renderCurrentChat() {
    const { chatId, config, onPage } = state;

    if (!onPage) { showState('nopage'); return; }
    if (!chatId)  { showState('nochat'); return; }

    const hs = config?.handshake;
    const hsState = hs?.state || 'none';

    if (!config || hsState === 'none') {
      showState('none');
      return;
    }

    if (hsState === 'initiated') {
      showState('initiated');
      return;
    }

    if (hsState === 'received') {
      showState('received');
      return;
    }

    if (hsState === 'verifying') {
      showState('verifying');
      el('fp-display').textContent = hs.fingerprint || '';
      return;
    }

    if (hsState === 'active') {
      showState('active');
      const on = config.enabled;
      el('active-dot').className = 'p-status-dot ' + (on ? 'p-status-dot--on' : 'p-status-dot--off');
      el('active-title').textContent = on ? 'Шифрование активно' : 'Шифрование выключено';
      el('chk-enabled').checked = on;
      el('fp-active').textContent = hs.fingerprint || '';
      return;
    }

    showState('none');
  }

  function renderChatsList() {
    const list  = el('chats-list');
    const empty = el('chats-empty');
    const chats = state.allChats || {};
    const ids   = Object.keys(chats);

    list.innerHTML = '';

    if (ids.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    ids.forEach(id => {
      const c  = chats[id];
      const hs = c.handshake || {};
      const stateLabel = {
        none:      'Нет ключа',
        initiated: 'Ожидание…',
        received:  'Запрос',
        verifying: 'Сверка',
        active:    c.enabled ? '🔒 Активно' : '🔓 Выкл'
      }[hs.state || 'none'] || '—';

      const dot = c.enabled ? '🟢' : '⚪';

      const item = document.createElement('div');
      item.className = 'p-chat-item';
      item.innerHTML = `
        <span class="p-chat-id">Чат ${id}</span>
        <span class="p-chat-state">${stateLabel}</span>
        <button class="p-chat-del" data-id="${id}" title="Удалить">✕</button>
      `;
      list.appendChild(item);
    });

    list.querySelectorAll('.p-chat-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (!confirm(`Сбросить ключ для чата ${id}?`)) return;
        sendToContent({ type: 'VKE_RESET_CHAT', chatId: id });
        delete state.allChats[id];
        if (state.chatId === id) { state.config = null; }
        render();
      });
    });
  }

  // ── Message to content script ─────────────────────────────────────────

  function sendToContent(msg) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
    });
  }

  // ── Button handlers ───────────────────────────────────────────────────

  el('btn-hs-start')?.addEventListener('click', () => {
    sendToContent({ type: 'VKE_HS_START' });
    // Optimistic UI
    if (!state.config) state.config = { enabled: false, passphrase: '', handshake: { state: 'none', myPubKey: '', myPrivKey: '', theirPubKey: '', fingerprint: '' } };
    state.config.handshake.state = 'initiated';
    render();
  });

  el('btn-hs-cancel')?.addEventListener('click', () => {
    sendToContent({ type: 'VKE_HS_CANCEL' });
    if (state.config) state.config.handshake.state = 'none';
    render();
  });

  el('btn-hs-accept')?.addEventListener('click', () => {
    sendToContent({ type: 'VKE_HS_ACCEPT' });
    if (state.config) state.config.handshake.state = 'verifying';
    render();
  });

  el('btn-hs-decline')?.addEventListener('click', () => {
    sendToContent({ type: 'VKE_HS_CANCEL' });
    if (state.config) state.config.handshake.state = 'none';
    render();
  });

  el('btn-fp-ok')?.addEventListener('click', () => {
    sendToContent({ type: 'VKE_FP_CONFIRM' });
    if (state.config) {
      state.config.handshake.state = 'active';
      state.config.enabled = true;
    }
    render();
  });

  el('btn-fp-bad')?.addEventListener('click', () => {
    sendToContent({ type: 'VKE_HS_CANCEL' });
    if (state.config) state.config.handshake.state = 'none';
    showToast('⚠️ Ключи сброшены');
    render();
  });

  el('chk-enabled')?.addEventListener('change', () => {
    sendToContent({ type: 'VKE_TOGGLE' });
    if (state.config) state.config.enabled = el('chk-enabled').checked;
    render();
  });

  el('btn-reset')?.addEventListener('click', () => {
    if (!state.chatId) return;
    if (!confirm('Сбросить ключ шифрования для этого чата?')) return;
    sendToContent({ type: 'VKE_RESET_CHAT', chatId: state.chatId });
    state.config = null;
    render();
  });

  // ── Toast ─────────────────────────────────────────────────────────────

  function showToast(msg) {
    let t = document.querySelector('.p-toast');
    if (!t) { t = document.createElement('div'); t.className = 'p-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:6px 14px;border-radius:6px;font-size:12px;z-index:999;transition:opacity .3s;';
    setTimeout(() => t.style.opacity = '0', 2000);
    setTimeout(() => t.remove(), 2400);
  }

  // ── Listen for state from content script ──────────────────────────────

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'VKE_STATE') {
      state.chatId   = msg.chatId   || null;
      state.config   = msg.config   || null;
      state.allChats = msg.allChats || {};
      state.onPage   = true;
      render();
    }
  });

  // ── Init: request current state ───────────────────────────────────────

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]) { render(); return; }
    const url = tabs[0].url || '';
    state.onPage = url.includes('vk.com/im');
    chrome.tabs.sendMessage(tabs[0].id, { type: 'VKE_GET_STATE' }, () => {
      if (chrome.runtime.lastError) {
        // Content script not loaded (not on VK)
        state.onPage = false;
        render();
      }
    });
  });

  // Fallback render
  setTimeout(() => { if (!el('state-active')?.classList.contains('hidden') === false) render(); }, 300);
});
