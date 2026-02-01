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

// Set up paths for pkg bundle
const isPkg = typeof process.pkg !== 'undefined';
if (isPkg) {
  // When packaged, adjust paths
  process.env.NODE_PATH = path.join(__dirname, '../node_modules');
  require('module').Module._initPaths();
}

// Run the bootstrap logic
require('../dist/bootstrap-cli.js');
