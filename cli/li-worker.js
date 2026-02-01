#!/usr/bin/env node
/**
 * LinkedIn Publisher Worker CLI
 * 
 * Usage:
 *   li-worker --mongodb-uri "..." --secret "..."
 * 
 * Or with environment variables:
 *   MONGODB_URI="..." STORAGE_STATE_SECRET="..." li-worker
 */

const path = require('path');

// Set up paths for pkg bundle
const isPkg = typeof process.pkg !== 'undefined';
if (isPkg) {
  process.env.NODE_PATH = path.join(__dirname, '../node_modules');
  require('module').Module._initPaths();
}

// Run the worker
require('../dist/cli/worker-cli.js');
