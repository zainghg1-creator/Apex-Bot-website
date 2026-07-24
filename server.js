require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const mongoose = require('mongoose');

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

const DISCORD_API = 'https://discord.com/api/v10';
const ADMINISTRATOR = 0x8n;
const ALLOWED_MODULES = ['welcome', 'tickets', 'teamliste', 'support', 'moderation', 'teamupdate', 'stats', 'verification', 'antinuke'];

const app = express();
app.set('trust proxy', 1);

app.use(express.static(__dirname));
app.use(express.json({ limit: '8mb' }));

app.use(cookieSession({
  name: 'apex_session',
  keys: [SESSION_SECRET || 'default-secret'],
  maxAge: 24 * 60 * 60 * 1000,
  secure: NODE_ENV === 'production',
  sameSite: 'lax',
  httpOnly: true
}));

// MongoDB
let GuildConfig = null;
if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI, { dbName: 'apex' }).then(() => {
    const schema = new mongoose.Schema({
      guildId: { type: String, required: true, unique: true },
      data: { type: mongoose.Schema.Types.Mixed, default: {} }
    }, { timestamps: true });
    GuildConfig = mongoose.models.GuildConfig || mongoose.model('GuildConfig', schema);
    console.log('✅ MongoDB bereit');
  });
}

async function saveModuleConfig(guildId, moduleName, moduleData) {
  if (!GuildConfig) return;
  await GuildConfig.findOneAndUpdate(
    { guildId },
    { $set: { [`data.${moduleName}`]: moduleData } },
    { upsert: true }
  );
  console.log(`💾 Config gespeichert: ${guildId} → ${moduleName}`);
}

// === ROUTES (unverändert bis auf Logging) ===
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard.html', (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ... (OAuth-Routen bleiben gleich wie in deiner ursprünglichen Datei)

app.post('/api/guild/:guildId/config/:module', async (req, res) => {
  const { guildId, module } = req.params;
  if (!ALLOWED_MODULES.includes(module)) return res.status(400).json({ error: 'unknown_module' });

  try {
    await saveModuleConfig(guildId, module, req.body);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Rest der Routen (guilds, roles, channels etc.) bleiben gleich wie bei dir
// ... (kopiere den Rest aus deiner ursprünglichen server.js)

// Export für Vercel
module.exports = app;

if (NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🌐 Dashboard auf http://localhost:${PORT}`));
}
