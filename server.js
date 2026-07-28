console.log('🔑 BOT_TOKEN vorhanden?', process.env.BOT_TOKEN ? '✅ Ja' : '❌ Nein');
require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');

// ============================================================
// VARIABLEN
// ============================================================
const {
  CLIENT_ID,
  CLIENT_SECRET,
  BOT_TOKEN,
  REDIRECT_URI,
  SESSION_SECRET,
  MONGODB_URI,
  PORT = 3000,
  NODE_ENV = 'production'
} = process.env;

console.log('🔍 Server startet...');
console.log('CLIENT_ID:', CLIENT_ID ? '✅' : '❌');
console.log('MONGODB_URI:', MONGODB_URI ? '✅' : '❌');
console.log('REDIRECT_URI:', REDIRECT_URI);

const DISCORD_API = 'https://discord.com/api/v10';
const ADMINISTRATOR = 0x8n;
const ALLOWED_MODULES = ['welcome', 'tickets', 'teamliste', 'automod', 'teamupdate', 'stats', 'levels', 'verification', 'antinuke', 'minigames', 'rolenicknames', 'reactionroles', 'custom_buttons', 'statusembed', 'applications', 'voice_support', 'shiftsystem'];

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();
app.set('trust proxy', 1);

app.use(express.static(__dirname));
app.use(express.json({ limit: '20mb' }));

app.use(cookieSession({
  name: 'apex_session',
  keys: [SESSION_SECRET || 'default-secret'],
  maxAge: 24 * 60 * 60 * 1000,
  secure: NODE_ENV === 'production',
  sameSite: 'lax',
  httpOnly: true
}));

// ============================================================
// MONGODB (NUR WENN URI VORHANDEN)
// ============================================================
let cachedConnection = global._apexMongooseConnection || { conn: null, promise: null };
global._apexMongooseConnection = cachedConnection;

async function connectToDatabase() {
  if (cachedConnection.conn) return cachedConnection.conn;
  if (!MONGODB_URI) {
    console.log('⚠️ Keine MongoDB URI - laufe ohne DB');
    return null;
  }
  if (!cachedConnection.promise) {
    cachedConnection.promise = mongoose.connect(MONGODB_URI, {
      dbName: 'apex',
      // Kurz genug, damit ein echter Verbindungsfehler VOR Vercels eigenem
      // Function-Timeout (10s im Hobby-Plan) als sauberes JSON zurückkommt,
      // statt dass die Plattform die Function killt (-> HTML statt JSON -> "unknown_error" im Dashboard).
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 20000,
      connectTimeoutMS: 5000,
      tls: true,
      retryWrites: true
    }).then(m => m).catch(err => {
      // Bei Fehlschlag die gecachte Promise verwerfen, sonst hängt jede
      // weitere Anfrage an derselben fehlgeschlagenen Verbindung fest,
      // bis der Serverless-Container neu startet.
      cachedConnection.promise = null;
      throw err;
    });
  }
  cachedConnection.conn = await cachedConnection.promise;
  return cachedConnection.conn;
}

if (MONGODB_URI) {
  app.use(async (req, res, next) => {
    try {
      await connectToDatabase();
      next();
    } catch (err) {
      console.error('MongoDB Fehler:', err.message);
      // Wichtig: NICHT next() aufrufen und so tun als wäre alles ok.
      // Ohne DB-Verbindung würden nachfolgende Mongoose-Queries (z.B. beim
      // Speichern der Config) einfach "buffern" und auf eine Verbindung warten,
      // bis Vercel die ganze Function killt -> HTML-Timeout-Seite statt JSON
      // -> "unknown_error" im Dashboard. Stattdessen sofort ein klares
      // JSON-Fehlerobjekt zurückgeben, das der Client anzeigen kann.
      if (res.headersSent) return;
      return res.status(503).json({ error: 'database_unavailable' });
    }
  });
} else {
  console.log('⚠️ MongoDB deaktiviert (keine URI)');
}

// ============================================================
// SCHEMA
// ============================================================
let GuildConfig = null;
let ButtonAction = null;
try {
  const guildConfigSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} }
  }, { timestamps: true });
  GuildConfig = mongoose.models.GuildConfig || mongoose.model('GuildConfig', guildConfigSchema);

  const buttonActionSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true, index: true },
    guildId: { type: String, required: true, index: true },
    action: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: Date.now, expires: 3600 }
  });
  ButtonAction = mongoose.models.ButtonAction || mongoose.model('ButtonAction', buttonActionSchema);
} catch (e) {
  console.log('⚠️ Mongoose Schema nicht geladen');
}

async function getGuildConfig(guildId) {
  if (!GuildConfig) return {};
  const doc = await GuildConfig.findOne({ guildId }).lean();
  return doc?.data || {};
}

async function saveModuleConfig(guildId, moduleName, moduleData) {
  if (!GuildConfig) return;
  await GuildConfig.findOneAndUpdate(
    { guildId },
    { $set: { [`data.${moduleName}`]: moduleData } },
    { upsert: true, new: true }
  );
}

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard.html', (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ============================================================
// OAUTH2
// ============================================================
app.get('/auth/discord/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
    prompt: 'consent'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=missing_code');
  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    if (!tokenRes.ok) throw new Error('Token exchange failed');
    const tokenData = await tokenRes.json();
    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userRes.ok) throw new Error('User fetch failed');
    const user = await userRes.json();
    req.session.accessToken = tokenData.access_token;
    req.session.user = {
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      discriminator: user.discriminator
    };
    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('OAuth Fehler:', err);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// ============================================================
// MIDDLEWARE: AUTH
// ============================================================
function requireAuth(req, res, next) {
  if (!req.session?.accessToken) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  next();
}

async function requireGuildAdmin(req, res, next) {
  if (!req.session?.accessToken) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  const guildId = req.params.guildId;
  if (!guildId) return res.status(400).json({ error: 'missing_guild_id' });

  try {
    const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${req.session.accessToken}` }
    });
    if (!guildsRes.ok) {
      if (guildsRes.status === 401) {
        req.session = null;
        return res.status(401).json({ error: 'session_expired' });
      }
      return res.status(502).json({ error: 'discord_api_error' });
    }
    const guilds = await guildsRes.json();
    const guild = guilds.find(g => g.id === guildId);
    if (!guild) {
      return res.status(403).json({ error: 'not_in_guild' });
    }
    const perms = BigInt(guild.permissions ?? 0);
    const isAdmin = guild.owner || (perms & ADMINISTRATOR) === ADMINISTRATOR;
    if (!isAdmin) {
      return res.status(403).json({ error: 'not_admin' });
    }
    next();
  } catch (err) {
    console.error('requireGuildAdmin Fehler:', err);
    res.status(500).json({ error: 'server_error' });
  }
}

// ============================================================
// BOT GUILD CACHE
// ============================================================
let botGuildsCache = { ids: new Set(), fetchedAt: 0 };

async function getBotGuildIds() {
  if (Date.now() - botGuildsCache.fetchedAt < 60000) return botGuildsCache.ids;
  const ids = new Set();
  let after = '0';
  try {
    while (true) {
      const res = await fetch(`${DISCORD_API}/users/@me/guilds?limit=200&after=${after}`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
      });
      if (!res.ok) break;
      const page = await res.json();
      page.forEach(g => ids.add(g.id));
      if (page.length < 200) break;
      after = page[page.length - 1].id;
    }
  } catch (err) {
    console.error('Fehler beim Abrufen der Bot-Guilds:', err);
  }
  botGuildsCache = { ids, fetchedAt: Date.now() };
  return ids;
}

// ============================================================
// API: GUILDS
// ============================================================
app.get('/api/guilds', requireAuth, async (req, res) => {
  try {
    const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${req.session.accessToken}` }
    });
    if (guildsRes.status === 401) {
      req.session = null;
      return res.status(401).json({ error: 'session_expired' });
    }
    if (!guildsRes.ok) return res.status(502).json({ error: 'discord_api_error' });
    const guilds = await guildsRes.json();
    const adminGuilds = guilds.filter(g => {
      const perms = BigInt(g.permissions ?? 0);
      return g.owner === true || (perms & ADMINISTRATOR) === ADMINISTRATOR;
    });
    const botGuildIds = await getBotGuildIds();
    const result = adminGuilds.map(g => ({
      id: g.id,
      name: g.name,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
      botIstDrauf: botGuildIds.has(g.id)
    })).sort((a, b) => Number(b.botIstDrauf) - Number(a.botIstDrauf) || a.name.localeCompare(b.name));
    res.json({ user: req.session.user, guilds: result, clientId: CLIENT_ID });
  } catch (err) {
    console.error('API /guilds Fehler:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ============================================================
// GUILD OWNER
// ============================================================
async function fetchGuildOwner(ownerId) {
  if (!ownerId) return null;
  try {
    const res = await fetch(`${DISCORD_API}/users/${ownerId}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return {
      id: user.id,
      username: user.global_name || user.username,
      avatar: user.avatar
    };
  } catch (err) {
    console.error('Fehler beim Laden des Server-Owners:', err);
    return null;
  }
}

// ============================================================
// BOT-ANZAHL
// ============================================================
async function countGuildBots(guildId) {
  let count = 0;
  let after = '0';
  const MAX_PAGES = 10;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members?limit=1000&after=${after}`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
      });
      if (!res.ok) {
        if (page === 0) return null;
        break;
      }
      const members = await res.json();
      count += members.filter(m => m.user?.bot).length;
      if (members.length < 1000) break;
      after = members[members.length - 1].user.id;
    }
  } catch (err) {
    console.error('Fehler beim Zählen der Bots:', err);
    return null;
  }
  return count;
}

// ============================================================
// API: GUILD DETAILS
// ============================================================
app.get('/api/guild/:guildId', requireAuth, async (req, res) => {
  try {
    const guildRes = await fetch(`${DISCORD_API}/guilds/${req.params.guildId}?with_counts=true`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!guildRes.ok) return res.status(guildRes.status).json({ error: 'guild_not_found' });
    const guildData = await guildRes.json();
    const [owner, botCount] = await Promise.all([
      fetchGuildOwner(guildData.owner_id),
      countGuildBots(req.params.guildId)
    ]);
    res.json({
      members: guildData.approximate_member_count ?? 0,
      boosts: guildData.premium_subscription_count ?? 0,
      botCount,
      owner
    });
  } catch (err) {
    console.error('API /guild/:id Fehler:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ============================================================
// API: CONFIG
// ============================================================
app.get('/api/guild/:guildId/config', requireAuth, async (req, res) => {
  try {
    const config = await getGuildConfig(req.params.guildId);
    res.json(config);
  } catch (err) {
    console.error('Fehler beim Laden der Konfiguration:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ============================================================
// STATISTIK-KANÄLE
// ============================================================
async function getGuildRolesCount(guildId) {
  try {
    const res = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!res.ok) return 0;
    const roles = await res.json();
    return Math.max(roles.length - 1, 0);
  } catch (err) {
    console.error('Fehler beim Zählen der Rollen:', err);
    return 0;
  }
}

async function getGuildBoostsCount(guildId) {
  try {
    const res = await fetch(`${DISCORD_API}/guilds/${guildId}?with_counts=true`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!res.ok) return 0;
    const g = await res.json();
    return g.premium_subscription_count ?? 0;
  } catch (err) {
    console.error('Fehler beim Zählen der Boosts:', err);
    return 0;
  }
}

async function getMemberAndBotCounts(guildId) {
  const botCount = (await countGuildBots(guildId)) ?? 0;
  let approxTotal = 0;
  try {
    const res = await fetch(`${DISCORD_API}/guilds/${guildId}?with_counts=true`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (res.ok) {
      const g = await res.json();
      approxTotal = g.approximate_member_count ?? 0;
    }
  } catch (err) {
    console.error('Fehler beim Zählen der Mitglieder:', err);
  }
  return { members: Math.max(approxTotal - botCount, 0), bots: botCount };
}

async function countGuildMembersWithRole(guildId, roleId) {
  let count = 0;
  let after = '0';
  const MAX_PAGES = 10;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members?limit=1000&after=${after}`, {
        headers: { Authorization: `Bot ${BOT_TOKEN}` }
      });
      if (!res.ok) { if (page === 0) return 0; break; }
      const members = await res.json();
      count += members.filter(m => (m.roles || []).includes(roleId)).length;
      if (members.length < 1000) break;
      after = members[members.length - 1].user.id;
    }
  } catch (err) {
    console.error('Fehler beim Zählen der Rollen-Mitglieder:', err);
  }
  return count;
}

async function syncStatsChannelsNow(guildId, statsData) {
  if (!BOT_TOKEN || !statsData?.enabled) return statsData;
  const channels = Array.isArray(statsData.channels) ? statsData.channels : [];
  const pending = channels.filter(ch => !ch.channelId && ch.categoryId && ch.channelName && ch.statType);
  if (pending.length === 0) return statsData;

  const [{ members, bots }, rolesCount, boostsCount] = await Promise.all([
    getMemberAndBotCounts(guildId),
    getGuildRolesCount(guildId),
    getGuildBoostsCount(guildId)
  ]);

  for (const entry of pending) {
    let count = 0;
    switch (entry.statType) {
      case 'members': count = members; break;
      case 'bots': count = bots; break;
      case 'roles': count = rolesCount; break;
      case 'boosts': count = boostsCount; break;
      case 'role_count':
        count = entry.roleId ? await countGuildMembersWithRole(guildId, entry.roleId) : 0;
        break;
      default: continue;
    }

    const channelName = entry.channelName.replace('{stat}', String(count)).slice(0, 100);

    try {
      const createRes = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${BOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: channelName,
          type: 2,
          parent_id: entry.categoryId,
          permission_overwrites: [
            { id: guildId, type: 0, deny: '1048576' },
            ...(CLIENT_ID ? [{ id: CLIENT_ID, type: 1, allow: '1048576' }] : [])
          ]
        })
      });
      const created = await createRes.json();
      if (createRes.ok) {
        entry.channelId = created.id;
        console.log(`✅ Statistik-Kanal sofort erstellt: ${channelName} (${created.id})`);
      } else {
        console.warn('⚠️ Statistik-Kanal konnte nicht sofort erstellt werden:', created);
      }
    } catch (err) {
      console.error('❌ Fehler beim Sofort-Erstellen des Statistik-Kanals:', err);
    }
  }

  return { ...statsData, channels };
}

app.post('/api/guild/:guildId/config/:module', requireAuth, async (req, res) => {
  const { guildId, module } = req.params;
  if (!ALLOWED_MODULES.includes(module)) {
    return res.status(400).json({ error: 'unknown_module' });
  }
  try {
    let moduleData = req.body;
    if (module === 'stats') {
      moduleData = await syncStatsChannelsNow(guildId, moduleData);
    }
    await saveModuleConfig(guildId, module, moduleData);
    res.json({ success: true, data: moduleData });
  } catch (err) {
    console.error('Fehler beim Speichern der Konfiguration:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ============================================================
// API: ROLES & CHANNELS
// ============================================================
app.get('/api/guild/:guildId/roles', requireAuth, async (req, res) => {
  try {
    const rolesRes = await fetch(`${DISCORD_API}/guilds/${req.params.guildId}/roles`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!rolesRes.ok) return res.status(rolesRes.status).json({ error: 'discord_api_error' });
    const roles = await rolesRes.json();
    const result = roles.filter(r => r.name !== '@everyone' && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.color }));
    res.json(result);
  } catch (err) {
    console.error('API /roles Fehler:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/guild/:guildId/channels', requireAuth, async (req, res) => {
  try {
    const channelsRes = await fetch(`${DISCORD_API}/guilds/${req.params.guildId}/channels`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!channelsRes.ok) return res.status(channelsRes.status).json({ error: 'discord_api_error' });
    const channels = await channelsRes.json();
    const result = channels.filter(c => [0, 2, 4].includes(c.type))
      .sort((a, b) => a.position - b.position)
      .map(c => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id || null }));
    res.json(result);
  } catch (err) {
    console.error('API /channels Fehler:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// ============================================================
// API: USER INFO
// ============================================================
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// ============================================================
// TEST ROUTE
// ============================================================
app.get('/api/test', (req, res) => {
  res.json({ status: '✅ Server läuft!', time: new Date().toISOString() });
});

// ============================================================
// HELPER: Bild als Base64 erkennen
// ============================================================
function isBase64Image(str) {
  return str && str.startsWith('data:image');
}

function getMimeTypeFromBase64(base64) {
  const match = base64.match(/^data:image\/(\w+);/);
  return match ? match[1] : 'png';
}

function stripBase64Header(base64) {
  return base64.replace(/^data:image\/\w+;base64,/, '');
}

// ============================================================
// TICKET-PANEL SENDEN
// ============================================================
app.post('/api/guild/:guildId/tickets/send-panel', requireAuth, async (req, res) => {
  const { guildId } = req.params;
  const { panelIndex, channelId } = req.body;

  console.log('📤 Sende Panel:', { guildId, panelIndex, channelId });

  if (panelIndex === undefined || panelIndex === null || !channelId) {
    return res.status(400).json({ error: 'panelIndex und channelId sind erforderlich.' });
  }

  try {
    const config = await getGuildConfig(guildId);
    const tickets = config.tickets || {};
    const panels = tickets.options || [];

    if (panelIndex < 0 || panelIndex >= panels.length) {
      return res.status(404).json({ error: `Panel mit Index ${panelIndex} nicht gefunden.` });
    }

    const panel = panels[panelIndex];
    if (!panel) {
      return res.status(404).json({ error: 'Panel-Daten ungültig.' });
    }

    const linkedOptions = panel.options || [];
    if (linkedOptions.length === 0) {
      return res.status(400).json({
        error: '⚠️ Dieses Panel hat keine verlinkten Kategorien!',
        hint: 'Füge im Dashboard unter "Optionen" mindestens eine Kategorie hinzu.'
      });
    }

    console.log('📋 Verlinkte Kategorien:', linkedOptions);

    const embed = {
      title: panel.title || 'Support Center',
      description: panel.description || 'Wähle eine Kategorie, um ein Ticket zu öffnen.',
      color: parseInt(panel.color ? panel.color.replace('#', '') : 'ffffff', 16),
      timestamp: new Date().toISOString()
    };

    let files = [];
    let imageUrl = panel.image || '';
    if (imageUrl && isBase64Image(imageUrl)) {
      const mimeType = getMimeTypeFromBase64(imageUrl);
      const base64Data = stripBase64Header(imageUrl);
      const buffer = Buffer.from(base64Data, 'base64');
      files.push({
        name: `panel_image.${mimeType}`,
        data: buffer
      });
      embed.image = { url: `attachment://panel_image.${mimeType}` };
    } else if (imageUrl && imageUrl.startsWith('http')) {
      embed.image = { url: imageUrl };
    }

    const selectOptions = linkedOptions.map(opt => {
      const option = {
        label: opt.label || 'Unbenannt',
        value: opt.categoryId || 'no_category',
        description: `Ticket in ${opt.label || 'dieser Kategorie'} öffnen`
      };
      if (opt.emoji) {
        option.emoji = { name: opt.emoji };
      }
      return option;
    });

    const components = [{
      type: 1,
      components: [{
        type: 3,
        custom_id: `ticket_select_${panelIndex}_${guildId}`,
        placeholder: 'Wähle eine Kategorie aus...',
        options: selectOptions
      }]
    }];

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      console.error('❌ BOT_TOKEN fehlt in .env!');
      return res.status(500).json({ error: 'BOT_TOKEN nicht konfiguriert.' });
    }

    const payload = {
      embeds: [embed],
      components: components
    };

    let response;
    if (files.length > 0) {
      const formData = new FormData();
      formData.append('payload_json', JSON.stringify(payload));
      files.forEach(f => {
        formData.append('files[0]', new Blob([f.data]), f.name);
      });

      response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${botToken}`
        },
        body: formData
      });
    } else {
      response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${botToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    }

    const responseData = await response.json();

    if (!response.ok) {
      console.error('❌ Discord API Fehler:', response.status, responseData);
      return res.status(response.status).json({
        error: `Discord Fehler (${response.status}): ${responseData.message || 'Unbekannt'}`,
        details: responseData
      });
    }

    console.log('✅ Panel gesendet, Nachricht-ID:', responseData.id);
    res.json({ 
      success: true, 
      message: 'Panel wurde erfolgreich gesendet!', 
      data: responseData 
    });

  } catch (err) {
    console.error('❌ Fehler beim Senden des Panels:', err);
    res.status(500).json({ error: 'Interner Serverfehler: ' + err.message });
  }
});

// ============================================================
// VERIFICATION PANEL SENDEN
// ============================================================
app.post('/api/guild/:guildId/verification/send-panel', requireAuth, async (req, res) => {
  const { guildId } = req.params;
  const { 
    channelId, 
    method, 
    roleId,
    title,
    description,
    color,
    image,
    buttonLabel
  } = req.body;

  console.log('📤 Empfangene Farbdaten:', { color, raw: req.body });

  if (!channelId || !method || !roleId) {
    return res.status(400).json({ error: 'channelId, method und roleId sind erforderlich.' });
  }

  try {
    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      return res.status(500).json({ error: 'BOT_TOKEN nicht konfiguriert.' });
    }

    let parsedColor = 0x5865f2;
    if (color) {
      let hex = color.replace(/[^0-9a-fA-F]/g, '');
      if (hex.length === 3) {
        hex = hex.split('').map(c => c + c).join('');
      }
      if (hex.length === 6) {
        parsedColor = parseInt(hex, 16);
        console.log('✅ Geparste Farbe (dezimal):', parsedColor, '| Hex:', '#' + hex);
      } else {
        console.warn('⚠️ Ungültige Farbe – Länge:', hex.length, 'Verwende Standard (Discord-Blau)');
      }
    }

    const embed = {
      title: title || '🔐 Verifizierung',
      description: description || (method === 'button'
        ? 'Klicke auf den Button, um dich zu verifizieren.'
        : 'Beantworte die folgende Aufgabe, um dich zu verifizieren.'),
      color: parsedColor
    };

    let files = [];
    let imageUrl = image || '';
    if (imageUrl && isBase64Image(imageUrl)) {
      const mimeType = getMimeTypeFromBase64(imageUrl);
      const base64Data = stripBase64Header(imageUrl);
      const buffer = Buffer.from(base64Data, 'base64');
      files.push({
        name: `verification_image.${mimeType}`,
        data: buffer
      });
      embed.image = { url: `attachment://verification_image.${mimeType}` };
    } else if (imageUrl && imageUrl.startsWith('http')) {
      embed.image = { url: imageUrl };
    }

    let components = [];
    const label = buttonLabel || (method === 'button' ? 'Verifizieren' : 'Aufgabe lösen');
    if (method === 'button') {
      components = [{
        type: 1,
        components: [{
          type: 2,
          label: label,
          style: 1,
          custom_id: `verify_button_${guildId}_${roleId}`
        }]
      }];
    } else if (method === 'math') {
      components = [{
        type: 1,
        components: [{
          type: 2,
          label: label,
          style: 1,
          custom_id: `verify_math_${guildId}_${roleId}`
        }]
      }];
    } else {
      return res.status(400).json({ error: 'Ungültige Methode.' });
    }

    const payload = {
      embeds: [embed],
      components: components
    };

    let response;
    if (files.length > 0) {
      const formData = new FormData();
      formData.append('payload_json', JSON.stringify(payload));
      files.forEach(f => {
        formData.append('files[0]', new Blob([f.data]), f.name);
      });

      response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${botToken}`
        },
        body: formData
      });
    } else {
      response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${botToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    }

    const data = await response.json();
    if (!response.ok) {
      console.error('❌ Discord API Fehler:', response.status, data);
      return res.status(response.status).json({ error: `Discord Fehler: ${data.message || 'Unbekannt'}` });
    }

    console.log('✅ Verifizierungs-Panel gesendet!');
    res.json({ success: true, message: 'Verifizierungs-Panel gesendet!', data });
  } catch (err) {
    console.error('❌ Fehler beim Senden des Verifizierungs-Panels:', err);
    res.status(500).json({ error: 'Interner Serverfehler: ' + err.message });
  }
});

// ============================================================
// REACTION ROLES: NACHRICHT SENDEN
// ============================================================
function formatEmojiForApi(raw) {
  const customMatch = raw.match(/^<a?:(\w+):(\d+)>$/);
  if (customMatch) {
    return `${customMatch[1]}:${customMatch[2]}`;
  }
  return raw;
}

app.post('/api/guild/:guildId/reactionroles/send-panel', requireAuth, async (req, res) => {
  const { guildId } = req.params;
  const { panelIndex } = req.body;

  if (panelIndex === undefined || panelIndex === null) {
    return res.status(400).json({ error: 'panelIndex ist erforderlich.' });
  }

  try {
    const config = await getGuildConfig(guildId);
    const reactionroles = config.reactionroles || {};
    const panels = reactionroles.panels || [];

    if (panelIndex < 0 || panelIndex >= panels.length) {
      return res.status(404).json({ error: `Nachricht mit Index ${panelIndex} nicht gefunden.` });
    }

    const panel = panels[panelIndex];
    if (!panel || !panel.channelId) {
      return res.status(400).json({ error: 'Kein Kanal für diese Nachricht ausgewählt.' });
    }

    const mappings = (panel.mappings || []).filter(m => m.emoji && m.roleId);
    if (mappings.length === 0) {
      return res.status(400).json({ error: 'Diese Nachricht hat keine Emoji-Rollen-Zuordnungen.' });
    }

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      return res.status(500).json({ error: 'BOT_TOKEN nicht konfiguriert.' });
    }

    let parsedColor = 0xffffff;
    if (panel.color) {
      let hex = panel.color.replace(/[^0-9a-fA-F]/g, '');
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
      if (hex.length === 6) parsedColor = parseInt(hex, 16);
    }

    const embed = {
      title: panel.title || '🎭 Reaction Roles',
      description: panel.description || 'Reagiere mit einem Emoji, um eine Rolle zu erhalten!',
      color: parsedColor
    };
    if (panel.image && panel.image.startsWith('http')) {
      embed.image = { url: panel.image };
    }

    const messageRes = await fetch(`https://discord.com/api/v10/channels/${panel.channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ embeds: [embed] })
    });
    const messageData = await messageRes.json();

    if (!messageRes.ok) {
      console.error('❌ Discord API Fehler (Reaction Roles):', messageRes.status, messageData);
      return res.status(messageRes.status).json({ error: `Discord Fehler: ${messageData.message || 'Unbekannt'}` });
    }

    for (const mapping of mappings) {
      const encodedEmoji = encodeURIComponent(formatEmojiForApi(mapping.emoji));
      try {
        const reactionRes = await fetch(
          `https://discord.com/api/v10/channels/${panel.channelId}/messages/${messageData.id}/reactions/${encodedEmoji}/@me`,
          { method: 'PUT', headers: { 'Authorization': `Bot ${botToken}` } }
        );
        if (!reactionRes.ok) {
          console.warn('⚠️ Reaktion konnte nicht hinzugefügt werden:', mapping.emoji, reactionRes.status);
        }
      } catch (err) {
        console.error('⚠️ Fehler beim Hinzufügen der Reaktion:', mapping.emoji, err);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    panels[panelIndex] = { ...panel, messageId: messageData.id };
    reactionroles.panels = panels;
    await saveModuleConfig(guildId, 'reactionroles', reactionroles);

    res.json({ success: true, messageId: messageData.id });
  } catch (err) {
    console.error('❌ Fehler beim Senden der Reaction-Role Nachricht:', err);
    res.status(500).json({ error: 'Interner Serverfehler: ' + err.message });
  }
});

// ============================================================
// 🆕 BEWERBUNGEN: Panel-Nachricht (mit Bewerben-Button) senden
// ============================================================
app.post('/api/guild/:guildId/applications/send-panel', requireAuth, async (req, res) => {
  const { guildId } = req.params;
  const { formId } = req.body;

  if (!formId) {
    return res.status(400).json({ error: 'formId ist erforderlich.' });
  }

  try {
    const config = await getGuildConfig(guildId);
    const applications = config.applications || {};
    const forms = applications.forms || [];
    const formIndex = forms.findIndex(f => f.id === formId);

    if (formIndex === -1) {
      return res.status(404).json({ error: 'Bewerbung nicht gefunden.' });
    }

    const form = forms[formIndex];
    if (!form.panelChannelId) {
      return res.status(400).json({ error: 'Kein Kanal für diese Bewerbung ausgewählt.' });
    }

    const questions = (form.questions || []).filter(q => q && q.trim());
    if (questions.length === 0) {
      return res.status(400).json({ error: 'Bitte füge mindestens eine Frage hinzu.' });
    }

    const botToken = process.env.BOT_TOKEN;
    if (!botToken) {
      return res.status(500).json({ error: 'BOT_TOKEN nicht konfiguriert.' });
    }

    let parsedColor = 0x2b2d31;
    if (form.color) {
      let hex = form.color.replace(/[^0-9a-fA-F]/g, '');
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
      if (hex.length === 6) parsedColor = parseInt(hex, 16);
    }

    const embed = {
      title: form.title || form.name || 'Bewerbung',
      description: form.description || 'Klicke auf den Button, um dich zu bewerben. Der Ablauf läuft über Direktnachrichten.',
      color: parsedColor
    };

    const components = [{
      type: 1,
      components: [{
        type: 2,
        style: 1,
        label: (form.buttonLabel || 'Bewerben').slice(0, 80),
        custom_id: `apply_start_${form.id}`
      }]
    }];

    const messageRes = await fetch(`https://discord.com/api/v10/channels/${form.panelChannelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ embeds: [embed], components })
    });
    const messageData = await messageRes.json();

    if (!messageRes.ok) {
      console.error('❌ Discord API Fehler (Bewerbungen):', messageRes.status, messageData);
      return res.status(messageRes.status).json({ error: `Discord Fehler: ${messageData.message || 'Unbekannt'}` });
    }

    forms[formIndex] = { ...form, messageId: messageData.id };
    applications.forms = forms;
    await saveModuleConfig(guildId, 'applications', applications);

    res.json({ success: true, messageId: messageData.id });
  } catch (err) {
    console.error('❌ Fehler beim Senden der Bewerbungs-Nachricht:', err);
    res.status(500).json({ error: 'Interner Serverfehler: ' + err.message });
  }
});

// ============================================================
// 🆕 BOT CONTROL: Nachricht senden (mit Action-Buttons)
// ============================================================
app.post('/api/guild/:guildId/bot/send', requireAuth, requireGuildAdmin, async (req, res) => {
  const { guildId } = req.params;
  const { channelId, content, embeds, components } = req.body;

  if (!channelId) {
    return res.status(400).json({ error: 'channelId ist erforderlich' });
  }

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ error: 'BOT_TOKEN nicht konfiguriert' });
  }

  const botGuilds = await getBotGuildIds();
  if (!botGuilds.has(guildId)) {
    return res.status(403).json({ error: 'Bot ist nicht auf diesem Server' });
  }

  let processedComponents = components;
  if (components && Array.isArray(components) && components.length > 0) {
    for (const row of components) {
      if (row.type === 1 && row.components) {
        for (const btn of row.components) {
          if (btn.type === 2 && btn.action) {
            const action = btn.action;
            const id = crypto.randomBytes(8).toString('hex');
            if (ButtonAction) {
              try {
                await ButtonAction.create({
                  id,
                  guildId,
                  action: {
                    type: action.type,
                    roleId: action.roleId || null,
                    channelId: action.channelId || null,
                    message: action.message || null
                  }
                });
              } catch (err) {
                console.error('Fehler beim Speichern der Button-Action:', err);
                return res.status(500).json({ error: 'Fehler beim Speichern der Aktion' });
              }
            } else {
              return res.status(500).json({ error: 'Datenbank nicht verfügbar für Button-Actions' });
            }
            btn.custom_id = `act_${id}`;
            delete btn.action;
          }
        }
      }
    }
  }

  const payload = {};
  if (content && content.trim()) payload.content = content;
  if (embeds && Array.isArray(embeds) && embeds.length > 0) payload.embeds = embeds;
  if (processedComponents && processedComponents.length > 0) payload.components = processedComponents;

  try {
    const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Discord API Fehler beim Senden:', response.status, data);
      return res.status(response.status).json({ error: `Discord Fehler: ${data.message || 'Unbekannt'}` });
    }
    res.json({ success: true, message: data });
  } catch (err) {
    console.error('Fehler beim Senden der Bot-Nachricht:', err);
    res.status(500).json({ error: 'Interner Serverfehler: ' + err.message });
  }
});

// ============================================================
// 🆕 BOT CONTROL: Nachricht bearbeiten
// ============================================================
app.post('/api/guild/:guildId/bot/edit', requireAuth, requireGuildAdmin, async (req, res) => {
  const { guildId } = req.params;
  const { channelId, messageId, content, embeds, components } = req.body;

  if (!channelId || !messageId) {
    return res.status(400).json({ error: 'channelId und messageId sind erforderlich' });
  }

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ error: 'BOT_TOKEN nicht konfiguriert' });
  }

  const botGuilds = await getBotGuildIds();
  if (!botGuilds.has(guildId)) {
    return res.status(403).json({ error: 'Bot ist nicht auf diesem Server' });
  }

  const payload = {};
  if (content !== undefined) payload.content = content;
  if (embeds && Array.isArray(embeds)) payload.embeds = embeds;
  if (components && Array.isArray(components)) payload.components = components;

  try {
    const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bot ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Discord API Fehler beim Bearbeiten:', response.status, data);
      return res.status(response.status).json({ error: `Discord Fehler: ${data.message || 'Unbekannt'}` });
    }
    res.json({ success: true, message: data });
  } catch (err) {
    console.error('Fehler beim Bearbeiten der Bot-Nachricht:', err);
    res.status(500).json({ error: 'Interner Serverfehler: ' + err.message });
  }
});

// ============================================================
// 🆕 BOT CONTROL: Nachrichtenliste abrufen
// ============================================================
app.get('/api/guild/:guildId/bot/messages', requireAuth, requireGuildAdmin, async (req, res) => {
  const { guildId } = req.params;
  const { channelId, limit = 20 } = req.query;

  if (!channelId) {
    return res.status(400).json({ error: 'channelId ist erforderlich' });
  }

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ error: 'BOT_TOKEN nicht konfiguriert' });
  }

  const botGuilds = await getBotGuildIds();
  if (!botGuilds.has(guildId)) {
    return res.status(403).json({ error: 'Bot ist nicht auf diesem Server' });
  }

  try {
    const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages?limit=${Math.min(parseInt(limit) || 20, 50)}`, {
      headers: { 'Authorization': `Bot ${botToken}` }
    });
    if (!response.ok) {
      const errData = await response.json();
      return res.status(response.status).json({ error: `Discord Fehler: ${errData.message || 'Unbekannt'}` });
    }
    const messages = await response.json();
    const botId = process.env.CLIENT_ID || (await fetch(`${DISCORD_API}/users/@me`, { headers: { 'Authorization': `Bot ${botToken}` } }).then(r => r.json()).then(u => u.id));
    const filtered = messages.filter(m => m.author.id === botId);
    res.json(filtered);
  } catch (err) {
    console.error('Fehler beim Abrufen der Nachrichten:', err);
    res.status(500).json({ error: 'Interner Serverfehler: ' + err.message });
  }
});

// ============================================================
// EXPORT
// ============================================================
module.exports = app;

if (NODE_ENV !== 'production') {
  connectToDatabase().then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Apex Dashboard läuft auf http://localhost:${PORT}`);
    });
  }).catch(err => {
    console.error('❌ Fehler:', err);
  });
}
