/**
 * VK Шифратор — Popup Script (v2)
 * Reads state directly from chrome.storage; sends commands to content script.
 */

document.addEventListener('DOMContentLoaded', () => {

  // ── State ──────────────────────────────────────────────────────────────
  // config is the flat ChatConfig: { state, enabled, fingerprint, … }
  let state = { chatId: null, config: null, allChats: {}, onPage: false, tabId: null };

  const el    = id => document.getElementById(id);
  const STATES = ['nopage', 'nochat', 'none', 'initiated', 'received', 'verifying', 'active'];

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

    if (!onPage)  { showState('nopage');  return; }
    if (!chatId)  { showState('nochat');  return; }

    const hsState = config?.state || 'none';

    if (!config || hsState === 'none') { showState('none'); return; }

    if (hsState === 'initiated') { showState('initiated'); return; }

    if (hsState === 'received')  { showState('received');  return; }

    if (hsState === 'verifying') {
      showState('verifying');
      el('fp-display').textContent = config.fingerprint || '';
      return;
    }

    if (hsState === 'active') {
      showState('active');
      const on = !!config.enabled;
      el('active-dot').className   = 'p-status-dot ' + (on ? 'p-status-dot--on' : 'p-status-dot--off');
      el('active-title').textContent = on ? 'Шифрование активно' : 'Шифрование выключено';
      el('chk-enabled').checked    = on;
      el('fp-active').textContent  = config.fingerprint || '';
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
      const c = chats[id];
      const stateLabel = {
        none:      'Нет ключа',
        initiated: 'Ожидание…',
        received:  'Запрос',
        verifying: 'Сверка',
        active:    c.enabled ? '🔒 Активно' : '🔓 Выкл'
      }[c.state || 'none'] || '—';

      const item = document.createElement('div');
      item.className = 'p-chat-item';
      item.innerHTML =
        '<span class="p-chat-id">Чат ' + id + '</span>' +
        '<span class="p-chat-state">' + stateLabel + '</span>' +
        '<button class="p-chat-del" data-id="' + id + '" title="Удалить">✕</button>';
      list.appendChild(item);
    });

    list.querySelectorAll('.p-chat-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (!confirm('Сбросить ключ для чата ' + id + '?')) return;
        chrome.storage.local.get(['vkEncChats'], data => {
          const chats = data.vkEncChats || {};
          delete chats[id];
          chrome.storage.local.set({ vkEncChats: chats }, () => {
            if (state.chatId === id) state.config = null;
            delete state.allChats[id];
            sendToContent({ type: 'VKE_RESET_CHAT', chatId: id });
            render();
          });
        });
      });
    });
  }

  // ── Content script communication ──────────────────────────────────────

  function sendToContent(msg) {
    if (state.tabId) {
      chrome.tabs.sendMessage(state.tabId, msg).catch(() => {});
    }
  }

  // ── Button handlers ───────────────────────────────────────────────────

  el('btn-hs-start')?.addEventListener('click',  () => sendToContent({ type: 'VKE_HS_START' }));
  el('btn-hs-cancel')?.addEventListener('click', () => sendToContent({ type: 'VKE_HS_CANCEL' }));
  el('btn-hs-accept')?.addEventListener('click', () => sendToContent({ type: 'VKE_HS_ACCEPT' }));
  el('btn-hs-decline')?.addEventListener('click',() => sendToContent({ type: 'VKE_HS_DECLINE' }));

  el('btn-fp-ok')?.addEventListener('click', () => sendToContent({ type: 'VKE_FP_CONFIRM' }));

  el('btn-fp-bad')?.addEventListener('click', () => {
    sendToContent({ type: 'VKE_HS_CANCEL' });
    showToast('⚠️ Ключи сброшены — безопасность нарушена');
  });

  el('chk-enabled')?.addEventListener('change', () => sendToContent({ type: 'VKE_TOGGLE' }));

  el('btn-reset')?.addEventListener('click', () => {
    if (!state.chatId) return;
    if (!confirm('Сбросить ключ шифрования для этого чата?')) return;
    sendToContent({ type: 'VKE_RESET_CHAT', chatId: state.chatId });
  });

  // ── Storage change listener (real-time UI sync) ───────────────────────

  chrome.storage.onChanged.addListener(changes => {
    if (!changes.vkEncChats) return;
    state.allChats = changes.vkEncChats.newValue || {};
    state.config   = state.chatId ? (state.allChats[state.chatId] || null) : null;
    render();
  });

  // ── Toast ─────────────────────────────────────────────────────────────

  function showToast(msg) {
    let t = document.querySelector('.p-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'p-toast';
      document.body.appendChild(t);
      t.style.cssText =
        'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);' +
        'background:#333;color:#fff;padding:6px 14px;border-radius:6px;' +
        'font-size:12px;z-index:9999;transition:opacity .3s;';
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2200);
  }

  // ── Init: read tab URL + storage ─────────────────────────────────────

  function extractChatId(url) {
    let m = url.match(/[?&]sel=([^&#]+)/);
    if (m) return m[1];
    m = url.match(/\/im\/convo\/(\d+)/);
    if (m) return m[1];
    return null;
  }

  function loadState() {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab) { render(); return; }

      state.tabId  = tab.id;
      state.onPage = (tab.url || '').includes('vk.com/im');
      state.chatId = extractChatId(tab.url || '');

      chrome.storage.local.get(['vkEncChats'], data => {
        state.allChats = data.vkEncChats || {};
        state.config   = state.chatId ? (state.allChats[state.chatId] || null) : null;
        render();
      });
    });
  }

  loadState();
});
