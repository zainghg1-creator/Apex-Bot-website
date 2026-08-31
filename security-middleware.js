const DISCORD_API = 'https://discord.com/api/v10';
const ADMINISTRATOR = 0x8n;

const authCache = new Map();
const rate = new Map();

function extractGuildId(req) {
  const pathMatch = req.path.match(/^\/api\/guilds?\/(\d{17,20})(?:\/|$)/);
  if (pathMatch) return pathMatch[1];

  const candidates = [
    req.body?.guildId,
    req.body?.guildID,
    req.body?.serverId,
    req.query?.guildId,
    req.query?.guildID,
    req.query?.serverId
  ];
  return candidates.find(v => typeof v === 'string' && /^\d{17,20}$/.test(v)) || null;
}

function cleanup() {
  const now = Date.now();
  for (const [key, value] of authCache) if (value.expires <= now) authCache.delete(key);
  for (const [key, value] of rate) if (value.reset <= now) rate.delete(key);
}
setInterval(cleanup, 60_000).unref();

function checkRateLimit(req, res) {
  const key = `${req.ip}:${req.session?.user?.id || 'anonymous'}`;
  const now = Date.now();
  let entry = rate.get(key);
  if (!entry || entry.reset <= now) {
    entry = { count: 0, reset: now + 60_000 };
    rate.set(key, entry);
  }
  entry.count++;
  if (entry.count > 120) {
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
  const cached = authCache.get(cacheKey);
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
    authCache.set(cacheKey, { allowed, expires: Date.now() + 5_000 });
    return allowed;
  } catch (error) {
    console.error('[SECURITY] Discord authorization failed:', error.message);
    return false;
  }
}

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    const expected = `${req.protocol}://${req.get('host')}`;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}

function securityMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.removeHeader('X-Powered-By');

  if (!req.path.startsWith('/api/')) return next();
  if (!checkRateLimit(req, res)) return;

  const guildId = extractGuildId(req);
  const guildScoped = /^\/api\/guilds?\/\d{17,20}(?:\/|$)/.test(req.path);

  // Every guild-scoped API request, including GET, must belong to a real
  // authenticated Discord Administrator of that exact guild.
  if (guildScoped) {
    if (!req.session?.accessToken || !req.session?.user?.id) {
      return res.status(401).json({ error: 'not_authenticated' });
    }
    if (!guildId) return res.status(400).json({ error: 'guild_id_required' });

    return isGuildAdmin(req, guildId).then(allowed => {
      if (!allowed) return res.status(403).json({ error: 'not_guild_admin' });

      const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
      if (mutating && !sameOrigin(req)) {
        return res.status(403).json({ error: 'origin_not_allowed' });
      }
      next();
    }).catch(() => res.status(403).json({ error: 'not_guild_admin' }));
  }

  // Any other state-changing API endpoint still requires a valid session.
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (mutating) {
    if (!req.session?.accessToken || !req.session?.user?.id) {
      return res.status(401).json({ error: 'not_authenticated' });
    }
    if (!sameOrigin(req)) return res.status(403).json({ error: 'origin_not_allowed' });
    return res.status(400).json({ error: 'guild_id_required' });
  }

  next();
}

function installExpressSecurity(express) {
  const originalUse = express.application.use;
  let installed = false;
  let useCount = 0;

  express.application.use = function patchedUse(...args) {
    useCount++;
    const result = originalUse.apply(this, args);
    if (!installed && useCount === 3) {
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
      throw new Error('SECURITY: SESSION_SECRET muss in Production gesetzt sein und mindestens 32 Zeichen haben.');
    }
  }
}

module.exports = { installExpressSecurity, validateEnvironment, securityMiddleware };
