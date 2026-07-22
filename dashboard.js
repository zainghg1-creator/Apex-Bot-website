let activeGuildId = null;

function showToast(message = '✓ Erfolgreich gespeichert!') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000); // Geht nach 3 Sekunden automatisch weg
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
  document.querySelectorAll('.module-page').forEach((page) => page.classList.add('hidden'));

  document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');
  document.getElementById(`mod-${tabName}`)?.classList.remove('hidden');
}

async function openManagement(guildId, name, iconUrl) {
  activeGuildId = guildId;
  document.getElementById('active-guild-name').textContent = name;
  document.getElementById('active-guild-icon').src = iconUrl;
  document.getElementById('manage-overlay').classList.remove('hidden');

  loadSettings(guildId);
}

function closeManagement() {
  activeGuildId = null;
  document.getElementById('manage-overlay').classList.add('hidden');
}

async function loadSettings(guildId) {
  try {
    const res = await fetch(`/api/guild/${guildId}/config`);
    if (res.ok) {
      const data = await res.json();
      
      // Willkommen
      if(data.welcome) {
        document.getElementById('welcome-channel').value = data.welcome.channelId || '';
        document.getElementById('welcome-text').value = data.welcome.text || '';
        document.getElementById('welcome-color').value = data.welcome.color || '#5865F2';
        document.getElementById('welcome-image').value = data.welcome.image || '';
        document.getElementById('welcome-avatar-thumbnail').checked = !!data.welcome.avatarThumbnail;
        document.getElementById('welcome-autoroles').value = (data.welcome.autoroles || []).join(',');
      }

      // Leave
      if(data.leave) {
        document.getElementById('leave-channel').value = data.leave.channelId || '';
        document.getElementById('leave-text').value = data.leave.text || '';
        document.getElementById('leave-color').value = data.leave.color || '#ED4245';
        document.getElementById('leave-image').value = data.leave.image || '';
        document.getElementById('leave-avatar-thumbnail').checked = !!data.leave.avatarThumbnail;
      }

      // Tickets
      if(data.tickets) {
        document.getElementById('ticket-embed-channel').value = data.tickets.embedChannel || '';
        document.getElementById('ticket-embed-text').value = data.tickets.embedText || '';
        document.getElementById('ticket-category').value = data.tickets.category || '';
        document.getElementById('ticket-welcome-msg').value = data.tickets.welcomeMsg || '';
      }

      // Teamliste
      if(data.teamlist) {
        document.getElementById('teamlist-channel').value = data.teamlist.channelId || '';
        document.getElementById('teamlist-roles').value = (data.teamlist.roles || []).join(',');
      }
    }
  } catch (err) {
    console.error('Fehler beim Laden der Config:', err);
  }
}

async function saveModuleSettings(moduleType) {
  if (!activeGuildId) return;

  let bodyData = {};

  if (moduleType === 'welcome') {
    bodyData = {
      channelId: document.getElementById('welcome-channel').value,
      text: document.getElementById('welcome-text').value,
      color: document.getElementById('welcome-color').value,
      image: document.getElementById('welcome-image').value,
      avatarThumbnail: document.getElementById('welcome-avatar-thumbnail').checked,
      autoroles: document.getElementById('welcome-autoroles').value.split(',').map(s => s.trim()).filter(Boolean)
    };
  } else if (moduleType === 'leave') {
    bodyData = {
      channelId: document.getElementById('leave-channel').value,
      text: document.getElementById('leave-text').value,
      color: document.getElementById('leave-color').value,
      image: document.getElementById('leave-image').value,
      avatarThumbnail: document.getElementById('leave-avatar-thumbnail').checked
    };
  } else if (moduleType === 'tickets') {
    bodyData = {
      embedChannel: document.getElementById('ticket-embed-channel').value,
      embedText: document.getElementById('ticket-embed-text').value,
      category: document.getElementById('ticket-category').value,
      welcomeMsg: document.getElementById('ticket-welcome-msg').value
    };
  } else if (moduleType === 'teamlist') {
    bodyData = {
      channelId: document.getElementById('teamlist-channel').value,
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
      showToast(); // Toast-Animation auslösen
    }
  } catch (err) {
    console.error('Fehler beim Speichern:', err);
  }
}
