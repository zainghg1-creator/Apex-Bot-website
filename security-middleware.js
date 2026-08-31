const crypto = require('crypto');

const DISCORD_API = 'https://discord.com/api/v10';
const ADMINISTRATOR = 0x8n;

const cache = new Map();
const rate = new Map();

function extractGuildId(req) {
  const pathMatch = req.path.match(/^\/api\/(?:guild|guilds)\/(\d{17,20})(?:\/|$)/);
  if (pathMatch) return pathMatch[1];

  const bodyGuildId = req.body && (req.body.guildId || req.body.guildID || req.body.serverId);
  if (typeof bodyGuildId === 'string' && /^\d{17,20}$/.test(bodyGuildId)) return bodyGuildId;

  const queryGuildId = req.query && (req.query.guildId || req.query.guildID || req.query.serverId);
  if (typeof queryGuildId === 'string' && /^\d{17,20}$/.test(queryGuildId)) return queryGuildId;

  return null;
}

function cleanupMaps() {
  const now = Date.now();
  for (const [key, value] of cache) if (value.expires < now) cache.delete(key);
  for (const [key, value] of rate) if (value.reset < now) rate.delete(key);
}
setInterval(cleanupMaps, 60_000).unref();

function rateLimit(req, res) {
  const key = `${req.ip}:${req.session?.user?.id || 'anon'}`;
  const now = Date.now();
  const current = rate.get(key);

  if (!current || current.reset <= now) {
    rate.set(key, { count: 1, reset: now + 60_000 });
    return true;
  }

  current.count += 1;
  if (current.count > 120) {
    res.status(429).json({ error: 'rate_limited' });
    return false;
  }
  return true;
}

async function isGuildAdmin(req, guildId) {
  const userId = req.session?.user?.id;
  const accessToken = req.session?.accessToken;
  if (!userId || !accessToken || !guildId) return false;

  const cacheKey = `${userId}:${guildId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.allowed;

  try {
    const response = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (response.status === 401) {
      req.session = null;
      return false;
    }
    if (!response.ok) return false;

    const guilds = await response.json();
    const guild = guilds.find(g => g.id === guildId);
    if (!guild) return false;

    const permissions = BigInt(guild.permissions ?? 0);
    const allowed = guild.owner === true || (permissions & ADMINISTRATOR) === ADMINISTRATOR;
    cache.set(cacheKey, { allowed, expires: Date.now() + 30_000 });
    return allowed;
  } catch (error) {
    console.error('[SECURITY] Discord authorization check failed:', error.message);
    return false;
  }
}

function securityMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (!req.path.startsWith('/api/')) return next();

  if (!rateLimit(req, res)) return;

  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (!mutating) return next();

  // Never trust the frontend, URL, DevTools or a manually crafted request.
  // Every API write must have a real Discord session and admin permission.
  if (!req.session?.accessToken || !req.session?.user?.id) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  const guildId = extractGuildId(req);
  if (!guildId) {
    return res.status(400).json({ error: 'guild_id_required' });
  }

  isGuildAdmin(req, guildId).then(allowed => {
    if (!allowed) return res.status(403).json({ error: 'not_guild_admin' });
    next();
  }).catch(() => res.status(403).json({ error: 'not_guild_admin' }));
}

function installExpressSecurity(express) {
  const originalUse = express.application.use;
  let installed = false;
  let useCount = 0;

  express.application.use = function patchedUse(...args) {
    useCount += 1;
    const result = originalUse.apply(this, args);
    const first = args[0];
    const looksLikeCookieSession = typeof first === 'function' && (
      first.name === 'cookieSession' ||
      first.name === 'cookieSessionMiddleware'
    );

    if (!installed && (looksLikeCookieSession || useCount === 3)) {
      originalUse.call(this, securityMiddleware);
      installed = true;
    }

    return result;
  };
}

function validateEnvironment() {
  if (process.env.NODE_ENV === 'production') {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret === 'default-secret' || secret.length < 32) {
      throw new Error('SECURITY: SESSION_SECRET muss in Production gesetzt sein und mindestens 32 Zeichen/Bytes Entropie haben.');
    }
  }
}

module.exports = { installExpressSecurity, validateEnvironment, securityMiddleware };
