require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const fs = require('fs');

const {
  CLIENT_ID,
  CLIENT_SECRET,
  BOT_TOKEN,
  REDIRECT_URI,
  SESSION_SECRET,
  PORT = 3000
} = process.env;

// Pflicht-Variablen prüfen
['CLIENT_ID', 'CLIENT_SECRET', 'BOT_TOKEN', 'REDIRECT_URI', 'SESSION_SECRET'].forEach((key) => {
  if (!process.env[key]) {
    console.warn(`[WARNUNG] Umgebungsvariable ${key} ist nicht gesetzt (siehe .env.example)`);
  }
});

const DISCORD_API = 'https://discord.com/api/v10';
const ADMINISTRATOR = 0x8n;
const CONFIG_FILE = path.join(__dirname, 'guild_configs.json');

const app = express();

app.set('trust proxy', 1);
app.use(express.static(__dirname));
// Höheres Limit, da Embed-Bilder als Base64-Daten-URLs im JSON-Body mitgeschickt werden
app.use(express.json({ limit: '8mb' }));

app.use(
  cookieSession({
    name: 'apex_session',
    keys: [SESSION_SECRET || 'bitte-in-der-.env-aendern'],
    maxAge: 24 * 60 * 60 * 1000,
    secure: true,
    sameSite: 'lax',
    httpOnly: true
  })
);

// Hilfsfunktionen für Config-Datenbank
function getConfigs() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveConfigs(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Landingpage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// OAuth2 Login
app.get('/auth/discord/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
    prompt: 'consent'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// OAuth2 Callback
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

    if (!tokenRes.ok) return res.redirect('/?error=auth_failed');
    const tokenData = await tokenRes.json();

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userRes.ok) return res.redirect('/?error=auth_failed');
    const user = await userRes.json();

    req.session.accessToken = tokenData.access_token;
    req.session.user = { id: user.id, username: user.username, avatar: user.avatar };

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('Fehler im OAuth-Callback:', err);
    res.redirect('/?error=auth_failed');
  }
});

// Logout
app.get('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// Middleware
function requireAuth(req, res, next) {
  if (!req.session || !req.session.accessToken) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  next();
}

// Bot Guild Cache
let botGuildsCache = { ids: new Set(), fetchedAt: 0 };
const BOT_CACHE_TTL = 60 * 1000;

async function getBotGuildIds() {
  if (Date.now() - botGuildsCache.fetchedAt < BOT_CACHE_TTL) {
    return botGuildsCache.ids;
  }

  const ids = new Set();
  let after = '0';

  while (true) {
    const res = await fetch(`${DISCORD_API}/users/@me/guilds?limit=200&after=${after}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!res.ok) break;
    const page = await res.json();
    page.forEach((g) => ids.add(g.id));
    if (page.length < 200) break;
    after = page[page.length - 1].id;
  }

  botGuildsCache = { ids, fetchedAt: Date.now() };
  return ids;
}

// API: Server-Liste
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
    const adminGuilds = guilds.filter((g) => {
      const perms = BigInt(g.permissions ?? 0);
      return g.owner === true || (perms & ADMINISTRATOR) === ADMINISTRATOR;
    });

    const botGuildIds = await getBotGuildIds();

    const result = adminGuilds
      .map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
        botIstDrauf: botGuildIds.has(g.id)
      }))
      .sort((a, b) => Number(b.botIstDrauf) - Number(a.botIstDrauf) || a.name.localeCompare(b.name));

    res.json({ user: req.session.user, guilds: result, clientId: CLIENT_ID });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// API: Einzelner Server Details
app.get('/api/guild/:guildId', requireAuth, async (req, res) => {
  const { guildId } = req.params;
  try {
    const guildRes = await fetch(`${DISCORD_API}/guilds/${guildId}?with_counts=true`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });

    if (!guildRes.ok) return res.status(guildRes.status).json({ error: 'guild_not_found' });
    const guildData = await guildRes.json();

    res.json({
      members: guildData.approximate_member_count ?? 0,
      boosts: guildData.premium_subscription_count ?? 0
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// Erlaubte Modul-Namen für die generische Config-API
const MODULE_NAMES = [
  'welcome', 'tickets', 'teamliste', 'support',
  'moderation', 'teamupdate', 'stats', 'verification', 'antinuke'
];

// API: Komplette Modul-Konfiguration eines Servers abrufen (für das Dashboard)
app.get('/api/guild/:guildId/config', requireAuth, (req, res) => {
  const configs = getConfigs();
  res.json(configs[req.params.guildId] || {});
});

// API: Einstellungen eines einzelnen Moduls speichern
// z.B. POST /api/guild/123/config/welcome  { join: {...}, leave: {...} }
app.post('/api/guild/:guildId/config/:module', requireAuth, (req, res) => {
  const { guildId, module } = req.params;

  if (!MODULE_NAMES.includes(module)) {
    return res.status(400).json({ error: 'unknown_module' });
  }

  const configs = getConfigs();
  if (!configs[guildId]) configs[guildId] = {};

  configs[guildId][module] = req.body;
  saveConfigs(configs);

  res.json({ success: true });
});

// API: Rollen eines Servers abrufen (für Rollen-Auswahl im Dashboard)
app.get('/api/guild/:guildId/roles', requireAuth, async (req, res) => {
  try {
    const rolesRes = await fetch(`${DISCORD_API}/guilds/${req.params.guildId}/roles`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!rolesRes.ok) return res.status(rolesRes.status).json({ error: 'discord_api_error' });

    const roles = await rolesRes.json();
    const result = roles
      .filter((r) => r.name !== '@everyone' && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.color }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// API: Kanäle eines Servers abrufen (für Kanal-Auswahl im Dashboard)
// type: 0 = Textkanal, 2 = Sprachkanal, 4 = Kategorie
app.get('/api/guild/:guildId/channels', requireAuth, async (req, res) => {
  try {
    const channelsRes = await fetch(`${DISCORD_API}/guilds/${req.params.guildId}/channels`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    if (!channelsRes.ok) return res.status(channelsRes.status).json({ error: 'discord_api_error' });

    const channels = await channelsRes.json();
    const result = channels
      .filter((c) => [0, 2, 4].includes(c.type))
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id || null }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// API: User Info
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Apex Dashboard läuft auf http://localhost:${PORT}`);
  });
}
