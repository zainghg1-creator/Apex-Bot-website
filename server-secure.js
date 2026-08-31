// Security bootstrap: this file is the only Vercel/Node entrypoint.
// It installs the authorization middleware before server.js registers any routes.
const express = require('express');
const { installExpressSecurity, validateEnvironment } = require('./security-middleware');

validateEnvironment();
installExpressSecurity(express);

module.exports = require('./server.js');
