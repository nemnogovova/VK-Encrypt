document.addEventListener('DOMContentLoaded', () => {
  const keyInput = document.getElementById('encryptionKey');
  const enabledCheckbox = document.getElementById('encryptionEnabled');
  const saveBtn = document.getElementById('saveBtn');
  const toggleVisibility = document.getElementById('toggleKeyVisibility');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  // Load saved settings
  chrome.storage.local.get(['vkEncKey', 'vkEncEnabled'], (data) => {
    if (data.vkEncKey) {
      keyInput.value = data.vkEncKey;
    }
    if (data.vkEncEnabled) {
      enabledCheckbox.checked = true;
    }
    updateStatus();
  });

  // Toggle key visibility
  toggleVisibility.addEventListener('click', () => {
    if (keyInput.type === 'password') {
      keyInput.type = 'text';
      toggleVisibility.textContent = '🙈';
    } else {
      keyInput.type = 'password';
      toggleVisibility.textContent = '👁';
    }
  });

  // Update status indicator
  function updateStatus() {
    const hasKey = keyInput.value.trim().length > 0;
    const isEnabled = enabledCheckbox.checked;

    if (hasKey && isEnabled) {
      statusDot.classList.add('active');
      statusText.textContent = 'Шифрование активно';
    } else if (hasKey && !isEnabled) {
      statusDot.classList.remove('active');
      statusText.textContent = 'Выключено (ключ задан)';
    } else {
      statusDot.classList.remove('active');
      statusText.textContent = 'Не активно — введите ключ';
    }
  }

  enabledCheckbox.addEventListener('change', updateStatus);
  keyInput.addEventListener('input', updateStatus);

  // Save settings
  saveBtn.addEventListener('click', () => {
    const key = keyInput.value.trim();

    if (!key) {
      chrome.storage.local.set({ vkEncKey: '', vkEncEnabled: false }, () => {
        enabledCheckbox.checked = false;
        updateStatus();
        notifyContentScript();
        showSaved();
      });
      return;
    }

    chrome.storage.local.set({
      vkEncKey: key,
      vkEncEnabled: enabledCheckbox.checked
    }, () => {
      updateStatus();
      notifyContentScript();
      showSaved();
    });
  });

  function notifyContentScript() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'VK_ENC_SETTINGS_UPDATED'
        }).catch(() => {});
      }
    });
  }

  function showSaved() {
    saveBtn.textContent = '✓ Сохранено';
    saveBtn.style.background = '#4bb34b';
    setTimeout(() => {
      saveBtn.textContent = 'Сохранить';
      saveBtn.style.background = '';
    }, 1500);
  }
});
