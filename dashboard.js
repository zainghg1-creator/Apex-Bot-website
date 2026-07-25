'use strict';

console.log('✅ NEUE dashboard.js – Ticket-System 10x cooler!');

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
  ticketOptionCount: 0,
  ticketConfigCache: null,
  ticketConfigCacheGuildId: null
};

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function escapeHtml(str) {
  if (!str) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
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
async function apiFetch(endpoint, options = {}) {
  const res = await fetch(`${CONFIG.API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    if (res.status === 401) { window.location.href = '/'; return null; }
    const error = await res.json().catch(() => ({ error: 'unknown_error' }));
    throw new Error(error.error || `HTTP ${res.status}`);
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
    if (!data) return;
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
  if (state.guildRoles.length === 0 || state.guildChannels.length === 0) {
    await loadRolesAndChannels(guildId);
  } else {
    renderAllSelects();
    renderCategorySelects();
  }
  await getCachedTicketConfig(true);
  await loadGuildDetails(guildId);
  await loadAllModuleSettings(guildId);
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
  } catch {
    state.guildRoles = [];
    state.guildChannels = [];
  }
  DOM.overviewRoles.textContent = state.guildRoles.length;
  DOM.overviewChannels.textContent = state.guildChannels.length;
  renderAllSelects();
  renderCategorySelects();
}
function renderAllSelects() {
  const selectIds = ['join-channel', 'leave-channel', 'teamliste-channel', 'support-channel', 'moderation-log-channel', 'teamupdate-channel'];
  selectIds.forEach(id => renderChannelSelect(id, 0));
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
function renderCategorySelects() {
  const ids = ['ticket-location-category', 'ticket-overflow-categories'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const categories = state.guildChannels.filter(c => c.type === 4);
    if (categories.length === 0) {
      el.innerHTML = `<option value="">Keine Kategorien gefunden</option>`;
      return;
    }
    el.innerHTML = categories.map(c => `<option value="${c.id}">📁 ${escapeHtml(c.name)}</option>`).join('');
  });
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
    return `<div class="role-chip ${isSelected ? 'selected' : ''}" data-role-id="${r.id}" role="option" aria-selected="${isSelected}" onclick="toggleRoleChip('${containerId}', '${r.id}', ${singleSelect})">
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
// TABS & SUBTABS
// ============================================================
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.module-page').forEach(page => page.classList.add('hidden'));
  const activeBtn = document.querySelector(`[data-tab="${tabName}"]`);
  const activePage = document.getElementById(`mod-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');
  if (activePage) activePage.classList.remove('hidden');
  if (tabName === 'tickets' && state.activeGuildId) {
    setTimeout(() => renderTicketOverview(), 50);
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
// COLOR SYNC (für Welcome-Modul)
// ============================================================
function syncColor(prefix) {
  const color = document.getElementById(`${prefix}-color`).value;
  const hexInput = document.getElementById(`${prefix}-color-hex`);
  const preview = document.getElementById(`${prefix}-preview`);
  if (hexInput) hexInput.value = color;
  if (preview) preview.style.borderLeftColor = color;
}
function syncColorHex(prefix) {
  let hex = document.getElementById(`${prefix}-color-hex`).value.trim();
  if (!hex.startsWith('#')) hex = `#${hex}`;
  if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    document.getElementById(`${prefix}-color`).value = hex;
    const preview = document.getElementById(`${prefix}-preview`);
    if (preview) preview.style.borderLeftColor = hex;
  }
}

// ============================================================
// IMAGE UPLOAD (für Welcome und Ticket)
// ============================================================
function handleImageUpload(input, prefix) {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showToast('Bild ist zu groß (max. 5MB)', 'error');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const previewImg = document.getElementById(`${prefix}-image-preview`);
    if (previewImg) previewImg.src = dataUrl;
    input.dataset.value = dataUrl;
    updateEmbedPreview(prefix);
  };
  reader.onerror = () => showToast('Fehler beim Lesen der Datei', 'error');
  reader.readAsDataURL(file);
}
function clearImage(prefix) {
  const input = document.getElementById(`${prefix}-image-input`);
  if (input) { input.value = ''; input.dataset.value = ''; }
  const previewImg = document.getElementById(`${prefix}-image-preview`);
  if (previewImg) previewImg.src = '';
  updateEmbedPreview(prefix);
}
const updateEmbedPreview = debounce((prefix) => {
  const titleEl = document.getElementById(`${prefix}-title`) || document.getElementById(`${prefix}-panel-title`);
  const descEl = document.getElementById(`${prefix}-text`) || document.getElementById(`${prefix}-panel-desc`);
  const previewTitle = document.getElementById(`${prefix}-preview-title`);
  const previewDesc = document.getElementById(`${prefix}-preview-desc`);
  const previewImage = document.getElementById(`${prefix}-preview-image`);
  const previewThumb = document.getElementById(`${prefix}-preview-thumb`);
  const imageInput = document.getElementById(`${prefix}-image-input`);
  const avatarThumbToggle = document.getElementById(`${prefix}-avatar-thumb`);
  if (previewTitle && titleEl) previewTitle.textContent = titleEl.value || titleEl.placeholder;
  if (previewDesc && descEl) previewDesc.textContent = descEl.value || descEl.placeholder;
  if (previewImage) {
    const val = imageInput?.dataset.value;
    if (val) { previewImage.src = val; previewImage.classList.remove('hidden'); }
    else { previewImage.classList.add('hidden'); }
  }
  if (previewThumb) previewThumb.style.display = avatarThumbToggle && !avatarThumbToggle.checked ? 'none' : '';
}, 200);

// ============================================================
// LOAD SETTINGS (für andere Module)
// ============================================================
async function loadAllModuleSettings(guildId) {
  try {
    const config = await apiFetch(`/guild/${guildId}/config`).catch(() => ({}));
    applyWelcomeConfig(config.welcome || {});
    // Tickets werden separat geladen
    applyTeamlisteConfig(config.teamliste || {});
    applySimpleConfig('support', config.support || {});
    applySimpleConfig('moderation', config.moderation || {});
    applySimpleConfig('teamupdate', config.teamupdate || {});
    applySimpleConfig('stats', config.stats || {});
    applyVerificationConfig(config.verification || {});
    applySimpleConfig('antinuke', config.antinuke || {});
  } catch (err) { console.error('Fehler beim Laden der Konfiguration:', err); }
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
function applyVerificationConfig(cfg) {
  setChecked('verification-enabled', cfg.enabled ?? false);
  renderRoleChips('verification-roles', cfg.roleId ? [cfg.roleId] : [], true);
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
  if (colorEl) colorEl.value = color || '#ffffff';
  if (hexEl) hexEl.value = color || '#ffffff';
  const preview = document.getElementById(`${prefix}-preview`);
  if (preview) preview.style.borderLeftColor = color || '#ffffff';
}
function setImage(prefix, url) {
  const preview = document.getElementById(`${prefix}-image-preview`);
  const input = document.getElementById(`${prefix}-image-input`);
  if (preview) preview.src = url || '';
  if (input) input.dataset.value = url || '';
}

// ============================================================
// SAVE SETTINGS (für andere Module)
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
      case 'teamliste':
        payload = {
          channelId: document.getElementById('teamliste-channel').value,
          roles: getSelectedRoleIds('teamliste-roles')
        };
        break;
      case 'verification':
        const roles = getSelectedRoleIds('verification-roles');
        payload = { enabled: document.getElementById('verification-enabled').checked, roleId: roles[0] || null };
        break;
      default:
        const enabledEl = document.getElementById(`${moduleName}-enabled`);
        const channelEl = document.getElementById(`${moduleName}-channel`) || document.getElementById(`${moduleName}-log-channel`);
        payload = { enabled: enabledEl ? enabledEl.checked : true, channelId: channelEl ? channelEl.value : undefined };
    }
    await apiFetch(`/guild/${state.activeGuildId}/config/${moduleName}`, { method: 'POST', body: JSON.stringify(payload) });
    showToast(`${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)} erfolgreich gespeichert!`, 'success');
    if (saveStatus) { saveStatus.textContent = '✓ Gespeichert'; saveStatus.classList.remove('hidden'); setTimeout(() => saveStatus.classList.add('hidden'), 3000); }
  } catch (err) {
    showToast(`Fehler beim Speichern: ${err.message}`, 'error');
    if (saveStatus) { saveStatus.textContent = '✕ Fehler'; saveStatus.classList.remove('hidden'); setTimeout(() => saveStatus.classList.add('hidden'), 3000); }
  }
}

// ============================================================
// KEYBOARD SUPPORT
// ============================================================
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !DOM.manageOverlay.classList.contains('hidden')) closeManagement();
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const activeTab = document.querySelector('.tab-btn.active');
    if (activeTab) { const moduleName = activeTab.dataset.tab; if (moduleName) saveModuleSettings(moduleName); }
  }
});

// ============================================================
// NEUES TICKET SYSTEM – 10x COOLER
// ============================================================

const ticketGrid = document.getElementById('ticket-overview-grid');
const editContainer = document.getElementById('ticket-edit-container');
const editContent = document.getElementById('ticket-edit-content');
let editingIndex = null;
let isEditViewOpen = false;
let buttonCounter = 0;
let optionCounter = 0;

// ------ Tab-Navigation für die Bearbeitungsansicht ------
function switchEditTab(tabName) {
  document.querySelectorAll('.edit-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.edit-tab-content').forEach(el => el.classList.add('hidden'));
  const activeBtn = document.querySelector(`.edit-tab-btn[data-edit-tab="${tabName}"]`);
  const activeContent = document.getElementById(`edit-tab-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');
  if (activeContent) activeContent.classList.remove('hidden');
  updateEditPreview();
}

// ------ Hilfsfunktionen für die Bearbeitungsansicht ------
function populateCategorySelects() {
  const ids = ['edit-ticket-category', 'edit-ticket-overflow', 'edit-option-category'];
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

// ------ Buttons (für Panel) ------
window.addButtonRow = function(data = null) {
  const container = document.getElementById('edit-button-list');
  if (!container) return;
  const rowId = `btn-${++buttonCounter}`;
  const row = document.createElement('div');
  row.className = 'button-row';
  row.id = rowId;
  row.innerHTML = `
    <input type="text" placeholder="Label" class="btn-label" value="${data ? escapeHtml(data.label || '') : ''}" style="min-width:120px;">
    <input type="text" placeholder="Emoji" class="btn-emoji" value="${data ? escapeHtml(data.emoji || '') : '🎫'}" style="max-width:80px;">
    <input type="color" class="btn-color" value="${data ? (data.color || '#ffffff') : '#ffffff'}" style="width:44px;height:38px;padding:0;border:1px solid var(--border-subtle);border-radius:8px;background:var(--bg-base);cursor:pointer;">
    <input type="text" placeholder="Aktion (z.B. open)" class="btn-action" value="${data ? escapeHtml(data.action || '') : ''}" style="min-width:100px;">
    <button type="button" class="button-remove" onclick="document.getElementById('${rowId}').remove()" aria-label="Button entfernen">✕</button>
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

// ------ Optionen (Kategorien) für das Panel ------
window.addOptionRow = function(data = null) {
  const container = document.getElementById('edit-options-list');
  if (!container) return;
  const rowId = `opt-${++optionCounter}`;
  const row = document.createElement('div');
  row.className = 'option-row';
  row.id = rowId;
  row.innerHTML = `
    <input type="text" placeholder="Label, z.B. Support" class="opt-label" value="${data ? escapeHtml(data.label || '') : ''}" style="flex:2;">
    <input type="text" placeholder="Emoji" class="opt-emoji" value="${data ? escapeHtml(data.emoji || '') : '🎫'}" style="max-width:80px;">
    <select class="opt-category" style="flex:2;"></select>
    <button type="button" class="option-remove" onclick="document.getElementById('${rowId}').remove()" aria-label="Option entfernen">✕</button>
  `;
  container.appendChild(row);
  const select = row.querySelector('.opt-category');
  const categories = state.guildChannels.filter(c => c.type === 4);
  select.innerHTML = categories.length
    ? categories.map(c => `<option value="${c.id}">📁 ${escapeHtml(c.name)}</option>`).join('')
    : `<option value="">Keine Kategorien gefunden</option>`;
  if (data && data.categoryId) select.value = data.categoryId;
};
function collectOptions() {
  const rows = document.querySelectorAll('#edit-options-list .option-row');
  return Array.from(rows).map(row => ({
    label: row.querySelector('.opt-label')?.value || '',
    emoji: row.querySelector('.opt-emoji')?.value || '🎫',
    categoryId: row.querySelector('.opt-category')?.value || ''
  }));
}

// ------ LIVE-VORSCHAU (für die Bearbeitungsansicht) ------
function updateEditPreview() {
  const preview = document.getElementById('edit-embed-preview');
  if (!preview) return;

  const title = document.getElementById('edit-panel-title')?.value || 'Support Center';
  const desc = document.getElementById('edit-panel-desc')?.value || 'Wähle eine Kategorie, um ein Ticket zu öffnen.';
  const color = document.getElementById('edit-panel-color')?.value || '#ffffff';
  const imageInput = document.getElementById('edit-image-input');
  const image = imageInput?.dataset.value || '';

  const titleEl = preview.querySelector('.discord-embed-title');
  const descEl = preview.querySelector('.discord-embed-desc');
  const imgEl = preview.querySelector('.discord-embed-image');

  if (titleEl) titleEl.textContent = title;
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

// ------ Übersicht der Tickets (Karten) – angepasst an neue CSS-Klassen ------
async function renderTicketOverview() {
  if (!ticketGrid) return;
  if (!state.activeGuildId) {
    ticketGrid.innerHTML = `<div class="state-box" style="grid-column:1/-1;">Bitte wähle zuerst einen Server aus.</div>`;
    return;
  }
  ticketGrid.innerHTML = `<div class="state-box" style="grid-column:1/-1;"><span class="loading-spinner"></span> Lade Ticket-Panels...</div>`;

  // Zähler aktualisieren
  const countEl = document.getElementById('ticket-panel-count');
  if (countEl) countEl.textContent = 'Lade...';

  try {
    const tickets = await getCachedTicketConfig();
    if (!tickets) {
      ticketGrid.innerHTML = `<div class="state-box error" style="grid-column:1/-1;">Fehler beim Laden der Konfiguration.</div>`;
      return;
    }
    const options = tickets.options || [];

    // Zähler aktualisieren
    if (countEl) countEl.textContent = `${options.length} Panel${options.length !== 1 ? 's' : ''}`;

    if (options.length === 0) {
      ticketGrid.innerHTML = `
        <div class="guild-card ticket-add-card" onclick="openAddTicket()">
          <div class="ticket-add-icon"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
          <div style="font-weight:700; font-size:1rem;">Neues Ticket-Panel</div>
          <div style="color:var(--text-muted); font-size:0.8rem;">Klicke hier, um ein neues Panel zu erstellen.</div>
        </div>
      `;
      return;
    }

    let html = '';
    options.forEach((opt, index) => {
      const emoji = opt.emoji || '🎫';
      const label = opt.label || opt.panelName || 'Unbenannt';
      const categoryName = state.guildChannels.find(c => c.id === opt.categoryId)?.name || 'Keine Kategorie';
      const isActive = opt.enabled !== false;
      const statusClass = isActive ? 'active' : '';
      const statusText = isActive ? 'Aktiv' : 'Inaktiv';

      html += `
        <div class="guild-card ticket-card" style="border-left: 4px solid ${isActive ? '#22c55e' : '#ef4444'};">
          <div class="ticket-card-header">
            <div class="ticket-icon-badge"><svg viewBox="0 0 24 24"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><line x1="12" y1="9" x2="12" y2="15"/></svg></div>
            <div class="ticket-card-titles">
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <span style="font-weight:700; font-size:0.95rem;">${escapeHtml(emoji)} ${escapeHtml(label)}</span>
                <span class="ticket-status-pill ${statusClass}"><span class="status-dot"></span> ${statusText}</span>
              </div>
            </div>
          </div>
          <div class="ticket-card-meta">
            <div class="ticket-card-meta-row">
              <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
              ${escapeHtml(categoryName)}
            </div>
            <div class="ticket-card-meta-row">
              <svg viewBox="0 0 24 24"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><line x1="12" y1="9" x2="12" y2="15"/></svg>
              ${opt.options && opt.options.length ? opt.options.length + ' Optionen' : 'Keine Optionen'}
            </div>
          </div>
          <div class="ticket-card-footer">
            <div class="ticket-quick-toggle">
              <label class="switch" style="width:32px; height:18px;">
                <input type="checkbox" ${isActive ? 'checked' : ''} onchange="toggleTicketStatus(${index}, this.checked)">
                <span class="switch-slider"></span>
              </label>
              <span style="font-size:0.7rem;">${isActive ? 'Aktiv' : 'Inaktiv'}</span>
            </div>
            <div style="display:flex; gap:6px;">
              <button class="btn btn-secondary" onclick="openEditView(${index})" style="padding:6px 12px; font-size:0.7rem; min-height:30px;">✏️ Bearbeiten</button>
              <button class="btn btn-danger" onclick="deleteTicketOption(${index})" style="padding:6px 12px; font-size:0.7rem; min-height:30px;">🗑️</button>
            </div>
          </div>
        </div>
      `;
    });

    // Add-Karte
    html += `
      <div class="guild-card ticket-add-card" onclick="openAddTicket()">
        <div class="ticket-add-icon"><svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
        <div style="font-weight:700; font-size:1rem;">Neues Ticket-Panel</div>
        <div style="color:var(--text-muted); font-size:0.8rem;">Klicke hier, um ein neues Panel zu erstellen.</div>
      </div>
    `;

    ticketGrid.innerHTML = html;
  } catch (err) {
    ticketGrid.innerHTML = `<div class="state-box error" style="grid-column:1/-1;">Fehler beim Laden: ${err.message}</div>`;
  }
}

// ------ Toggle Status (aktiv/inaktiv) ------
window.toggleTicketStatus = async function(index, checked) {
  try {
    const config = await apiFetch(`/guild/${state.activeGuildId}/config`);
    if (!config.tickets || !config.tickets.options || !config.tickets.options[index]) return;
    config.tickets.options[index].enabled = checked;
    await apiFetch(`/guild/${state.activeGuildId}/config/tickets`, {
      method: 'POST',
      body: JSON.stringify(config.tickets)
    });
    invalidateTicketCache();
    showToast(`Panel ${checked ? 'aktiviert' : 'deaktiviert'}!`, 'success');
    renderTicketOverview();
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
};

// ------ Neues Ticket / Bearbeiten ------
window.openAddTicket = function() { editingIndex = null; showEditView(null); };
window.openEditView = function(index) { editingIndex = index; showEditView(index); };

// ------ Bearbeitungsansicht mit ALLEN Einstellungen (inkl. Kanalauswahl) ------
async function showEditView(index) {
  document.getElementById('ticket-overview-container').classList.add('hidden');
  editContainer.classList.remove('hidden');
  isEditViewOpen = true;
  editContent.innerHTML = `<div style="text-align:center;padding:3rem;"><span class="loading-spinner"></span> Lade Ticket-Einstellungen...</div>`;

  const tickets = await getCachedTicketConfig();
  if (!tickets) {
    editContent.innerHTML = `<div class="state-box error">Fehler beim Laden der Konfiguration.</div>`;
    return;
  }
  const options = tickets.options || [];
  let data = null;
  if (index !== null && options[index]) {
    data = options[index];
  } else {
    data = {
      enabled: true,
      panelName: 'Neues Ticket',
      panelChannelId: '',
      supportRoles: [],
      categoryId: '',
      title: 'Support Center',
      description: 'Wähle eine Kategorie, um ein Ticket zu öffnen.',
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

  // --- HTML mit allen neuen CSS-Klassen ---
  let html = `
    <div class="card form-card" style="max-width:100%; padding:1.5rem;">

      <!-- Toolbar: Panel wechseln -->
      <div class="edit-toolbar">
        <label><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="21" x2="9" y2="9"/></svg> Panel:</label>
        <select id="edit-panel-select">
          ${options.map((opt, i) => `<option value="${i}" ${i === index ? 'selected' : ''}>${escapeHtml(opt.panelName || opt.label || 'Unbenannt')}</option>`).join('')}
          ${index === null ? `<option value="new" selected>+ Neues Panel</option>` : ''}
        </select>
        <button class="btn btn-secondary" onclick="switchToSelectedPanel()" style="flex-shrink:0; padding:6px 14px; min-height:34px; font-size:0.75rem;">Wechseln</button>
      </div>

      <!-- Vorschau -->
      <div class="edit-preview-wrap">
        <div class="edit-preview-label"><svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Live-Vorschau</div>
        <div class="discord-embed" id="edit-embed-preview" style="border-left-color:${data.color || '#ffffff'};">
          <div class="discord-embed-body">
            <div class="discord-embed-title">${escapeHtml(data.title || 'Support Center')}</div>
            <div class="discord-embed-desc">${escapeHtml(data.description || 'Wähle eine Kategorie, um ein Ticket zu öffnen.')}</div>
            <img class="discord-embed-image ${data.image ? '' : 'hidden'}" src="${data.image || ''}" style="max-height:120px; width:100%; border-radius:6px; margin-top:6px; object-fit:cover;">
            <div class="discord-embed-footer">
              <img src="apex_logo.png" style="width:14px;height:14px;border-radius:50%;">
              <span>Ticket System • Powered by Apex</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Tabs -->
      <div class="edit-tabs">
        <button class="edit-tab-btn active" data-edit-tab="general" onclick="switchEditTab('general')"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> Allgemein</button>
        <button class="edit-tab-btn" data-edit-tab="embed" onclick="switchEditTab('embed')"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="21" x2="9" y2="9"/></svg> Design</button>
        <button class="edit-tab-btn" data-edit-tab="messages" onclick="switchEditTab('messages')"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Nachrichten</button>
        <button class="edit-tab-btn" data-edit-tab="roles" onclick="switchEditTab('roles')"><svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Berechtigungen</button>
        <button class="edit-tab-btn" data-edit-tab="advanced" onclick="switchEditTab('advanced')"><svg viewBox="0 0 24 24"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4 12H2"/><path d="M22 12h-2"/><path d="M19.07 4.93l-2.83 2.83"/><path d="M7.76 16.24l-2.83 2.83"/><path d="M16.24 7.76l2.83-2.83"/><path d="M4.93 19.07l2.83-2.83"/></svg> Fortgeschritten</button>
        <button class="edit-tab-btn" data-edit-tab="options" onclick="switchEditTab('options')"><svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Optionen</button>
      </div>

      <!-- TAB: Allgemein (inkl. Kanalauswahl) -->
      <div id="edit-tab-general" class="edit-tab-content">
        <div class="form-group">
          <div class="switch-row">
            <label style="margin:0; font-size:0.9rem; font-weight:600;">Panel aktiv</label>
            <label class="switch"><input type="checkbox" id="edit-panel-enabled" ${data.enabled ? 'checked' : ''}><span class="switch-slider"></span></label>
          </div>
          <small style="margin-top:-4px;">Deaktiviert das Panel – es wird nicht im ausgewählten Kanal angezeigt.</small>
        </div>
        <div class="form-group">
          <label for="edit-panel-name">Panel-Name</label>
          <input type="text" id="edit-panel-name" value="${escapeHtml(data.panelName || '')}" placeholder="z.B. Support">
          <small>Wird in der Kanalnamen-Vorlage verwendet.</small>
        </div>
        <!-- Kanalauswahl für das Panel -->
        <div class="form-group">
          <label for="edit-panel-channel">📢 Kanal für das Panel</label>
          <select id="edit-panel-channel" style="width:100%; background:var(--bg-base); border:1px solid var(--border-subtle); border-radius:8px; padding:8px 12px; color:var(--text-primary); min-height:38px;"></select>
          <small>Hier wird das Ticket-Panel (Embed) gesendet.</small>
        </div>
        <div class="form-group">
          <label>Support-Rollen (Zugriff)</label>
          <div id="edit-support-roles" class="chip-select"></div>
          <small>Diese Rollen können Tickets sehen und verwalten.</small>
        </div>
        <div class="form-group">
          <label for="edit-ticket-category">📂 Kategorie für Tickets</label>
          <select id="edit-ticket-category" style="width:100%; background:var(--bg-base); border:1px solid var(--border-subtle); border-radius:8px; padding:8px 12px; color:var(--text-primary); min-height:38px;"></select>
          <small>Tickets werden in dieser Kategorie erstellt.</small>
        </div>
      </div>

      <!-- TAB: Design -->
      <div id="edit-tab-embed" class="edit-tab-content hidden">
        <div class="form-group">
          <label for="edit-panel-title">Panel-Titel</label>
          <input type="text" id="edit-panel-title" value="${escapeHtml(data.title || 'Support Center')}" placeholder="Support Center" oninput="updateEditPreview()">
        </div>
        <div class="form-group">
          <label for="edit-panel-desc">Panel-Beschreibung</label>
          <textarea id="edit-panel-desc" rows="3" placeholder="Wähle eine Kategorie, um ein Ticket zu öffnen." oninput="updateEditPreview()">${escapeHtml(data.description || '')}</textarea>
        </div>
        <div class="form-group">
          <label>Panel-Bild (optional)</label>
          <div class="image-upload">
            <img id="edit-image-preview" class="image-preview" src="${data.image || ''}" alt="">
            <div class="upload-btn-wrap">
              <label class="btn btn-secondary" for="edit-image-input">📤 Hochladen</label>
              <input type="file" id="edit-image-input" accept="image/*" onchange="handleEditImageUpload(this)">
            </div>
            <button class="btn btn-secondary" onclick="clearEditImage()" type="button">Entfernen</button>
          </div>
        </div>
        <div class="form-group">
          <label>Akzentfarbe</label>
          <div class="color-row">
            <input type="color" id="edit-panel-color" value="${data.color || '#ffffff'}" oninput="document.getElementById('edit-panel-color-hex').value = this.value; updateEditPreview();">
            <input type="text" id="edit-panel-color-hex" value="${data.color || '#ffffff'}" oninput="document.getElementById('edit-panel-color').value = this.value; updateEditPreview();">
          </div>
        </div>
      </div>

      <!-- TAB: Nachrichten -->
      <div id="edit-tab-messages" class="edit-tab-content hidden">
        <div class="form-group">
          <label for="edit-create-msg">Begrüßungsnachricht im Ticket</label>
          <textarea id="edit-create-msg" rows="3" placeholder="Hallo {user}, wir kümmern uns um dein Anliegen.">${escapeHtml(data.creationMessage || '')}</textarea>
          <small>Platzhalter: <code>{user}</code>, <code>{username}</code></small>
        </div>
        <div class="form-group">
          <label for="edit-channel-template">Kanalnamen-Vorlage</label>
          <input type="text" id="edit-channel-template" value="${escapeHtml(data.channelNameTemplate || '{panel.name}-{ticket.creator.username}')}" placeholder="{panel.name}-{ticket.creator.username}">
          <small>Platzhalter: <code>{panel.name}</code>, <code>{ticket.creator.username}</code>, <code>{ticket.id}</code></small>
        </div>
      </div>

      <!-- TAB: Berechtigungen -->
      <div id="edit-tab-roles" class="edit-tab-content hidden">
        <div class="form-group">
          <label>Rollen, die ein Ticket öffnen dürfen (optional)</label>
          <div id="edit-allowed-roles" class="chip-select"></div>
          <small>Leer lassen = jeder darf öffnen.</small>
        </div>
        <div class="form-group">
          <label>Rollen, die kein Ticket öffnen dürfen (optional)</label>
          <div id="edit-denied-roles" class="chip-select"></div>
        </div>
        <div class="form-group">
          <label for="edit-max-tickets">Maximale Tickets pro Benutzer</label>
          <input type="number" id="edit-max-tickets" value="${data.maxTickets || 1}" min="1" step="1">
        </div>
      </div>

      <!-- TAB: Fortgeschritten -->
      <div id="edit-tab-advanced" class="edit-tab-content hidden">
        <div class="form-group">
          <div class="switch-row">
            <label style="margin:0; font-size:0.85rem;">Überlauf-Kategorien aktivieren</label>
            <label class="switch"><input type="checkbox" id="edit-overflow-enabled" ${data.overflowEnabled ? 'checked' : ''}><span class="switch-slider"></span></label>
          </div>
          <small>Wenn aktiv, werden Tickets auf mehrere Kategorien verteilt.</small>
        </div>
        <div class="form-group" id="edit-overflow-group" style="${data.overflowEnabled ? '' : 'display:none;'}">
          <label for="edit-ticket-overflow">Überlauf-Kategorien (mehrfach)</label>
          <select id="edit-ticket-overflow" multiple style="height:auto;min-height:60px; width:100%; background:var(--bg-base); border:1px solid var(--border-subtle); border-radius:8px; padding:8px; color:var(--text-primary);"></select>
          <small>Halte Strg (Cmd) gedrückt, um mehrere auszuwählen.</small>
        </div>
        <div class="form-group">
          <label for="edit-thread-mode">Thread-Modus</label>
          <select id="edit-thread-mode" style="width:100%; background:var(--bg-base); border:1px solid var(--border-subtle); border-radius:8px; padding:8px 12px; color:var(--text-primary); min-height:38px;">
            <option value="none" ${data.threadMode === 'none' ? 'selected' : ''}>Keine Threads</option>
            <option value="thread" ${data.threadMode === 'thread' ? 'selected' : ''}>Öffentliche Threads</option>
            <option value="private" ${data.threadMode === 'private' ? 'selected' : ''}>Private Threads</option>
          </select>
        </div>
        <div class="form-group">
          <label style="font-weight:600; font-size:0.85rem;">Transkript-Einstellungen</label>
          <div class="switch-row">
            <label style="margin:0; font-size:0.85rem;">Transkripte speichern</label>
            <label class="switch"><input type="checkbox" id="edit-save-transcripts" ${data.saveTranscripts ? 'checked' : ''}><span class="switch-slider"></span></label>
          </div>
          <div class="switch-row">
            <label style="margin:0; font-size:0.85rem;">Bilder in Transkripten</label>
            <label class="switch"><input type="checkbox" id="edit-save-images" ${data.saveImages ? 'checked' : ''}><span class="switch-slider"></span></label>
          </div>
          <div class="switch-row">
            <label style="margin:0; font-size:0.85rem;">Private Transkripte</label>
            <label class="switch"><input type="checkbox" id="edit-private-transcripts" ${data.privateTranscripts ? 'checked' : ''}><span class="switch-slider"></span></label>
          </div>
        </div>
        <div class="form-group">
          <div class="switch-row">
            <label style="margin:0; font-size:0.85rem;">Claim-System aktivieren</label>
            <label class="switch"><input type="checkbox" id="edit-claim-enabled" ${data.claimEnabled ? 'checked' : ''}><span class="switch-slider"></span></label>
          </div>
          <small>Ermöglicht Teammitgliedern, Tickets zu übernehmen.</small>
        </div>
        <div class="form-group">
          <label style="font-weight:600; font-size:0.85rem;">Buttons (für das Panel)</label>
          <div id="edit-button-list"></div>
          <button type="button" class="add-button-btn" onclick="window.addButtonRow()">+ Button hinzufügen</button>
        </div>
      </div>

      <!-- TAB: Optionen (verlinkte Kategorien) -->
      <div id="edit-tab-options" class="edit-tab-content hidden">
        <div class="form-group">
          <label style="font-weight:600; font-size:0.85rem;">Dropdown-Optionen (Kategorien)</label>
          <div id="edit-options-list"></div>
          <button type="button" class="add-option-btn" onclick="window.addOptionRow()">+ Option hinzufügen</button>
          <small>Diese Optionen erscheinen im Dropdown-Menü des Panels.</small>
        </div>
      </div>

      <!-- Speichern -->
      <div class="form-action" style="margin-top:1.2rem;padding-top:1.2rem;border-top:1px solid var(--border-subtle);">
        <button class="btn btn-primary" onclick="saveEditView()">💾 Speichern</button>
        <button class="btn btn-secondary" onclick="closeEditView()">Abbrechen</button>
        <span id="edit-save-status" class="hidden status-success"></span>
      </div>
    </div>
  `;

  editContent.innerHTML = html;

  // --- Befüllen der dynamischen Elemente ---

  // Kategorien befüllen
  populateCategorySelects();

  // Rollen-Chips rendern
  renderEditRoleChips('edit-support-roles', data.supportRoles || []);
  renderEditRoleChips('edit-allowed-roles', data.allowedRoles || []);
  renderEditRoleChips('edit-denied-roles', data.deniedRoles || []);

  // Kanal für das Panel befüllen (Textkanäle)
  const panelChannelSelect = document.getElementById('edit-panel-channel');
  if (panelChannelSelect) {
    const textChannels = state.guildChannels.filter(c => c.type === 0);
    panelChannelSelect.innerHTML = textChannels.length
      ? textChannels.map(c => `<option value="${c.id}" ${c.id === data.panelChannelId ? 'selected' : ''}># ${escapeHtml(c.name)}</option>`).join('')
      : `<option value="">Keine Textkanäle gefunden</option>`;
    if (data.panelChannelId && !textChannels.some(c => c.id === data.panelChannelId)) {
      panelChannelSelect.value = '';
    }
  }

  // Ausgewählte Kategorie setzen
  if (data.categoryId) document.getElementById('edit-ticket-category').value = data.categoryId;

  // Overflow-Kategorien setzen
  if (data.overflowCategories) {
    const overflowSelect = document.getElementById('edit-ticket-overflow');
    if (overflowSelect) {
      Array.from(overflowSelect.options).forEach(opt => {
        opt.selected = data.overflowCategories.includes(opt.value);
      });
    }
  }

  // Overflow-Toggle
  document.getElementById('edit-overflow-enabled').addEventListener('change', function() {
    document.getElementById('edit-overflow-group').style.display = this.checked ? '' : 'none';
  });

  // Buttons laden
  if (data.buttons && data.buttons.length) {
    data.buttons.forEach(btn => window.addButtonRow(btn));
  } else {
    window.addButtonRow({ label: 'Ticket öffnen', emoji: '🎫', color: '#ffffff', action: 'open' });
  }

  // Optionen laden
  if (data.options && data.options.length) {
    data.options.forEach(opt => window.addOptionRow(opt));
  } else {
    window.addOptionRow({ label: 'Allgemeiner Support', emoji: '🎫', categoryId: '' });
  }

  // Aktiven Tab setzen
  switchEditTab('general');
  // Vorschau initial aktualisieren
  updateEditPreview();
}

// ------ Hilfsfunktionen für Bild-Upload ------
window.handleEditImageUpload = function(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showToast('Bild ist zu groß (max. 5MB)', 'error');
    input.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const preview = document.getElementById('edit-image-preview');
    if (preview) preview.src = e.target.result;
    input.dataset.value = e.target.result;
    updateEditPreview();
  };
  reader.readAsDataURL(file);
};
window.clearEditImage = function() {
  const input = document.getElementById('edit-image-input');
  if (input) { input.value = ''; input.dataset.value = ''; }
  const preview = document.getElementById('edit-image-preview');
  if (preview) preview.src = '';
  updateEditPreview();
};

// ------ Panel wechseln (Dropdown) ------
window.switchToSelectedPanel = async function() {
  const select = document.getElementById('edit-panel-select');
  if (!select) return;
  const val = select.value;
  if (val === 'new') {
    editingIndex = null;
    showEditView(null);
  } else {
    const index = parseInt(val);
    editingIndex = index;
    showEditView(index);
  }
};

// ------ Bearbeitungsansicht schließen ------
window.closeEditView = function() {
  document.getElementById('ticket-overview-container').classList.remove('hidden');
  editContainer.classList.add('hidden');
  editContent.innerHTML = '';
  editingIndex = null;
  isEditViewOpen = false;
  renderTicketOverview();
};

// ------ Speichern der Bearbeitung (mit Kanal) ------
window.saveEditView = async function() {
  const saveStatus = document.getElementById('edit-save-status');
  if (saveStatus) { saveStatus.classList.add('hidden'); saveStatus.textContent = '⏳ Speichern...'; saveStatus.classList.remove('hidden'); }

  // Daten aus allen Tabs sammeln
  const enabled = document.getElementById('edit-panel-enabled').checked;
  const panelName = document.getElementById('edit-panel-name').value.trim();
  const panelChannelId = document.getElementById('edit-panel-channel')?.value || '';
  const supportRoles = getEditSelectedRoles('edit-support-roles');
  const categoryId = document.getElementById('edit-ticket-category').value;
  const title = document.getElementById('edit-panel-title').value.trim();
  const description = document.getElementById('edit-panel-desc').value.trim();
  const color = document.getElementById('edit-panel-color').value;
  const imageInput = document.getElementById('edit-image-input');
  const image = imageInput?.dataset.value || '';
  const creationMessage = document.getElementById('edit-create-msg').value.trim();
  const channelNameTemplate = document.getElementById('edit-channel-template').value.trim() || '{panel.name}-{ticket.creator.username}';
  const allowedRoles = getEditSelectedRoles('edit-allowed-roles');
  const deniedRoles = getEditSelectedRoles('edit-denied-roles');
  const maxTickets = parseInt(document.getElementById('edit-max-tickets').value) || 1;
  const overflowEnabled = document.getElementById('edit-overflow-enabled').checked;
  const overflowSelect = document.getElementById('edit-ticket-overflow');
  const overflowCategories = overflowSelect ? Array.from(overflowSelect.selectedOptions).map(o => o.value) : [];
  const threadMode = document.getElementById('edit-thread-mode').value;
  const saveTranscripts = document.getElementById('edit-save-transcripts').checked;
  const saveImages = document.getElementById('edit-save-images').checked;
  const privateTranscripts = document.getElementById('edit-private-transcripts').checked;
  const claimEnabled = document.getElementById('edit-claim-enabled').checked;
  const buttons = collectButtons().filter(b => b.label.trim());
  const options = collectOptions().filter(o => o.label.trim());

  if (!panelName) {
    showToast('Bitte gib einen Panel-Namen ein.', 'error');
    if (saveStatus) saveStatus.textContent = '✕ Fehler';
    return;
  }

  try {
    const config = await apiFetch(`/guild/${state.activeGuildId}/config`);
    if (!config.tickets) config.tickets = {};
    if (!config.tickets.options) config.tickets.options = [];

    const newData = {
      enabled,
      panelName,
      panelChannelId,
      supportRoles,
      categoryId,
      title,
      description,
      color,
      image,
      creationMessage,
      channelNameTemplate,
      allowedRoles,
      deniedRoles,
      maxTickets,
      overflowEnabled,
      overflowCategories,
      threadMode,
      saveTranscripts,
      saveImages,
      privateTranscripts,
      claimEnabled,
      buttons,
      options
    };

    if (editingIndex !== null) {
      config.tickets.options[editingIndex] = newData;
    } else {
      config.tickets.options.push(newData);
    }

    await apiFetch(`/guild/${state.activeGuildId}/config/tickets`, {
      method: 'POST',
      body: JSON.stringify(config.tickets)
    });

    invalidateTicketCache();
    showToast(editingIndex !== null ? 'Ticket aktualisiert!' : 'Ticket hinzugefügt!', 'success');
    if (saveStatus) saveStatus.textContent = '✓ Gespeichert';
    closeEditView();
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
    if (saveStatus) saveStatus.textContent = '✕ Fehler';
  }
};

// ------ Ticket löschen ------
window.deleteTicketOption = async function(index) {
  if (!confirm('Möchtest du dieses Ticket wirklich löschen?')) return;
  try {
    const config = await apiFetch(`/guild/${state.activeGuildId}/config`);
    if (!config.tickets || !config.tickets.options || !config.tickets.options[index]) return;
    config.tickets.options.splice(index, 1);
    await apiFetch(`/guild/${state.activeGuildId}/config/tickets`, {
      method: 'POST',
      body: JSON.stringify(config.tickets)
    });
    invalidateTicketCache();
    showToast('Ticket gelöscht.', 'success');
    renderTicketOverview();
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
};

// ------ Event Listener für Ticket-Tab ------
document.addEventListener('DOMContentLoaded', function() {
  const ticketTabBtn = document.querySelector('[data-tab="tickets"]');
  if (ticketTabBtn) {
    ticketTabBtn.addEventListener('click', function() {
      setTimeout(() => { if (state.activeGuildId) renderTicketOverview(); }, 50);
    });
  }
  const overlay = document.getElementById('manage-overlay');
  if (overlay) {
    const observer = new MutationObserver(() => {
      if (!overlay.classList.contains('hidden')) {
        const activeTab = document.querySelector('.tab-btn.active[data-tab="tickets"]');
        if (activeTab && state.activeGuildId) renderTicketOverview();
      }
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }
});

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', loadDashboard);

// Funktionen global verfügbar machen
window.switchEditTab = switchEditTab;
window.renderTicketOverview = renderTicketOverview;
window.addOptionRow = addOptionRow;
window.updateEditPreview = updateEditPreview;
window.switchToSelectedPanel = switchToSelectedPanel;
