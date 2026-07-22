const CLIENT_ID = '1525613011262377994';
const BOT_PERMISSIONS = '8';

const loadingState = document.getElementById('loading-state');
const emptyState = document.getElementById('empty-state');
const errorState = document.getElementById('error-state');
const errorMessage = document.getElementById('error-message');
const guildListEl = document.getElementById('guild-list');
const userChip = document.getElementById('user-chip');
const userAvatar = document.getElementById('user-avatar');
const userName = document.getElementById('user-name');

const manageOverlay = document.getElementById('manage-overlay');
const activeGuildName = document.getElementById('active-guild-name');
const activeGuildIcon = document.getElementById('active-guild-icon');

const overviewMembers = document.getElementById('overview-members');
const overviewBoosts = document.getElementById('overview-boosts');

let activeGuildId = null;

function showState(state) {
  [loadingState, emptyState, errorState, guildListEl].forEach((el) => el?.classList.add('hidden'));
  state?.classList.remove('hidden');
}

async function loadDashboard() {
  showState(loadingState);
  try {
    const res = await fetch('/api/guilds');
    if (!res.ok) {
      if (res.status === 401) return (window.location.href = '/');
      throw new Error('Fehler beim Laden');
    }
    const data = await res.json();
    renderUser(data.user);
    renderGuilds(data.guilds, data.clientId || CLIENT_ID);
  } catch (err) {
    if (errorMessage) errorMessage.textContent = err.message;
    showState(errorState);
  }
}

function renderUser(user) {
  if (!user) return;
  if (userName) userName.textContent = user.username;
  if (userAvatar) {
    userAvatar.src = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';
  }
}

function renderGuilds(guilds, clientId) {
  if (!guilds || guilds.length === 0) return showState(emptyState);

  guildListEl.innerHTML = '';
  guilds.forEach((guild) => {
    const card = document.createElement('div');
    card.className = 'guild-card';

    const iconSrc = guild.icon || 'https://cdn.discordapp.com/embed/avatars/0.png';

    card.innerHTML = `
      <div class="guild-info">
        <img src="${iconSrc}" class="guild-icon" alt="${guild.name}">
        <span class="guild-name">${guild.name}</span>
      </div>
      <div class="guild-action">
        ${
          guild.botIstDrauf
            ? `<button class="btn btn-primary" onclick="openManagement('${guild.id}', '${escapeHtml(guild.name)}', '${iconSrc}')">Verwalten</button>`
            : `<a href="https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${BOT_PERMISSIONS}&guild_id=${guild.id}" target="_blank" class="btn btn-secondary">Bot einladen</a>`
        }
      </div>
    `;
    guildListEl.appendChild(card);
  });

  showState(guildListEl);
}

function escapeHtml(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

async function openManagement(guildId, name, iconUrl) {
  activeGuildId = guildId;
  if (activeGuildName) activeGuildName.textContent = name;
  if (activeGuildIcon) activeGuildIcon.src = iconUrl;

  if (overviewMembers) overviewMembers.textContent = '...';
  if (overviewBoosts) overviewBoosts.textContent = '...';

  manageOverlay?.classList.remove('hidden');

  // Lade Serverdetails & Willkommens-Einstellungen
  loadGuildDetails(guildId);
  loadWelcomeSettings(guildId);
}

function closeManagement() {
  activeGuildId = null;
  manageOverlay?.classList.add('hidden');
}

async function loadGuildDetails(guildId) {
  try {
    const res = await fetch(`/api/guild/${guildId}`);
    if (res.ok) {
      const data = await res.json();
      if (overviewMembers) overviewMembers.textContent = data.members ?? '0';
      if (overviewBoosts) overviewBoosts.textContent = data.boosts ?? '0';
    } else {
      if (overviewMembers) overviewMembers.textContent = 'N/A';
      if (overviewBoosts) overviewBoosts.textContent = 'N/A';
    }
  } catch (err) {
    if (overviewMembers) overviewMembers.textContent = 'N/A';
    if (overviewBoosts) overviewBoosts.textContent = 'N/A';
  }
}

// Module Tabs wechseln
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
  document.querySelectorAll('.module-page').forEach((page) => page.classList.add('hidden'));

  const activeBtn = document.querySelector(`[data-tab="${tabName}"]`);
  const activePage = document.getElementById(`mod-${tabName}`);

  if (activeBtn) activeBtn.classList.add('active');
  if (activePage) activePage.classList.remove('hidden');
}

// Willkommens-Modul Logik
async function loadWelcomeSettings(guildId) {
  try {
    const res = await fetch(`/api/guild/${guildId}/welcome`);
    if (res.ok) {
      const data = await res.json();
      const txt = document.getElementById('welcome-text');
      const ch = document.getElementById('welcome-channel');
      if (txt) txt.value = data.text || '';
      if (ch) ch.value = data.channelId || '';
    }
  } catch (err) {
    console.error('Fehler beim Laden der Willkommen-Settings:', err);
  }
}

async function saveWelcomeSettings() {
  if (!activeGuildId) return;

  const text = document.getElementById('welcome-text').value;
  const channelId = document.getElementById('welcome-channel').value;
  const statusEl = document.getElementById('welcome-status');

  try {
    const res = await fetch(`/api/guild/${activeGuildId}/welcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, channelId })
    });

    if (res.ok && statusEl) {
      statusEl.classList.remove('hidden');
      setTimeout(() => statusEl.classList.add('hidden'), 3000);
    }
  } catch (err) {
    console.error('Fehler beim Speichern:', err);
  }
}

document.addEventListener('DOMContentLoaded', loadDashboard);
