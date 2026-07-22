require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/discord_bot')
  .then(() => console.log('[DB] MongoDB verknüpft.'))
  .catch((err) => console.error('[DB Fehler]', err));

// MongoDB Guild Config Schema
const guildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  welcome: {
    enabled: { type: Boolean, default: false },
    channelId: { type: String, default: '' },
    message: { type: String, default: 'Willkommen auf dem Server, {user}!' },
    embedColor: { type: String, default: '#5865F2' },
    imageUrl: { type: String, default: '' }
  },
  verification: {
    enabled: { type: Boolean, default: false },
    roleId: { type: String, default: '' },
    channelId: { type: String, default: '' }
  },
  antinuke: {
    enabled: { type: Boolean, default: false },
    maxDeletes: { type: Number, default: 5 }
  }
}, { timestamps: true });

const GuildConfig = mongoose.model('GuildConfig', guildConfigSchema);

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Cookie Session (Fix: secure in production only)
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'supersecretkey_change_me_in_prod'],
  maxAge: 24 * 60 * 60 * 1000, // 24 Stunden
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax'
}));

const DISCORD_API = 'https://discord.com/api/v10';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback';
const ADMINISTRATOR = 0x8;

// Auth Middleware
function requireAuth(req, res, next) {
  if (!req.session || !req.session.accessToken) {
    return res.status(401).json({ error: 'unauthorized', message: 'Nicht angemeldet.' });
  }
  next();
}

// Guild Admin Middleware (Fix: IDOR / Broken Access Control)
async function requireGuildAdmin(req, res, next) {
  const { guildId } = req.params;
  if (!guildId) return res.status(400).json({ error: 'missing_guild_id' });

  try {
    const userGuildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${req.session.accessToken}` }
    });

    if (!userGuildsRes.ok) {
      if (userGuildsRes.status === 401) {
        req.session = null;
        return res.status(401).json({ error: 'token_expired', message: 'Sitzung abgelaufen.' });
      }
      return res.status(500).json({ error: 'discord_api_error' });
    }

    const userGuilds = await userGuildsRes.json();
    const targetGuild = userGuilds.find((g) => g.id === guildId);

    if (!targetGuild) {
      return res.status(403).json({ error: 'forbidden', message: 'Keine Rechte für diesen Server.' });
    }

    const perms = BigInt(targetGuild.permissions);
    const isAdmin = targetGuild.owner || (perms & BigInt(ADMINISTRATOR)) === BigInt(ADMINISTRATOR);

    if (!isAdmin) {
      return res.status(403).json({ error: 'forbidden', message: 'Administrator-Berechtigung erforderlich.' });
    }

    req.targetGuild = targetGuild;
    next();
  } catch (err) {
    console.error('[Admin Check Error]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
}

// Auth Routes
app.get('/auth/discord/login', (req, res) => {
  // Fix: CSRF State Protection
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const scope = encodeURIComponent('identify guilds');
  const discordUrl = `${DISCORD_API}/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}&state=${state}`;
  res.redirect(discordUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;

  // Fix: Validate CSRF State
  if (!state || state !== req.session.oauthState) {
    return res.status(400).send('Ungültiger State-Parameter (CSRF-Schutz ausgelöst).');
  }
  delete req.session.oauthState;

  if (!code) return res.status(400).send('Kein Authorisierungscode übergeben.');

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

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return res.status(400).json({ error: 'token_exchange_failed', details: tokenData });
    }

    req.session.accessToken = tokenData.access_token;

    // Fetch user info
    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userRes.json();
    req.session.user = userData;

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('[OAuth Callback Error]', err);
    res.status(500).send('Fehler bei der Discord-Authentifizierung.');
  }
});

app.get('/auth/discord/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// API Endpoints
app.get('/api/user', requireAuth, (req, res) => {
  res.json(req.session.user);
});

app.get('/api/user/guilds', requireAuth, async (req, res) => {
  try {
    const response = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${req.session.accessToken}` }
    });

    if (!response.ok) return res.status(401).json({ error: 'unauthorized' });

    const guilds = await response.json();
    // Filtere Server, auf denen der User Admin/Owner ist
    const adminGuilds = guilds.filter((g) => {
      const perms = BigInt(g.permissions);
      return g.owner || (perms & BigInt(ADMINISTRATOR)) === BigInt(ADMINISTRATOR);
    });

    res.json(adminGuilds);
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// Guild Config Endpoints (Gesichert mit requireGuildAdmin)
app.get('/api/guild/:guildId/config', requireAuth, requireGuildAdmin, async (req, res) => {
  try {
    let config = await GuildConfig.findOne({ guildId: req.params.guildId });
    if (!config) {
      config = await GuildConfig.create({ guildId: req.params.guildId });
    }
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'database_error' });
  }
});

app.post('/api/guild/:guildId/config', requireAuth, requireGuildAdmin, async (req, res) => {
  try {
    const allowedUpdates = {};
    if (req.body.welcome) allowedUpdates.welcome = req.body.welcome;
    if (req.body.verification) allowedUpdates.verification = req.body.verification;
    if (req.body.antinuke) allowedUpdates.antinuke = req.body.antinuke;

    const updated = await GuildConfig.findOneAndUpdate(
      { guildId: req.params.guildId },
      { $set: allowedUpdates },
      { new: true, upsert: true }
    );
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ error: 'database_error' });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Dashboard läuft auf http://localhost:${PORT}`);
});
