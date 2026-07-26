console.log('🔑 BOT_TOKEN vorhanden?', process.env.BOT_TOKEN ? '✅ Ja' : '❌ Nein');
require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const mongoose = require('mongoose');

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

// ===== DEBUG =====
console.log('🔍 Server startet...');
console.log('CLIENT_ID:', CLIENT_ID ? '✅' : '❌');
console.log('MONGODB_URI:', MONGODB_URI ? '✅' : '❌');
console.log('REDIRECT_URI:', REDIRECT_URI);
// =================

const DISCORD_API = 'https://discord.com/api/v10';
const ADMINISTRATOR = 0x8n;
const ALLOWED_MODULES = ['welcome', 'tickets', 'teamliste', 'support', 'automod', 'teamupdate', 'stats', 'verification', 'antinuke', 'minigames', 'rolenicknames'];

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();
app.set('trust proxy', 1);

app.use(express.static(__dirname));
app.use(express.json({ limit: '20mb' })); // Größeres Limit für Base64-Bilder

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
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 60000,
      tls: true,
      retryWrites: true
    }).then(m => m);
  }
  cachedConnection.conn = await cachedConnection.promise;
  return cachedConnection.conn;
}

// Mongo Middleware NUR wenn URI da ist
if (MONGODB_URI) {
  app.use(async (req, res, next) => {
    try {
      await connectToDatabase();
      next();
    } catch (err) {
      console.error('MongoDB Fehler:', err.message);
      next();
    }
  });
} else {
  console.log('⚠️ MongoDB deaktiviert (keine URI)');
}

// ============================================================
// SCHEMA (nur wenn mongoose verfügbar)
// ============================================================
let GuildConfig = null;
try {
  const guildConfigSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} }
  }, { timestamps: true });
  GuildConfig = mongoose.models.GuildConfig || mongoose.model('GuildConfig', guildConfigSchema);
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
// BOT-ANZAHL (zählt Mitglieder mit user.bot === true)
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

app.post('/api/guild/:guildId/config/:module', requireAuth, async (req, res) => {
  const { guildId, module } = req.params;
  if (!ALLOWED_MODULES.includes(module)) {
    return res.status(400).json({ error: 'unknown_module' });
  }
  try {
    await saveModuleConfig(guildId, module, req.body);
    res.json({ success: true });
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
// HELPER: Bild als Base64 erkennen und in Attachment konvertieren
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
// ⭐ TICKET-PANEL SENDEN (MIT EMBED + DROPDOWN + BASE64-BILD)
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

    // Embed erstellen
    const embed = {
      title: panel.title || 'Support Center',
      description: panel.description || 'Wähle eine Kategorie, um ein Ticket zu öffnen.',
      color: parseInt(panel.color ? panel.color.replace('#', '') : 'ffffff', 16),
      timestamp: new Date().toISOString()
    };

    // ========== BILD VERARBEITEN ==========
    let files = [];
    let imageUrl = panel.image || '';
    if (imageUrl && isBase64Image(imageUrl)) {
      // Base64-Bild – als Attachment senden
      const mimeType = getMimeTypeFromBase64(imageUrl);
      const base64Data = stripBase64Header(imageUrl);
      const buffer = Buffer.from(base64Data, 'base64');
      files.push({
        name: `panel_image.${mimeType}`,
        data: buffer
      });
      // Embed verweist auf Attachment
      embed.image = { url: `attachment://panel_image.${mimeType}` };
    } else if (imageUrl && imageUrl.startsWith('http')) {
      // Externe URL – direkt setzen
      embed.image = { url: imageUrl };
    }

    // Select Menu (Dropdown) erstellen
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

    // Body für Discord-API
    const payload = {
      embeds: [embed],
      components: components
    };

    // Falls Dateien vorhanden, als FormData senden
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
      // Normales JSON
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
// VERIFICATION PANEL SENDEN (MIT BASE64-BILD)
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

    // Farbkonvertierung
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

    // Embed
    const embed = {
      title: title || '🔐 Verifizierung',
      description: description || (method === 'button'
        ? 'Klicke auf den Button, um dich zu verifizieren.'
        : 'Beantworte die folgende Aufgabe, um dich zu verifizieren.'),
      color: parsedColor
    };

    // ========== BILD VERARBEITEN ==========
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

    // Button
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
// EXPORT (für Vercel)
// ============================================================
module.exports = app;

// Lokaler Start (nur wenn nicht auf Vercel)
if (NODE_ENV !== 'production') {
  connectToDatabase().then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Apex Dashboard läuft auf http://localhost:${PORT}`);
    });
  }).catch(err => {
    console.error('❌ Fehler:', err);
  });
}
