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
  ticketConfigCache: null,
  ticketConfigCacheGuildId: null
};

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
async function apiFetch(endpoint, options = {}) {
  const res = await fetch(`${CONFIG.API_BASE}${endpoint}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
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
// GUILD LIST – DAS LÄDT DIE SERVER
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
  // Sidebar user
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
  if (state.guildRoles.length === 0 || state.guildChannels.length === 0) {
    await loadRolesAndChannels(guildId);
  } else {
    renderAllSelects();
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
}

function renderAllSelects() {
  const selectIds = ['join-channel', 'leave-channel', 'teamliste-channel', 'support-channel', 'moderation-log-channel', 'teamupdate-channel', 'verification-channel'];
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
// COLOR SYNC (Welcome) – mit automatischer Vorschau-Aktualisierung
// ============================================================
function syncColor(prefix) {
  const color = document.getElementById(`${prefix}-color`).value;
  const hexInput = document.getElementById(`${prefix}-color-hex`);
  const preview = document.getElementById(`${prefix}-preview`);
  if (hexInput) hexInput.value = color;
  if (preview) preview.style.borderLeftColor = color;
  // Vorschau aktualisieren
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
// IMAGE UPLOAD (Welcome)
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

// ============================================================
// EMBED VORSCHAU (Welcome) – inklusive Farbaktualisierung
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

  if (previewTitle && titleEl) previewTitle.textContent = titleEl.value || titleEl.placeholder;
  if (previewDesc && descEl) previewDesc.textContent = descEl.value || descEl.placeholder;
  if (previewImage) {
    const val = imageInput?.dataset.value;
    if (val) { previewImage.src = val; previewImage.classList.remove('hidden'); }
    else { previewImage.classList.add('hidden'); }
  }
  // Farbe anwenden
  if (preview && colorInput) {
    preview.style.borderLeftColor = colorInput.value;
  }
}, 200);

// ============================================================
// LOAD SETTINGS (andere Module)
// ============================================================
async function loadAllModuleSettings(guildId) {
  try {
    const config = await apiFetch(`/guild/${guildId}/config`).catch(() => ({}));
    applyWelcomeConfig(config.welcome || {});
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
  // Vorschau aktualisieren
  updateEmbedPreview('join');
  updateEmbedPreview('leave');
}

function applyTeamlisteConfig(cfg) {
  setSelectValue('teamliste-channel', cfg.channelId || '');
  renderRoleChips('teamliste-roles', cfg.roles || []);
}

function applyVerificationConfig(cfg) {
  setChecked('verification-enabled', cfg.enabled ?? false);
  setSelectValue('verification-method', cfg.method || 'button');
  setSelectValue('verification-channel', cfg.channelId || '');
  renderRoleChips('verification-roles', cfg.roleId ? [cfg.roleId] : [], true);
  setValue('verification-title', cfg.title || '');
  setValue('verification-description', cfg.description || '');
  setColor('verification', cfg.color || '#6d5ef8');
  setValue('verification-image', cfg.image || '');
  setValue('verification-button-label', cfg.buttonLabel || '');
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
function setImage(prefix, url) {
  const preview = document.getElementById(`${prefix}-image-preview`);
  const input = document.getElementById(`${prefix}-image-input`);
  if (preview) preview.src = url || '';
  if (input) input.dataset.value = url || '';
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
          categoryId: document.getElementById('edit-ticket-category')?.value || '',
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
      case 'verification':
        payload = {
          enabled: document.getElementById('verification-enabled').checked,
          method: document.getElementById('verification-method').value,
          channelId: document.getElementById('verification-channel').value,
          roleId: getSelectedRoleIds('verification-roles')[0] || null,
          title: document.getElementById('verification-title').value,
          description: document.getElementById('verification-description').value,
          color: document.getElementById('verification-color').value,
          image: document.getElementById('verification-image').value,
          buttonLabel: document.getElementById('verification-button-label').value
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
// TICKET SYSTEM – GALAXYBOT-STYLE
// ============================================================

const ticketGrid = document.getElementById('ticket-overview-grid');
const editContainer = document.getElementById('ticket-edit-container');
const editContent = document.getElementById('ticket-edit-content');
let editingIndex = null;
let buttonCounter = 0;
let optionCounter = 0;

// ---- Tab-Navigation ----
function switchEditTab(tabName) {
  document.querySelectorAll('.edit-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.edit-tab-content').forEach(el => el.classList.add('hidden'));
  const activeBtn = document.querySelector(`.edit-tab-btn[data-edit-tab="${tabName}"]`);
  const activeContent = document.getElementById(`edit-tab-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');
  if (activeContent) activeContent.classList.remove('hidden');
  updateEditPreview();
}

// ---- Hilfsfunktionen ----
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

// ---- Buttons ----
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

// ---- Optionen (mit Support-Rollen) ----
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

// ---- Farb-Swatches (Embed-Tab) ----
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

// ---- Live-Vorschau (Edit) ----
function updateEditPreview() {
  const preview = document.getElementById('edit-embed-preview');
  if (!preview) return;

  const title = document.getElementById('edit-panel-title')?.value || 'Support Center';
  const desc = document.getElementById('edit-panel-desc')?.value || 'Wähle eine Kategorie aus.';
  const color = document.getElementById('edit-panel-color')?.value || '#ffffff';
  const imageInput = document.getElementById('edit-image-input');
  const image = imageInput?.dataset.value || '';

  const titleEl = preview.querySelector('.embed-preview-title');
  const descEl = preview.querySelector('.embed-preview-desc');
  const imgEl = preview.querySelector('.embed-preview-image');

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

// ---- Panel in Discord senden ----
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

// ---- Übersicht rendern (GalaxyBot-Style) ----
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

    // Toolbar
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

    let html = toolbarHtml;
    html += `<div class="ticket-grid">`;

    panels.forEach((panel, index) => {
      const emoji = panel.emoji || '🎫';
      const label = panel.panelName || panel.label || 'Unbenannt';
      const categoryName = state.guildChannels.find(c => c.id === panel.categoryId)?.name || 'Keine Kategorie';
      const isActive = panel.enabled !== false;
      const optionCount = (panel.options || []).length;

      html += `
        <div class="ticket-card" style="border-left-color: ${isActive ? '#22c55e' : '#ef4444'};">
          <div class="header">
            <div class="title"><span class="emoji">${escapeHtml(emoji)}</span> ${escapeHtml(label)}</div>
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

// ---- Ticket löschen ----
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

// ---- Neues Ticket / Bearbeiten ----
window.openAddTicket = function() { editingIndex = null; showEditView(null); };
window.openEditView = function(index) { editingIndex = index; showEditView(index); };

// ---- Bearbeitungsansicht ----
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

      <!-- Header: Zurück / Panel-Auswahl / Kanal + Senden -->
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

      <!-- Tabs -->
      <div class="edit-tabs">
        <button class="edit-tab-btn active" data-edit-tab="general" onclick="switchEditTab('general')">Allgemein</button>
        <button class="edit-tab-btn" data-edit-tab="embed" onclick="switchEditTab('embed')">Embed</button>
        <button class="edit-tab-btn" data-edit-tab="messages" onclick="switchEditTab('messages')">Nachrichten</button>
        <button class="edit-tab-btn" data-edit-tab="roles" onclick="switchEditTab('roles')">Berechtigungen</button>
        <button class="edit-tab-btn" data-edit-tab="advanced" onclick="switchEditTab('advanced')">Fortgeschritten</button>
        <button class="edit-tab-btn" data-edit-tab="options" onclick="switchEditTab('options')">Optionen</button>
      </div>

      <!-- TAB: Allgemein -->
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
            <label for="edit-ticket-category">Kategorie für Tickets</label>
            <select id="edit-ticket-category"></select>
            <small>Tickets werden in dieser Kategorie erstellt.</small>
          </div>
        </div>

      </div>

      <!-- TAB: Embed -->
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
              <div class="embed-preview-title">${escapeHtml(data.title || 'Support Center')}</div>
              <div class="embed-preview-desc">${escapeHtml(data.description || 'Wähle eine Kategorie aus.')}</div>
              <img class="embed-preview-image ${data.image ? '' : 'hidden'}" src="${data.image || ''}">
              <div class="embed-preview-footer">
                <img src="apex_logo.png">
                <span>Ticket System • Powered by Apex</span>
              </div>
            </div>
          </div>
          <div class="form-group">
            <label for="edit-panel-title">Titel</label>
            <input type="text" id="edit-panel-title" value="${escapeHtml(data.title || 'Support Center')}" placeholder="Support Center" oninput="updateEditPreview()">
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

      <!-- TAB: Nachrichten -->
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

      <!-- TAB: Berechtigungen -->
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

      <!-- TAB: Fortgeschritten -->
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

      <!-- TAB: Optionen -->
      <div id="edit-tab-options" class="edit-tab-content hidden">

        <div class="tpe-card">
          <div class="tpe-card-title">📋 Dropdown-Optionen</div>
          <div class="tpe-card-sub" style="margin-bottom:14px;">Jede Option kann eigene Support-Rollen und eine eigene Kategorie haben.</div>
          <div id="edit-options-list"></div>
          <button type="button" class="add-option-btn" onclick="window.addOptionRow()">+ Option hinzufügen</button>
        </div>

      </div>

      <!-- Speichern -->
      <div class="tpe-footer">
        <button class="btn btn-primary" onclick="saveEditView()">💾 Speichern</button>
        <button class="btn btn-secondary" onclick="closeEditView()">Abbrechen</button>
        <span id="edit-save-status" class="hidden status-success"></span>
      </div>
    </div>
  `;

  editContent.innerHTML = html;

  // ---- Befüllen ----
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

  if (data.categoryId) document.getElementById('edit-ticket-category').value = data.categoryId;

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

// ---- Bearbeitungsansicht schließen ----
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
  const image = document.getElementById('verification-image').value;
  const buttonLabel = document.getElementById('verification-button-label').value;

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
// START
// ============================================================
loadDashboard();
