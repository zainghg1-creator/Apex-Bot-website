require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

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

const app = express();

// Statische Dateien (index.html, dashboard.html etc.) direkt aus dem Hauptordner bereitstellen
app.use(express.static(__dirname));

app.use(
  session({
    secret: SESSION_SECRET || 'bitte-in-der-.env-aendern',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 // 1 Stunde
    }
  })
);

// Explicit Route für die Hauptseite / Landingpage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- Schritt 1: "Dashboard"-Button landet hier und wird zu Discord geschickt ----------
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

// ---------- Schritt 2: Discord schickt den User mit einem "code" hierher zurück ----------
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

    if (!tokenRes.ok) {
      console.error('Token-Tausch fehlgeschlagen:', tokenRes.status, await tokenRes.text());
      return res.redirect('/?error=auth_failed');
    }
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

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

function requireAuth(req, res, next) {
  if (!req.session.accessToken) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  next();
}

let botGuildsCache = { ids: new Set(), fetchedAt: 0 };
const BOT_CACHE_TTL = 60 * 1000; // 60 Sekunden

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
    if (!res.ok) {
      console.error('Bot-Server-Liste konnte nicht geladen werden:', res.status);
      break;
    }
    const page = await res.json();
    page.forEach((g) => ids.add(g.id));
    if (page.length < 200) break;
    after = page[page.length - 1].id;
  }

  botGuildsCache = { ids, fetchedAt: Date.now() };
  return ids;
}

// ---------- Schritt 3: Liefert dem Dashboard alle Server ----------
app.get('/api/guilds', requireAuth, async (req, res) => {
  try {
    const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${req.session.accessToken}` }
    });

    if (guildsRes.status === 401) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'session_expired' });
    }
    if (!guildsRes.ok) {
      return res.status(502).json({ error: 'discord_api_error' });
    }

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
    console.error('Fehler bei /api/guilds:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// WICHTIG FÜR VERCEL SERVERLESS:
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Apex Dashboard läuft auf http://localhost:${PORT}`);
  });
}
// Statt require('express-session'):
const cookieSession = require('cookie-session');

// Express Middleware anpassen:
app.use(
  cookieSession({
    name: 'session',
    keys: [SESSION_SECRET || 'bitte-in-der-.env-aendern'],
    maxAge: 24 * 60 * 60 * 1000, // 24 Stunden
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    httpOnly: true
  })
);
