let activeGuildId = null;

// ==========================================
// 1. INITIALISIERUNG & SERVER-LISTE LADEN
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadUserDataAndGuilds();
});

async function loadUserDataAndGuilds() {
  try {
    const res = await fetch('/api/guilds');
    
    // Falls Session abgelaufen oder nicht eingeloggt -> Redirect
    if (res.status === 401) {
      window.location.href = '/auth/discord/login';
      return;
    }

    if (!res.ok) {
      console.error('Fehler beim Abrufen der Serverdaten.');
      return;
    }

    const data = await res.json();

    // User Profile oben rechts eintragen
    if (data.user) {
      const nameElem = document.getElementById('user-name');
      const avatarElem = document.getElementById('user-avatar');

      if (nameElem) nameElem.textContent = data.user.username;
      if (avatarElem) {
        avatarElem.src = data.user.avatar 
          ? `https://cdn.discordapp.com/avatars/${data.user.id}/${data.user.avatar}.png`
          : 'https://cdn.discordapp.com/embed/avatars/0.png';
      }
    }

    // Serverliste rendern
    const guildListContainer = document.getElementById('guild-list');
    if (!guildListContainer) return;

    guildListContainer.innerHTML = '';

    if (!data.guilds || data.guilds.length === 0) {
      guildListContainer.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px 0;">
          <p>Keine Server gefunden, auf denen du Administrator-Rechte hast.</p>
        </div>
      `;
      return;
    }

    data.guilds.forEach(guild => {
      const iconUrl = guild.icon || 'https://cdn.discordapp.com/embed/avatars/0.png';
      
      const card = document.createElement('div');
      card.className = 'guild-card';
      card.innerHTML = `
        <div class="guild-info">
          <img src="${iconUrl}" class="guild-icon" alt="${guild.name}">
          <div>
            <h3 style="font-size: 1rem; font-weight: 700;">${guild.name}</h3>
          </div>
        </div>
        <button class="btn btn-primary" onclick="openManagement('${guild.id}', '${guild.name.replace(/'/g, "\\'")}', '${iconUrl}')">
          Verwalten
        </button>
      `;
      guildListContainer.appendChild(card);
    });

  } catch (err) {
    console.error('Fehler beim Verbinden mit der API:', err);
  }
}

// ==========================================
// 2. UI & TAB STEUERUNG
// ==========================================

function showToast(message = '✓ Erfolgreich gespeichert!') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add('show');
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000); // Blendet sich nach 3 Sekunden automatisch aus
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
  document.querySelectorAll('.module-page').forEach((page) => page.classList.add('hidden'));

  const activeBtn = document.querySelector(`[data-tab="${tabName}"]`);
  const activePage = document.getElementById(`mod-${tabName}`);

  if (activeBtn) activeBtn.classList.add('active');
  if (activePage) activePage.classList.remove('hidden');
}

async function openManagement(guildId, name, iconUrl) {
  activeGuildId = guildId;

  const activeNameElem = document.getElementById('active-guild-name');
  const activeIconElem = document.getElementById('active-guild-icon');
  const overlayElem = document.getElementById('manage-overlay');

  if (activeNameElem) activeNameElem.textContent = name;
  if (activeIconElem) activeIconElem.src = iconUrl;
  if (overlayElem) overlayElem.classList.remove('hidden');

  switchTab('overview');
  await loadSettings(guildId);
}

function closeManagement() {
  activeGuildId = null;
  const overlayElem = document.getElementById('manage-overlay');
  if (overlayElem) overlayElem.classList.add('hidden');
}

// ==========================================
// 3. EINSTELLUNGEN LADEN & SPEICHERN
// ==========================================

async function loadSettings(guildId) {
  try {
    const res = await fetch(`/api/guild/${guildId}/config`);
    if (!res.ok) return;

    const data = await res.json();
    
    // Willkommen
    if (data.welcome) {
      document.getElementById('welcome-channel').value = data.welcome.channelId || '';
      document.getElementById('welcome-text').value = data.welcome.text || '';
      document.getElementById('welcome-color').value = data.welcome.color || '#5865F2';
      document.getElementById('welcome-image').value = data.welcome.image || '';
      document.getElementById('welcome-avatar-thumbnail').checked = !!data.welcome.avatarThumbnail;
      document.getElementById('welcome-autoroles').value = (data.welcome.autoroles || []).join(', ');
    } else {
      resetFields(['welcome-channel', 'welcome-text', 'welcome-image', 'welcome-autoroles']);
      document.getElementById('welcome-color').value = '#5865F2';
      document.getElementById('welcome-avatar-thumbnail').checked = false;
    }

    // Leave
    if (data.leave) {
      document.getElementById('leave-channel').value = data.leave.channelId || '';
      document.getElementById('leave-text').value = data.leave.text || '';
      document.getElementById('leave-color').value = data.leave.color || '#ED4245';
      document.getElementById('leave-image').value = data.leave.image || '';
      document.getElementById('leave-avatar-thumbnail').checked = !!data.leave.avatarThumbnail;
    } else {
      resetFields(['leave-channel', 'leave-text', 'leave-image']);
      document.getElementById('leave-color').value = '#ED4245';
      document.getElementById('leave-avatar-thumbnail').checked = false;
    }

    // Tickets
    if (data.tickets) {
      document.getElementById('ticket-embed-channel').value = data.tickets.embedChannel || '';
      document.getElementById('ticket-embed-text').value = data.tickets.embedText || '';
      document.getElementById('ticket-category').value = data.tickets.category || '';
      document.getElementById('ticket-welcome-msg').value = data.tickets.welcomeMsg || '';
    } else {
      resetFields(['ticket-embed-channel', 'ticket-embed-text', 'ticket-category', 'ticket-welcome-msg']);
    }

    // Teamliste
    if (data.teamlist) {
      document.getElementById('teamlist-channel').value = data.teamlist.channelId || '';
      document.getElementById('teamlist-roles').value = (data.teamlist.roles || []).join(', ');
    } else {
      resetFields(['teamlist-channel', 'teamlist-roles']);
    }

  } catch (err) {
    console.error('Fehler beim Laden der Server-Konfiguration:', err);
  }
}

async function saveModuleSettings(moduleType) {
  if (!activeGuildId) return;

  let bodyData = {};

  if (moduleType === 'welcome') {
    bodyData = {
      channelId: document.getElementById('welcome-channel').value.trim(),
      text: document.getElementById('welcome-text').value,
      color: document.getElementById('welcome-color').value,
      image: document.getElementById('welcome-image').value.trim(),
      avatarThumbnail: document.getElementById('welcome-avatar-thumbnail').checked,
      autoroles: document.getElementById('welcome-autoroles').value.split(',').map(s => s.trim()).filter(Boolean)
    };
  } else if (moduleType === 'leave') {
    bodyData = {
      channelId: document.getElementById('leave-channel').value.trim(),
      text: document.getElementById('leave-text').value,
      color: document.getElementById('leave-color').value,
      image: document.getElementById('leave-image').value.trim(),
      avatarThumbnail: document.getElementById('leave-avatar-thumbnail').checked
    };
  } else if (moduleType === 'tickets') {
    bodyData = {
      embedChannel: document.getElementById('ticket-embed-channel').value.trim(),
      embedText: document.getElementById('ticket-embed-text').value,
      category: document.getElementById('ticket-category').value.trim(),
      welcomeMsg: document.getElementById('ticket-welcome-msg').value
    };
  } else if (moduleType === 'teamlist') {
    bodyData = {
      channelId: document.getElementById('teamlist-channel').value.trim(),
      roles: document.getElementById('teamlist-roles').value.split(',').map(s => s.trim()).filter(Boolean)
    };
  }

  try {
    const res = await fetch(`/api/guild/${activeGuildId}/config/${moduleType}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyData)
    });

    if (res.ok) {
      showToast('✓ Einstellungen erfolgreich gespeichert!');
    } else {
      showToast('❌ Fehler beim Speichern!');
    }
  } catch (err) {
    console.error('Fehler beim Speichern:', err);
    showToast('❌ Netzwerkfehler!');
  }
}

function resetFields(fieldIds) {
  fieldIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}
