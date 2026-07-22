require('dotenv').config(); //[cite: 2]
const express = require('express'); //[cite: 2]
const cookieSession = require('cookie-session'); //[cite: 2]
const path = require('path'); //[cite: 2]
const fs = require('fs'); //[cite: 2]

const {
  CLIENT_ID,
  CLIENT_SECRET,
  BOT_TOKEN,
  REDIRECT_URI,
  SESSION_SECRET,
  PORT = 3000
} = process.env; //[cite: 2]

const DISCORD_API = 'https://discord.com/api/v10'; //[cite: 2]
const ADMINISTRATOR = 0x8n; //[cite: 2]
// Vercel erlaubt Schreibzugriff NUR im /tmp-Ordner!
const CONFIG_FILE = process.env.VERCEL ? '/tmp/guild_configs.json' : path.join(__dirname, 'guild_configs.json'); //[cite: 2]

const app = express(); //[cite: 2]

app.set('trust proxy', 1); //[cite: 2]
app.use(express.static(__dirname)); //[cite: 2]
app.use(express.json()); //[cite: 2]

app.use(
  cookieSession({
    name: 'apex_session',
    keys: [SESSION_SECRET || 'apex-secret-key-12345'],
    maxAge: 24 * 60 * 60 * 1000,
    secure: true,
    sameSite: 'lax',
    httpOnly: true
  })
); //[cite: 2]

// Hilfsfunktionen für Config-Datenbank
function getConfigs() {
  if (!fs.existsSync(CONFIG_FILE)) return {}; //[cite: 2]
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); //[cite: 2]
  } catch (e) {
    return {}; //[cite: 2]
  }
}

function saveConfigs(data) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8'); //[cite: 2]
  } catch (e) {
    console.error('Fehler beim Speichern der Config:', e);
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html')); //[cite: 2]
});

// OAuth2 Login
app.get('/auth/discord/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
    prompt: 'consent'
  }); //[cite: 2]
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`); //[cite: 2]
});

// OAuth2 Callback
app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query; //[cite: 2]
  if (!code) return res.redirect('/?error=missing_code'); //[cite: 2]

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
    }); //[cite: 2]

    if (!tokenRes.ok) return res.redirect('/?error=auth_failed'); //[cite: 2]
    const tokenData = await tokenRes.json(); //[cite: 2]

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    }); //[cite: 2]
    if (!userRes.ok) return res.redirect('/?error=auth_failed'); //[cite: 2]
    const user = await userRes.json(); //[cite: 2]

    req.session.accessToken = tokenData.access_token; //[cite: 2]
    req.session.user = { id: user.id, username: user.username, avatar: user.avatar }; //[cite: 2]

    res.redirect('/dashboard.html'); //[cite: 2]
  } catch (err) {
    console.error('Fehler im OAuth-Callback:', err); //[cite: 2]
    res.redirect('/?error=auth_failed'); //[cite: 2]
  }
});

// Logout
app.get('/auth/logout', (req, res) => {
  req.session = null; //[cite: 2]
  res.redirect('/'); //[cite: 2]
});

function requireAuth(req, res, next) {
  if (!req.session || !req.session.accessToken) {
    return res.status(401).json({ error: 'not_authenticated' }); //[cite: 2]
  }
  next(); //[cite: 2]
}

// API: Server-Liste
app.get('/api/guilds', requireAuth, async (req, res) => {
  try {
    const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${req.session.accessToken}` }
    }); //[cite: 2]

    if (guildsRes.status === 401) {
      req.session = null; //[cite: 2]
      return res.status(401).json({ error: 'session_expired' }); //[cite: 2]
    }
    if (!guildsRes.ok) return res.status(502).json({ error: 'discord_api_error' }); //[cite: 2]

    const guilds = await guildsRes.json(); //[cite: 2]
    const adminGuilds = guilds.filter((g) => {
      const perms = BigInt(g.permissions ?? 0);
      return g.owner === true || (perms & ADMINISTRATOR) === ADMINISTRATOR;
    }); //[cite: 2]

    const result = adminGuilds.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
      botIstDrauf: true
    })); //[cite: 2]

    res.json({ user: req.session.user, guilds: result, clientId: CLIENT_ID }); //[cite: 2]
  } catch (err) {
    res.status(500).json({ error: 'server_error' }); //[cite: 2]
  }
});

// API Config abrufen
app.get('/api/guild/:guildId/config', requireAuth, (req, res) => {
  const configs = getConfigs();
  res.json(configs[req.params.guildId] || {});
});

// API Config speichern
app.post('/api/guild/:guildId/config/:module', requireAuth, (req, res) => {
  const { guildId, module } = req.params;
  const configs = getConfigs();
  if (!configs[guildId]) configs[guildId] = {};
  configs[guildId][module] = req.body;
  saveConfigs(configs);
  res.json({ success: true });
});

// WICHTIG FÜR VERCEL SERVERLESS: Exportieren statt app.listen!
module.exports = app; //[cite: 2]

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Lokal gestartet auf http://localhost:${PORT}`);
  });
}
