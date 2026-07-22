require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');

const app = express();

// -------------------------------------------------------------
// 1. UMWELTVARIABLEN NORMALIEN (Vercel & Lokale Kompatibilität)
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || process.env.DISCORD_REDIRECT_URI;
const MONGODB_URI = process.env.MONGODB_URI;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET || 'apex_bot_secret_key_12345';

const DISCORD_API = 'https://discord.com/api/v10';

// -------------------------------------------------------------
// 2. MONGODB VERBINDUNG & SCHEMA DEFINITION
// -------------------------------------------------------------
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Verbindung zu MongoDB hergestellt.'))
    .catch(err => console.error('❌ MongoDB Verbindungsfehler:', err));
} else {
  console.warn('⚠️ MONGODB_URI ist nicht definiert! Datenbank-Features deaktiviert.');
}

// Schema für Bot-Einstellungen pro Server (Guild)
const GuildConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  prefix: { type: String, default: '!' },
  welcomeChannelId: { type: String, default: '' },
  welcomeMessage: { type: String, default: 'Willkommen auf dem Server!' },
  autoRole: { type: String, default: '' },
  logsChannelId: { type: String, default: '' }
}, { timestamps: true });

const GuildConfig = mongoose.models.GuildConfig || mongoose.model('GuildConfig', GuildConfigSchema);

// -------------------------------------------------------------
// 3. MIDDLEWARE & SESSION CONFIGURATION (Serverless Ready)
// -------------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Express Session mit MongoDB Store (verhindert Ausloggen auf Vercel)
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MONGODB_URI ? MongoStore.create({
    mongoUrl: MONGODB_URI,
    collectionName: 'sessions',
    ttl: 60 * 60 * 24 * 7 // 7 Tage Speicherdauer
  }) : undefined,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

// Auth-Prüfungs-Middleware
function checkAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.redirect('/auth/discord/login');
}

// -------------------------------------------------------------
// 4. ROUTING & DISCORD OAUTH2
// -------------------------------------------------------------

// Startseite (Haupt-URL /)
app.get('/', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/dashboard');
  }
  res.redirect('/auth/discord/login');
});

// Login Route
app.get('/auth/discord/login', (req, res) => {
  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.status(500).send('Fehler: CLIENT_ID oder REDIRECT_URI fehlt in den Environment Variables.');
  }

  const scope = encodeURIComponent('identify guilds');
  const discordUrl = `${DISCORD_API}/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}`;
  
  res.redirect(discordUrl);
});

// Callback Route (Serverless-kompatibel ohne flüchtige CSRF-State-Vergleiche)
app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Fehler: Kein Authorisierungscode von Discord erhalten.');
  }

  try {
    // Token von Discord anfordern
    const tokenResponse = await axios.post(`${DISCORD_API}/oauth2/token`, new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token, token_type } = tokenResponse.data;

    // Benutzerprofil abrufen
    const userResponse = await axios.get(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `${token_type} ${access_token}` }
    });

    // Server-Liste des Users abrufen
    const guildsResponse = await axios.get(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `${token_type} ${access_token}` }
    });

    // In Session speichern
    req.session.accessToken = access_token;
    req.session.user = userResponse.data;
    req.session.guilds = guildsResponse.data;

    res.redirect('/dashboard');
  } catch (error) {
    console.error('OAuth2 Fehler:', error.response?.data || error.message);
    res.status(500).send('Fehler bei der Anmeldung über Discord.');
  }
});

// Logout Route
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// -------------------------------------------------------------
// 5. API ROUTES FÜR DASHBOARD & BOT
// -------------------------------------------------------------

// API: Eingeloggter Benutzer
app.get('/api/user', checkAuth, (req, res) => {
  res.json(req.session.user);
});

// API: Serverliste (filtert auf Administrator / Manage Guild)
app.get('/api/guilds', checkAuth, async (req, res) => {
  try {
    const userGuilds = req.session.guilds || [];
    
    // Filter: Administrator (0x8) oder Manage Guild (0x20)
    const adminGuilds = userGuilds.filter(guild => {
      const perms = BigInt(guild.permissions);
      return (perms & BigInt(0x8)) === BigInt(0x8) || (perms & BigInt(0x20)) === BigInt(0x20);
    });

    res.json(adminGuilds);
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Serverliste.' });
  }
});

// API: Einstellungen eines spezifischen Servers laden
app.get('/api/guilds/:guildId/settings', checkAuth, async (req, res) => {
  try {
    const { guildId } = req.params;
    let config = await GuildConfig.findOne({ guildId });

    if (!config) {
      config = await GuildConfig.create({ guildId });
    }

    res.json(config);
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Abrufen der Einstellungen.' });
  }
});

// API: Einstellungen eines spezifischen Servers speichern
app.post('/api/guilds/:guildId/settings', checkAuth, async (req, res) => {
  try {
    const { guildId } = req.params;
    const { prefix, welcomeChannelId, welcomeMessage, autoRole, logsChannelId } = req.body;

    const updatedConfig = await GuildConfig.findOneAndUpdate(
      { guildId },
      { prefix, welcomeChannelId, welcomeMessage, autoRole, logsChannelId },
      { new: true, upsert: true }
    );

    res.json({ success: true, config: updatedConfig });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Speichern der Einstellungen.' });
  }
});

// -------------------------------------------------------------
// 6. DASHBOARD ROUTE
// -------------------------------------------------------------
app.get('/dashboard', checkAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'), (err) => {
    if (err) {
      // Fallback HTML, falls public/dashboard.html (noch) fehlt
      res.send(`
        <!DOCTYPE html>
        <html lang="de">
        <head>
          <meta charset="UTF-8">
          <title>Apex Bot Dashboard</title>
          <style>
            body { font-family: sans-serif; background: #0f172a; color: white; padding: 30px; text-align: center; }
            a { color: #38bdf8; text-decoration: none; font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>Willkommen, ${req.session.user.username}!</h1>
          <p>Du bist erfolgreich über Discord eingeloggt.</p>
          <p><a href="/logout">Abmelden</a></p>
        </body>
        </html>
      `);
    }
  });
});

// -------------------------------------------------------------
// 7. SERVER START / VERCEL EXPORT
// -------------------------------------------------------------
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Apex Dashboard läuft lokal auf http://localhost:${PORT}`);
  });
}

module.exports = app;
