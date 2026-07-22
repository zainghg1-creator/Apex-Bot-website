const CLIENT_ID = '1525613011262377994';
const BOT_PERMISSIONS = '8';

// ========== DOM Elements ==========
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

// ========== State Management ==========
let activeGuildId = null;
let guildRoles = [];
let guildChannels = [];
let ticketOptionCount = 0;

// ========== UI State Functions ==========
function showState(state) {
  const states = [loadingState, emptyState, errorState, guildListEl];
  states.forEach((el) => el?.classList.add('hidden'));
  state?.classList.remove('hidden');
}

// ========== Dashboard Loading ==========
async function loadDashboard() {
  showState(loadingState);
  try {
    const res = await fetch('/api/guilds');
    if (!res.ok) {
      if (res.status === 401) return (window.location.href = '/');
      throw new Error('Fehler beim Laden der Server');
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
  guilds.forEach((guild, idx) => {
    const card = document.createElement('div');
    card.className = 'guild-card';
    card.style.animationDelay = `${idx * 0.05}s`;

    const iconSrc = guild.icon || 'https://cdn.discordapp.com/embed/avatars/0.png';

    card.innerHTML = `
      <div class="guild-info">
        <img src="${iconSrc}" class="guild-icon" alt="${escapeHtml(guild.name)}">
        <span class="guild-name">${escapeHtml(guild.name)}</span>
      </div>
      <div class="guild-action">
        ${
          guild.botIstDrauf
            ? `<button class="btn btn-primary" onclick="openManagement('${guild.id}', '${escapeHtml(guild.name)}', '${iconSrc}')">Verwalten</button>`
            : `<a href="https://discord.com/api/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${BOT_PERMISSIONS}&guild_id=${guild.id}" target="_blank" class="btn btn-secondary">Bot hinzufügen</a>`
        }
      </div>
    `;
    guildListEl.appendChild(card);
  });

  showState(guildListEl);
}

function escapeHtml(str) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return str.replace(/[&<>"']/g, (char) => map[char]);
}

// ========== Management Overlay ==========
async function openManagement(guildId, name, iconUrl) {
  activeGuildId = guildId;
  if (activeGuildName) activeGuildName.textContent = name;
  if (activeGuildIcon) activeGuildIcon.src = iconUrl;

  if (overviewMembers) overviewMembers.textContent = '...';
  if (overviewBoosts) overviewBoosts.textContent = '...';

  manageOverlay?.classList.remove('hidden');

  await Promise.all([
    loadGuildDetails(guildId),
    loadRolesAndChannels(guildId),
    loadAllModuleSettings(guildId),
  ]);
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
    }
  } catch (err) {
    console.error('Guild details error:', err);
    if (overviewMembers) overviewMembers.textContent = 'N/A';
    if (overviewBoosts) overviewBoosts.textContent = 'N/A';
  }
}

// ========== Roles & Channels ==========
async function loadRolesAndChannels(guildId) {
  try {
    const [rolesRes, channelsRes] = await Promise.all([
      fetch(`/api/guild/${guildId}/roles`),
      fetch(`/api/guild/${guildId}/channels`),
    ]);
    guildRoles = rolesRes.ok ? await rolesRes.json() : [];
    guildChannels = channelsRes.ok ? await channelsRes.json() : [];
  } catch (err) {
    console.error('Failed to load roles/channels:', err);
    guildRoles = [];
    guildChannels = [];
  }
}

function renderChannelSelect(selectId, filterType = 0) {
  const el = document.getElementById(selectId);
  if (!el) return;

  const relevant = guildChannels.filter((c) => c.type === filterType);
  if (relevant.length === 0) {
    el.innerHTML = `<option value="">Keine Kanäle gefunden</option>`;
    return;
  }

  el.innerHTML = relevant
    .map((c) => `<option value="${c.id}"># ${escapeHtml(c.name)}</option>`)
    .join('');
}

function renderRoleChips(containerId, selectedIds = [], singleSelect = false) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (guildRoles.length === 0) {
    el.innerHTML = `<span class="chip-empty">Keine Rollen gefunden</span>`;
    return;
  }

  el.innerHTML = guildRoles
    .map((r) => {
      const isSelected = selectedIds.includes(r.id);
      return `
        <div class="role-chip ${isSelected ? 'selected' : ''}" 
             data-role-id="${r.id}" 
             onclick="toggleRoleChip('${containerId}', '${r.id}', ${singleSelect})"
             role="button"
             tabindex="0"
             aria-pressed="${isSelected}">
          <span class="chip-icon">@</span>${escapeHtml(r.name)}
        </div>
      `;
    })
    .join('');
}

function toggleRoleChip(containerId, roleId, singleSelect) {
  const el = document.getElementById(containerId);
  const chip = el.querySelector(`[data-role-id="${roleId}"]`);
  if (!chip) return;

  if (singleSelect) {
    el.querySelectorAll('.role-chip').forEach((c) => {
      c.classList.remove('selected');
      c.setAttribute('aria-pressed', 'false');
    });
    chip.classList.add('selected');
    chip.setAttribute('aria-pressed', 'true');
  } else {
    chip.classList.toggle('selected');
    chip.setAttribute('aria-pressed', chip.classList.contains('selected'));
  }
}

function getSelectedRoleIds(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return [];
  return Array.from(el.querySelectorAll('.role-chip.selected')).map(
    (c) => c.dataset.roleId
  );
}

// ========== Tab Navigation ==========
function switchTab(tabName) {
  const tabs = document.querySelectorAll('.tab-btn');
  const pages = document.querySelectorAll('.module-page');

  tabs.forEach((btn) => btn.classList.remove('active'));
  pages.forEach((page) => page.classList.add('hidden'));

  const activeBtn = document.querySelector(`[data-tab="${tabName}"]`);
  const activePage = document.getElementById(`mod-${tabName}`);

  if (activeBtn) activeBtn.classList.add('active');
  if (activePage) activePage.classList.remove('hidden');
}

function switchSubtab(moduleName, subName) {
  const container = document.getElementById(`mod-${moduleName}`);
  if (!container) return;

  const subtabs = container.querySelectorAll('.subtab-btn');
  const subpages = container.querySelectorAll('.subpage');

  subtabs.forEach((btn) => btn.classList.remove('active'));
  subpages.forEach((page) => page.classList.add('hidden'));

  const activeBtn = container.querySelector(`[data-sub="${subName}"]`);
  const activePage = document.getElementById(`${moduleName}-${subName}-page`);

  if (activeBtn) activeBtn.classList.add('active');
  if (activePage) activePage.classList.remove('hidden');
}

// ========== Color Sync ==========
function syncColor(prefix) {
  const colorInput = document.getElementById(`${prefix}-color`);
  const hexInput = document.getElementById(`${prefix}-color-hex`);
  const preview = document.getElementById(`${prefix}-preview`);

  if (colorInput && hexInput) {
    hexInput.value = colorInput.value;
  }
  if (preview) preview.style.borderLeftColor = colorInput.value;
}

function syncColorHex(prefix) {
  let hex = document.getElementById(`${prefix}-color-hex`).value.trim();
  if (!hex.startsWith('#')) hex = `#${hex}`;

  if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    const colorInput = document.getElementById(`${prefix}-color`);
    if (colorInput) colorInput.value = hex;

    const preview = document.getElementById(`${prefix}-preview`);
    if (preview) preview.style.borderLeftColor = hex;
  }
}

// ========== Image Upload ==========
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

// ========== Embed Preview ==========
function updateEmbedPreview(prefix) {
  const titleEl =
    document.getElementById(`${prefix}-title`) ||
    document.getElementById(`${prefix}-panel-title`);
  const descEl =
    document.getElementById(`${prefix}-text`) ||
    document.getElementById(`${prefix}-panel-desc`);
  const previewTitle = document.getElementById(`${prefix}-preview-title`);
  const previewDesc = document.getElementById(`${prefix}-preview-desc`);
  const previewImage = document.getElementById(`${prefix}-preview-image`);
  const previewThumb = document.getElementById(`${prefix}-preview-thumb`);
  const imageInput = document.getElementById(`${prefix}-image-input`);
  const avatarThumbToggle = document.getElementById(`${prefix}-avatar-thumb`);

  if (previewTitle && titleEl)
    previewTitle.textContent = titleEl.value || titleEl.placeholder;
  if (previewDesc && descEl)
    previewDesc.textContent = descEl.value || descEl.placeholder;

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
    previewThumb.style.display =
      avatarThumbToggle && !avatarThumbToggle.checked ? 'none' : '';
  }
}

// ========== Ticket Options ==========
function addTicketOption(data = null) {
  ticketOptionCount++;
  const id = `ticket-opt-${ticketOptionCount}`;
  const list = document.getElementById('ticket-options-list');
  if (!list) return;

  const row = document.createElement('div');
  row.className = 'option-row';
  row.id = id;
  row.innerHTML = `
    <input type="text" placeholder="Label, z.B. Allgemeiner Support" class="opt-label" value="${
      data ? escapeHtml(data.label || '') : ''
    }">
    <input type="text" placeholder="Emoji (optional)" class="opt-emoji" style="max-width: 90px;" value="${
      data ? escapeHtml(data.emoji || '') : ''
    }">
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
  return Array.from(document.querySelectorAll('#ticket-options-list .option-row')).map(
    (row) => ({
      label: row.querySelector('.opt-label').value,
      emoji: row.querySelector('.opt-emoji').value,
      categoryId: row.querySelector('.opt-category').value,
    })
  );
}

// ========== Load Module Settings ==========
async function loadAllModuleSettings(guildId) {
  try {
    const res = await fetch(`/api/guild/${guildId}/config`);
    const config = res.ok ? await res.json() : {};

    applyWelcomeConfig(config.welcome || {});
    applyTicketConfig(config.tickets || {});
    applySimpleConfig('support', config.support || {});
    applySimpleConfig('moderation', config.moderation || {});
  } catch (err) {
    console.error('Failed to load module settings:', err);
  }
}

function applyWelcomeConfig(cfg) {
  const j = cfg.join || {};
  const l = cfg.leave || {};

  const joinEnabled = document.getElementById('join-enabled');
  if (joinEnabled) joinEnabled.checked = j.enabled ?? true;

  const joinMode = document.getElementById('join-mode');
  if (joinMode) joinMode.value = j.mode || 'embed';

  const joinTitle = document.getElementById('join-title');
  if (joinTitle) joinTitle.value = j.title || '';

  const joinText = document.getElementById('join-text');
  if (joinText) joinText.value = j.text || '';

  const joinColor = document.getElementById('join-color');
  if (joinColor) joinColor.value = j.color || '#ffffff';

  const joinColorHex = document.getElementById('join-color-hex');
  if (joinColorHex) joinColorHex.value = j.color || '#ffffff';

  const joinAvatarThumb = document.getElementById('join-avatar-thumb');
  if (joinAvatarThumb) joinAvatarThumb.checked = j.useAvatarThumbnail ?? true;

  if (j.image) {
    const previewImg = document.getElementById('join-image-preview');
    const input = document.getElementById('join-image-input');
    if (previewImg) previewImg.src = j.image;
    if (input) input.dataset.value = j.image;
  }

  const joinChannel = document.getElementById('join-channel');
  if (joinChannel && j.channelId) joinChannel.value = j.channelId;

  renderRoleChips('join-roles', j.roles || []);

  const leaveEnabled = document.getElementById('leave-enabled');
  if (leaveEnabled) leaveEnabled.checked = l.enabled ?? false;

  updateEmbedPreview('join');
  updateEmbedPreview('leave');
}

function applyTicketConfig(cfg) {
  const panelChannel = document.getElementById('ticket-panel-channel');
  if (panelChannel && cfg.panelChannelId) panelChannel.value = cfg.panelChannelId;

  const title = document.getElementById('ticket-panel-title');
  if (title) title.value = cfg.title || '';

  const desc = document.getElementById('ticket-panel-desc');
  if (desc) desc.value = cfg.description || '';

  const color = document.getElementById('ticket-color');
  if (color) color.value = cfg.color || '#ffffff';

  const colorHex = document.getElementById('ticket-color-hex');
  if (colorHex) colorHex.value = cfg.color || '#ffffff';

  const optionsList = document.getElementById('ticket-options-list');
  if (optionsList) optionsList.innerHTML = '';
  ticketOptionCount = 0;

  const options =
    cfg.options && cfg.options.length
      ? cfg.options
      : [{ label: 'Allgemeiner Support', emoji: '🎫', categoryId: '' }];
  options.forEach((opt) => addTicketOption(opt));

  updateEmbedPreview('ticket');
}

function applySimpleConfig(prefix, cfg) {
  const enabledEl = document.getElementById(`${prefix}-enabled`);
  if (enabledEl) enabledEl.checked = cfg.enabled ?? enabledEl.checked;

  const channelEl =
    document.getElementById(`${prefix}-channel`) ||
    document.getElementById(`${prefix}-log-channel`);
  if (channelEl && cfg.channelId) channelEl.value = cfg.channelId;
}

// ========== Save Module Settings ==========
async function saveModuleSettings(moduleName) {
  if (!activeGuildId) return;

  let payload = {};

  if (moduleName === 'welcome') {
    payload = {
      join: {
        enabled: document.getElementById('join-enabled')?.checked ?? true,
        mode: document.getElementById('join-mode')?.value || 'embed',
        title: document.getElementById('join-title')?.value || '',
        text: document.getElementById('join-text')?.value || '',
        color: document.getElementById('join-color')?.value || '#ffffff',
        image: document.getElementById('join-image-input')?.dataset.value || '',
        useAvatarThumbnail: document.getElementById('join-avatar-thumb')?.checked ?? true,
        channelId: document.getElementById('join-channel')?.value || '',
        roles: getSelectedRoleIds('join-roles'),
      },
      leave: {
        enabled: document.getElementById('leave-enabled')?.checked ?? false,
        mode: document.getElementById('leave-mode')?.value || 'embed',
        title: document.getElementById('leave-title')?.value || '',
        text: document.getElementById('leave-text')?.value || '',
        color: document.getElementById('leave-color')?.value || '#ffffff',
        image: document.getElementById('leave-image-input')?.dataset.value || '',
        useAvatarThumbnail: document.getElementById('leave-avatar-thumb')?.checked ?? true,
        channelId: document.getElementById('leave-channel')?.value || '',
      },
    };
  } else if (moduleName === 'tickets') {
    payload = {
      panelChannelId: document.getElementById('ticket-panel-channel')?.value || '',
      title: document.getElementById('ticket-panel-title')?.value || '',
      description: document.getElementById('ticket-panel-desc')?.value || '',
      color: document.getElementById('ticket-color')?.value || '#ffffff',
      image: document.getElementById('ticket-image-input')?.dataset.value || '',
      creationMessage: document.getElementById('ticket-create-msg')?.value || '',
      options: collectTicketOptions(),
    };
  } else {
    const enabledEl = document.getElementById(`${moduleName}-enabled`);
    const channelEl =
      document.getElementById(`${moduleName}-channel`) ||
      document.getElementById(`${moduleName}-log-channel`);

    payload = {
      enabled: enabledEl?.checked ?? true,
      channelId: channelEl?.value || undefined,
    };
  }

  try {
    const res = await fetch(`/api/guild/${activeGuildId}/config/${moduleName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    showToast(res.ok ? '✓ Erfolgreich gespeichert!' : '✕ Speichern fehlgeschlagen');
  } catch (err) {
    console.error('Save error:', err);
    showToast('✕ Verbindungsfehler beim Speichern');
  }
}

// ========== Toast Notification ==========
function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ========== Initialization ==========
document.addEventListener('DOMContentLoaded', loadDashboard);
