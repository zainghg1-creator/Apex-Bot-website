'use strict';

// ============================================================
// KONFIGURATION
// ============================================================
const CONFIG = {
  CLIENT_ID: '1525613011262377994',
  BOT_PERMISSIONS: '8',
  API_BASE: '/api'
};

// ============================================================
// DOM-REFERENCES (cached)
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
  ticketOptionCount: 0
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

// ============================================================
// DISCORD SNOWFLAKE HELPERS
// ============================================================
const DISCORD_EPOCH = 1420070400000n;

function snowflakeToDate(id) {
  try {
    const snowflake = BigInt(id);
    const timestampMs = Number((snowflake >> 22n) + DISCORD_EPOCH);
    const date = new Date(timestampMs);
    return isNaN(date.getTime()) ? null : date;
  } catch (err) {
    return null;
  }
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
    if (res.status === 401) {
      window.location.href = '/';
      return null;
    }
    const error = await res.json().catch(() => ({ error: 'unknown_error' }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }
  
  return res.json();
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
  if (!guilds || guilds.length === 0) {
    showState(DOM.emptyState);
    return;
  }
  
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
  
  // Reset stats
  DOM.overviewMembers.textContent = '...';
  DOM.overviewBoosts.textContent = '...';
  DOM.overviewBots.textContent = '...';
  DOM.overviewChannels.textContent = '...';
  DOM.overviewRoles.textContent = '...';
  DOM.overviewOwnerName.textContent = '...';
  DOM.overviewOwnerAvatar.classList.add('hidden');
  DOM.overviewOwnerAvatar.src = '';
  
  // Erstellungsdatum steckt direkt in der Guild-ID und braucht keinen API-Call
  DOM.overviewCreated.textContent = formatGuildCreatedDate(guildId);
  
  await Promise.all([
    loadGuildDetails(guildId),
    loadRolesAndChannels(guildId),
    loadAllModuleSettings(guildId)
  ]);
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
  } catch (err) {
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
  } catch (err) {
    state.guildRoles = [];
    state.guildChannels = [];
  }
  
  DOM.overviewRoles.textContent = state.guildRoles.length;
  DOM.overviewChannels.textContent = state.guildChannels.length;
  
  renderAllSelects();
  renderCategorySelects();
}

function renderAllSelects() {
  const selectIds = [
    'join-channel', 'leave-channel', 'ticket-panel-channel',
    'teamliste-channel', 'support-channel', 'moderation-log-channel',
    'teamupdate-channel'
  ];
  
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
  
  el.innerHTML = relevant
    .map(c => `<option value="${c.id}"># ${escapeHtml(c.name)}</option>`)
    .join('');
}

function renderCategorySelects() {
  const ids = ['ticket-location-category', 'ticket-overflow-categories', 'ticket-modal-category'];
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
  
  el.innerHTML = state.guildRoles
    .map(r => {
      const isSelected = selectedSet.has(r.id);
      return `<div class="role-chip ${isSelected ? 'selected' : ''}" 
                    data-role-id="${r.id}" 
                    role="option" 
                    aria-selected="${isSelected}"
                    onclick="toggleRoleChip('${containerId}', '${r.id}', ${singleSelect})">
                <span class="chip-icon" aria-hidden="true">@</span>
                <span class="chip-label">${escapeHtml(r.name)}</span>
              </div>`;
    })
    .join('');
}

function toggleRoleChip(containerId, roleId, singleSelect) {
  const el = document.getElementById(containerId);
  const chip = el.querySelector(`[data-role-id="${roleId}"]`);
  if (!chip) return;
  
  if (singleSelect) {
    el.querySelectorAll('.role-chip').forEach(c => {
      c.classList.remove('selected');
      c.setAttribute('aria-selected', 'false');
    });
    chip.classList.add('selected');
    chip.setAttribute('aria-selected', 'true');
  } else {
    chip.classList.toggle('selected');
    chip.setAttribute('aria-selected', chip.classList.contains('selected') ? 'true' : 'false');
  }
}

function getSelectedRoleIds(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return [];
  return Array.from(el.querySelectorAll('.role-chip.selected'))
    .map(c => c.dataset.roleId);
}

// ============================================================
// TABS & SUBTABS
// ============================================================
function switchTab(tabName) {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.module-page').forEach(page => page.classList.add('hidden'));
  
  const activeBtn = document.querySelector(`[data-tab="${tabName}"]`);
  const activePage = document.getElementById(`mod-${tabName}`);
  
  if (activeBtn) activeBtn.classList.add('active');
  if (activePage) activePage.classList.remove('hidden');

  // Wenn Ticket-Tab, lade die Übersicht
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
// COLOR SYNC
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
// IMAGE UPLOAD
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
  if (input) {
    input.value = '';
    input.dataset.value = '';
  }
  const previewImg = document.getElementById(`${prefix}-image-preview`);
  if (previewImg) previewImg.src = '';
  updateEmbedPreview(prefix);
}

// ============================================================
// EMBED PREVIEW (debounced) – wird noch für Willkommen genutzt
// ============================================================
const updateEmbedPreview = debounce((prefix) => {
  const titleEl = document.getElementById(`${prefix}-title`) || document.getElementById(`${prefix}-panel-title`);
  const descEl = document.getElementById(`${prefix}-text`) || document.getElementById(`${prefix}-panel-desc`);
  const previewTitle = document.getElementById(`${prefix}-preview-title`);
  const previewDesc = document.getElementById(`${prefix}-preview-desc`);
  const previewImage = document.getElementById(`${prefix}-preview-image`);
  const previewThumb = document.getElementById(`${prefix}-preview-thumb`);
  const imageInput = document.getElementById(`${prefix}-image-input`);
  const avatarThumbToggle = document.getElementById(`${prefix}-avatar-thumb`);
  
  if (previewTitle && titleEl) {
    previewTitle.textContent = titleEl.value || titleEl.placeholder;
  }
  
  if (previewDesc && descEl) {
    previewDesc.textContent = descEl.value || descEl.placeholder;
  }
  
  if (previewImage) {
    const val = imageInput?.dataset.value;
    if (val) {
      previewImage.src = val;
      previewImage.classList.remove('hidden');
    } else {
      previewImage.classList.add('hidden');
    }
  }
  
  if (previewThumb) {
    previewThumb.style.display = avatarThumbToggle && !avatarThumbToggle.checked ? 'none' : '';
  }
}, 200);

// ============================================================
// TICKET OPTIONS (Dropdown-Liste für das Modal – wird nicht mehr im Tab angezeigt, aber fürs Modal benötigt)
// ============================================================
function addTicketOption(data = null) {
  state.ticketOptionCount++;
  const id = `ticket-opt-${state.ticketOptionCount}`;
  const list = document.getElementById('ticket-options-list');
  if (!list) return;
  
  const row = document.createElement('div');
  row.className = 'option-row';
  row.id = id;
  
  row.innerHTML = `
    <input type="text" placeholder="Label, z.B. Allgemeiner Support" class="opt-label" value="${data ? escapeHtml(data.label || '') : ''}">
    <input type="text" placeholder="Emoji (optional)" class="opt-emoji" style="max-width:90px;" value="${data ? escapeHtml(data.emoji || '') : ''}">
    <select class="opt-category"></select>
    <button type="button" class="option-remove" onclick="document.getElementById('${id}').remove()" aria-label="Kategorie entfernen">✕</button>
  `;
  
  list.appendChild(row);
  
  const select = row.querySelector('.opt-category');
  const cats = state.guildChannels.filter(c => c.type === 4);
  
  select.innerHTML = cats.length
    ? cats.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
    : `<option value="">Keine Kategorien gefunden</option>`;
  
  if (data && data.categoryId) select.value = data.categoryId;
}

function collectTicketOptions() {
  return Array.from(document.querySelectorAll('#ticket-options-list .option-row')).map(row => ({
    label: row.querySelector('.opt-label')?.value || '',
    emoji: row.querySelector('.opt-emoji')?.value || '',
    categoryId: row.querySelector('.opt-category')?.value || ''
  }));
}

// ============================================================
// LOAD SETTINGS
// ============================================================
async function loadAllModuleSettings(guildId) {
  try {
    const config = await apiFetch(`/guild/${guildId}/config`).catch(() => ({}));
    
    applyWelcomeConfig(config.welcome || {});
    applyTicketConfig(config.tickets || {});
    applyTeamlisteConfig(config.teamliste || {});
    applySimpleConfig('support', config.support || {});
    applySimpleConfig('moderation', config.moderation || {});
    applySimpleConfig('teamupdate', config.teamupdate || {});
    applySimpleConfig('stats', config.stats || {});
    applyVerificationConfig(config.verification || {});
    applySimpleConfig('antinuke', config.antinuke || {});
  } catch (err) {
    console.error('Fehler beim Laden der Konfiguration:', err);
  }
}

function applyWelcomeConfig(cfg) {
  const j = cfg.join || {};
  const l = cfg.leave || {};
  
  // Join
  setChecked('join-enabled', j.enabled ?? true);
  setSelectValue('join-mode', j.mode || 'embed');
  setValue('join-title', j.title || '');
  setValue('join-text', j.text || '');
  setColor('join', j.color || '#ffffff');
  setChecked('join-avatar-thumb', j.useAvatarThumbnail ?? true);
  setImage('join', j.image);
  setSelectValue('join-channel', j.channelId || '');
  renderRoleChips('join-roles', j.roles || []);
  
  // Leave
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

// ============================================================
// ERWEITERTE TICKET-CONFIG (wird für die anderen Felder benötigt, auch wenn sie im Tab nicht mehr sichtbar sind)
// ============================================================
function applyTicketConfig(cfg) {
  // Alte Felder – werden weiterhin geladen/gespeichert, falls sie woanders gebraucht werden
  setSelectValue('ticket-panel-channel', cfg.panelChannelId || '');
  setValue('ticket-panel-title', cfg.title || '');
  setValue('ticket-panel-desc', cfg.description || '');
  setColor('ticket', cfg.color || '#ffffff');
  setValue('ticket-create-msg', cfg.creationMessage || '');
  setImage('ticket', cfg.image);

  // Ticket-Optionen (Dropdown-Kategorien) – nur für das Modal
  document.getElementById('ticket-options-list').innerHTML = '';
  state.ticketOptionCount = 0;
  const options = cfg.options?.length ? cfg.options : [{ label: 'Allgemeiner Support', emoji: '🎫', categoryId: '' }];
  options.forEach(opt => addTicketOption(opt));

  // NEUE erweiterte Felder (werden gespeichert, auch wenn nicht im Tab sichtbar)
  setChecked('ticket-panel-enabled', cfg.enabled ?? true);
  setValue('ticket-panel-name', cfg.panelName || '');
  renderRoleChips('ticket-support-roles', cfg.supportRoles || []);
  setSelectValue('ticket-location-category', cfg.locationCategory || '');
  setSelectMultiple('ticket-overflow-categories', cfg.overflowCategories || []);
  setSelectValue('ticket-thread-mode', cfg.threadMode || 'none');
  setChecked('ticket-save-transcripts', cfg.saveTranscripts ?? false);
  setChecked('ticket-save-images', cfg.saveImages ?? false);
  setChecked('ticket-private-transcripts', cfg.privateTranscripts ?? false);
  setValue('ticket-channel-name-template', cfg.channelNameTemplate || '{panel.name}-{ticket.creator.username}');

  updateEmbedPreview('ticket');
}

// ============================================================
// HELPER FÜR MEHRFACHAUSWAHL
// ============================================================
function getSelectedOptions(selectId) {
  const el = document.getElementById(selectId);
  if (!el) return [];
  return Array.from(el.selectedOptions).map(opt => opt.value);
}

function setSelectMultiple(selectId, values) {
  const el = document.getElementById(selectId);
  if (!el) return;
  Array.from(el.options).forEach(opt => {
    opt.selected = values.includes(opt.value);
  });
}

// ============================================================
// WEITERE KONFIG-APPLIER
// ============================================================
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

// Helper
function setValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function setChecked(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}

function setSelectValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

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
// SAVE SETTINGS (inkl. erweiterter Tickets)
// ============================================================
async function saveModuleSettings(moduleName) {
  const saveStatus = document.getElementById(`${moduleName}-save-status`);
  if (saveStatus) {
    saveStatus.classList.add('hidden');
    saveStatus.textContent = '⏳ Speichern...';
    saveStatus.classList.remove('hidden');
  }
  
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
          panelChannelId: document.getElementById('ticket-panel-channel').value,
          title: document.getElementById('ticket-panel-title').value,
          description: document.getElementById('ticket-panel-desc').value,
          color: document.getElementById('ticket-color').value,
          image: document.getElementById('ticket-image-input')?.dataset.value || '',
          creationMessage: document.getElementById('ticket-create-msg').value,
          options: collectTicketOptions().filter(opt => opt.label.trim()),
          // NEUE Felder:
          enabled: document.getElementById('ticket-panel-enabled').checked,
          panelName: document.getElementById('ticket-panel-name').value,
          supportRoles: getSelectedRoleIds('ticket-support-roles'),
          locationCategory: document.getElementById('ticket-location-category').value,
          overflowCategories: getSelectedOptions('ticket-overflow-categories'),
          threadMode: document.getElementById('ticket-thread-mode').value,
          saveTranscripts: document.getElementById('ticket-save-transcripts').checked,
          saveImages: document.getElementById('ticket-save-images').checked,
          privateTranscripts: document.getElementById('ticket-private-transcripts').checked,
          channelNameTemplate: document.getElementById('ticket-channel-name-template').value
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
        payload = {
          enabled: document.getElementById('verification-enabled').checked,
          roleId: roles[0] || null
        };
        break;
        
      default:
        const enabledEl = document.getElementById(`${moduleName}-enabled`);
        const channelEl = document.getElementById(`${moduleName}-channel`) || document.getElementById(`${moduleName}-log-channel`);
        payload = {
          enabled: enabledEl ? enabledEl.checked : true,
          channelId: channelEl ? channelEl.value : undefined
        };
    }
    
    await apiFetch(`/guild/${state.activeGuildId}/config/${moduleName}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    
    showToast(`${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)} erfolgreich gespeichert!`, 'success');
    
    if (saveStatus) {
      saveStatus.textContent = '✓ Gespeichert';
      saveStatus.classList.remove('hidden');
      setTimeout(() => saveStatus.classList.add('hidden'), 3000);
    }
  } catch (err) {
    showToast(`Fehler beim Speichern: ${err.message}`, 'error');
    if (saveStatus) {
      saveStatus.textContent = '✕ Fehler';
      saveStatus.classList.remove('hidden');
      setTimeout(() => saveStatus.classList.add('hidden'), 3000);
    }
  }
}

// ============================================================
// KEYBOARD SUPPORT
// ============================================================
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !DOM.manageOverlay.classList.contains('hidden')) {
    closeManagement();
  }
  
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const activeTab = document.querySelector('.tab-btn.active');
    if (activeTab) {
      const moduleName = activeTab.dataset.tab;
      if (moduleName) saveModuleSettings(moduleName);
    }
  }
});

// ============================================================
// NEUE FUNKTIONEN FÜR DIE TICKET-ÜBERSICHT (Kartenansicht + Bearbeitungsansicht)
// ============================================================

// ------ Globale Referenzen für die Ticket-Übersicht ------
const ticketGrid = document.getElementById('ticket-overview-grid');
const editContainer = document.getElementById('ticket-edit-container');
const editContent = document.getElementById('ticket-edit-content');
let editingIndex = null;

// ------ Hilfsfunktion: Kategorien für Dropdowns füllen ------
function populateCategorySelects() {
  const ids = ['edit-ticket-category', 'edit-ticket-overflow'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const categories = state.guildChannels.filter(c => c.type === 4);
    el.innerHTML = categories.length
      ? categories.map(c => `<option value="${c.id}">📁 ${escapeHtml(c.name)}</option>`).join('')
      : `<option value="">Keine Kategorien gefunden</option>`;
  });
}

// ------ Hilfsfunktion: Rollen-Chips in der Bearbeitungsansicht rendern ------
function renderEditRoleChips(containerId, selectedIds = [], singleSelect = false) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (state.guildRoles.length === 0) {
    el.innerHTML = `<span class="chip-empty">Keine Rollen gefunden</span>`;
    return;
  }
  const selectedSet = new Set(selectedIds);
  el.innerHTML = state.guildRoles
    .map(r => {
      const isSelected = selectedSet.has(r.id);
      return `<div class="role-chip ${isSelected ? 'selected' : ''}" 
                    data-role-id="${r.id}" 
                    onclick="toggleEditRoleChip('${containerId}', '${r.id}', ${singleSelect})">
                <span class="chip-icon">@</span>
                <span class="chip-label">${escapeHtml(r.name)}</span>
              </div>`;
    })
    .join('');
}

// ------ Toggle für Rollen-Chips in der Bearbeitungsansicht ------
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

// ------ Werte aus den Chips sammeln ------
function getEditSelectedRoles(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return [];
  return Array.from(el.querySelectorAll('.role-chip.selected'))
    .map(c => c.dataset.roleId);
}

// ------ Buttons (für Panel) ------
let buttonCounter = 0;

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

// ------ Übersicht rendern (Karten) ------
async function renderTicketOverview() {
  if (!ticketGrid) return;
  if (!state.activeGuildId) {
    ticketGrid.innerHTML = `<div class="state-box" style="grid-column:1/-1;">Bitte wähle zuerst einen Server aus.</div>`;
    return;
  }

  try {
    const config = await apiFetch(`/guild/${state.activeGuildId}/config`);
    const tickets = config.tickets || {};
    const options = tickets.options || [];

    if (options.length === 0) {
      ticketGrid.innerHTML = `
        <div class="guild-card add-card" onclick="openAddTicket()">
          <div style="font-size:3rem; line-height:1;">＋</div>
          <div style="font-weight:700; font-size:1.1rem; margin-top:6px;">Neues Ticket hinzufügen</div>
          <div style="color:var(--text-muted); font-size:0.85rem;">Klicke hier, um eine neue Kategorie zu erstellen.</div>
        </div>
      `;
      return;
    }

    let html = '';
    options.forEach((opt, index) => {
      const emoji = opt.emoji || '🎫';
      const label = opt.label || 'Unbenannt';
      const categoryName = state.guildChannels.find(c => c.id === opt.categoryId)?.name || 'Keine Kategorie';

      html += `
        <div class="guild-card">
          <div class="guild-info">
            <div class="guild-icon">${escapeHtml(emoji)}</div>
            <span class="guild-name">${escapeHtml(label)}</span>
          </div>
          <div class="guild-detail">
            <span>📂 Kategorie: ${escapeHtml(categoryName)}</span>
          </div>
          <div class="guild-action">
            <button class="btn btn-secondary" onclick="openEditView(${index})">Bearbeiten</button>
            <button class="btn btn-danger" onclick="deleteTicketOption(${index})">Löschen</button>
          </div>
        </div>
      `;
    });

    html += `
      <div class="guild-card add-card" onclick="openAddTicket()">
        <div style="font-size:3rem; line-height:1;">＋</div>
        <div style="font-weight:700; font-size:1.1rem; margin-top:6px;">Neues Ticket hinzufügen</div>
        <div style="color:var(--text-muted); font-size:0.85rem;">Klicke hier, um eine weitere Kategorie zu erstellen.</div>
      </div>
    `;

    ticketGrid.innerHTML = html;
  } catch (err) {
    ticketGrid.innerHTML = `<div class="state-box error" style="grid-column:1/-1;">Fehler beim Laden: ${err.message}</div>`;
  }
}

// ------ Neues Ticket hinzufügen ------
window.openAddTicket = function() {
  editingIndex = null;
  showEditView(null);
};

// ------ Vorhandenes Ticket bearbeiten ------
window.openEditView = function(index) {
  editingIndex = index;
  showEditView(index);
};

// ------ Bearbeitungsansicht anzeigen und befüllen ------
async function showEditView(index) {
  // Übersicht ausblenden, Bearbeitungsansicht einblenden
  document.getElementById('ticket-overview-container').classList.add('hidden');
  editContainer.classList.remove('hidden');

  // Config laden
  let config;
  try {
    config = await apiFetch(`/guild/${state.activeGuildId}/config`);
  } catch {
    showToast('Fehler beim Laden der Konfiguration.', 'error');
    return;
  }
  if (!config.tickets) config.tickets = {};
  if (!config.tickets.options) config.tickets.options = [];

  let data = null;
  if (index !== null && config.tickets.options[index]) {
    data = config.tickets.options[index];
  } else {
    // neues Ticket – Standardwerte
    data = {
      enabled: true,
      panelName: 'Neues Ticket',
      supportRoles: [],
      categoryId: '',
      overflowEnabled: false,
      overflowCategories: [],
      threadMode: 'none',
      saveTranscripts: false,
      saveImages: false,
      privateTranscripts: false,
      channelNameTemplate: '{panel.name}-{ticket.creator.username}',
      allowedRoles: [],
      deniedRoles: [],
      maxTickets: 1,
      claimEnabled: false,
      buttons: []
    };
  }

  // HTML für die Bearbeitungsansicht generieren
  let html = `
    <div class="card form-card" style="max-width:100%;">
      <h3 style="font-size:1rem; font-weight:700; margin-bottom:0.5rem;">${index !== null ? 'Ticket bearbeiten' : 'Neues Ticket hinzufügen'}</h3>

      <!-- Panel aktiv -->
      <div class="form-group">
        <div class="switch-row">
          <label style="margin:0;">Panel aktiv</label>
          <label class="switch"><input type="checkbox" id="edit-panel-enabled" ${data.enabled ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
      </div>

      <!-- Panel Name -->
      <div class="form-group">
        <label for="edit-panel-name">Panel-Name</label>
        <input type="text" id="edit-panel-name" value="${escapeHtml(data.panelName || '')}" placeholder="Support">
      </div>

      <!-- Support Rollen -->
      <div class="form-group">
        <label>Support-Rollen (Zugriff)</label>
        <div id="edit-support-roles" class="chip-select"></div>
      </div>

      <!-- Kategorie -->
      <div class="form-group">
        <label for="edit-ticket-category">Kategorie für Tickets</label>
        <select id="edit-ticket-category"></select>
      </div>

      <!-- Overflow aktiv -->
      <div class="form-group">
        <div class="switch-row">
          <label style="margin:0;">Überlauf-Kategorien aktivieren</label>
          <label class="switch"><input type="checkbox" id="edit-overflow-enabled" ${data.overflowEnabled ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
      </div>

      <!-- Overflow Kategorien -->
      <div class="form-group" id="edit-overflow-group" style="${data.overflowEnabled ? '' : 'display:none;'}">
        <label for="edit-ticket-overflow">Überlauf-Kategorien (mehrfach)</label>
        <select id="edit-ticket-overflow" multiple style="height:auto;min-height:80px;"></select>
        <small>Halte Strg (Cmd) gedrückt, um mehrere auszuwählen.</small>
      </div>

      <!-- Threading Modus -->
      <div class="form-group">
        <label for="edit-thread-mode">Thread-Modus</label>
        <select id="edit-thread-mode">
          <option value="none" ${data.threadMode === 'none' ? 'selected' : ''}>Keine Threads</option>
          <option value="thread" ${data.threadMode === 'thread' ? 'selected' : ''}>Öffentliche Threads</option>
          <option value="private" ${data.threadMode === 'private' ? 'selected' : ''}>Private Threads</option>
        </select>
      </div>

      <!-- Transkript Einstellungen -->
      <div class="form-group">
        <label style="font-weight:700;">Transkript-Einstellungen</label>
        <div class="switch-row">
          <label style="margin:0;">Transkripte speichern</label>
          <label class="switch"><input type="checkbox" id="edit-save-transcripts" ${data.saveTranscripts ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <div class="switch-row">
          <label style="margin:0;">Bilder in Transkripten</label>
          <label class="switch"><input type="checkbox" id="edit-save-images" ${data.saveImages ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
        <div class="switch-row">
          <label style="margin:0;">Private Transkripte</label>
          <label class="switch"><input type="checkbox" id="edit-private-transcripts" ${data.privateTranscripts ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
      </div>

      <!-- Kanalnamen Vorlage -->
      <div class="form-group">
        <label for="edit-channel-template">Kanalnamen-Vorlage</label>
        <input type="text" id="edit-channel-template" value="${escapeHtml(data.channelNameTemplate || '{panel.name}-{ticket.creator.username}')}" placeholder="{panel.name}-{ticket.creator.username}">
        <small>Platzhalter: <code>{panel.name}</code>, <code>{ticket.creator.username}</code>, <code>{ticket.id}</code></small>
      </div>

      <!-- Rollen, die öffnen dürfen -->
      <div class="form-group">
        <label>Rollen, die ein Ticket öffnen dürfen (optional)</label>
        <div id="edit-allowed-roles" class="chip-select"></div>
        <small>Leer lassen = jeder darf öffnen.</small>
      </div>

      <!-- Rollen, die nicht öffnen dürfen -->
      <div class="form-group">
        <label>Rollen, die kein Ticket öffnen dürfen (optional)</label>
        <div id="edit-denied-roles" class="chip-select"></div>
      </div>

      <!-- Maximale Tickets pro User -->
      <div class="form-group">
        <label for="edit-max-tickets">Maximale Tickets pro Benutzer</label>
        <input type="number" id="edit-max-tickets" value="${data.maxTickets || 1}" min="1" step="1">
      </div>

      <!-- Claim System -->
      <div class="form-group">
        <div class="switch-row">
          <label style="margin:0;">Claim-System aktivieren</label>
          <label class="switch"><input type="checkbox" id="edit-claim-enabled" ${data.claimEnabled ? 'checked' : ''}><span class="switch-slider"></span></label>
        </div>
      </div>

      <!-- Buttons -->
      <div class="form-group">
        <label style="font-weight:700;">Buttons (für das Panel)</label>
        <div id="edit-button-list"></div>
        <button type="button" class="add-button-btn" onclick="window.addButtonRow()">+ Button hinzufügen</button>
      </div>

      <!-- Speichern -->
      <div class="form-action">
        <button class="btn btn-primary" onclick="saveEditView()">Speichern</button>
        <button class="btn btn-secondary" onclick="closeEditView()">Abbrechen</button>
        <span id="edit-save-status" class="hidden status-success"></span>
      </div>
    </div>
  `;

  editContent.innerHTML = html;

  // Kategorien befüllen
  populateCategorySelects();
  // Rollen-Chips rendern
  renderEditRoleChips('edit-support-roles', data.supportRoles || []);
  renderEditRoleChips('edit-allowed-roles', data.allowedRoles || []);
  renderEditRoleChips('edit-denied-roles', data.deniedRoles || []);
  // Ausgewählte Kategorie setzen
  if (data.categoryId) document.getElementById('edit-ticket-category').value = data.categoryId;
  // Mehrfachauswahl für Overflow setzen
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
    const group = document.getElementById('edit-overflow-group');
    group.style.display = this.checked ? '' : 'none';
  });

  // Buttons laden
  if (data.buttons && data.buttons.length) {
    data.buttons.forEach(btn => window.addButtonRow(btn));
  } else {
    // Standard-Button
    window.addButtonRow({ label: 'Ticket öffnen', emoji: '🎫', color: '#ffffff', action: 'open' });
  }
}

// ------ Bearbeitungsansicht schließen ------
window.closeEditView = function() {
  document.getElementById('ticket-overview-container').classList.remove('hidden');
  editContainer.classList.add('hidden');
  editContent.innerHTML = '';
  editingIndex = null;
  renderTicketOverview();
};

// ------ Speichern der Bearbeitung ------
window.saveEditView = async function() {
  const saveStatus = document.getElementById('edit-save-status');
  if (saveStatus) {
    saveStatus.classList.remove('hidden');
    saveStatus.textContent = '⏳ Speichern...';
  }

  // Daten sammeln
  const enabled = document.getElementById('edit-panel-enabled').checked;
  const panelName = document.getElementById('edit-panel-name').value.trim();
  const supportRoles = getEditSelectedRoles('edit-support-roles');
  const categoryId = document.getElementById('edit-ticket-category').value;
  const overflowEnabled = document.getElementById('edit-overflow-enabled').checked;
  const overflowSelect = document.getElementById('edit-ticket-overflow');
  const overflowCategories = overflowSelect ? Array.from(overflowSelect.selectedOptions).map(o => o.value) : [];
  const threadMode = document.getElementById('edit-thread-mode').value;
  const saveTranscripts = document.getElementById('edit-save-transcripts').checked;
  const saveImages = document.getElementById('edit-save-images').checked;
  const privateTranscripts = document.getElementById('edit-private-transcripts').checked;
  const channelNameTemplate = document.getElementById('edit-channel-template').value.trim() || '{panel.name}-{ticket.creator.username}';
  const allowedRoles = getEditSelectedRoles('edit-allowed-roles');
  const deniedRoles = getEditSelectedRoles('edit-denied-roles');
  const maxTickets = parseInt(document.getElementById('edit-max-tickets').value) || 1;
  const claimEnabled = document.getElementById('edit-claim-enabled').checked;
  const buttons = collectButtons().filter(b => b.label.trim());

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
      supportRoles,
      categoryId,
      overflowEnabled,
      overflowCategories,
      threadMode,
      saveTranscripts,
      saveImages,
      privateTranscripts,
      channelNameTemplate,
      allowedRoles,
      deniedRoles,
      maxTickets,
      claimEnabled,
      buttons
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
    showToast('Ticket gelöscht.', 'success');
    renderTicketOverview();
  } catch (err) {
    showToast(`Fehler: ${err.message}`, 'error');
  }
};

// ------ Event Listener für Ticket-Tab ------
document.addEventListener('DOMContentLoaded', function() {
  const ticketTabBtn = document.querySelector('[data
