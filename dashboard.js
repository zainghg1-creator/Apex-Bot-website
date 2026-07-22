// Dashboard Client JS
let currentGuildId = null;

document.addEventListener('DOMContentLoaded', () => {
  initUser();
  initGuilds();
  initTabs();
  initColorSync();
  initFormListeners();
});

// Sicheres HTML Escaping (Fix: XSS Schutz)
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// User Profile laden
async function initUser() {
  try {
    const res = await fetch('/api/user');
    if (!res.ok) {
      window.location.href = '/auth/discord/login';
      return;
    }
    const user = await res.json();
    const userNameEl = document.getElementById('user-name');
    const userAvatarEl = document.getElementById('user-avatar');

    if (userNameEl) userNameEl.textContent = `${user.username}`;
    if (userAvatarEl && user.avatar) {
      userAvatarEl.src = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
    }
  } catch (err) {
    console.error('Fehler beim Laden des Users:', err);
  }
}

// Admin-Gilden laden
async function initGuilds() {
  try {
    const res = await fetch('/api/user/guilds');
    if (!res.ok) return;

    const guilds = await res.json();
    const select = document.getElementById('server-select');
    if (!select) return;

    select.innerHTML = '';

    if (guilds.length === 0) {
      select.innerHTML = '<option value="">Keine Admin-Server gefunden</option>';
      return;
    }

    guilds.forEach((guild) => {
      const opt = document.createElement('option');
      opt.value = guild.id;
      opt.textContent = guild.name;
      select.appendChild(opt);
    });

    currentGuildId = guilds[0].id;
    select.value = currentGuildId;

    select.addEventListener('change', (e) => {
      currentGuildId = e.target.value;
      loadGuildConfig(currentGuildId);
    });

    loadGuildConfig(currentGuildId);
  } catch (err) {
    console.error('Fehler beim Laden der Server:', err);
  }
}

// Tab Navigation
function initTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      navItems.forEach((i) => i.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.remove('active'));

      item.classList.add('active');
      const targetTab = item.getAttribute('data-tab');
      const tabEl = document.getElementById(targetTab);
      if (tabEl) tabEl.classList.add('active');

      const titleEl = document.getElementById('page-title');
      if (titleEl) titleEl.textContent = item.textContent;
    });
  });
}

// Hex & Color-Picker Sync
function initColorSync() {
  const colorPicker = document.getElementById('welcome-color');
  const hexInput = document.getElementById('welcome-color-hex');

  if (!colorPicker || !hexInput) return;

  colorPicker.addEventListener('input', (e) => {
    hexInput.value = e.target.value.toUpperCase();
  });

  hexInput.addEventListener('input', (e) => {
    let val = e.target.value.trim();
    if (!val.startsWith('#')) val = '#' + val;
    
    // Unterstützt auch 3-stellige Hex-Codes (#FFF -> #FFFFFF)
    if (/^#[0-9A-Fa-f]{3}$/.test(val)) {
      val = '#' + val[1] + val[1] + val[2] + val[2] + val[3] + val[3];
    }

    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
      colorPicker.value = val;
    }
  });
}

// Config vom Backend laden
async function loadGuildConfig(guildId) {
  if (!guildId) return;

  try {
    const res = await fetch(`/api/guild/${guildId}/config`);
    if (!res.ok) {
      showToast('Fehler beim Laden der Konfiguration', true);
      return;
    }

    const config = await res.json();

    // Welcome Config befüllen
    const w = config.welcome || {};
    setInputValue('welcome-enabled', w.enabled || false, 'checkbox');
    setInputValue('welcome-channel', w.channelId || '');
    setInputValue('welcome-message', w.message || '');
    setInputValue('welcome-color', w.embedColor || '#5865F2');
    setInputValue('welcome-color-hex', w.embedColor || '#5865F2');
    setInputValue('welcome-image-url', w.imageUrl || '');

    // Verification Config befüllen (Sichere Null-Checks)
    const v = config.verification || {};
    setInputValue('verification-enabled', v.enabled || false, 'checkbox');
    setInputValue('verification-channel', v.channelId || '');
    setInputValue('verification-role', v.roleId || '');

    // Anti-Nuke Config befüllen
    const an = config.antinuke || {};
    setInputValue('antinuke-enabled', an.enabled || false, 'checkbox');
    setInputValue('antinuke-max-deletes', an.maxDeletes || 5);

  } catch (err) {
    console.error('Fehler beim Laden der Guild-Config:', err);
  }
}

function setInputValue(id, value, type = 'text') {
  const el = document.getElementById(id);
  if (!el) return;
  if (type === 'checkbox') {
    el.checked = Boolean(value);
  } else {
    el.value = value;
  }
}

// Speicher-Button Event Listener
function initFormListeners() {
  const saveWelcomeBtn = document.getElementById('save-welcome-btn');
  if (saveWelcomeBtn) {
    saveWelcomeBtn.addEventListener('click', () => {
      saveConfigSection('welcome', {
        enabled: document.getElementById('welcome-enabled')?.checked || false,
        channelId: document.getElementById('welcome-channel')?.value.trim() || '',
        message: document.getElementById('welcome-message')?.value.trim() || '',
        embedColor: document.getElementById('welcome-color-hex')?.value.trim() || '#5865F2',
        imageUrl: document.getElementById('welcome-image-url')?.value.trim() || ''
      });
    });
  }

  const saveVerificationBtn = document.getElementById('save-verification-btn');
  if (saveVerificationBtn) {
    saveVerificationBtn.addEventListener('click', () => {
      saveConfigSection('verification', {
        enabled: document.getElementById('verification-enabled')?.checked || false,
        channelId: document.getElementById('verification-channel')?.value.trim() || '',
        roleId: document.getElementById('verification-role')?.value.trim() || ''
      });
    });
  }

  const saveAntinukeBtn = document.getElementById('save-antinuke-btn');
  if (saveAntinukeBtn) {
    saveAntinukeBtn.addEventListener('click', () => {
      saveConfigSection('antinuke', {
        enabled: document.getElementById('antinuke-enabled')?.checked || false,
        maxDeletes: parseInt(document.getElementById('antinuke-max-deletes')?.value || '5', 10)
      });
    });
  }
}

// Config im Backend speichern
async function saveConfigSection(section, data) {
  if (!currentGuildId) return;

  try {
    const res = await fetch(`/api/guild/${currentGuildId}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [section]: data })
    });

    if (res.ok) {
      showToast('Einstellungen erfolgreich gespeichert!');
    } else {
      const errData = await res.json();
      showToast(`Fehler beim Speichern: ${errData.message || 'Unbekannter Fehler'}`, true);
    }
  } catch (err) {
    console.error('Speicherfehler:', err);
    showToast('Netzwerkfehler beim Speichern.', true);
  }
}

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.style.backgroundColor = isError ? '#ef4444' : '#22c55e';
  toast.style.display = 'block';

  setTimeout(() => {
    toast.style.display = 'none';
  }, 3000);
}
