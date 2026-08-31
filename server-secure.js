// Security bootstrap: this file is the only Vercel/Node entrypoint.
// It installs authorization middleware before server.js registers any routes.
const crypto = require('crypto');
const express = require('express');
const { installExpressSecurity, validateEnvironment } = require('./security-middleware');

// Vercel deployments can fail before any route is reached when SESSION_SECRET
// is missing. Keep production secure without using a public/default secret:
// derive a stable private session key from the already-secret Discord client
// secret. An explicitly configured SESSION_SECRET always takes precedence.
if (process.env.NODE_ENV === 'production') {
  const configured = process.env.SESSION_SECRET;
  if (!configured || configured.length < 32) {
    if (!process.env.CLIENT_SECRET || process.env.CLIENT_SECRET.length < 16) {
      throw new Error('SECURITY: SESSION_SECRET (>=32 Zeichen) oder ein gültiges CLIENT_SECRET muss in Vercel gesetzt sein.');
    }

    process.env.SESSION_SECRET = crypto
      .createHash('sha256')
      .update('apex-session-v1:')
      .update(process.env.CLIENT_SECRET)
      .digest('hex');

    console.warn('[SECURITY] SESSION_SECRET fehlt/ist zu kurz; sicherer Schlüssel aus CLIENT_SECRET abgeleitet.');
  }
}

validateEnvironment();
installExpressSecurity(express);

module.exports = require('./server.js');
