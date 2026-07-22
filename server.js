const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Discord OAuth2 Konfiguration
// ERSETZE DIESE WERTE MIT DEINEN ANGABEN AUS DEM DISCORD DEVELOPER PORTAL
const CLIENT_ID = 'DEINE_DISCORD_CLIENT_ID';
const CLIENT_SECRET = 'DEIN_DISCORD_CLIENT_SECRET';
const CALLBACK_URL = 'http://localhost:3000/auth/discord/callback';

const CONFIG_FILE = path.join(__dirname, 'guild_configs.json');

// Helper-Funktionen für JSON Speicherung
function getConfigs() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({}), 'utf-8');
  }
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

function saveConfigs(configs) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2), 'utf-8');
}

// Passport Session Setup
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new Strategy({
  clientID: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  callbackURL: CALLBACK_URL,
  scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
  process.nextTick(() => done(null, profile));
}));

// Express Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // Stelle sicher, dass html/js in 'public' liegen oder passe den Pfad an

app.use(session({
  secret: 'apex_super_secret_key_change_me',
  resave: false,
  saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Middleware: Authentifizierung prüfen
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Nicht angemeldet' });
}

// ----------------- OAUTH ROUTES -----------------

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback', passport.authenticate('discord', {
  failureRedirect: '/'
}), (req, res) => {
  res.redirect('/dashboard.html');
});

app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/');
  });
});

// ----------------- USER & GUILD APIS -----------------

// Aktuellen User abrufen
app.get('/api/user', requireAuth, (req, res) => {
  res.json(req.user);
});

// Serverliste des Users abrufen (nur Server mit Admin-Rechten)
app.get('/api/guilds', requireAuth, (req, res) => {
  const adminGuilds = req.user.guilds.filter(guild => (guild.permissions & 0x8) === 0x8);
  res.json(adminGuilds);
});

// ----------------- CONFIGURATION APIS -----------------

// Alle Konfigurationen eines bestimmten Guilds abrufen
app.get('/api/guild/:guildId/config', requireAuth, (req, res) => {
  const configs = getConfigs();
  res.json(configs[req.params.guildId] || {});
});

// Einzelne Modul-Einstellungen speichern (Welcome, Leave, Tickets, Teamlist)
app.post('/api/guild/:guildId/config/:module', requireAuth, (req, res) => {
  const { guildId, module } = req.params;
  const configs = getConfigs();

  if (!configs[guildId]) {
    configs[guildId] = {};
  }

  // Modul-Daten aktualisieren
  configs[guildId][module] = req.body;

  saveConfigs(configs);
  res.json({ success: true, message: `${module} erfolgreich gespeichert!` });
});

// Frontend Route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Server starten
app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
