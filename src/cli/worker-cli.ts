#!/usr/bin/env node
/**
 * LinkedIn Publisher Worker CLI
 * 
 * Run this on your local machine to process publishing jobs.
 * 
 * Usage:
 *   li-worker --mongodb-uri "..." --secret "..."
 * 
 * Or with environment variables:
 *   MONGODB_URI="..." STORAGE_STATE_SECRET="..." li-worker
 */

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          LinkedIn Publisher Worker CLI v1.0.0                 ║
║                                                               ║
║  This tool runs on your machine and publishes articles        ║
║  to LinkedIn using your authenticated browser session.        ║
╚═══════════════════════════════════════════════════════════════╝
`);

const args = process.argv.slice(2);
const mongodbUri = args.find((_, i) => args[i - 1] === '--mongodb-uri') || process.env.MONGODB_URI;
const storageSecret = args.find((_, i) => args[i - 1] === '--secret') || process.env.STORAGE_STATE_SECRET;

if (!mongodbUri || !storageSecret) {
  console.log('❌ Missing required configuration.');
  console.log('');
  console.log('Usage:');
  console.log('  li-worker --mongodb-uri "<uri>" --secret "<secret>"');
  console.log('');
  console.log('Or set environment variables:');
  console.log('  MONGODB_URI="<uri>" STORAGE_STATE_SECRET="<secret>" li-worker');
  console.log('');
  process.exit(1);
}

process.env.MONGODB_URI = mongodbUri;
process.env.STORAGE_STATE_SECRET = storageSecret;

console.log('🔌 Connecting to database...');
console.log('🚀 Starting worker...');
console.log('Press Ctrl+C to stop.');
console.log('');

// Import and run the actual worker
require('../worker');
