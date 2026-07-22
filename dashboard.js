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
    }
  } catch (err) {
    DOM.overviewMembers.textContent = 'N/A';
    DOM.overviewBoosts.textContent = 'N/A';
  }
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
  
  renderAllSelects();
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
  
  // Validate file size (max 5MB)
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
// EMBED PREVIEW (debounced)
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
// TICKET OPTIONS
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

function applyTicketConfig(cfg) {
  setSelectValue('ticket-panel-channel', cfg.panelChannelId || '');
  setValue('ticket-panel-title', cfg.title || '');
  setValue('ticket-panel-desc', cfg.description || '');
  setColor('ticket', cfg.color || '#ffffff');
  setValue('ticket-create-msg', cfg.creationMessage || '');
  setImage('ticket', cfg.image);
  
  document.getElementById('ticket-options-list').innerHTML = '';
  state.ticketOptionCount = 0;
  
  const options = cfg.options?.length ? cfg.options : [{ label: 'Allgemeiner Support', emoji: '🎫', categoryId: '' }];
  options.forEach(opt => addTicketOption(opt));
  
  updateEmbedPreview('ticket');
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

// Helper for config loading
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
// SAVE SETTINGS
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
          options: collectTicketOptions().filter(opt => opt.label.trim())
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
  // ESC schließt das Overlay
  if (e.key === 'Escape' && !DOM.manageOverlay.classList.contains('hidden')) {
    closeManagement();
  }
  
  // Strg+Enter speichert im aktuellen Tab
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const activeTab = document.querySelector('.tab-btn.active');
    if (activeTab) {
      const moduleName = activeTab.dataset.tab;
      if (moduleName) saveModuleSettings(moduleName);
    }
  }
});

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', loadDashboard);
