// Security bootstrap for Vercel/Node.
// server.js owns the Express app and its middleware/routes.
// Keep this entrypoint deliberately small so /auth/discord/login cannot crash
// because of middleware monkey-patching during module initialization.
require('dotenv').config();
const { validateEnvironment } = require('./security-middleware');

validateEnvironment();
module.exports = require('./server.js');
