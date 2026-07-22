require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

// Liest deine Vercel Environment Variables (unterstützt beide Schreibweisen)
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || process.env.DISCORD_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'fallback_secret_key';

const DISCORD_API = 'https://discord.com/api/v10';

// Express Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// 1. Login Route
app.get('/auth/discord/login', (req, res) => {
  if (!CLIENT_ID) {
    return res.status(500).json({ error: "CLIENT_ID ist nicht konfiguriert!" });
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const scope = encodeURIComponent('identify guilds');
  const discordUrl = `${DISCORD_API}/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scope}&state=${state}`;

  res.redirect(discordUrl);
});

// 2. Callback Route (Verarbeitung nach Discord-Login)
app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || state !== req.session.oauthState) {
    return res.status(400).send('Ungültiger Status oder abgebrochene Autorisierung.');
  }

  try {
    // Token-Anfrage an Discord
    const tokenResponse = await axios.post(`${DISCORD_API}/oauth2/token`, new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const accessToken = tokenResponse.data.access_token;

    // Benutzerdaten von Discord abrufen
    const userResponse = await axios.get(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    req.session.user = userResponse.data;
    res.redirect('/dashboard');
  } catch (error) {
    console.error('OAuth2 Error:', error.response?.data || error.message);
    res.status(500).send('Fehler beim Anmelden über Discord.');
  }
});

// 3. Dashboard Route
app.get('/dashboard', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/auth/discord/login');
  }
  res.send(`<h1>Willkommen auf dem Dashboard, ${req.session.user.username}!</h1>`);
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Server Starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
