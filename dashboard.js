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
let guildRoles = [];     // [{id, name, color}]
let guildChannels = [];  // [{id, name, type}] type: 0=text,2=voice,4=category
let ticketOptionCount = 0;

// ---------- Grundlegende Server-Auswahl ----------

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

// ---------- Verwaltungs-Overlay öffnen ----------

async function openManagement(guildId, name, iconUrl) {
  activeGuildId = guildId;
  if (activeGuildName) activeGuildName.textContent = name;
  if (activeGuildIcon) activeGuildIcon.src = iconUrl;

  if (overviewMembers) overviewMembers.textContent = '...';
  if (overviewBoosts) overviewBoosts.textContent = '...';

  manageOverlay?.classList.remove('hidden');

  loadGuildDetails(guildId);
  await loadRolesAndChannels(guildId);
  await loadAllModuleSettings(guildId);
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

// ---------- Rollen & Kanäle laden ----------

async function loadRolesAndChannels(guildId) {
  try {
    const [rolesRes, channelsRes] = await Promise.all([
      fetch(`/api/guild/${guildId}/roles`),
      fetch(`/api/guild/${guildId}/channels`)
    ]);
    guildRoles = rolesRes.ok ? await rolesRes.json() : [];
    guildChannels = channelsRes.ok ? await channelsRes.json() : [];
  } catch (err) {
    guildRoles = [];
    guildChannels = [];
  }

  renderChannelSelect('join-channel', 0);
  renderChannelSelect('leave-channel', 0);
  renderChannelSelect('ticket-panel-channel', 0);
  renderChannelSelect('teamliste-channel', 0);
  renderChannelSelect('support-channel', 0);
  renderChannelSelect('moderation-log-channel', 0);
  renderChannelSelect('teamupdate-channel', 0);

  renderRoleChips('join-roles', []);
  renderRoleChips('teamliste-roles', []);
  renderRoleChips('verification-roles', [], true);
}

function renderChannelSelect(selectId, filterType) {
  const el = document.getElementById(selectId);
  if (!el) return;
  const relevant = guildChannels.filter((c) => c.type === filterType);
  if (relevant.length === 0) {
    el.innerHTML = `<option value="">Keine Textkanäle gefunden</option>`;
    return;
  }
  el.innerHTML = relevant.map((c) => `<option value="${c.id}"># ${escapeHtml(c.name)}</option>`).join('');
}

function renderRoleChips(containerId, selectedIds, singleSelect = false) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (guildRoles.length === 0) {
    el.innerHTML = `<span class="chip-empty">Keine Rollen gefunden</span>`;
    return;
  }
  el.innerHTML = guildRoles
    .map((r) => {
      const isSelected = selectedIds.includes(r.id);
      return `<div class="role-chip ${isSelected ? 'selected' : ''}" data-role-id="${r.id}" onclick="toggleRoleChip('${containerId}', '${r.id}', ${singleSelect})"><span class="chip-icon">@</span><span class="chip-label">${escapeHtml(r.name)}</span></div>`;
    })
    .join('');
}

function toggleRoleChip(containerId, roleId, singleSelect) {
  const el = document.getElementById(containerId);
  const chip = el.querySelector(`[data-role-id="${roleId}"]`);
  if (!chip) return;
  if (singleSelect) {
    el.querySelectorAll('.role-chip').forEach((c) => c.classList.remove('selected'));
    chip.classList.add('selected');
  } else {
    chip.classList.toggle('selected');
  }
}

function getSelectedRoleIds(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return [];
  return Array.from(el.querySelectorAll('.role-chip.selected')).map((c) => c.dataset.roleId);
}

// ---------- Tabs & Subtabs ----------

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
  document.querySelectorAll('.module-page').forEach((page) => page.classList.add('hidden'));

  const activeBtn = document.querySelector(`[data-tab="${tabName}"]`);
  const activePage = document.getElementById(`mod-${tabName}`);

  if (activeBtn) activeBtn.classList.add('active');
  if (activePage) activePage.classList.remove('hidden');
}

function switchSubtab(moduleName, subName) {
  const container = document.getElementById(`mod-${moduleName}`);
  if (!container) return;
  container.querySelectorAll('.subtab-btn').forEach((btn) => btn.classList.remove('active'));
  container.querySelectorAll('.subpage').forEach((page) => page.classList.add('hidden'));

  container.querySelector(`[data-sub="${subName}"]`)?.classList.add('active');
  document.getElementById(`${moduleName}-${subName}-page`)?.classList.remove('hidden');
}

// ---------- Farb-Sync (Color Picker <-> Hex Input) ----------

function syncColor(prefix) {
  const color = document.getElementById(`${prefix}-color`).value;
  document.getElementById(`${prefix}-color-hex`).value = color;
  const preview = document.getElementById(`${prefix}-preview`);
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

// ---------- Bild-Upload (als Base64 gespeichert) ----------

function handleImageUpload(input, prefix) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const previewImg = document.getElementById(`${prefix}-image-preview`);
    if (previewImg) previewImg.src = dataUrl;
    input.dataset.value = dataUrl;
    updateEmbedPreview(prefix);
  };
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

// ---------- Live Embed-Vorschau ----------

function updateEmbedPreview(prefix) {
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
}

// ---------- Ticket-Kategorien (dynamische Zeilen) ----------

function addTicketOption(data = null) {
  ticketOptionCount++;
  const id = `ticket-opt-${ticketOptionCount}`;
  const list = document.getElementById('ticket-options-list');
  const row = document.createElement('div');
  row.className = 'option-row';
  row.id = id;
  row.innerHTML = `
    <input type="text" placeholder="Label, z.B. Allgemeiner Support" class="opt-label" value="${data ? escapeHtml(data.label || '') : ''}">
    <input type="text" placeholder="Emoji (optional)" class="opt-emoji" style="max-width: 90px;" value="${data ? escapeHtml(data.emoji || '') : ''}">
    <select class="opt-category"></select>
    <button type="button" class="option-remove" onclick="document.getElementById('${id}').remove()">✕</button>
  `;
  list.appendChild(row);
  const select = row.querySelector('.opt-category');
  const cats = guildChannels.filter((c) => c.type === 4);
  select.innerHTML = cats.length
    ? cats.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
    : `<option value="">Keine Kategorien gefunden</option>`;
  if (data && data.categoryId) select.value = data.categoryId;
}

function collectTicketOptions() {
  return Array.from(document.querySelectorAll('#ticket-options-list .option-row')).map((row) => ({
    label: row.querySelector('.opt-label').value,
    emoji: row.querySelector('.opt-emoji').value,
    categoryId: row.querySelector('.opt-category').value
  }));
}

// ---------- Einstellungen laden ----------

async function loadAllModuleSettings(guildId) {
  try {
    const res = await fetch(`/api/guild/${guildId}/config`);
    const config = res.ok ? await res.json() : {};

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

  document.getElementById('join-enabled').checked = j.enabled ?? true;
  document.getElementById('join-mode').value = j.mode || 'embed';
  document.getElementById('join-title').value = j.title || '';
  document.getElementById('join-text').value = j.text || '';
  document.getElementById('join-color').value = j.color || '#ffffff';
  document.getElementById('join-color-hex').value = j.color || '#ffffff';
  document.getElementById('join-avatar-thumb').checked = j.useAvatarThumbnail ?? true;
  if (j.image) {
    document.getElementById('join-image-preview').src = j.image;
    document.getElementById('join-image-input').dataset.value = j.image;
  }
  if (j.channelId) document.getElementById('join-channel').value = j.channelId;
  renderRoleChips('join-roles', j.roles || []);

  document.getElementById('leave-enabled').checked = l.enabled ?? false;
  document.getElementById('leave-mode').value = l.mode || 'embed';
  document.getElementById('leave-title').value = l.title || '';
  document.getElementById('leave-text').value = l.text || '';
  document.getElementById('leave-color').value = l.color || '#ffffff';
  document.getElementById('leave-color-hex').value = l.color || '#ffffff';
  document.getElementById('leave-avatar-thumb').checked = l.useAvatarThumbnail ?? true;
  if (l.image) {
    document.getElementById('leave-image-preview').src = l.image;
    document.getElementById('leave-image-input').dataset.value = l.image;
  }
  if (l.channelId) document.getElementById('leave-channel').value = l.channelId;

  updateEmbedPreview('join');
  updateEmbedPreview('leave');
}

function applyTicketConfig(cfg) {
  if (cfg.panelChannelId) document.getElementById('ticket-panel-channel').value = cfg.panelChannelId;
  document.getElementById('ticket-panel-title').value = cfg.title || '';
  document.getElementById('ticket-panel-desc').value = cfg.description || '';
  document.getElementById('ticket-color').value = cfg.color || '#ffffff';
  document.getElementById('ticket-color-hex').value = cfg.color || '#ffffff';
  document.getElementById('ticket-create-msg').value = cfg.creationMessage || '';
  if (cfg.image) {
    document.getElementById('ticket-image-preview').src = cfg.image;
    document.getElementById('ticket-image-input').dataset.value = cfg.image;
  }

  document.getElementById('ticket-options-list').innerHTML = '';
  ticketOptionCount = 0;
  const options = cfg.options && cfg.options.length ? cfg.options : [{ label: 'Allgemeiner Support', emoji: '🎫', categoryId: '' }];
  options.forEach((opt) => addTicketOption(opt));

  updateEmbedPreview('ticket');
}

function applyTeamlisteConfig(cfg) {
  if (cfg.channelId) document.getElementById('teamliste-channel').value = cfg.channelId;
  renderRoleChips('teamliste-roles', cfg.roles || []);
}

function applyVerificationConfig(cfg) {
  document.getElementById('verification-enabled').checked = cfg.enabled ?? false;
  renderRoleChips('verification-roles', cfg.roleId ? [cfg.roleId] : [], true);
}

function applySimpleConfig(prefix, cfg) {
  const enabledEl = document.getElementById(`${prefix}-enabled`);
  if (enabledEl) enabledEl.checked = cfg.enabled ?? enabledEl.checked;
  const channelEl = document.getElementById(`${prefix}-channel`) || document.getElementById(`${prefix}-log-channel`);
  if (channelEl && cfg.channelId) channelEl.value = cfg.channelId;
}

// ---------- Einstellungen speichern ----------

async function saveModuleSettings(moduleName) {
  let payload = {};

  if (moduleName === 'welcome') {
    payload = {
      join: {
        enabled: document.getElementById('join-enabled').checked,
        mode: document.getElementById('join-mode').value,
        title: document.getElementById('join-title').value,
        text: document.getElementById('join-text').value,
        color: document.getElementById('join-color').value,
        image: document.getElementById('join-image-input').dataset.value || '',
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
        image: document.getElementById('leave-image-input').dataset.value || '',
        useAvatarThumbnail: document.getElementById('leave-avatar-thumb').checked,
        channelId: document.getElementById('leave-channel').value
      }
    };
  } else if (moduleName === 'tickets') {
    payload = {
      panelChannelId: document.getElementById('ticket-panel-channel').value,
      title: document.getElementById('ticket-panel-title').value,
      description: document.getElementById('ticket-panel-desc').value,
      color: document.getElementById('ticket-color').value,
      image: document.getElementById('ticket-image-input').dataset.value || '',
      creationMessage: document.getElementById('ticket-create-msg').value,
      options: collectTicketOptions()
    };
  } else if (moduleName === 'teamliste') {
    payload = {
      channelId: document.getElementById('teamliste-channel').value,
      roles: getSelectedRoleIds('teamliste-roles')
    };
  } else if (moduleName === 'verification') {
    const roles = getSelectedRoleIds('verification-roles');
    payload = {
      enabled: document.getElementById('verification-enabled').checked,
      roleId: roles[0] || null
    };
  } else {
    const enabledEl = document.getElementById(`${moduleName}-enabled`);
    const channelEl = document.getElementById(`${moduleName}-channel`) || document.getElementById(`${moduleName}-log-channel`);
    payload = {
      enabled: enabledEl ? enabledEl.checked : true,
      channelId: channelEl ? channelEl.value : undefined
    };
  }

  try {
    const res = await fetch(`/api/guild/${activeGuildId}/config/${moduleName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      showToast('✓ Erfolgreich gespeichert!');
    } else {
      showToast('✕ Speichern fehlgeschlagen');
    }
  } catch (err) {
    showToast('✕ Verbindungsfehler beim Speichern');
  }
}

// ---------- Toast-Benachrichtigung ----------

function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

document.addEventListener('DOMContentLoaded', loadDashboard);
