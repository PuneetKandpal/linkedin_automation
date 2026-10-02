#!/usr/bin/env node
/**
 * LinkedIn Account Connector CLI
 * 
 * Usage:
 *   li-connect --account ACCOUNT_ID --mongodb-uri "..." --secret "..."
 * 
 * Or run interactively:
 *   li-connect
 */

const path = require('path');
const fs = require('fs');

// Set up paths for pkg bundle
const isPkg = typeof process.pkg !== 'undefined';
if (isPkg) {
  // When packaged, adjust paths
  process.env.NODE_PATH = path.join(__dirname, '../node_modules');
  require('module').Module._initPaths();
}

// Auto-load shared client config if present
try {
  const cfgPath = path.join(__dirname, '..', 'client-config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    if (!process.env.MONGODB_URI && typeof cfg.mongodbUri === 'string' && cfg.mongodbUri.trim().length > 0) {
      process.env.MONGODB_URI = cfg.mongodbUri.trim();
    }
    if (!process.env.STORAGE_STATE_SECRET && typeof cfg.storageStateSecret === 'string' && cfg.storageStateSecret.trim().length > 0) {
      process.env.STORAGE_STATE_SECRET = cfg.storageStateSecret.trim();
    }
  }
} catch (e) {
  // If config is invalid, fall back to CLI/env-driven config.
}

// Run the bootstrap logic
require('../dist/cli/bootstrap-cli.js');
