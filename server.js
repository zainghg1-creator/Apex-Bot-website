require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const mongoose = require('mongoose');

// ============================================================
// ENV VALIDATION
// ============================================================
const REQUIRED_ENV = ['CLIENT_ID', 'CLIENT_SECRET', 'BOT_TOKEN', 'REDIRECT_URI', 'SESSION_SECRET', 'MONGODB_URI'];
REQUIRED_ENV.forEach(key => {
  if (!process.env[key]) {
    console.warn(`⚠️  Umgebungsvariable ${key} ist nicht gesetzt`);
  }
});

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

// ===== DEBUG: JETZT HIER einfügen (NACH den Variablen) =====
console.log('🔍 Umgebungsvariablen Check:');
console.log('CLIENT_ID:', CLIENT_ID ? '✅ gesetzt' : '❌ fehlt');
console.log('CLIENT_SECRET:', CLIENT_SECRET ? '✅ gesetzt' : '❌ fehlt');
console.log('BOT_TOKEN:', BOT_TOKEN ? '✅ gesetzt' : '❌ fehlt');
console.log('REDIRECT_URI:', REDIRECT_URI);
console.log('MONGODB_URI:', MONGODB_URI ? '✅ gesetzt (versteckt)' : '❌ fehlt');
console.log('SESSION_SECRET:', SESSION_SECRET ? '✅ gesetzt' : '❌ fehlt');
console.log('PORT:', PORT);
// ============================================================
