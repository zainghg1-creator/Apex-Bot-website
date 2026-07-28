'use strict';

console.log('✅ GalaxyBot-Style Dashboard geladen!');

// ============================================================
// KONFIGURATION
// ============================================================
const CONFIG = {
  CLIENT_ID: '1525613011262377994',
  BOT_PERMISSIONS: '8',
  API_BASE: '/api'
};

// ============================================================
// DOM-REFERENCES
// ============================================================
const DOM = {
  loadingState: document.getElementById('loading-state'),
  emptyState: document.getElementById('empty-state'),
  errorState: document.getElementById('error-state'),
  errorMessage: document.getElementById('error-message'),
  guildList: document.getElementById('guild-list'),
  userAvatar: document.getElementById('user-avatar'),
  userName: document.getElementById('user-name'),
  manageOverlay: document.getElementById('manage-overlay'),
  activeGuildName: document.getElementById('active-guild-name'),
  activeGuildIcon: document.getElementById('active-guild-icon'),
  overviewMembers: document.getElementById('overview-members'),
  overviewBoosts: document.getElementById('overview-boosts'),
  overviewBots: document.getElementById('overview-bots'),
  overviewChannels: document.getElementById('overview-channels'),
  overviewRoles: document.getElementById('overview-roles'),
  overviewCreated: document.getElementById('overview-created'),
  overviewOwnerName: document.getElementById('overview-owner-name'),
  overviewOwnerAvatar: document.getElementById('overview-owner-avatar'),
  toastContainer: document.getElementById('toast-container')
};

// ============================================================
// STATE
// ============================================================
let state = {
  activeGuildId: null,
  guildRoles: [],
  guildChannels: [],
  guildDataGuildId: null,
  ticketConfigCache: null,
  ticketConfigCacheGuildId: null
};

const TEAMUPDATE_COMMANDS = ['neuer_teamler', 'uprank', 'downrank', 'teamkick', 'teamwarn'];

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function escapeHtml(str) {
  if (!str) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(str).replace(/[&<>"']/g, m => map[m]);
}

function showState(stateEl) {
  [DOM.loadingState, DOM.emptyState, DOM.errorState, DOM.guildList].forEach(el => {
    if (el) el.classList.add('hidden');
  });
  if (stateEl) stateEl.classList.remove('hidden');
}

function showToast(message, type = 'success') {
  if (!DOM.toastContainer) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  toast.innerHTML = `<span style="margin-right:8px;">${icon}</span> ${message}`;
  DOM.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

function debounce(fn, delay = 300) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}

const DISCORD_EPOCH = 1420070400000n;
function snowflakeToDate(id) {
  try {
    const snowflake = BigInt(id);
    const timestampMs = Number((snowflake >> 22n) + DISCORD_EPOCH);
    const date = new Date(timestampMs);
    return isNaN(date.getTime()) ? null : date;
  } catch { return null; }
}
function formatGuildCreatedDate(guildId) {
  const date = snowflakeToDate(guildId);
  if (!date) return 'N/A';
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ============================================================
// API FUNCTIONS
// ============================================================
const FRIENDLY_ERRORS = {
  database_unavailable: 'Datenbank aktuell nicht erreichbar – bitte in ein paar Sekunden erneut versuchen.',
  server_error: 'Serverfehler – bitte erneut versuchen.',
  unknown_module: 'Unbekanntes Modul.',
  discord_api_error: 'Discord konnte nicht erreicht werden.',
  unknown_error: 'Zeitüberschreitung beim Server – bitte erneut versuchen.'
};

async function apiFetch(endpoint, options = {}) {
  const res = await fetch(`${CONFIG.API_BASE}${endpoint}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!res.ok) {
    if (res.status === 401) { window.location.href = '/'; return null; }
    const error = await res.json().catch(() => ({ error: 'unknown_error' }));
    const code = error.error || `HTTP ${res.status}`;
    throw new Error(FRIENDLY_ERRORS[code] || code);
  }
  return res.json();
}

// ============================================================
// CACHED TICKET CONFIG
// ============================================================
async function getCachedTicketConfig(forceRefresh = false) {
  if (!state.activeGuildId) return null;
  if (!forceRefresh && state.ticketConfigCache && state.ticketConfigCacheGuildId === state.activeGuildId) {
    return state.ticketConfigCache;
  }
  try {
    const config = await apiFetch(`/guild/${state.activeGuildId}/config`);
    state.ticketConfigCache = config.tickets || {};
    state.ticketConfigCacheGuildId = state.activeGuildId;
    return state.ticketConfigCache;
  } catch (err) {
    console.error('Fehler beim Laden der Ticket-Config:', err);
    return null;
  }
}
function invalidateTicketCache() {
  state.ticketConfigCache = null;
  state.ticketConfigCacheGuildId = null;
}

// ============================================================
// GUILD LIST
// ============================================================
async function loadDashboard() {
  showState(DOM.loadingState);
  try {
    const data = await apiFetch('/guilds');
    if (!data) {
      DOM.errorMessage.textContent = 'Keine Daten vom Server erhalten.';
      showState(DOM.errorState);
      return;
    }
    renderUser(data.user);
    renderGuilds(data.guilds, data.clientId || CONFIG.CLIENT_ID);
  } catch (err) {
    DOM.errorMessage.textContent = err.message || 'Fehler beim Laden der Server';
    showState(DOM.errorState);
  }
}

function renderUser(user) {
  if (!user) return;
  if (DOM.userName) DOM.userName.textContent = user.username;
  if (DOM.userAvatar) {
    DOM.userAvatar.src = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';
    DOM.userAvatar.alt = `${user.username}s Avatar`;
  }
  const sidebarAvatar = document.getElementById('sidebar-user-avatar');
  if (sidebarAvatar) {
    sidebarAvatar.src = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';
  }
  const sidebarName = document.getElementById('sidebar-user-name');
  if (sidebarName) sidebarName.textContent = user.username || 'User';
}

function renderGuilds(guilds, clientId) {
  if (!guilds || guilds.length === 0) { showState(DOM.emptyState); return; }
  DOM.guildList.innerHTML = '';
  guilds.forEach(guild => {
    const card = document.createElement('div');
    card.className = 'guild-card';
    const iconSrc = guild.icon || 'https://cdn.discordapp.com/embed/avatars/0.png';
    const isManaged = guild.botIstDrauf;
    card.innerHTML = `
      <div class="guild-info">
        <img src="${iconSrc}" class="guild-icon" alt="${escapeHtml(guild.name)} Icon" width="48" height="48" loading="lazy">
        <span class="guild-name">${escapeHtml(guild.name)}</span>
      </div>
      <div class="guild-action">
        ${isManaged
          ? `<button class="btn btn-primary" onclick="openManagement('${guild.id}', '${escapeHtml(guild.name)}', '${iconSrc}')">Verwalten</button>`
          : `<a href="https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${CONFIG.BOT_PERMISSIONS}&guild_id=${guild.id}" target="_blank" rel="noopener" class="btn btn-secondary">Bot einladen</a>`
        }
      </div>
    `;
    DOM.guildList.appendChild(card);
  });
  showState(DOM.guildList);
}

// ============================================================
// MANAGEMENT OVERLAY
// ============================================================
async function openManagement(guildId, name, iconUrl) {
  state.activeGuildId = guildId;
  DOM.activeGuildName.textContent = name;
  DOM.activeGuildIcon.src = iconUrl;
  DOM.activeGuildIcon.alt = `${name} Icon`;
  DOM.manageOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  DOM.overviewMembers.textContent = '...';
  DOM.overviewBoosts.textContent = '...';
  DOM.overviewBots.textContent = '...';
  DOM.overviewChannels.textContent = '...';
  DOM.overviewRoles.textContent = '...';
  DOM.overviewOwnerName.textContent = '...';
  DOM.overviewOwnerAvatar.classList.add('hidden');
  DOM.overviewOwnerAvatar.src = '';
  DOM.overviewCreated.textContent = formatGuildCreatedDate(guildId);
  if (state.guildDataGuildId !== guildId || state.guildRoles.length === 0 || state.guildChannels.length === 0) {
    await loadRolesAndChannels(guildId);
  } else {
    renderAllSelects();
  }
  await getCachedTicketConfig(true);
  await loadGuildDetails(guildId);
  await loadAllModuleSettings(guildId);
  renderBotChannelSelect();
  renderVoiceSupportSelects(); // Voice Support
}

function closeManagement() {
  state.activeGuildId = null;
  DOM.manageOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

async function loadGuildDetails(guildId) {
  try {
    const data = await apiFetch(`/guild/${guildId}`);
    if (data) {
      DOM.overviewMembers.textContent = data.members ?? '0';
      DOM.overviewBoosts.textContent = data.boosts ?? '0';
      DOM.overviewBots.textContent = data.botCount ?? data.bots ?? 'N/A';
      renderGuildOwner(data.owner);
    }
  } catch {
    DOM.overviewMembers.textContent = 'N/A';
    DOM.overviewBoosts.textContent = 'N/A';
    DOM.overviewBots.textContent = 'N/A';
    renderGuildOwner(null);
  }
}

function renderGuildOwner(owner) {
  if (!owner) {
    DOM.overviewOwnerName.textContent = 'N/A';
    DOM.overviewOwnerAvatar.classList.add('hidden');
    DOM.overviewOwnerAvatar.src = '';
    return;
  }
  DOM.overviewOwnerName.textContent = owner.username || 'Unbekannt';
  DOM.overviewOwnerAvatar.src = owner.avatar
    ? `https://cdn.discordapp.com/avatars/${owner.id}/${owner.avatar}.png`
    : 'https://cdn.discordapp.com/embed/avatars/0.png';
  DOM.overviewOwnerAvatar.alt = `${owner.username || 'Owner'}s Avatar`;
  DOM.overviewOwnerAvatar.classList.remove('hidden');
}

// ============================================================
// ROLES & CHANNELS
// ============================================================
async function loadRolesAndChannels(guildId) {
  try {
    const [roles, channels] = await Promise.all([
      apiFetch(`/guild/${guildId}/roles`).catch(() => []),
      apiFetch(`/guild/${guildId}/channels`).catch(() => [])
    ]);
    state.guildRoles = roles || [];
    state.guildChannels = channels || [];
    state.guildDataGuildId = guildId;
  } catch {
    state.guildRoles = [];
    state.guildChannels = [];
    state.guildDataGuildId = null;
  }
  DOM.overviewRoles.textContent = state.guildRoles.length;
  DOM.overviewChannels.textContent = state.guildChannels.length;
  renderAllSelects();
  renderVoiceSupportSelects();
}

function renderAllSelects() {
  const selectIds = ['join-channel', 'leave-channel', 'teamliste-channel', 'automod-log-channel', 'teamupdate-channel', 'verification-channel', 'minigames-counting-channel', 'minigames-flags-channel', 'minigames-emoji-channel', 'levels-channel', 'statusembed-channel'];
  selectIds.forEach(id => renderChannelSelect(id, 0));
  TEAMUPDATE_COMMANDS.forEach(cmd => renderChannelSelect(`cmd-${cmd}-channel`, 0));
}

function renderChannelSelect(selectId, filterType) {
  const el = document.getElementById(selectId);
  if (!el) return;
  const relevant = state.guildChannels.filter(c => c.type === filterType);
  if (relevant.length === 0) {
    el.innerHTML = `<option value="">Keine Textkanäle gefunden</option>`;
    return;
  }
  el.innerHTML = relevant.map(c => `<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('');
}

function renderRoleChips(containerId, selectedIds = [], singleSelect = false) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (state.guildRoles.length === 0) {
    el.innerHTML = `<span class="chip-empty">Keine Rollen gefunden</span>`;
    return;
  }
  const selectedSet = new Set(selectedIds);
  el.innerHTML = state.guildRoles.map(r => {
    const isSelected = selectedSet.has(r.id);
    return `<div class="role-chip ${isSelected ? 'selected' : ''}" data-role-id="${r.id}" onclick="toggleRoleChip('${containerId}', '${r.id}', ${singleSelect})">
      <span class="chip-icon">@</span>
      <span class="chip-label">${escapeHtml(r.name)}</span>
    </div>`;
  }).join('');
}

function toggleRoleChip(containerId, roleId, singleSelect) {
  const el = document.getElementById(containerId);
  const chip = el.querySelector(`[data-role-id="${roleId}"]`);
  if (!chip) return;
  if (singleSelect) {
    el.querySelectorAll('.role-chip').forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
  } else {
    chip.classList.toggle('selected');
  }
}

function getSelectedRoleIds(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return [];
  return Array.from(el.querySelectorAll('.role-chip.selected')).map(c => c.dataset.roleId);
}

// ============================================================
// CHANNEL CHIPS
// ============================================================
function renderChannelChips(containerId, selectedIds = []) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const textChannels = state.guildChannels.filter(c => c.type === 0);
  if (textChannels.length === 0) {
    el.innerHTML = `<span class="chip-empty">Keine Textkanäle gefunden</span>`;
    return;
  }
  const selectedSet = new Set(selectedIds);
  el.innerHTML = textChannels.map(c => {
    const isSelected = selectedSet.has(c.id);
    return `<div class="role-chip ${isSelected ? 'selected' : ''}" data-channel-id="${c.id}" onclick="toggleChannelChip('${containerId}', '${c.id}')">
      <span class="chip-icon">#</span>
      <span class="chip-label">${escapeHtml(c.name)}</span>
    </div>`;
  }).join('');
}

function toggleChannelChip(containerId, channelId) {
  const el = document.getElementById(containerId);
  const chip = el.querySelector(`[data-channel-id="${channelId}"]`);
  if (!chip) return;
  chip.classList.toggle('selected');
}

function getSelectedChannelIds(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return [];
  return Array.from(el.querySelectorAll('.role-chip.selected')).map(c => c.dataset.channelId);
}

// ============================================================
// TABS & SUBTABS
// ============================================================
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.module-page').forEach(page => page.classList.add('hidden'));
  const activeBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  const activePage = document.getElementById(`mod-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');
  if (activePage) activePage.classList.remove('hidden');
  if (tabName === 'tickets' && state.activeGuildId) {
    setTimeout(() => renderTicketOverview(), 50);
  }
  if (tabName === 'bot') {
    renderBotChannelSelect();
  }
  if (tabName === 'voice_support') {
    renderVoiceSupportSelects();
  }
}

function switchSubtab(moduleName, subName) {
  const container = document.getElementById(`mod-${moduleName}`);
  if (!container) return;
  container.querySelectorAll('.subtab-btn').forEach(btn => btn.classList.remove('active'));
  container.querySelectorAll('.subpage').forEach(page => page.classList.add('hidden'));
  const activeBtn = container.querySelector(`[data-sub="${subName}"]`);
  const activePage = document.getElementById(`${moduleName}-${subName}-page`);
  if (activeBtn) activeBtn.classList.add('active');
  if (activePage) activePage.classList.remove('hidden');
}

// ============================================================
// COLOR SYNC
// ============================================================
function syncColor(prefix) {
  const color = document.getElementById(`${prefix}-color`).value;
  const hexInput = document.getElementById(`${prefix}-color-hex`);
  const preview = document.getElementById(`${prefix}-preview`);
  if (hexInput) hexInput.value = color;
  if (preview) preview.style.borderLeftColor = color;
  updateEmbedPreview(prefix);
}

function syncColorHex(prefix) {
  let hex = document.getElementById(`${prefix}-color-hex`).value.trim();
  if (!hex.startsWith('#')) hex = `#${hex}`;
  if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    document.getElementById(`${prefix}-color`).value = hex;
    const preview = document.getElementById(`${prefix}-preview`);
    if (preview) preview.style.borderLeftColor = hex;
    updateEmbedPreview(prefix);
  }
}

// ============================================================
// BILD-KOMPRIMIERUNG
// ============================================================
function compressImage(dataUrl, maxSizeKB = 300) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;
      const maxDim = 800;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      let quality = 0.9;
      let result = canvas.toDataURL('image/jpeg', quality);
      while (result.length > maxSizeKB * 1024 && quality > 0.1) {
        quality -= 0.1;
        result = canvas.toDataURL('image/jpeg', quality);
      }
      resolve(result);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// ============================================================
// IMAGE UPLOAD
// ============================================================
async function handleImageUpload(input, prefix) {
  const file = input.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Bitte wähle ein Bild aus.', 'error');
    input.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('Bild ist zu groß (max. 5MB).', 'error');
    input.value = '';
    return;
  }
  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const compressed = await compressImage(e.target.result, 300);
        const previewImg = document.getElementById(`${prefix}-image-preview`);
        if (previewImg) previewImg.src = compressed;
        input.dataset.value = compressed;
        updateEmbedPreview(prefix);
        showToast('Bild hochgeladen ✅', 'success');
      } catch (err) {
        showToast('Fehler beim Komprimieren: ' + err.message, 'error');
      }
    };
    reader.onerror = () => showToast('Fehler beim Lesen der Datei', 'error');
    reader.readAsDataURL(file);
  } catch (err) {
    showToast('Fehler: ' + err.message, 'error');
  }
}

function clearImage(prefix) {
  const input = document.getElementById(`${prefix}-image-input`);
  if (input) { input.value = ''; input.dataset.value = ''; }
  const previewImg = document.getElementById(`${prefix}-image-preview`);
  if (previewImg) previewImg.src = '';
  updateEmbedPreview(prefix);
}

function setImage(prefix, url) {
  const preview = document.getElementById(`${prefix}-image-preview`);
  const input = document.getElementById(`${prefix}-image-input`);
  if (preview) {
    if (url && (url.startsWith('data:image') || url.startsWith('http'))) {
      preview.src = url;
      preview.style.display = 'block';
    } else {
      preview.src = '';
      preview.style.display = 'none';
    }
  }
  if (input) {
    input.dataset.value = url || '';
  }
  updateEmbedPreview(prefix);
}

// ============================================================
// EMBED VORSCHAU
// ============================================================
const updateEmbedPreview = debounce((prefix) => {
  const titleEl = document.getElementById(`${prefix}-title`);
  const descEl = document.getElementById(`${prefix}-text`);
  const previewTitle = document.getElementById(`${prefix}-preview-title`);
  const previewDesc = document.getElementById(`${prefix}-preview-desc`);
  const previewImage = document.getElementById(`${prefix}-preview-image`);
  const imageInput = document.getElementById(`${prefix}-image-input`);
  const colorInput = document.getElementById(`${prefix}-color`);
  const preview = document.getElementById(`${prefix}-preview`);

  if (previewTitle && titleEl) {
    const titleVal = titleEl.value.trim();
    previewTitle.textContent = titleVal;
    previewTitle.classList.toggle('hidden', !titleVal);
  }
  if (previewDesc && descEl) previewDesc.textContent = descEl.value || descEl.placeholder;
  if (previewImage) {
    const val = imageInput?.dataset.value;
    if (val) { previewImage.src = val; previewImage.classList.remove('hidden'); }
    else { previewImage.classList.add('hidden'); }
  }
  if (preview && colorInput) {
    preview.style.borderLeftColor = colorInput.value;
  }
}, 200);

// ============================================================
// LOAD SETTINGS
// ============================================================
async function loadAllModuleSettings(guildId) {
  try {
    const config = await apiFetch(`/guild/${guildId}/config`).catch(() => ({}));
    applyWelcomeConfig(config.welcome || {});
    applyTeamlisteConfig(config.teamliste || {});
    applyAutomodConfig(config.automod || {});
    applyTeamupdateConfig(config.teamupdate || {});
    applyMinigamesConfig(config.minigames || {});
    applyVerificationConfig(config.verification || {});
    applySimpleConfig('antinuke', config.antinuke || {});
    applyRoleNicknamesConfig(config.rolenicknames || {});
    applyReactionRolesConfig(config.reactionroles || {});
    applyStatsConfig(config.stats || {});
    applyLevelsConfig(config.levels || {});
    applyStatusEmbedConfig(config.statusembed || {});
    applyApplicationsConfig(config.applications || {});
    applyVoiceSupportConfig(config.voice_support || {});
  } catch (err) { console.error('Fehler beim Laden der Konfiguration:', err); }
}

function applyStatusEmbedConfig(cfg) {
  setChecked('statusembed-enabled', cfg.enabled ?? false);
  setSelectValue('statusembed-channel', cfg.channelId || '');
  setValue('statusembed-interval', cfg.intervalMinutes ?? 30);
  setValue('statusembed-title', cfg.title ?? '');
  const colorEl = document.getElementById('statusembed-color');
  if (colorEl) colorEl.value = cfg.color || '#2b2d31';
  renderRoleChips('statusembed-role', cfg.roleId ? [cfg.roleId] : [], true);
}

function applyWelcomeConfig(cfg) {
  const j = cfg.join || {};
  const l = cfg.leave || {};
  setChecked('join-enabled', j.enabled ?? true);
  setSelectValue('join-mode', j.mode || 'embed');
  setValue('join-title', j.title || '');
  setValue('join-text', j.text || '');
  setColor('join', j.color || '#ffffff');
  setChecked('join-avatar-thumb', j.useAvatarThumbnail ?? true);
  setImage('join', j.image);
  setSelectValue('join-channel', j.channelId || '');
  renderRoleChips('join-roles', j.roles || []);
  setChecked('leave-enabled', l.enabled ?? false);
  setSelectValue('leave-mode', l.mode || 'embed');
  setValue('leave-title', l.title || '');
  setValue('leave-text', l.text || '');
  setColor('leave', l.color || '#ffffff');
  setChecked('leave-avatar-thumb', l.useAvatarThumbnail ?? true);
  setImage('leave', l.image);
  setSelectValue('leave-channel', l.channelId || '');
  updateEmbedPreview('join');
  updateEmbedPreview('leave');
}

function applyTeamlisteConfig(cfg) {
  setSelectValue('teamliste-channel', cfg.channelId || '');
  renderRoleChips('teamliste-roles', cfg.roles || []);
}

function applyAutomodConfig(cfg) {
  setChecked('automod-enabled', cfg.enabled ?? false);
  setSelectValue('automod-log-channel', cfg.logChannelId || '');

  const spam = cfg.spam || {};
  setChecked('automod-spam-enabled', spam.enabled ?? false);
  setValue('automod-spam-max', spam.maxMessages ?? 5);
  setValue('automod-spam-seconds', spam.perSeconds ?? 5);
  setSelectValue('automod-spam-action', spam.action || 'delete');
  setValue('automod-spam-timeout', spam.timeoutSeconds ?? 60);

  const links = cfg.links || {};
  setChecked('automod-links-enabled', links.enabled ?? false);
  setSelectValue('automod-links-action', links.action || 'delete');
  setValue('automod-links-timeout', links.timeoutSeconds ?? 60);

  const whitelist = cfg.whitelist || {};
  renderChannelChips('automod-whitelist-channels', whitelist.channelIds || []);
  renderRoleChips('automod-whitelist-roles', whitelist.roleIds || []);

  const userContainer = document.getElementById('automod-whitelist-users-list');
  if (userContainer) userContainer.innerHTML = '';
  const userIds = whitelist.userIds || [];
  if (userIds.length === 0) {
    addAutomodUserIdRow();
  } else {
    userIds.forEach(id => addAutomodUserIdRow(id));
  }
}

let automodUserIdCounter = 0;
window.addAutomodUserIdRow = function(value = '') {
  const container = document.getElementById('automod-whitelist-users-list');
  if (!container) return;
  const rowId = `automod-uid-${++automodUserIdCounter}`;
  const row = document.createElement('div');
  row.className = 'option-row';
  row.id = rowId;
  row.innerHTML = `
    <input type="text" placeholder="User-ID (z.B. 123456789012345678)" class="automod-uid-input" value="${escapeHtml(value)}" style="flex:1;">
    <button type="button" class="option-remove" onclick="document.getElementById('${rowId}').remove()">✕</button>
  `;
  container.appendChild(row);
};

function collectAutomodUserIds() {
  const inputs = document.querySelectorAll('#automod-whitelist-users-list .automod-uid-input');
  return Array.from(inputs)
    .map(el => el.value.trim())
    .filter(v => /^\d{15,25}$/.test(v));
}

function applyTeamupdateConfig(cfg) {
  setChecked('teamupdate-enabled', cfg.enabled ?? false);
  setSelectValue('teamupdate-channel', cfg.channelId || '');
  const commands = cfg.commands || {};
  TEAMUPDATE_COMMANDS.forEach(cmd => {
    const c = commands[cmd] || {};
    setChecked(`cmd-enabled-${cmd}`, c.enabled ?? true);
    renderRoleChips(`cmdrole-${cmd}`, c.roles || []);
    setSelectValue(`cmd-${cmd}-channel`, c.channelId || '');
    if (cmd === 'neuer_teamler' || cmd === 'teamkick') {
      renderRoleChips(`cmdrole-${cmd}-auto`, c.autoRoles || []);
    }
    if (cmd === 'teamwarn') {
      const stages = c.warnStages || [];
      renderRoleChips('cmdrole-teamwarn-stage1', stages[0] ? [stages[0]] : [], true);
      renderRoleChips('cmdrole-teamwarn-stage2', stages[1] ? [stages[1]] : [], true);
      renderRoleChips('cmdrole-teamwarn-stage3', stages[2] ? [stages[2]] : [], true);
      renderRoleChips('cmdrole-teamwarn-stage4', stages[3] ? [stages[3]] : [], true);
    }
  });
}

function applyMinigamesConfig(cfg) {
  const c = cfg.counting || {};
  setChecked('minigames-counting-enabled', c.enabled ?? false);
  setSelectValue('minigames-counting-channel', c.channelId || '');

  const f = cfg.flags || {};
  setChecked('minigames-flags-enabled', f.enabled ?? false);
  setSelectValue('minigames-flags-channel', f.channelId || '');
  const fb = f.buttons || {};
  setChecked('minigames-flags-btn-skip', fb.skip ?? true);
  setChecked('minigames-flags-btn-hint', fb.hint ?? true);
  setChecked('minigames-flags-btn-letter', fb.firstLetter ?? true);

  const e = cfg.emoji || {};
  setChecked('minigames-emoji-enabled', e.enabled ?? false);
  setSelectValue('minigames-emoji-channel', e.channelId || '');
  const eb = e.buttons || {};
  setChecked('minigames-emoji-btn-skip', eb.skip ?? true);
  setChecked('minigames-emoji-btn-hint', eb.hint ?? true);
  setChecked('minigames-emoji-btn-letter', eb.firstLetter ?? true);
}

// ============================================================
// LEVEL-SYSTEM
// ============================================================
function applyLevelsConfig(cfg) {
  setChecked('levels-enabled', cfg.enabled ?? false);
  setValue('levels-xp-min', cfg.xpMin ?? 15);
  setValue('levels-xp-max', cfg.xpMax ?? 25);
  setValue('levels-cooldown', cfg.cooldownSeconds ?? 60);
  setValue('levels-base-xp', cfg.baseXp ?? 100);
  setValue('levels-xp-increment', cfg.xpIncrement ?? 50);
  setValue('levels-message', cfg.levelUpMessage ?? '🎉 {user} hat **Level {level}** erreicht!');
  setSelectValue('levels-channel', cfg.channelId || '');
  const voice = cfg.voice || {};
  setChecked('levels-voice-enabled', voice.enabled ?? false);
  setValue('levels-voice-xp', voice.xpPerMinute ?? 10);
}

function toggleCommandRoles(cmd) {
  const panel = document.getElementById(`cmd-roles-${cmd}`);
  const btn = document.querySelector(`.command-row[data-command="${cmd}"] .command-menu-btn`);
  if (!panel) return;
  panel.classList.toggle('hidden');
  if (btn) btn.classList.toggle('active', !panel.classList.contains('hidden'));
}

function applyVerificationConfig(cfg) {
  setChecked('verification-enabled', cfg.enabled ?? false);
  setSelectValue('verification-method', cfg.method || 'button');
  setSelectValue('verification-channel', cfg.channelId || '');
  renderRoleChips('verification-roles', cfg.roleId ? [cfg.roleId] : [], true);
  renderRoleChips('verification-remove-roles', cfg.removeRoleIds || []);
  setValue('verification-title', cfg.title || '');
  setValue('verification-description', cfg.description || '');
  setColor('verification', cfg.color || '#6d5ef8');
  setImage('verification', cfg.image);
  setValue('verification-button-label', cfg.buttonLabel || '');
}

function applyRoleNicknamesConfig(cfg) {
  setChecked('rolenicknames-enabled', cfg.enabled ?? false);
  const container = document.getElementById('rolenick-list');
  if (container) container.innerHTML = '';
  const entries = cfg.entries || [];
  if (entries.length === 0) {
    addRoleNicknameRow();
  } else {
    entries.forEach(entry => addRoleNicknameRow(entry));
  }
}

window.addRoleNicknameRow = function(data = null) {
  const container = document.getElementById('rolenick-list');
  if (!container) return;
  const rowId = `rolenick-${++rolenickCounter}`;
  const row = document.createElement('div');
  row.className = 'option-row';
  row.id = rowId;

  row.innerHTML = `
    <select class="rn-role" style="flex:2; min-width:140px;"></select>
    <input type="text" placeholder="Präfix (z.B. [Team] )" class="rn-prefix" value="${data ? escapeHtml(data.prefix || '') : ''}" style="flex:2; min-width:120px;">
    <input type="text" placeholder="Suffix (z.B.  | Mod)" class="rn-suffix" value="${data ? escapeHtml(data.suffix || '') : ''}" style="flex:2; min-width:120px;">
    <button type="button" class="option-remove" onclick="document.getElementById('${rowId}').remove()">✕</button>
  `;
  container.appendChild(row);

  const select = row.querySelector('.rn-role');
  select.innerHTML = state.guildRoles.length
    ? state.guildRoles.map(r => `<option value="${r.id}">@${escapeHtml(r.name)}</option>`).join('')
    : `<option value="">Keine Rollen gefunden</option>`;
  if (data && data.roleId) select.value = data.roleId;
};

function collectRoleNicknames() {
  const rows = document.querySelectorAll('#rolenick-list .option-row');
  return Array.from(rows).map(row => ({
    roleId: row.querySelector('.rn-role')?.value || '',
    prefix: row.querySelector('.rn-prefix')?.value || '',
    suffix: row.querySelector('.rn-suffix')?.value || ''
  })).filter(e => e.roleId && (e.prefix || e.suffix));
}

// ============================================================
// REACTION ROLES
// ============================================================
function applyReactionRolesConfig(cfg) {
  const container = document.getElementById('reactionroles-list');
  if (container) container.innerHTML = '';
  const panels = cfg.panels || [];
  panels.forEach(panel => addReactionRolePanel(panel));
}

window.addReactionRolePanel = function(data = null) {
  const container = document.getElementById('reactionroles-list');
  if (!container) return;
  const panelId = `rr-panel-${++reactionRolePanelCounter}`;
  const wrapper = document.createElement('div');
  wrapper.className = 'panel-card';
  wrapper.id = panelId;
  wrapper.dataset.messageId = (data && data.messageId) || '';

  const color = (data && data.color) || '#ffffff';
  wrapper.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px; flex-wrap:wrap;">
      <h3 style="font-size:0.95rem; font-weight:700; margin:0;">🎭 Reaction-Role Nachricht</h3>
      <button type="button" class="option-remove" onclick="document.getElementById('${panelId}').remove()">✕ Entfernen</button>
    </div>
    <div class="form-group"><label>Kanal</label><select class="rr-channel"></select></div>
    <div class="form-group"><label>Titel</label><input type="text" class="rr-title" placeholder="🎭 Wähle deine Rollen" value="${data ? escapeHtml(data.title || '') : ''}"></div>
    <div class="form-group"><label>Beschreibung</label><textarea class="rr-description" rows="3" placeholder="Reagiere mit einem Emoji, um eine Rolle zu erhalten!">${data ? escapeHtml(data.description || '') : ''}</textarea></div>
    <div class="form-group">
      <label>Farbe</label>
      <div class="color-row">
        <input type="color" class="rr-color" value="${color}" oninput="this.nextElementSibling.value=this.value;">
        <input type="text" class="rr-color-hex" value="${color}" oninput="this.previousElementSibling.value=this.value;">
      </div>
    </div>
    <div class="form-group"><label>Bild-URL (optional)</label><input type="text" class="rr-image" placeholder="https://example.com/bild.png" value="${data ? escapeHtml(data.image || '') : ''}"></div>
    <div class="form-group">
      <label>Emoji → Rolle Zuordnungen</label>
      <small style="display:block; margin-bottom:6px;">Trage ein Emoji ein (z.B. 😀 oder ein Server-Emoji wie &lt;:name:123456789&gt;) und wähle die Rolle, die dafür vergeben werden soll.</small>
      <div class="rr-mappings-list"></div>
      <button type="button" class="add-option-btn" onclick="addReactionRoleMapping(this)">+ Zuordnung hinzufügen</button>
    </div>
    <div class="form-action">
      <button type="button" class="btn btn-secondary" onclick="sendReactionRolePanel('${panelId}')">📤 Nachricht senden</button>
      <span class="rr-send-status" style="align-self:center; font-size:0.8rem; color:var(--text-muted);">${data && data.messageId ? '✓ Gesendet' : 'Noch nicht gesendet'}</span>
    </div>
  `;
  container.appendChild(wrapper);

  const channelSelect = wrapper.querySelector('.rr-channel');
  const textChannels = state.guildChannels.filter(c => c.type === 0);
  channelSelect.innerHTML = textChannels.length
    ? textChannels.map(c => `<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('')
    : `<option value="">Keine Textkanäle gefunden</option>`;
  if (data && data.channelId) channelSelect.value = data.channelId;

  const addMappingBtn = wrapper.querySelector('.add-option-btn');
  const mappings = (data && data.mappings) || [];
  if (mappings.length === 0) {
    addReactionRoleMapping(addMappingBtn);
  } else {
    mappings.forEach(m => addReactionRoleMapping(addMappingBtn, m));
  }
};

window.addReactionRoleMapping = function(btnEl, data = null) {
  const panelCard = btnEl.closest('.panel-card');
  if (!panelCard) return;
  const list = panelCard.querySelector('.rr-mappings-list');
  const row = document.createElement('div');
  row.className = 'option-row rr-mapping-row';
  row.innerHTML = `
    <input type="text" class="rr-emoji" placeholder="Emoji" value="${data ? escapeHtml(data.emoji || '') : ''}" style="flex:1; min-width:80px;">
    <select class="rr-role" style="flex:2; min-width:140px;"></select>
    <button type="button" class="option-remove" onclick="this.parentElement.remove()">✕</button>
  `;
  list.appendChild(row);
  const select = row.querySelector('.rr-role');
  select.innerHTML = state.guildRoles.length
    ? state.guildRoles.map(r => `<option value="${r.id}">@${escapeHtml(r.name)}</option>`).join('')
    : `<option value="">Keine Rollen gefunden</option>`;
  if (data && data.roleId) select.value = data.roleId;
};

function collectReactionRolePanels() {
  const panels = Array.from(document.querySelectorAll('#reactionroles-list .panel-card'));
  return panels.map(panel => {
    const mappings = Array.from(panel.querySelectorAll('.rr-mapping-row')).map(row => ({
      emoji: row.querySelector('.rr-emoji')?.value.trim() || '',
      roleId: row.querySelector('.rr-role')?.value || ''
    })).filter(m => m.emoji && m.roleId);
    return {
      channelId: panel.querySelector('.rr-channel')?.value || '',
      title: panel.querySelector('.rr-title')?.value || '',
      description: panel.querySelector('.rr-description')?.value || '',
      color: panel.querySelector('.rr-color-hex')?.value || '#ffffff',
      image: panel.querySelector('.rr-image')?.value || '',
      messageId: panel.dataset.messageId || null,
      mappings
    };
  }).filter(p => p.channelId);
}

async function sendReactionRolePanel(panelId) {
  if (!state.activeGuildId) return;
  const allPanels = Array.from(document.querySelectorAll('#reactionroles-list .panel-card'));
  const panelIndex = allPanels.findIndex(p => p.id === panelId);
  if (panelIndex === -1) return;

  const panelEl = document.getElementById(panelId);
  const mappingCount = panelEl ? panelEl.querySelectorAll('.rr-mapping-row').length : 0;
  if (mappingCount === 0) {
    showToast('Bitte füge mindestens eine Emoji-Rollen Zuordnung hinzu.', 'error');
    return;
  }

  try {
    await saveModuleSettings('reactionroles');
    const data = await apiFetch(`/guild/${state.activeGuildId}/reactionroles/send-panel`, {
      method: 'POST',
      body: JSON.stringify({ panelIndex })
    });
    if (data?.messageId && panelEl) {
      panelEl.dataset.messageId = data.messageId;
      const statusEl = panelEl.querySelector('.rr-send-status');
      if (statusEl) statusEl.textContent = '✓ Gesendet';
    }
    showToast('Reaction-Role Nachricht gesendet!', 'success');
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
}

function generateId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function applyApplicationsConfig(cfg) {
  const container = document.getElementById('applications-list');
  if (container) container.innerHTML = '';
  const forms = cfg.forms || [];
  forms.forEach(form => addApplicationForm(form));
}

// ============================================================
// addApplicationForm (mit Annahme/Ablehnung)
// ============================================================
window.addApplicationForm = function(data = null) {
  const container = document.getElementById('applications-list');
  if (!container) return;
  const panelId = `app-form-${++applicationFormCounter}`;
  const wrapper = document.createElement('div');
  wrapper.className = 'panel-card';
  wrapper.id = panelId;
  wrapper.dataset.formId = (data && data.id) || generateId();
  wrapper.dataset.messageId = (data && data.messageId) || '';

  const color = (data && data.color) || '#2b2d31';
  wrapper.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px; flex-wrap:wrap;">
      <h3 style="font-size:0.95rem; font-weight:700; margin:0;">📝 Bewerbung</h3>
      <button type="button" class="option-remove" onclick="document.getElementById('${panelId}').remove()">✕ Entfernen</button>
    </div>
    <div class="form-group">
      <div class="switch-row">
        <label>Aktiv (Bewerbungen können abgeschickt werden)</label>
        <label class="switch"><input type="checkbox" class="app-enabled" ${(!data || data.enabled !== false) ? 'checked' : ''}><span class="switch-slider"></span></label>
      </div>
    </div>
    <div class="form-group"><label>Name (intern)</label><input type="text" class="app-name" placeholder="z.B. Team-Bewerbung" value="${data ? escapeHtml(data.name || '') : ''}"></div>
    <div class="form-group"><label>Kanal für den Bewerben-Button</label><select class="app-panel-channel"></select></div>
    <div class="form-group"><label>Titel der Panel-Nachricht</label><input type="text" class="app-title" placeholder="Team-Bewerbung" value="${data ? escapeHtml(data.title || '') : ''}"></div>
    <div class="form-group"><label>Beschreibung der Panel-Nachricht</label><textarea class="app-description" rows="3" placeholder="Klicke auf den Button, um dich zu bewerben. Der Ablauf läuft über Direktnachrichten.">${data ? escapeHtml(data.description || '') : ''}</textarea></div>
    <div class="form-group"><label>Button-Text</label><input type="text" class="app-button-label" maxlength="80" placeholder="Bewerben" value="${data ? escapeHtml(data.buttonLabel || '') : ''}"></div>
    <div class="form-group">
      <label>Farbe</label>
      <div class="color-row">
        <input type="color" class="app-color" value="${color}" oninput="this.nextElementSibling.value=this.value;">
        <input type="text" class="app-color-hex" value="${color}" oninput="this.previousElementSibling.value=this.value;">
      </div>
    </div>
    <div class="form-group"><label>Ergebnis-Kanal (fertige Bewerbungen mit Buttons)</label><select class="app-result-channel"></select></div>
    <div class="form-group"><label>Rolle pingen (optional)</label><select class="app-role"><option value="">Keine Rolle</option></select></div>
    <div class="form-group"><label>Rolle bei Annahme</label><select class="app-accept-role"><option value="">Keine Rolle</option></select></div>
    <div class="form-group"><label>Rolle bei Ablehnung (optional)</label><select class="app-reject-role"><option value="">Keine Rolle</option></select></div>
    <div class="form-group"><label>Entscheider-Rollen (dürfen annehmen/ablehnen)</label><div class="chip-select app-review-roles"></div></div>
    <div class="form-group">
      <label>Fragen</label>
      <small style="display:block; margin-bottom:6px;">Diese Fragen werden dem Bewerber nacheinander per DM gestellt.</small>
      <div class="app-questions-list"></div>
      <button type="button" class="add-option-btn" onclick="addApplicationQuestion(this)">+ Frage hinzufügen</button>
    </div>
    <div class="form-action">
      <button type="button" class="btn btn-secondary" onclick="sendApplicationPanel('${panelId}')">📤 Nachricht senden</button>
      <span class="app-send-status" style="align-self:center; font-size:0.8rem; color:var(--text-muted);">${data && data.messageId ? '✓ Gesendet' : 'Noch nicht gesendet'}</span>
    </div>
  `;
  container.appendChild(wrapper);

  const textChannels = state.guildChannels.filter(c => c.type === 0);
  const channelOptions = textChannels.length
    ? textChannels.map(c => `<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('')
    : `<option value="">Keine Textkanäle gefunden</option>`;

  const panelChannelSelect = wrapper.querySelector('.app-panel-channel');
  panelChannelSelect.innerHTML = channelOptions;
  if (data && data.panelChannelId) panelChannelSelect.value = data.panelChannelId;

  const resultChannelSelect = wrapper.querySelector('.app-result-channel');
  resultChannelSelect.innerHTML = channelOptions;
  if (data && data.resultChannelId) resultChannelSelect.value = data.resultChannelId;

  const roleSelects = wrapper.querySelectorAll('.app-role, .app-accept-role, .app-reject-role');
  const roleOptions = state.guildRoles.length
    ? state.guildRoles.map(r => `<option value="${r.id}">@${escapeHtml(r.name)}</option>`).join('')
    : `<option value="">Keine Rollen</option>`;
  roleSelects.forEach(sel => {
    sel.innerHTML = `<option value="">Keine Rolle</option>` + roleOptions;
  });
  if (data && data.pingRoleId) {
    const pingSel = wrapper.querySelector('.app-role');
    if (pingSel) pingSel.value = data.pingRoleId;
  }
  if (data && data.acceptRoleId) {
    const acceptSel = wrapper.querySelector('.app-accept-role');
    if (acceptSel) acceptSel.value = data.acceptRoleId;
  }
  if (data && data.rejectRoleId) {
    const rejectSel = wrapper.querySelector('.app-reject-role');
    if (rejectSel) rejectSel.value = data.rejectRoleId;
  }

  const reviewRolesContainer = wrapper.querySelector('.app-review-roles');
  if (reviewRolesContainer) {
    const reviewRoleIds = (data && data.reviewRoles) || [];
    const chipId = `app-review-roles-${panelId}`;
    reviewRolesContainer.id = chipId;
    renderRoleChips(chipId, reviewRoleIds, false);
  }

  const addQuestionBtn = wrapper.querySelector('.add-option-btn');
  const questions = (data && data.questions) || [];
  if (questions.length === 0) {
    addApplicationQuestion(addQuestionBtn);
  } else {
    questions.forEach(q => addApplicationQuestion(addQuestionBtn, q));
  }
};

// ============================================================
// collectApplicationForms
// ============================================================
function collectApplicationForms() {
  const forms = Array.from(document.querySelectorAll('#applications-list .panel-card'));
  return forms.map(form => {
    const questions = Array.from(form.querySelectorAll('.app-question'))
      .map(input => input.value.trim())
      .filter(q => q);
    const acceptRoleId = form.querySelector('.app-accept-role')?.value || '';
    const rejectRoleId = form.querySelector('.app-reject-role')?.value || '';
    const reviewRoles = getSelectedRoleIds(form.querySelector('.app-review-roles')?.id);
    return {
      id: form.dataset.formId,
      enabled: form.querySelector('.app-enabled')?.checked ?? true,
      name: form.querySelector('.app-name')?.value || '',
      panelChannelId: form.querySelector('.app-panel-channel')?.value || '',
      title: form.querySelector('.app-title')?.value || '',
      description: form.querySelector('.app-description')?.value || '',
      buttonLabel: form.querySelector('.app-button-label')?.value || '',
      color: form.querySelector('.app-color-hex')?.value || '#2b2d31',
      resultChannelId: form.querySelector('.app-result-channel')?.value || '',
      pingRoleId: form.querySelector('.app-role')?.value || null,
      acceptRoleId: acceptRoleId,
      rejectRoleId: rejectRoleId,
      reviewRoles: reviewRoles,
      questions,
      messageId: form.dataset.messageId || null
    };
  });
}

window.addApplicationQuestion = function(btnEl, value = '') {
  const panelCard = btnEl.closest('.panel-card');
  if (!panelCard) return;
  const list = panelCard.querySelector('.app-questions-list');
  const row = document.createElement('div');
  row.className = 'option-row app-question-row';
  row.innerHTML = `
    <input type="text" class="app-question" placeholder="z.B. Warum möchtest du Teammitglied werden?" value="${escapeHtml(value || '')}" style="flex:1;">
    <button type="button" class="option-remove" onclick="this.parentElement.remove()">✕</button>
  `;
  list.appendChild(row);
};

async function sendApplicationPanel(panelId) {
  if (!state.activeGuildId) return;
  const panelEl = document.getElementById(panelId);
  if (!panelEl) return;
  const formId = panelEl.dataset.formId;

  const questionCount = panelEl.querySelectorAll('.app-question-row .app-question').length;
  if (questionCount === 0) {
    showToast('Bitte füge mindestens eine Frage hinzu.', 'error');
    return;
  }
  if (!panelEl.querySelector('.app-panel-channel')?.value) {
    showToast('Bitte wähle einen Kanal für den Bewerben-Button aus.', 'error');
    return;
  }

  try {
    await saveModuleSettings('applications');
    const data = await apiFetch(`/guild/${state.activeGuildId}/applications/send-panel`, {
      method: 'POST',
      body: JSON.stringify({ formId })
    });
    if (data?.messageId && panelEl) {
      panelEl.dataset.messageId = data.messageId;
      const statusEl = panelEl.querySelector('.app-send-status');
      if (statusEl) statusEl.textContent = '✓ Gesendet';
    }
    showToast('Bewerbungs-Nachricht gesendet!', 'success');
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
}

function applySimpleConfig(prefix, cfg) {
  setChecked(`${prefix}-enabled`, cfg.enabled ?? false);
  const channelId = cfg.channelId || cfg.logChannelId || '';
  const el = document.getElementById(`${prefix}-channel`) || document.getElementById(`${prefix}-log-channel`);
  if (el) setSelectValue(el.id, channelId);
}

function setValue(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function setChecked(id, val) { const el = document.getElementById(id); if (el) el.checked = !!val; }
function setSelectValue(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function setColor(prefix, color) {
  const colorEl = document.getElementById(`${prefix}-color`);
  const hexEl = document.getElementById(`${prefix}-color-hex`);
  const preview = document.getElementById(`${prefix}-preview`);
  if (colorEl) colorEl.value = color || '#ffffff';
  if (hexEl) hexEl.value = color || '#ffffff';
  if (preview) preview.style.borderLeftColor = color || '#ffffff';
}

// ============================================================
// SAVE SETTINGS
// ============================================================
async function saveModuleSettings(moduleName) {
  const saveStatus = document.getElementById(`${moduleName}-save-status`);
  if (saveStatus) { saveStatus.classList.add('hidden'); saveStatus.textContent = '⏳ Speichern...'; saveStatus.classList.remove('hidden'); }
  let payload = {};
  try {
    switch (moduleName) {
      case 'welcome':
        payload = {
          join: {
            enabled: document.getElementById('join-enabled').checked,
            mode: document.getElementById('join-mode').value,
            title: document.getElementById('join-title').value,
            text: document.getElementById('join-text').value,
            color: document.getElementById('join-color').value,
            image: document.getElementById('join-image-input')?.dataset.value || '',
            useAvatarThumbnail: document.getElementById('join-avatar-thumb').checked,
            channelId: document.getElementById('join-channel').value,
            roles: getSelectedRoleIds('join-roles')
          },
          leave: {
            enabled: document.getElementById('leave-enabled').checked,
            mode: document.getElementById('leave-mode').value,
            title: document.getElementById('leave-title').value,
            text: document.getElementById('leave-text').value,
            color: document.getElementById('leave-color').value,
            image: document.getElementById('leave-image-input')?.dataset.value || '',
            useAvatarThumbnail: document.getElementById('leave-avatar-thumb').checked,
            channelId: document.getElementById('leave-channel').value
          }
        };
        break;
      case 'tickets':
        payload = {
          panelChannelId: document.getElementById('edit-panel-channel')?.value || '',
          title: document.getElementById('edit-panel-title')?.value || '',
          description: document.getElementById('edit-panel-desc')?.value || '',
          color: document.getElementById('edit-panel-color')?.value || '#ffffff',
          image: document.getElementById('edit-image-input')?.dataset.value || '',
          creationMessage: document.getElementById('edit-create-msg')?.value || '',
          enabled: document.getElementById('edit-panel-enabled')?.checked ?? true,
          panelName: document.getElementById('edit-panel-name')?.value || '',
          supportRoles: getEditSelectedRoles('edit-support-roles') || [],
          logChannelId: document.getElementById('edit-log-channel')?.value || '',
          overflowEnabled: document.getElementById('edit-overflow-enabled')?.checked ?? false,
          overflowCategories: getSelectedOptions('edit-ticket-overflow') || [],
          threadMode: document.getElementById('edit-thread-mode')?.value || 'none',
          saveTranscripts: document.getElementById('edit-save-transcripts')?.checked ?? false,
          saveImages: document.getElementById('edit-save-images')?.checked ?? false,
          privateTranscripts: document.getElementById('edit-private-transcripts')?.checked ?? false,
          channelNameTemplate: document.getElementById('edit-channel-template')?.value || '{panel.name}-{ticket.creator.username}',
          allowedRoles: getEditSelectedRoles('edit-allowed-roles') || [],
          deniedRoles: getEditSelectedRoles('edit-denied-roles') || [],
          maxTickets: parseInt(document.getElementById('edit-max-tickets')?.value) || 1,
          claimEnabled: document.getElementById('edit-claim-enabled')?.checked ?? false,
          buttons: collectButtons() || [],
          options: collectOptions() || []
        };
        invalidateTicketCache();
        break;
      case 'teamliste':
        payload = { channelId: document.getElementById('teamliste-channel').value, roles: getSelectedRoleIds('teamliste-roles') };
        break;
      case 'automod':
        payload = {
          enabled: document.getElementById('automod-enabled').checked,
          logChannelId: document.getElementById('automod-log-channel').value,
          spam: {
            enabled: document.getElementById('automod-spam-enabled').checked,
            maxMessages: parseInt(document.getElementById('automod-spam-max').value) || 5,
            perSeconds: parseInt(document.getElementById('automod-spam-seconds').value) || 5,
            action: document.getElementById('automod-spam-action').value,
            timeoutSeconds: parseInt(document.getElementById('automod-spam-timeout').value) || 60
          },
          links: {
            enabled: document.getElementById('automod-links-enabled').checked,
            action: document.getElementById('automod-links-action').value,
            timeoutSeconds: parseInt(document.getElementById('automod-links-timeout').value) || 60
          },
          whitelist: {
            channelIds: getSelectedChannelIds('automod-whitelist-channels'),
            roleIds: getSelectedRoleIds('automod-whitelist-roles'),
            userIds: collectAutomodUserIds()
          }
        };
        break;
      case 'teamupdate':
        payload = {
          enabled: document.getElementById('teamupdate-enabled').checked,
          channelId: document.getElementById('teamupdate-channel').value,
          commands: Object.fromEntries(TEAMUPDATE_COMMANDS.map(cmd => {
            const entry = {
              enabled: document.getElementById(`cmd-enabled-${cmd}`)?.checked ?? true,
              roles: getSelectedRoleIds(`cmdrole-${cmd}`),
              channelId: document.getElementById(`cmd-${cmd}-channel`)?.value || ''
            };
            if (cmd === 'neuer_teamler' || cmd === 'teamkick') {
              entry.autoRoles = getSelectedRoleIds(`cmdrole-${cmd}-auto`);
            }
            if (cmd === 'teamwarn') {
              entry.warnStages = [
                getSelectedRoleIds('cmdrole-teamwarn-stage1')[0] || null,
                getSelectedRoleIds('cmdrole-teamwarn-stage2')[0] || null,
                getSelectedRoleIds('cmdrole-teamwarn-stage3')[0] || null,
                getSelectedRoleIds('cmdrole-teamwarn-stage4')[0] || null
              ];
            }
            return [cmd, entry];
          }))
        };
        break;
      case 'verification':
        payload = {
          enabled: document.getElementById('verification-enabled').checked,
          method: document.getElementById('verification-method').value,
          channelId: document.getElementById('verification-channel').value,
          roleId: getSelectedRoleIds('verification-roles')[0] || null,
          removeRoleIds: getSelectedRoleIds('verification-remove-roles'),
          title: document.getElementById('verification-title').value,
          description: document.getElementById('verification-description').value,
          color: document.getElementById('verification-color').value,
          image: document.getElementById('verification-image-input')?.dataset.value || '',
          buttonLabel: document.getElementById('verification-button-label').value
        };
        break;
      case 'minigames':
        payload = {
          counting: {
            enabled: document.getElementById('minigames-counting-enabled').checked,
            channelId: document.getElementById('minigames-counting-channel').value
          },
          flags: {
            enabled: document.getElementById('minigames-flags-enabled').checked,
            channelId: document.getElementById('minigames-flags-channel').value,
            buttons: {
              skip: document.getElementById('minigames-flags-btn-skip').checked,
              hint: document.getElementById('minigames-flags-btn-hint').checked,
              firstLetter: document.getElementById('minigames-flags-btn-letter').checked
            }
          },
          emoji: {
            enabled: document.getElementById('minigames-emoji-enabled').checked,
            channelId: document.getElementById('minigames-emoji-channel').value,
            buttons: {
              skip: document.getElementById('minigames-emoji-btn-skip').checked,
              hint: document.getElementById('minigames-emoji-btn-hint').checked,
              firstLetter: document.getElementById('minigames-emoji-btn-letter').checked
            }
          }
        };
        break;
      case 'rolenicknames':
        payload = {
          enabled: document.getElementById('rolenicknames-enabled').checked,
          entries: collectRoleNicknames()
        };
        break;
      case 'reactionroles':
        payload = { panels: collectReactionRolePanels() };
        break;
      case 'stats':
        payload = {
          enabled: document.getElementById('stats-enabled').checked,
          channels: collectStatsChannels()
        };
        break;
      case 'levels':
        payload = {
          enabled: document.getElementById('levels-enabled').checked,
          channelId: document.getElementById('levels-channel')?.value || '',
          xpMin: parseInt(document.getElementById('levels-xp-min')?.value) || 15,
          xpMax: parseInt(document.getElementById('levels-xp-max')?.value) || 25,
          cooldownSeconds: parseInt(document.getElementById('levels-cooldown')?.value) || 60,
          baseXp: parseInt(document.getElementById('levels-base-xp')?.value) || 100,
          xpIncrement: parseInt(document.getElementById('levels-xp-increment')?.value) || 50,
          levelUpMessage: document.getElementById('levels-message')?.value || '🎉 {user} hat **Level {level}** erreicht!',
          voice: {
            enabled: document.getElementById('levels-voice-enabled')?.checked ?? false,
            xpPerMinute: parseInt(document.getElementById('levels-voice-xp')?.value) || 10
          }
        };
        break;
      case 'statusembed':
        payload = {
          enabled: document.getElementById('statusembed-enabled').checked,
          channelId: document.getElementById('statusembed-channel')?.value || '',
          intervalMinutes: Math.max(1, parseInt(document.getElementById('statusembed-interval')?.value) || 30),
          roleId: getSelectedRoleIds('statusembed-role')[0] || null,
          title: document.getElementById('statusembed-title')?.value || '',
          color: document.getElementById('statusembed-color')?.value || '#2b2d31'
        };
        break;
      case 'applications':
        payload = { forms: collectApplicationForms() };
        break;
      case 'voice_support':
        payload = {
          enabled: document.getElementById('voice_support-enabled').checked,
          waitingRoomId: document.getElementById('voice_support-waitingroom')?.value || '',
          notificationChannelId: document.getElementById('voice_support-notification')?.value || '',
          pingRoleId: getSelectedRoleIds('voice_support-pingrole')[0] || null,
          dutyOnRoleId: getSelectedRoleIds('voice_support-dutyon')[0] || null,
          dutyOffRoleId: getSelectedRoleIds('voice_support-dutyoff')[0] || null,
          dutyEmbedChannelId: document.getElementById('voice_support-dutyembed')?.value || '',
          embedTitle: document.getElementById('voice_support-embed-title')?.value || '',
          embedDescription: document.getElementById('voice_support-embed-desc')?.value || '',
          embedColor: document.getElementById('voice_support-embed-color')?.value || '#5865f2',
          embedImage: document.getElementById('voice_support-embed-image-input')?.dataset.value || ''
        };
        break;
      default:
        const enabledEl = document.getElementById(`${moduleName}-enabled`);
        const channelEl = document.getElementById(`${moduleName}-channel`) || document.getElementById(`${moduleName}-log-channel`);
        payload = { enabled: enabledEl ? enabledEl.checked : true, channelId: channelEl ? channelEl.value : undefined };
    }
    await apiFetch(`/guild/${state.activeGuildId}/config/${moduleName}`, { method: 'POST', body: JSON.stringify(payload) });
    showToast(`${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)} gespeichert!`, 'success');
    if (saveStatus) { saveStatus.textContent = '✓ Gespeichert'; saveStatus.classList.remove('hidden'); setTimeout(() => saveStatus.classList.add('hidden'), 3000); }
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
    if (saveStatus) { saveStatus.textContent = '✕ Fehler'; saveStatus.classList.remove('hidden'); setTimeout(() => saveStatus.classList.add('hidden'), 3000); }
  }
}

function getSelectedOptions(selectId) {
  const el = document.getElementById(selectId);
  if (!el) return [];
  return Array.from(el.selectedOptions).map(o => o.value);
}

// ============================================================
// KEYBOARD SUPPORT
// ============================================================
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !DOM.manageOverlay.classList.contains('hidden')) closeManagement();
});

// ============================================================
// TICKET SYSTEM
// ============================================================

const ticketGrid = document.getElementById('ticket-overview-grid');
const editContainer = document.getElementById('ticket-edit-container');
const editContent = document.getElementById('ticket-edit-content');
let editingIndex = null;
let buttonCounter = 0;
let optionCounter = 0;
let rolenickCounter = 0;
let reactionRolePanelCounter = 0;
let applicationFormCounter = 0;

function switchEditTab(tabName) {
  document.querySelectorAll('.edit-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.edit-tab-content').forEach(el => el.classList.add('hidden'));
  const activeBtn = document.querySelector(`.edit-tab-btn[data-edit-tab="${tabName}"]`);
  const activeContent = document.getElementById(`edit-tab-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');
  if (activeContent) activeContent.classList.remove('hidden');
  updateEditPreview();
}

function populateCategorySelects() {
  const ids = ['edit-ticket-overflow', 'edit-option-category'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const categories = state.guildChannels.filter(c => c.type === 4);
    el.innerHTML = categories.length
      ? categories.map(c => `<option value="${c.id}">📁 ${escapeHtml(c.name)}</option>`).join('')
      : `<option value="">Keine Kategorien gefunden</option>`;
  });
}

function renderEditRoleChips(containerId, selectedIds = [], singleSelect = false) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (state.guildRoles.length === 0) {
    el.innerHTML = `<span class="chip-empty">Keine Rollen gefunden</span>`;
    return;
  }
  const selectedSet = new Set(selectedIds);
  el.innerHTML = state.guildRoles.map(r => {
    const isSelected = selectedSet.has(r.id);
    return `<div class="role-chip ${isSelected ? 'selected' : ''}" data-role-id="${r.id}" onclick="toggleEditRoleChip('${containerId}', '${r.id}', ${singleSelect})">
      <span class="chip-icon">@</span>
      <span class="chip-label">${escapeHtml(r.name)}</span>
    </div>`;
  }).join('');
}

window.toggleEditRoleChip = function(containerId, roleId, singleSelect) {
  const el = document.getElementById(containerId);
  const chip = el.querySelector(`[data-role-id="${roleId}"]`);
  if (!chip) return;
  if (singleSelect) {
    el.querySelectorAll('.role-chip').forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
  } else {
    chip.classList.toggle('selected');
  }
};

function getEditSelectedRoles(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return [];
  return Array.from(el.querySelectorAll('.role-chip.selected')).map(c => c.dataset.roleId);
}

const TPE_SWATCHES = [
  { hex: '#5865f2', name: 'blue' },
  { hex: '#6d7079', name: 'gray' },
  { hex: '#23a55a', name: 'green' },
  { hex: '#ef4444', name: 'red' }
];

window.tpeUpdateButtonPreview = function(rowId) {
  const row = document.getElementById(rowId);
  if (!row) return;
  const label = row.querySelector('.btn-label')?.value || 'Button';
  const emoji = row.querySelector('.btn-emoji')?.value || '';
  const color = row.querySelector('.btn-color')?.value || '#5865f2';
  const chip = row.querySelector('.tpe-btn-chip');
  const headLabel = row.querySelector('.btn-action-label');
  if (chip) chip.innerHTML = `${emoji ? escapeHtml(emoji) + ' ' : ''}${escapeHtml(label)}`;
  if (chip) chip.style.background = color;
  row.querySelectorAll('.tpe-swatch').forEach(sw => {
    sw.classList.toggle('selected', sw.dataset.hex.toLowerCase() === color.toLowerCase());
  });
  if (headLabel && !headLabel.value) headLabel.placeholder = label || 'Button';
};

window.tpeSelectSwatch = function(rowId, hex) {
  const row = document.getElementById(rowId);
  if (!row) return;
  const colorInput = row.querySelector('.btn-color');
  if (colorInput) colorInput.value = hex;
  window.tpeUpdateButtonPreview(rowId);
};

window.addButtonRow = function(data = null) {
  const container = document.getElementById('edit-button-list');
  if (!container) return;
  const rowId = `btn-${++buttonCounter}`;
  const row = document.createElement('div');
  row.className = 'tpe-btn-card';
  row.id = rowId;

  const label = data ? (data.label || '') : 'Ticket öffnen';
  const emoji = data ? (data.emoji || '') : '🎫';
  const color = data ? (data.color || '#5865f2') : '#5865f2';
  const action = data ? (data.action || '') : 'open';

  const swatchesHtml = TPE_SWATCHES.map(sw => `
    <div class="tpe-swatch ${sw.hex.toLowerCase() === color.toLowerCase() ? 'selected' : ''}" data-hex="${sw.hex}" style="background:${sw.hex}; color:${sw.hex};" onclick="tpeSelectSwatch('${rowId}', '${sw.hex}')"></div>
  `).join('');

  row.innerHTML = `
    <div class="tpe-btn-card-head">
      <input type="text" class="btn-action-label" placeholder="${escapeHtml(label || 'Button')}" value="">
      <button type="button" class="tpe-btn-remove" onclick="document.getElementById('${rowId}').remove()">✕</button>
    </div>
    <div class="tpe-btn-grid">
      <div class="form-group">
        <label>Emoji</label>
        <input type="text" class="btn-emoji" value="${escapeHtml(emoji)}" oninput="tpeUpdateButtonPreview('${rowId}')">
      </div>
      <div class="form-group">
        <label>Label</label>
        <input type="text" class="btn-label" placeholder="z.B. Claim" value="${escapeHtml(label)}" oninput="tpeUpdateButtonPreview('${rowId}')">
      </div>
      <div class="form-group">
        <label>Aktion</label>
        <input type="text" class="btn-action" placeholder="z.B. open, close, claim" value="${escapeHtml(action)}">
      </div>
    </div>
    <input type="color" class="btn-color hidden" value="${color}" style="display:none;">
    <div class="tpe-color-row" style="margin-top:12px;">
      ${swatchesHtml}
    </div>
    <div class="tpe-btn-preview">
      <div class="tpe-btn-preview-label">Vorschau</div>
      <span class="tpe-btn-chip" style="background:${color};">${emoji ? escapeHtml(emoji) + ' ' : ''}${escapeHtml(label || 'Button')}</span>
    </div>
  `;
  container.appendChild(row);
};

function collectButtons() {
  const rows = document.querySelectorAll('#edit-button-list .button-row');
  return Array.from(rows).map(row => ({
    label: row.querySelector('.btn-label')?.value || '',
    emoji: row.querySelector('.btn-emoji')?.value || '🎫',
    color: row.querySelector('.btn-color')?.value || '#ffffff',
    action: row.querySelector('.btn-action')?.value || ''
  }));
}

window.addOptionRow = function(data = null) {
  const container = document.getElementById('edit-options-list');
  if (!container) return;
  const rowId = `opt-${++optionCounter}`;
  const row = document.createElement('div');
  row.className = 'option-row tpe-option-card';
  row.id = rowId;

  const supportRoles = data?.supportRoles || [];

  row.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; gap:8px; width:100%; align-items:center;">
      <input type="text" placeholder="Emoji" class="opt-emoji" value="${data ? escapeHtml(data.emoji || '') : '🎫'}" style="max-width:64px; text-align:center;">
      <input type="text" placeholder="Label" class="opt-label" value="${data ? escapeHtml(data.label || '') : ''}" style="flex:2; min-width:100px;">
      <select class="opt-category" style="flex:2; min-width:140px;"></select>
      <button type="button" class="option-remove" onclick="document.getElementById('${rowId}').remove()">✕</button>
    </div>
    <div class="option-support-roles">
      <label>Support-Rollen für diese Option</label>
      <div class="chip-select" id="opt-support-roles-${rowId}" style="margin-top:2px;"></div>
    </div>
  `;
  container.appendChild(row);

  const select = row.querySelector('.opt-category');
  const categories = state.guildChannels.filter(c => c.type === 4);
  select.innerHTML = categories.length
    ? categories.map(c => `<option value="${c.id}">📁 ${escapeHtml(c.name)}</option>`).join('')
    : `<option value="">Keine Kategorien</option>`;
  if (data && data.categoryId) select.value = data.categoryId;

  const chipContainerId = `opt-support-roles-${rowId}`;
  const chipContainer = document.getElementById(chipContainerId);
  if (chipContainer) {
    renderEditRoleChips(chipContainerId, supportRoles);
  }
};

function collectOptions() {
  const rows = document.querySelectorAll('#edit-options-list .option-row');
  return Array.from(rows).map(row => {
    const chipContainerId = `opt-support-roles-${row.id}`;
    const supportRoles = getEditSelectedRoles(chipContainerId);
    return {
      label: row.querySelector('.opt-label')?.value || '',
      emoji: row.querySelector('.opt-emoji')?.value || '🎫',
      categoryId: row.querySelector('.opt-category')?.value || '',
      supportRoles: supportRoles
    };
  });
}

window.tpeSelectPanelColor = function(hex) {
  const colorInput = document.getElementById('edit-panel-color');
  const hexInput = document.getElementById('edit-panel-color-hex');
  if (colorInput) colorInput.value = hex;
  if (hexInput) hexInput.value = hex;
  document.querySelectorAll('#edit-tab-embed .tpe-swatch').forEach(sw => {
    sw.classList.toggle('selected', (sw.dataset.hex || '').toLowerCase() === hex.toLowerCase());
  });
  updateEditPreview();
};

function updateEditPreview() {
  const preview = document.getElementById('edit-embed-preview');
  if (!preview) return;

  const title = document.getElementById('edit-panel-title')?.value?.trim() || '';
  const desc = document.getElementById('edit-panel-desc')?.value || 'Wähle eine Kategorie aus.';
  const color = document.getElementById('edit-panel-color')?.value || '#ffffff';
  const imageInput = document.getElementById('edit-image-input');
  const image = imageInput?.dataset.value || '';

  const titleEl = preview.querySelector('.embed-preview-title');
  const descEl = preview.querySelector('.embed-preview-desc');
  const imgEl = preview.querySelector('.embed-preview-image');

  if (titleEl) {
    titleEl.textContent = title;
    titleEl.classList.toggle('hidden', !title);
  }
  if (descEl) descEl.textContent = desc;
  preview.style.borderLeftColor = color;

  if (imgEl) {
    if (image) {
      imgEl.src = image;
      imgEl.classList.remove('hidden');
    } else {
      imgEl.classList.add('hidden');
      imgEl.src = '';
    }
  }
}

async function sendPanelToChannel(channelId, panelIndex) {
  if (!state.activeGuildId) { showToast('Kein Server ausgewählt.', 'error'); return; }
  if (!channelId) { showToast('Bitte wähle einen Kanal aus.', 'error'); return; }
  if (panelIndex === undefined || panelIndex === null) { showToast('Bitte wähle ein Panel aus.', 'error'); return; }

  try {
    const response = await apiFetch(`/guild/${state.activeGuildId}/tickets/send-panel`, {
      method: 'POST',
      body: JSON.stringify({ panelIndex, channelId })
    });
    if (response && response.success) {
      showToast('Panel erfolgreich gesendet! 🎉', 'success');
    } else {
      showToast(response?.error || 'Fehler beim Senden.', 'error');
    }
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
}

async function renderTicketOverview() {
  if (!ticketGrid) return;
  if (!state.activeGuildId) {
    ticketGrid.innerHTML = `<div class="state-box">Bitte wähle zuerst einen Server aus.</div>`;
    return;
  }
  ticketGrid.innerHTML = `<div class="state-box"><span class="loading-spinner"></span> Lade Ticket-Panels...</div>`;

  try {
    const tickets = await getCachedTicketConfig();
    if (!tickets) {
      ticketGrid.innerHTML = `<div class="state-box error">Fehler beim Laden der Konfiguration.</div>`;
      return;
    }
    const panels = tickets.options || [];

    if (panels.length === 0) {
      ticketGrid.innerHTML = `
        <div class="ticket-add-card" onclick="openAddTicket()">
          <div class="icon">＋</div>
          <div class="label">Neues Ticket-Panel</div>
          <div class="sub">Klicke hier, um ein neues Panel zu erstellen.</div>
        </div>
      `;
      return;
    }

    const activeCount = panels.filter(p => p.enabled !== false).length;
    const optionTotal = panels.reduce((sum, p) => sum + (p.options || []).length, 0);
    const statsHtml = `
      <div class="ticket-stats">
        <div class="ticket-stat accent"><div class="num">${panels.length}</div><div class="lbl">Panels</div></div>
        <div class="ticket-stat ok"><div class="num">${activeCount}</div><div class="lbl">Aktiv</div></div>
        <div class="ticket-stat"><div class="num">${optionTotal}</div><div class="lbl">Kategorien</div></div>
      </div>
    `;

    const toolbarHtml = `
      <div class="ticket-toolbar">
        <label>Panel:</label>
        <select id="send-panel-select">
          ${panels.map((opt, i) => `<option value="${i}">${escapeHtml(opt.panelName || opt.label || 'Unbenannt')}</option>`).join('')}
        </select>
        <label>Kanal:</label>
        <select id="send-channel-select">
          ${state.guildChannels.filter(c => c.type === 0).map(c => `<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('')}
          ${state.guildChannels.filter(c => c.type === 0).length === 0 ? '<option value="">Keine Textkanäle</option>' : ''}
        </select>
        <button class="btn btn-primary" onclick="sendPanelToChannel(document.getElementById('send-channel-select').value, parseInt(document.getElementById('send-panel-select').value))">
          📤 Abschicken
        </button>
      </div>
    `;

    let html = statsHtml + toolbarHtml;
    html += `<div class="ticket-grid">`;

    panels.forEach((panel, index) => {
      const emoji = panel.emoji || '🎫';
      const label = panel.panelName || panel.label || 'Unbenannt';
      const categoryName = state.guildChannels.find(c => c.id === panel.categoryId)?.name || 'Keine Kategorie';
      const isActive = panel.enabled !== false;
      const optionCount = (panel.options || []).length;
      const accent = isActive ? '#22c55e' : '#ef4444';

      html += `
        <div class="ticket-card" style="--ticket-accent: ${accent};">
          <div class="header">
            <div class="title-row">
              <div class="emoji-badge">${escapeHtml(emoji)}</div>
              <div class="title">${escapeHtml(label)}</div>
            </div>
            <span class="status-pill ${isActive ? 'active' : ''}">
              <span class="dot"></span> ${isActive ? 'Aktiv' : 'Inaktiv'}
            </span>
          </div>
          <div class="meta">
            <span>📂 ${escapeHtml(categoryName)}</span>
            <span>📋 ${optionCount} Option${optionCount !== 1 ? 'en' : ''}</span>
          </div>
          <div class="actions">
            <button class="btn btn-secondary" onclick="openEditView(${index})">✏️ Bearbeiten</button>
            <button class="btn btn-danger" onclick="deleteTicketOption(${index})">🗑️ Löschen</button>
          </div>
        </div>
      `;
    });

    html += `
      <div class="ticket-add-card" onclick="openAddTicket()">
        <div class="icon">＋</div>
        <div class="label">Neues Ticket-Panel</div>
        <div class="sub">Klicke hier, um ein neues Panel zu erstellen.</div>
      </div>
    `;
    html += `</div>`;

    ticketGrid.innerHTML = html;
  } catch (err) {
    ticketGrid.innerHTML = `<div class="state-box error">Fehler: ${err.message}</div>`;
  }
}

window.deleteTicketOption = async function(index) {
  if (!confirm('Möchtest du dieses Panel wirklich löschen?')) return;
  try {
    const config = await apiFetch(`/guild/${state.activeGuildId}/config`);
    if (!config.tickets || !config.tickets.options || !config.tickets.options[index]) return;
    config.tickets.options.splice(index, 1);
    await apiFetch(`/guild/${state.activeGuildId}/config/tickets`, { method: 'POST', body: JSON.stringify(config.tickets) });
    invalidateTicketCache();
    showToast('Panel gelöscht.', 'success');
    renderTicketOverview();
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
};

window.openAddTicket = function() { editingIndex = null; showEditView(null); };
window.openEditView = function(index) { editingIndex = index; showEditView(index); };

async function showEditView(index) {
  document.getElementById('ticket-overview-container').classList.add('hidden');
  editContainer.classList.remove('hidden');
  editContent.innerHTML = `<div style="text-align:center;padding:2rem;"><span class="loading-spinner"></span> Lade Einstellungen...</div>`;

  const tickets = await getCachedTicketConfig();
  if (!tickets) {
    editContent.innerHTML = `<div class="state-box error">Fehler beim Laden.</div>`;
    return;
  }
  const panels = tickets.options || [];
  let data = null;
  if (index !== null && panels[index]) {
    data = panels[index];
  } else {
    data = {
      enabled: true,
      panelName: 'Neues Panel',
      panelChannelId: '',
      logChannelId: '',
      supportRoles: [],
      categoryId: '',
      title: 'Support Center',
      description: 'Wähle eine Kategorie aus.',
      color: '#ffffff',
      image: '',
      creationMessage: 'Hallo {user}, wir kümmern uns um dein Anliegen.',
      channelNameTemplate: '{panel.name}-{ticket.creator.username}',
      allowedRoles: [],
      deniedRoles: [],
      maxTickets: 1,
      overflowEnabled: false,
      overflowCategories: [],
      threadMode: 'none',
      saveTranscripts: false,
      saveImages: false,
      privateTranscripts: false,
      claimEnabled: false,
      buttons: [],
      options: []
    };
  }

  const textChannelsForHeader = state.guildChannels.filter(c => c.type === 0);

  let html = `
    <div class="tpe">

      <div class="tpe-header">
        <button class="tpe-back" onclick="closeEditView()" title="Zurück">←</button>
        <div class="tpe-header-titles">
          <span class="tpe-title">Panel bearbeiten</span>
          <select id="edit-panel-select" class="tpe-panel-select" onchange="switchToSelectedPanel()">
            ${panels.map((p, i) => `<option value="${i}" ${i === index ? 'selected' : ''}>${escapeHtml(p.panelName || p.label || 'Unbenannt')}</option>`).join('')}
            ${index === null ? `<option value="new" selected>+ Neues Panel</option>` : ''}
          </select>
        </div>
        <div class="tpe-header-actions">
          <select id="tpe-send-channel" class="tpe-channel-select">
            ${textChannelsForHeader.length ? textChannelsForHeader.map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('') : `<option value="">Keine Textkanäle</option>`}
          </select>
          <button class="btn btn-primary" onclick="sendPanelToChannel(document.getElementById('tpe-send-channel').value, editingIndex)">📤 Panel senden</button>
        </div>
      </div>

      <div class="edit-tabs">
        <button class="edit-tab-btn active" data-edit-tab="general" onclick="switchEditTab('general')">Allgemein</button>
        <button class="edit-tab-btn" data-edit-tab="embed" onclick="switchEditTab('embed')">Embed</button>
        <button class="edit-tab-btn" data-edit-tab="messages" onclick="switchEditTab('messages')">Nachrichten</button>
        <button class="edit-tab-btn" data-edit-tab="roles" onclick="switchEditTab('roles')">Berechtigungen</button>
        <button class="edit-tab-btn" data-edit-tab="advanced" onclick="switchEditTab('advanced')">Fortgeschritten</button>
        <button class="edit-tab-btn" data-edit-tab="options" onclick="switchEditTab('options')">Optionen</button>
      </div>

      <div id="edit-tab-general" class="edit-tab-content">

        <div class="tpe-card">
          <div class="tpe-card-head">
            <div>
              <div class="tpe-card-title">Panel aktiv</div>
              <div class="tpe-card-sub">Deaktivierte Panels können nicht gesendet werden.</div>
            </div>
            <label class="switch"><input type="checkbox" id="edit-panel-enabled" ${data.enabled ? 'checked' : ''}><span class="switch-slider"></span></label>
          </div>
          <div class="form-group">
            <label for="edit-panel-name">Panel-Name</label>
            <input type="text" id="edit-panel-name" value="${escapeHtml(data.panelName || '')}" placeholder="z.B. Support">
          </div>
          <div class="form-group">
            <label>Support-Rollen (Fallback)</label>
            <div id="edit-support-roles" class="chip-select"></div>
            <small>Werden verwendet, wenn keine options­pezifischen Rollen definiert sind.</small>
          </div>
        </div>

        <div class="tpe-card">
          <div class="tpe-card-title">📍 Ticket-Standort</div>
          <div class="form-group">
            <label for="edit-panel-channel">Kanal für das Panel</label>
            <select id="edit-panel-channel"></select>
            <small>Hier wird das Ticket-Panel gesendet.</small>
          </div>
          <div class="form-group">
            <label for="edit-log-channel">Log-Kanal</label>
            <select id="edit-log-channel"></select>
            <small>Logs und Transkripte werden hier gesendet.</small>
          </div>
          <div class="form-group">
            <small>ℹ️ Die Kategorie für Tickets legst du pro Option im Tab „Optionen“ fest – jede Dropdown-Option kann eine eigene Kategorie haben.</small>
          </div>
        </div>

      </div>

      <div id="edit-tab-embed" class="edit-tab-content hidden">

        <div class="tpe-card">
          <div class="tpe-card-title" style="margin-bottom:12px;">📺 Live-Vorschau</div>
          <div class="tpe-discord-preview">
            <div class="tpe-discord-author">
              <div class="tpe-discord-avatar"><img src="apex_logo.png" alt="APEX Bot"></div>
              <div class="tpe-discord-namerow">
                <span class="tpe-discord-name">APEX Bot</span>
                <span class="tpe-discord-app-badge">✓ App</span>
                <span class="tpe-discord-time">Heute um 12:00</span>
              </div>
            </div>
            <div class="embed-preview" id="edit-embed-preview" style="border-left-color:${data.color || '#6d5ef8'};">
              <div class="embed-preview-title ${data.title ? '' : 'hidden'}">${escapeHtml(data.title || '')}</div>
              <div class="embed-preview-desc">${escapeHtml(data.description || 'Wähle eine Kategorie aus.')}</div>
              <img class="embed-preview-image ${data.image ? '' : 'hidden'}" src="${data.image || ''}">
            </div>
          </div>
          <div class="form-group">
            <label for="edit-panel-title">Titel</label>
            <input type="text" id="edit-panel-title" value="${escapeHtml(data.title || '')}" placeholder="Support Center" oninput="updateEditPreview()">
          </div>
          <div class="form-group">
            <label for="edit-panel-desc">Beschreibung</label>
            <textarea id="edit-panel-desc" rows="3" placeholder="Wähle eine Kategorie aus." oninput="updateEditPreview()">${escapeHtml(data.description || '')}</textarea>
          </div>
          <div class="form-group">
            <label>Bild (optional)</label>
            <div class="image-upload">
              <img id="edit-image-preview" class="image-preview" src="${data.image || ''}" alt="">
              <div class="upload-btn-wrap"><label class="btn btn-secondary" for="edit-image-input">📤 Hochladen</label><input type="file" id="edit-image-input" accept="image/*" onchange="handleEditImageUpload(this)"></div>
              <button class="btn btn-secondary" onclick="clearEditImage()">Entfernen</button>
            </div>
          </div>
          <div class="form-group">
            <label>Farbe</label>
            <div class="tpe-color-row">
              ${TPE_SWATCHES.map(sw => `<div class="tpe-swatch ${ (data.color || '#6d5ef8').toLowerCase() === sw.hex.toLowerCase() ? 'selected' : ''}" data-hex="${sw.hex}" style="background:${sw.hex}; color:${sw.hex};" onclick="tpeSelectPanelColor('${sw.hex}')"></div>`).join('')}
              <input type="color" id="edit-panel-color" value="${data.color || '#6d5ef8'}" oninput="document.getElementById('edit-panel-color-hex').value = this.value; updateEditPreview();">
              <input type="text" id="edit-panel-color-hex" value="${data.color || '#6d5ef8'}" oninput="document.getElementById('edit-panel-color').value = this.value; updateEditPreview();">
            </div>
          </div>
        </div>

      </div>

      <div id="edit-tab-messages" class="edit-tab-content hidden">

        <div class="tpe-card">
          <div class="tpe-card-title" style="margin-bottom:12px;">💬 Begrüßungsnachricht</div>
          <div class="tpe-discord-preview">
            <div class="tpe-discord-author">
              <div class="tpe-discord-avatar"><img src="apex_logo.png" alt="APEX Bot"></div>
              <div class="tpe-discord-namerow">
                <span class="tpe-discord-name">APEX Bot</span>
                <span class="tpe-discord-app-badge">✓ App</span>
                <span class="tpe-discord-time">Heute um 12:00</span>
              </div>
            </div>
            <div class="tpe-msg-bubble" id="tpe-message-preview">${escapeHtml(data.creationMessage || 'Hallo {user}, wir kümmern uns um dein Anliegen.')}</div>
          </div>
          <div class="form-group">
            <label for="edit-create-msg">Nachrichtentext</label>
            <textarea id="edit-create-msg" rows="3" placeholder="Hallo {user}, wir kümmern uns um dein Anliegen." oninput="document.getElementById('tpe-message-preview').textContent = this.value || 'Hallo {user}, wir kümmern uns um dein Anliegen.'">${escapeHtml(data.creationMessage || '')}</textarea>
            <small>Platzhalter: <code>{user}</code>, <code>{username}</code></small>
          </div>
          <div class="form-group">
            <label for="edit-channel-template">Kanalnamen-Vorlage</label>
            <input type="text" id="edit-channel-template" value="${escapeHtml(data.channelNameTemplate || '{panel.name}-{ticket.creator.username}')}" placeholder="{panel.name}-{ticket.creator.username}">
            <small>Platzhalter: <code>{panel.name}</code>, <code>{ticket.creator.username}</code>, <code>{ticket.id}</code></small>
          </div>
        </div>

        <div class="tpe-card">
          <div class="tpe-card-title">🔘 Buttons</div>
          <div class="tpe-card-sub" style="margin-bottom:14px;">Konfiguriere Emoji, Label, Farbe und Aktion jedes Buttons.</div>
          <div id="edit-button-list"></div>
          <button type="button" class="add-option-btn" onclick="window.addButtonRow()">+ Button hinzufügen</button>
        </div>

      </div>

      <div id="edit-tab-roles" class="edit-tab-content hidden">

        <div class="tpe-card">
          <div class="tpe-card-title">🔐 Zugriff</div>
          <div class="form-group">
            <label>Rollen, die öffnen dürfen (optional)</label>
            <div id="edit-allowed-roles" class="chip-select"></div>
            <small>Leer lassen = jeder darf öffnen.</small>
          </div>
          <div class="form-group">
            <label>Rollen, die nicht öffnen dürfen (optional)</label>
            <div id="edit-denied-roles" class="chip-select"></div>
          </div>
        </div>

        <div class="tpe-card">
          <div class="tpe-card-title">🎫 Ticket-Limit</div>
          <div class="form-group">
            <label>Max. Tickets pro User</label>
            <div class="tpe-stepper">
              <button type="button" onclick="document.getElementById('edit-max-tickets').stepDown(); if(document.getElementById('edit-max-tickets').value<1)document.getElementById('edit-max-tickets').value=1;">−</button>
              <input type="number" id="edit-max-tickets" value="${data.maxTickets || 1}" min="1" step="1">
              <button type="button" onclick="document.getElementById('edit-max-tickets').stepUp();">+</button>
            </div>
          </div>
        </div>

      </div>

      <div id="edit-tab-advanced" class="edit-tab-content hidden">

        <div class="tpe-card">
          <div class="tpe-card-head">
            <div>
              <div class="tpe-card-title">Überlauf-Kategorien</div>
              <div class="tpe-card-sub">Wenn die Hauptkategorie voll ist, weichen neue Tickets hierauf aus.</div>
            </div>
            <label class="switch"><input type="checkbox" id="edit-overflow-enabled" ${data.overflowEnabled ? 'checked' : ''}><span class="switch-slider"></span></label>
          </div>
          <div class="form-group" id="edit-overflow-group" style="${data.overflowEnabled ? '' : 'display:none;'}">
            <label for="edit-ticket-overflow">Überlauf-Kategorien</label>
            <select id="edit-ticket-overflow" multiple style="height:auto;min-height:50px;"></select>
            <small>Strg (Cmd) für Mehrfachauswahl.</small>
          </div>
        </div>

        <div class="tpe-card">
          <div class="tpe-card-title">🧵 Thread-Modus</div>
          <div class="form-group">
            <select id="edit-thread-mode">
              <option value="none" ${data.threadMode === 'none' ? 'selected' : ''}>Keine</option>
              <option value="thread" ${data.threadMode === 'thread' ? 'selected' : ''}>Öffentlich</option>
              <option value="private" ${data.threadMode === 'private' ? 'selected' : ''}>Privat</option>
            </select>
          </div>
        </div>

        <div class="tpe-card">
          <div class="tpe-card-title">📄 Transkript-Einstellungen</div>
          <div class="form-group">
            <div class="switch-row">
              <label style="font-size:0.85rem;">Transkripte speichern</label>
              <label class="switch"><input type="checkbox" id="edit-save-transcripts" ${data.saveTranscripts ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            <div class="switch-row">
              <label style="font-size:0.85rem;">Bilder in Transkripten</label>
              <label class="switch"><input type="checkbox" id="edit-save-images" ${data.saveImages ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
            <div class="switch-row">
              <label style="font-size:0.85rem;">Private Transkripte</label>
              <label class="switch"><input type="checkbox" id="edit-private-transcripts" ${data.privateTranscripts ? 'checked' : ''}><span class="switch-slider"></span></label>
            </div>
          </div>
        </div>

        <div class="tpe-card">
          <div class="tpe-card-head">
            <div>
              <div class="tpe-card-title">Claim-System</div>
              <div class="tpe-card-sub">Support-Mitglieder können Tickets für sich beanspruchen.</div>
            </div>
            <label class="switch"><input type="checkbox" id="edit-claim-enabled" ${data.claimEnabled ? 'checked' : ''}><span class="switch-slider"></span></label>
          </div>
        </div>

      </div>

      <div id="edit-tab-options" class="edit-tab-content hidden">

        <div class="tpe-card">
          <div class="tpe-card-title">📋 Dropdown-Optionen</div>
          <div class="tpe-card-sub" style="margin-bottom:14px;">Jede Option kann eigene Support-Rollen und eine eigene Kategorie haben.</div>
          <div id="edit-options-list"></div>
          <button type="button" class="add-option-btn" onclick="window.addOptionRow()">+ Option hinzufügen</button>
        </div>

      </div>

      <div class="tpe-footer">
        <button class="btn btn-primary" onclick="saveEditView()">💾 Speichern</button>
        <button class="btn btn-secondary" onclick="closeEditView()">Abbrechen</button>
        <span id="edit-save-status" class="hidden status-success"></span>
      </div>
    </div>
  `;

  editContent.innerHTML = html;

  populateCategorySelects();

  renderEditRoleChips('edit-support-roles', data.supportRoles || []);
  renderEditRoleChips('edit-allowed-roles', data.allowedRoles || []);
  renderEditRoleChips('edit-denied-roles', data.deniedRoles || []);

  const panelChannelSelect = document.getElementById('edit-panel-channel');
  if (panelChannelSelect) {
    const textChannels = state.guildChannels.filter(c => c.type === 0);
    panelChannelSelect.innerHTML = textChannels.length
      ? textChannels.map(c => `<option value="${c.id}" ${c.id === data.panelChannelId ? 'selected' : ''}># ${escapeHtml(c.name)}</option>`).join('')
      : `<option value="">Keine Textkanäle</option>`;
  }

  const logChannelSelect = document.getElementById('edit-log-channel');
  if (logChannelSelect) {
    const textChannels = state.guildChannels.filter(c => c.type === 0);
    logChannelSelect.innerHTML = textChannels.length
      ? textChannels.map(c => `<option value="${c.id}" ${c.id === data.logChannelId ? 'selected' : ''}># ${escapeHtml(c.name)}</option>`).join('')
      : `<option value="">Keine Textkanäle</option>`;
  }

  if (data.overflowCategories) {
    const overflowSelect = document.getElementById('edit-ticket-overflow');
    if (overflowSelect) {
      Array.from(overflowSelect.options).forEach(opt => {
        opt.selected = data.overflowCategories.includes(opt.value);
      });
    }
  }

  document.getElementById('edit-overflow-enabled').addEventListener('change', function() {
    document.getElementById('edit-overflow-group').style.display = this.checked ? '' : 'none';
  });

  if (data.buttons && data.buttons.length) {
    data.buttons.forEach(btn => window.addButtonRow(btn));
  } else {
    window.addButtonRow({ label: 'Ticket öffnen', emoji: '🎫', color: '#5865f2', action: 'open' });
  }

  if (data.options && data.options.length) {
    data.options.forEach(opt => window.addOptionRow(opt));
  } else {
    window.addOptionRow({ label: 'Allgemeiner Support', emoji: '🎫', categoryId: '', supportRoles: [] });
  }
}

window.closeEditView = function() {
  editContainer.classList.add('hidden');
  document.getElementById('ticket-overview-container').classList.remove('hidden');
  editingIndex = null;
};

// ============================================================
// VERIFICATION PANEL SENDEN
// ============================================================
async function sendVerificationPanel() {
  if (!state.activeGuildId) { showToast('Kein Server ausgewählt.', 'error'); return; }
  const channelId = document.getElementById('verification-channel').value;
  const method = document.getElementById('verification-method').value;
  const roleId = getSelectedRoleIds('verification-roles')[0];
  if (!channelId) { showToast('Bitte wähle einen Kanal aus.', 'error'); return; }
  if (!roleId) { showToast('Bitte wähle eine Rolle aus.', 'error'); return; }

  const title = document.getElementById('verification-title').value;
  const description = document.getElementById('verification-description').value;
  const color = document.getElementById('verification-color').value;
  const image = document.getElementById('verification-image-input')?.dataset.value || '';
  const buttonLabel = document.getElementById('verification-button-label').value;

  console.log('📤 Sende Verifizierungs-Panel mit:', { channelId, method, roleId, title, description, color, image, buttonLabel });

  try {
    const response = await apiFetch(`/guild/${state.activeGuildId}/verification/send-panel`, {
      method: 'POST',
      body: JSON.stringify({
        channelId,
        method,
        roleId,
        title,
        description,
        color,
        image,
        buttonLabel
      })
    });
    if (response && response.success) {
      showToast('Verifizierungs-Panel erfolgreich gesendet!', 'success');
    } else {
      showToast(response?.error || 'Fehler beim Senden.', 'error');
    }
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
}

// ============================================================
// STATISTIK-FUNKTIONEN
// ============================================================
let statsChannelCounter = 0;

function addStatsChannel(data = null) {
  const container = document.getElementById('stats-channels-list');
  if (!container) return;
  const id = (data && data.id) || `stats-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  const rowId = `stats-${++statsChannelCounter}`;
  const row = document.createElement('div');
  row.className = 'panel-card';
  row.id = rowId;
  row.dataset.id = id;
  row.style.marginBottom = '12px';

  const categoryId = data?.categoryId || '';
  const channelName = data?.channelName || '📊 {stat}';
  const statType = data?.statType || 'members';
  const roleId = data?.roleId || '';

  row.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
      <span style="font-weight:700;">Statistik-Kanal</span>
      <button type="button" class="option-remove" onclick="document.getElementById('${rowId}').remove()">✕</button>
    </div>
    <input type="hidden" class="stats-id" value="${escapeHtml(id)}">
    <div class="form-group">
      <label>Kategorie</label>
      <select class="stats-category">
        ${state.guildChannels.filter(c => c.type === 4).map(c =>
          `<option value="${c.id}" ${c.id === categoryId ? 'selected' : ''}>📁 ${escapeHtml(c.name)}</option>`
        ).join('') || '<option value="">Keine Kategorien gefunden</option>'}
      </select>
    </div>
    <div class="form-group">
      <label>Kanalname (Platzhalter: <code>{stat}</code> wird durch den Wert ersetzt)</label>
      <input type="text" class="stats-name" placeholder="📊 {stat}" value="${escapeHtml(channelName)}">
    </div>
    <div class="form-group">
      <label>Statistik-Typ</label>
      <select class="stats-type" onchange="toggleStatsRoleSelect('${rowId}')">
        <option value="members" ${statType === 'members' ? 'selected' : ''}>Mitglieder (ohne Bots)</option>
        <option value="bots" ${statType === 'bots' ? 'selected' : ''}>Bots</option>
        <option value="roles" ${statType === 'roles' ? 'selected' : ''}>Rollen</option>
        <option value="boosts" ${statType === 'boosts' ? 'selected' : ''}>Boosts</option>
        <option value="role_count" ${statType === 'role_count' ? 'selected' : ''}>Anzahl einer bestimmten Rolle</option>
      </select>
    </div>
    <div class="form-group stats-role-group" style="${statType === 'role_count' ? '' : 'display:none;'}">
      <label>Rolle</label>
      <select class="stats-role">
        ${state.guildRoles.map(r =>
          `<option value="${r.id}" ${r.id === roleId ? 'selected' : ''}>@${escapeHtml(r.name)}</option>`
        ).join('') || '<option value="">Keine Rollen gefunden</option>'}
      </select>
    </div>
  `;
  container.appendChild(row);
}

function toggleStatsRoleSelect(rowId) {
  const row = document.getElementById(rowId);
  if (!row) return;
  const type = row.querySelector('.stats-type').value;
  const group = row.querySelector('.stats-role-group');
  group.style.display = type === 'role_count' ? '' : 'none';
}

function collectStatsChannels() {
  const rows = document.querySelectorAll('#stats-channels-list .panel-card');
  return Array.from(rows).map(row => ({
    id: row.dataset.id,
    categoryId: row.querySelector('.stats-category').value,
    channelName: row.querySelector('.stats-name').value,
    statType: row.querySelector('.stats-type').value,
    roleId: row.querySelector('.stats-role')?.value || ''
  }));
}

function applyStatsConfig(cfg) {
  setChecked('stats-enabled', cfg.enabled ?? false);
  const container = document.getElementById('stats-channels-list');
  if (container) container.innerHTML = '';
  const channels = cfg.channels || [];
  if (channels.length === 0) {
    addStatsChannel();
  } else {
    channels.forEach(ch => addStatsChannel(ch));
  }
}

// ============================================================
// 🆕 BOT CONTROL FUNKTIONEN
// ============================================================
function renderBotChannelSelect() {
  const select = document.getElementById('bot-channel');
  if (!select) return;
  const textChannels = state.guildChannels.filter(c => c.type === 0);
  if (textChannels.length === 0) {
    select.innerHTML = `<option value="">Keine Textkanäle</option>`;
    return;
  }
  select.innerHTML = textChannels.map(c => `<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('');
}

let botEmbedCounter = 0;
let botButtonCounter = 0;

function addBotEmbed(data = null) {
  const container = document.getElementById('bot-embeds-list');
  if (!container) return;
  const idx = ++botEmbedCounter;
  const row = document.createElement('div');
  row.className = 'option-row';
  row.id = `bot-embed-${idx}`;
  row.innerHTML = `
    <input type="text" placeholder="Titel" class="bot-embed-title" value="${data?.title || ''}" style="flex:1;">
    <input type="text" placeholder="Beschreibung" class="bot-embed-desc" value="${data?.description || ''}" style="flex:2;">
    <input type="color" class="bot-embed-color" value="${data?.color || '#5865f2'}" style="width:40px;">
    <input type="text" placeholder="Bild-URL" class="bot-embed-image" value="${data?.image || ''}" style="flex:1;">
    <button type="button" class="option-remove" onclick="document.getElementById('${row.id}').remove()">✕</button>
  `;
  container.appendChild(row);
}

function addBotButton(data = null) {
  const container = document.getElementById('bot-buttons-list');
  if (!container) return;
  const idx = ++botButtonCounter;
  const row = document.createElement('div');
  row.className = 'option-row';
  row.id = `bot-btn-${idx}`;
  const label = data?.label || '';
  const style = data?.style || '1';
  const actionType = data?.actionType || 'none';
  const roleId = data?.roleId || '';
  const channelId = data?.channelId || '';
  const messageText = data?.messageText || '';

  let roleOptions = state.guildRoles.map(r => `<option value="${r.id}">@${escapeHtml(r.name)}</option>`).join('');
  if (!roleOptions) roleOptions = '<option value="">Keine Rollen</option>';

  let channelOptions = state.guildChannels.filter(c => c.type === 0).map(c => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
  if (!channelOptions) channelOptions = '<option value="">Keine Kanäle</option>';

  row.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; gap:8px; width:100%; align-items:center;">
      <input type="text" placeholder="Label" class="bot-btn-label" value="${escapeHtml(label)}" style="flex:1;">
      <select class="bot-btn-style" style="flex:1;">
        <option value="1" ${style === '1' ? 'selected' : ''}>Primary</option>
        <option value="2" ${style === '2' ? 'selected' : ''}>Secondary</option>
        <option value="3" ${style === '3' ? 'selected' : ''}>Success</option>
        <option value="4" ${style === '4' ? 'selected' : ''}>Danger</option>
        <option value="5" ${style === '5' ? 'selected' : ''}>Link</option>
      </select>
      <select class="bot-btn-action" style="flex:1.5;">
        <option value="none" ${actionType === 'none' ? 'selected' : ''}>Keine Aktion</option>
        <option value="role_add" ${actionType === 'role_add' ? 'selected' : ''}>Rolle hinzufügen</option>
        <option value="role_remove" ${actionType === 'role_remove' ? 'selected' : ''}>Rolle entfernen</option>
        <option value="role_toggle" ${actionType === 'role_toggle' ? 'selected' : ''}>Rolle toggeln</option>
        <option value="message_send" ${actionType === 'message_send' ? 'selected' : ''}>Nachricht senden</option>
      </select>
      <button type="button" class="option-remove" onclick="document.getElementById('${row.id}').remove()">✕</button>
    </div>
    <div class="bot-action-params" style="display:${actionType !== 'none' ? 'flex' : 'none'}; flex-wrap:wrap; gap:8px; width:100%; margin-top:4px;">
      <div class="bot-action-role" style="display:${(actionType === 'role_add' || actionType === 'role_remove' || actionType === 'role_toggle') ? 'flex' : 'none'}; flex:1; min-width:140px;">
        <select class="bot-action-role-select" style="width:100%;">
          ${roleOptions}
        </select>
      </div>
      <div class="bot-action-message" style="display:${actionType === 'message_send' ? 'flex' : 'none'}; flex-wrap:wrap; gap:8px; width:100%;">
        <select class="bot-action-channel" style="flex:1; min-width:140px;">
          ${channelOptions}
        </select>
        <input type="text" class="bot-action-msgtext" placeholder="Nachrichtentext" value="${escapeHtml(messageText)}" style="flex:2; min-width:120px;">
      </div>
    </div>
  `;
  container.appendChild(row);

  const actionSelect = row.querySelector('.bot-btn-action');
  const paramsDiv = row.querySelector('.bot-action-params');
  const roleDiv = row.querySelector('.bot-action-role');
  const msgDiv = row.querySelector('.bot-action-message');

  actionSelect.addEventListener('change', function() {
    const val = this.value;
    paramsDiv.style.display = val !== 'none' ? 'flex' : 'none';
    roleDiv.style.display = (val === 'role_add' || val === 'role_remove' || val === 'role_toggle') ? 'flex' : 'none';
    msgDiv.style.display = val === 'message_send' ? 'flex' : 'none';
  });

  if (data) {
    if (data.roleId) {
      const roleSelect = row.querySelector('.bot-action-role-select');
      if (roleSelect) roleSelect.value = data.roleId;
    }
    if (data.channelId) {
      const channelSelect = row.querySelector('.bot-action-channel');
      if (channelSelect) channelSelect.value = data.channelId;
    }
    if (data.messageText) {
      const msgInput = row.querySelector('.bot-action-msgtext');
      if (msgInput) msgInput.value = data.messageText;
    }
  }
}

function collectBotButtons() {
  const rows = document.querySelectorAll('#bot-buttons-list .option-row');
  const buttons = [];
  rows.forEach(row => {
    const label = row.querySelector('.bot-btn-label')?.value || '';
    const style = parseInt(row.querySelector('.bot-btn-style')?.value || '1');
    const actionType = row.querySelector('.bot-btn-action')?.value || 'none';
    if (!label) return;

    const btn = { label, style };
    if (style === 5) return;
    const action = {};
    if (actionType !== 'none') {
      action.type = actionType;
      if (actionType === 'role_add' || actionType === 'role_remove' || actionType === 'role_toggle') {
        const roleSelect = row.querySelector('.bot-action-role-select');
        if (roleSelect) action.roleId = roleSelect.value;
      } else if (actionType === 'message_send') {
        const channelSelect = row.querySelector('.bot-action-channel');
        const msgInput = row.querySelector('.bot-action-msgtext');
        if (channelSelect) action.channelId = channelSelect.value;
        if (msgInput) action.message = msgInput.value;
      }
      btn.action = action;
    }
    buttons.push(btn);
  });
  return buttons;
}

async function sendBotMessage() {
  const channelId = document.getElementById('bot-channel')?.value;
  if (!channelId) { showToast('Bitte wähle einen Kanal.', 'error'); return; }
  const content = document.getElementById('bot-content')?.value || '';
  const embeds = collectBotEmbeds();
  const buttons = collectBotButtons();

  if (!content && embeds.length === 0 && buttons.length === 0) {
    showToast('Bitte gib Text, Embed(s) oder Button(s) ein.', 'error');
    return;
  }

  let components = [];
  if (buttons.length > 0) {
    const row = {
      type: 1,
      components: buttons.map(btn => {
        const comp = {
          type: 2,
          label: btn.label,
          style: btn.style,
          custom_id: `btn_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
        };
        if (btn.action) {
          comp.action = btn.action;
        }
        return comp;
      })
    };
    components.push(row);
  }

  try {
    const response = await apiFetch(`/guild/${state.activeGuildId}/bot/send`, {
      method: 'POST',
      body: JSON.stringify({ channelId, content, embeds, components })
    });
    if (response?.success) {
      showToast('Nachricht gesendet!', 'success');
      loadBotMessages();
      document.getElementById('bot-content').value = '';
      document.getElementById('bot-embeds-list').innerHTML = '';
      document.getElementById('bot-buttons-list').innerHTML = '';
      botEmbedCounter = 0;
      botButtonCounter = 0;
    } else {
      showToast(response?.error || 'Fehler beim Senden.', 'error');
    }
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
}

function collectBotEmbeds() {
  const rows = document.querySelectorAll('#bot-embeds-list .option-row');
  return Array.from(rows).map(row => {
    const title = row.querySelector('.bot-embed-title')?.value || '';
    const description = row.querySelector('.bot-embed-desc')?.value || '';
    const color = row.querySelector('.bot-embed-color')?.value || '#5865f2';
    const image = row.querySelector('.bot-embed-image')?.value || '';
    const embed = { color: parseInt(color.replace('#',''),16) };
    if (title) embed.title = title;
    if (description) embed.description = description;
    if (image) embed.image = { url: image };
    return embed;
  }).filter(e => e.title || e.description || e.image);
}

let currentEditMessageId = null;

async function loadBotMessages() {
  const channelId = document.getElementById('bot-channel')?.value;
  if (!channelId) { showToast('Bitte wähle einen Kanal.', 'error'); return; }
  const list = document.getElementById('bot-messages-list');
  list.innerHTML = '<span class="loading-spinner"></span> Lade Nachrichten...';

  try {
    const messages = await apiFetch(`/guild/${state.activeGuildId}/bot/messages?channelId=${channelId}&limit=20`);
    if (!messages || messages.length === 0) {
      list.innerHTML = '<span class="chip-empty">Keine Bot-Nachrichten in diesem Kanal gefunden.</span>';
      return;
    }
    let html = '<div style="display:flex;flex-direction:column;gap:8px;">';
    messages.forEach(msg => {
      const embedPreview = msg.embeds && msg.embeds.length > 0
        ? `<div style="background:var(--bg-base);border-left:4px solid #${msg.embeds[0].color?.toString(16).padStart(6,'0') || 'ffffff'};padding:6px 10px;border-radius:4px;font-size:0.75rem;margin-top:4px;">
            ${msg.embeds[0].title ? `<strong>${escapeHtml(msg.embeds[0].title)}</strong>` : ''}
            ${msg.embeds[0].description ? `<div>${escapeHtml(msg.embeds[0].description)}</div>` : ''}
           </div>`
        : '';
      html += `
        <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:0.7rem;color:var(--text-muted);">ID: ${msg.id}</span>
            <span style="font-size:0.65rem;color:var(--text-dim);">${new Date(msg.timestamp).toLocaleString()}</span>
          </div>
          <div style="font-size:0.85rem;word-break:break-word;">${escapeHtml(msg.content || '')}</div>
          ${embedPreview}
          <div style="margin-top:6px;">
            <button class="btn btn-secondary" style="font-size:0.65rem;padding:4px 10px;" onclick="editBotMessageById('${msg.id}')">✏️ Bearbeiten</button>
          </div>
        </div>
      `;
    });
    html += '</div>';
    list.innerHTML = html;
  } catch (err) {
    list.innerHTML = `<span class="chip-empty" style="color:#ef4444;">Fehler: ${err.message}</span>`;
  }
}

function editBotMessageById(messageId) {
  currentEditMessageId = messageId;
  const list = document.getElementById('bot-messages-list');
  const items = list.querySelectorAll('div[style*="background:var(--bg-surface)"]');
  let target = null;
  items.forEach(el => {
    if (el.textContent.includes(messageId)) {
      target = el;
    }
  });
  if (!target) {
    showToast('Nachricht nicht in der Liste gefunden. Bitte lade neu.', 'error');
    return;
  }
  const contentDiv = target.querySelector('div[style*="font-size:0.85rem"]');
  const content = contentDiv ? contentDiv.textContent : '';
  document.getElementById('bot-content').value = content;

  const embedDiv = target.querySelector('div[style*="border-left:4px solid"]');
  if (embedDiv) {
    const title = embedDiv.querySelector('strong')?.textContent || '';
    const desc = embedDiv.querySelector('div:not(:first-child)')?.textContent || '';
    const color = embedDiv.style.borderLeftColor || '#5865f2';
    document.getElementById('bot-embeds-list').innerHTML = '';
    addBotEmbed({ title, description: desc, color });
  } else {
    document.getElementById('bot-embeds-list').innerHTML = '';
  }

  document.getElementById('bot-buttons-list').innerHTML = '';
  showToast(`Bearbeite Nachricht ${messageId}`, 'success');
  document.querySelector('#mod-bot .panel-card:last-child').scrollIntoView({ behavior: 'smooth' });
}

async function editBotMessage() {
  if (!currentEditMessageId) {
    showToast('Keine Nachricht zum Bearbeiten ausgewählt. Klicke zuerst auf "Bearbeiten" in der Liste.', 'error');
    return;
  }
  const channelId = document.getElementById('bot-channel')?.value;
  if (!channelId) { showToast('Bitte wähle einen Kanal.', 'error'); return; }

  const content = document.getElementById('bot-content')?.value || '';
  const embeds = collectBotEmbeds();
  const buttons = collectBotButtons();

  let components = [];
  if (buttons.length > 0) {
    const row = {
      type: 1,
      components: buttons.map(btn => ({
        type: 2,
        label: btn.label,
        style: btn.style,
        custom_id: `btn_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
      }))
    };
    components.push(row);
  }

  try {
    const response = await apiFetch(`/guild/${state.activeGuildId}/bot/edit`, {
      method: 'POST',
      body: JSON.stringify({
        channelId,
        messageId: currentEditMessageId,
        content,
        embeds,
        components
      })
    });
    if (response?.success) {
      showToast('Nachricht bearbeitet!', 'success');
      currentEditMessageId = null;
      loadBotMessages();
      document.getElementById('bot-content').value = '';
      document.getElementById('bot-embeds-list').innerHTML = '';
      document.getElementById('bot-buttons-list').innerHTML = '';
    } else {
      showToast(response?.error || 'Fehler beim Bearbeiten.', 'error');
    }
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
}

// ============================================================
// 🆕 VOICE SUPPORT
// ============================================================
function applyVoiceSupportConfig(cfg) {
  setChecked('voice_support-enabled', cfg.enabled ?? false);
  setSelectValue('voice_support-waitingroom', cfg.waitingRoomId || '');
  setSelectValue('voice_support-notification', cfg.notificationChannelId || '');
  setSelectValue('voice_support-dutyembed', cfg.dutyEmbedChannelId || '');
  renderRoleChips('voice_support-pingrole', cfg.pingRoleId ? [cfg.pingRoleId] : [], true);
  renderRoleChips('voice_support-dutyon', cfg.dutyOnRoleId ? [cfg.dutyOnRoleId] : [], true);
  renderRoleChips('voice_support-dutyoff', cfg.dutyOffRoleId ? [cfg.dutyOffRoleId] : [], true);
  // Embed-Felder
  setValue('voice_support-embed-title', cfg.embedTitle || '🆕 Support-Anfrage');
  setValue('voice_support-embed-desc', cfg.embedDescription || '{user} wartet im Support-Warteraum auf Hilfe.');
  setColor('voice_support', cfg.embedColor || '#5865f2');
  const imageInput = document.getElementById('voice_support-embed-image-input');
  if (imageInput) {
    imageInput.dataset.value = cfg.embedImage || '';
  }
  const previewImg = document.getElementById('voice_support-embed-image-preview');
  if (previewImg) {
    previewImg.src = cfg.embedImage || '';
    previewImg.style.display = cfg.embedImage ? 'block' : 'none';
  }
  updateVoiceSupportEmbedPreview();
}

function updateVoiceSupportEmbedPreview() {
  const preview = document.getElementById('voice_support-embed-preview');
  if (!preview) return;
  const title = document.getElementById('voice_support-embed-title')?.value || '';
  const desc = document.getElementById('voice_support-embed-desc')?.value || '';
  const color = document.getElementById('voice_support-embed-color')?.value || '#5865f2';
  const imageInput = document.getElementById('voice_support-embed-image-input');
  const image = imageInput?.dataset.value || '';
  const titleEl = preview.querySelector('.embed-preview-title');
  const descEl = preview.querySelector('.embed-preview-desc');
  const imgEl = preview.querySelector('.embed-preview-image');
  if (titleEl) {
    titleEl.textContent = title;
    titleEl.classList.toggle('hidden', !title);
  }
  if (descEl) descEl.textContent = desc;
  preview.style.borderLeftColor = color;
  if (imgEl) {
    if (image) {
      imgEl.src = image;
      imgEl.classList.remove('hidden');
    } else {
      imgEl.classList.add('hidden');
      imgEl.src = '';
    }
  }
}

async function sendDutyEmbed() {
  if (!state.activeGuildId) { showToast('Kein Server ausgewählt.', 'error'); return; }
  try {
    const response = await apiFetch(`/guild/${state.activeGuildId}/send-duty-embed`, { method: 'POST' });
    if (response?.success) {
      showToast('Duty-Embed gesendet!', 'success');
    } else {
      showToast(response?.error || 'Fehler beim Senden.', 'error');
    }
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
}

function renderVoiceSupportSelects() {
  const waitingRoomSelect = document.getElementById('voice_support-waitingroom');
  const notificationSelect = document.getElementById('voice_support-notification');
  const dutyEmbedSelect = document.getElementById('voice_support-dutyembed');
  const voiceChannels = state.guildChannels.filter(c => c.type === 2);
  const textChannels = state.guildChannels.filter(c => c.type === 0);
  if (waitingRoomSelect) {
    waitingRoomSelect.innerHTML = voiceChannels.length
      ? voiceChannels.map(c => `<option value="${c.id}">🔊 ${escapeHtml(c.name)}</option>`).join('')
      : '<option value="">Keine Sprachkanäle</option>';
  }
  if (notificationSelect) {
    notificationSelect.innerHTML = textChannels.length
      ? textChannels.map(c => `<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('')
      : '<option value="">Keine Textkanäle</option>';
  }
  if (dutyEmbedSelect) {
    dutyEmbedSelect.innerHTML = textChannels.length
      ? textChannels.map(c => `<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('')
      : '<option value="">Keine Textkanäle</option>';
  }
}

async function handleVoiceSupportImageUpload(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('Bitte wähle ein Bild aus.', 'error');
    input.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('Bild ist zu groß (max. 5MB).', 'error');
    input.value = '';
    return;
  }
  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const compressed = await compressImage(e.target.result, 300);
        const previewImg = document.getElementById('voice_support-embed-image-preview');
        if (previewImg) {
          previewImg.src = compressed;
          previewImg.style.display = 'block';
        }
        const inputField = document.getElementById('voice_support-embed-image-input');
        if (inputField) inputField.dataset.value = compressed;
        updateVoiceSupportEmbedPreview();
        showToast('Bild hochgeladen ✅', 'success');
      } catch (err) {
        showToast('Fehler beim Komprimieren: ' + err.message, 'error');
      }
    };
    reader.onerror = () => showToast('Fehler beim Lesen der Datei', 'error');
    reader.readAsDataURL(file);
  } catch (err) {
    showToast('Fehler: ' + err.message, 'error');
  }
}

function clearVoiceSupportImage() {
  const input = document.getElementById('voice_support-embed-image-input');
  if (input) { input.value = ''; input.dataset.value = ''; }
  const previewImg = document.getElementById('voice_support-embed-image-preview');
  if (previewImg) { previewImg.src = ''; previewImg.style.display = 'none'; }
  updateVoiceSupportEmbedPreview();
}

// ============================================================
// START
// ============================================================
loadDashboard();
