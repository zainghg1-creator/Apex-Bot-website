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

// Übersicht Elements
const overviewServerName = document.getElementById('overview-server-name');
const overviewServerIcon = document.getElementById('overview-server-icon');
const overviewServerId = document.getElementById('overview-server-id');
const overviewMembers = document.getElementById('overview-members');
const overviewBoosts = document.getElementById('overview-boosts');
const overviewCreated = document.getElementById('overview-created');

function showState(state) {
  [loadingState, emptyState, errorState, guildListEl].forEach((el) => el?.classList.add('hidden'));
  state?.classList.remove('hidden');
}

function inviteUrl(guildId) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: 'bot applications.commands',
    permissions: BOT_PERMISSIONS,
    guild_id: guildId,
    disable_guild_select: 'true'
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

function initials(name) {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function renderGuilds(guilds) {
  if (guilds.length === 0) {
    showState(emptyState);
    return;
  }

  guildListEl.innerHTML = guilds
    .map((g) => {
      const iconHtml = g.icon
        ? `<img class="guild-icon" src="${g.icon}" alt="">`
        : `<div class="guild-icon">${initials(g.name)}</div>`;

      const actionHtml = g.botIstDrauf
        ? `<button onclick="openManagement('${g.id}', '${escapeJsString(g.name)}', '${g.icon || ''}')" class="btn btn-secondary">Verwalten</button>`
        : `<a href="${inviteUrl(g.id)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary">Bot einladen</a>`;

      const statusHtml = g.botIstDrauf
        ? `<span class="guild-status status-active">● Apex ist aktiv</span>`
        : `<span class="guild-status status-missing">○ Apex ist nicht auf diesem Server</span>`;

      return `
        <div class="guild-row">
          ${iconHtml}
          <div class="guild-info">
            <div class="guild-name">${escapeHtml(g.name)}</div>
            ${statusHtml}
          </div>
          ${actionHtml}
        </div>
      `;
    })
    .join('');

  showState(guildListEl);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeJsString(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

async function loadDashboard() {
  try {
    const res = await fetch('/api/guilds');

    if (res.status === 401) {
      window.location.href = '/auth/discord/login';
      return;
    }

    if (!res.ok) {
      errorMessage.textContent = 'Deine Server konnten nicht geladen werden. Bitte versuch es erneut.';
      showState(errorState);
      return;
    }

    const data = await res.json();

    userAvatar.src = data.user.avatar
      ? `https://cdn.discordapp.com/avatars/${data.user.id}/${data.user.avatar}.png`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';
    userName.textContent = data.user.username;
    userChip.classList.remove('hidden');

    renderGuilds(data.guilds);
  } catch (err) {
    console.error(err);
    errorMessage.textContent = 'Verbindung zum Server fehlgeschlagen.';
    showState(errorState);
  }
}

// BERECHNUNG DES DISCORD CREATION DATES AUS DER SNOWFLAKE ID
function getGuildCreatedAt(guildId) {
  try {
    const discordEpoch = 1420070400000n;
    const timestamp = (BigInt(guildId) >> 22n) + discordEpoch;
    return new Date(Number(timestamp)).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  } catch (e) {
    return 'Unbekannt';
  }
}

// MANAGEMENT OVERLAY LOGIK MIT SERVER-DETAILS
async function openManagement(guildId, name, iconUrl) {
  // 1. Grunddaten sofort setzen
  if (activeGuildName) activeGuildName.textContent = name;
  if (overviewServerName) overviewServerName.textContent = name;
  if (overviewServerId) overviewServerId.textContent = guildId;

  const defaultIcon = 'https://cdn.discordapp.com/embed/avatars/0.png';
  const finalIcon = iconUrl || defaultIcon;

  if (activeGuildIcon) {
    activeGuildIcon.src = finalIcon;
    activeGuildIcon.classList.remove('hidden');
  }
  if (overviewServerIcon) {
    overviewServerIcon.src = finalIcon;
  }

  // Erstellungsdatum aus der Snowflake-ID berechnen
  if (overviewCreated) {
    overviewCreated.textContent = getGuildCreatedAt(guildId);
  }

  // Werte für Mitglieder & Boosts zurücksetzen
  if (overviewMembers) overviewMembers.textContent = 'Lädt...';
  if (overviewBoosts) overviewBoosts.textContent = 'Lädt...';

  // Erstes Modul (Übersicht) aktivieren und Modal anzeigen
  const firstBtn = document.querySelector('.module-menu .menu-item');
  showModule('overview', firstBtn);
  manageOverlay?.classList.remove('hidden');

  // 2. Erweiterte Serverdaten aus dem Backend abrufen
  try {
    const res = await fetch(`/api/guild/${guildId}`);
    if (res.ok) {
      const guildData = await res.json();
      if (overviewMembers) overviewMembers.textContent = guildData.members ?? '--';
      if (overviewBoosts) overviewBoosts.textContent = guildData.boosts ?? '0';
    } else {
      if (overviewMembers) overviewMembers.textContent = 'N/A';
      if (overviewBoosts) overviewBoosts.textContent = 'N/A';
    }
  } catch (err) {
    console.error('Fehler beim Laden der Serverdetails:', err);
    if (overviewMembers) overviewMembers.textContent = 'N/A';
    if (overviewBoosts) overviewBoosts.textContent = 'N/A';
  }
}

function closeManagement() {
  manageOverlay?.classList.add('hidden');
}

function showModule(modName, btnElement) {
  // Alle Modul-Seiten ausblenden
  document.querySelectorAll('.module-page').forEach((page) => page.classList.add('hidden'));

  // Highlight von allen Menü-Buttons entfernen
  document.querySelectorAll('.menu-item').forEach((btn) => btn.classList.remove('active'));

  // Ziel-Modul einblenden
  const targetPage = document.getElementById(`mod-${modName}`);
  if (targetPage) targetPage.classList.remove('hidden');

  // Geklickten Button hervorheben
  if (btnElement) {
    btnElement.classList.add('active');
  }
}

loadDashboard();
