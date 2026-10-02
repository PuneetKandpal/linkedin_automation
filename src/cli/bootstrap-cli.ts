import '../env';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { Logger } from '../engine/logger';
import { connectMongo } from '../db/mongo';
import { encryptJson } from '../db/crypto';
import { AccountModel } from '../db/models/AccountModel';
import { hasLinkedInAuthCookie, openRealChrome } from '../browser/real-chrome';
import mongoose from 'mongoose';

// CLI Banner
console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          LinkedIn Account Connector CLI v1.0.0                ║
║                                                               ║
║  This tool will help you connect your LinkedIn account        ║
║  to the publishing system.                                    ║
╚═══════════════════════════════════════════════════════════════╝
`);

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.findIndex(a => a === flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function promptValue(
  rl: ReturnType<typeof createInterface>,
  label: string,
  options?: { defaultValue?: string; required?: boolean; allowEmpty?: boolean; secret?: boolean }
): Promise<string> {
  const required = options?.required ?? true;
  const allowEmpty = options?.allowEmpty ?? false;

  while (true) {
    const suffix = options?.defaultValue !== undefined ? ` (default: ${options.defaultValue})` : '';
    const question = `${label}${suffix}: `;
    
    if (options?.secret) {
      // For secrets, use stdin directly to hide input
      process.stdout.write(question);
      const raw = await new Promise<string>((resolve) => {
        const stdin = process.stdin;
        const chunks: Buffer[] = [];
        stdin.on('data', (data: Buffer) => {
          chunks.push(data);
        });
        stdin.on('end', () => {
          resolve(Buffer.concat(chunks).toString().trim());
        });
        stdin.once('data', () => {
          stdin.pause();
          resolve(Buffer.concat(chunks).toString().trim());
        });
      });
      console.log(); // New line after secret input
      const value = raw.trim().length > 0 ? raw.trim() : (options?.defaultValue ?? '');
      if (allowEmpty) return value;
      if (!required) return value;
      if (value.trim().length > 0) return value;
    } else {
      const raw = await rl.question(question);
      const value = raw.trim().length > 0 ? raw.trim() : (options?.defaultValue ?? '');
      if (allowEmpty) return value;
      if (!required) return value;
      if (value.trim().length > 0) return value;
    }
  }
}

async function main() {
  const rl = createInterface({ input, output });
  
  try {
    // Get required configuration
    let mongodbUri = getArgValue('--mongodb-uri') || process.env.MONGODB_URI;
    if (!mongodbUri) {
      console.log('\n📋 Database Configuration');
      console.log('Please provide your MongoDB connection string.');
      console.log('Example: mongodb+srv://username:password@cluster.mongodb.net/dbname\n');
      mongodbUri = await promptValue(rl, 'MongoDB URI', { required: true });
    }
    process.env.MONGODB_URI = mongodbUri;

    let storageSecret = getArgValue('--secret') || process.env.STORAGE_STATE_SECRET;
    if (!storageSecret) {
      console.log('\n🔐 Security Configuration');
      console.log('Please provide the storage state secret (provided by your admin).\n');
      storageSecret = await promptValue(rl, 'Storage State Secret', { required: true, secret: true });
    }
    process.env.STORAGE_STATE_SECRET = storageSecret;

    let accountId = getArgValue('--account') || process.env.ACCOUNT_ID;
    if (!accountId || accountId.trim().length === 0) {
      console.log('\n👤 Account Information');
      console.log('Please provide a unique identifier for this account.\n');
      accountId = await promptValue(rl, 'Account ID (e.g., client_001)', { required: true });
    }

    const forceNoProxy = hasFlag('--no-proxy') || process.env.NO_PROXY === '1' || process.env.NO_PROXY === 'true';

    console.log('\n🚀 Initializing...');
    
    const runTs = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = resolve('./logs');
    mkdirSync(logDir, { recursive: true });

    const logger = new Logger({
      logFilePath: resolve(logDir, `connect_${accountId}_${runTs}.log`),
      latestLogPath: resolve(logDir, 'latest.log'),
    });

    console.log('  → Connecting to database...');
    await connectMongo();
    console.log('  ✅ Database connected');

    logger.info('Account Connector → MongoDB connected', {
      db: mongoose.connection.name,
      collection: AccountModel.collection.name,
    });

    const existing = await AccountModel.findOne({ accountId }).lean();

    console.log('\n📇 Account Details');
    
    const displayNameDefault = getArgValue('--display-name') || process.env.DISPLAY_NAME || existing?.displayName || '';
    const emailDefault = getArgValue('--email') || process.env.EMAIL || existing?.email || '';
    const timezoneDefault = getArgValue('--timezone') || process.env.TIMEZONE || existing?.timezone || 'UTC';

    const displayName = await promptValue(rl, 'Display name', {
      defaultValue: displayNameDefault || undefined,
      required: true,
    });

    const email = await promptValue(rl, 'Email', {
      defaultValue: emailDefault || undefined,
      required: true,
    });

    const timezone = await promptValue(rl, 'Timezone (e.g., Asia/Kolkata, America/New_York)', {
      defaultValue: timezoneDefault || 'UTC',
      required: true,
    });

    // Optional proxy configuration
    const proxyServerArg = getArgValue('--proxy-server') || process.env.PROXY_SERVER;
    let proxyServer = proxyServerArg;
    let proxyUsername: string | undefined;
    let proxyPassword: string | undefined;

    if (!proxyServer) {
      const useProxy = await promptValue(rl, 'Use proxy? (y/n)', { defaultValue: 'n' });
      if (useProxy.toLowerCase() === 'y') {
        proxyServer = await promptValue(rl, 'Proxy server (e.g., http://proxy.example.com:8080)');
        proxyUsername = await promptValue(rl, 'Proxy username (optional)', { allowEmpty: true });
        if (proxyUsername) {
          proxyPassword = await promptValue(rl, 'Proxy password', { secret: true });
        }
      }
    } else {
      proxyUsername = getArgValue('--proxy-username') || process.env.PROXY_USERNAME;
      proxyPassword = getArgValue('--proxy-password') || process.env.PROXY_PASSWORD;
    }

    const proxyConfigProvided = Boolean(proxyServer);

    console.log('\n💾 Saving account information...');
    
    const account = await AccountModel.findOneAndUpdate(
      { accountId },
      {
        $set: {
          accountId,
          displayName,
          email,
          timezone,
          status: 'active',
          proxy: proxyConfigProvided && proxyServer
            ? {
                server: proxyServer,
                username: proxyUsername,
                password: proxyPassword,
              }
            : undefined,
        },
      },
      { new: true, upsert: true }
    ).lean();

    console.log('  ✅ Account saved');
    logger.info('Account Connector → starting browser', { accountId });

    // The installed Google Chrome with a per-account profile. The worker reuses this exact
    // profile, so LinkedIn sees the same browser for login and publishing. (Playwright's bundled
    // Chromium is blocked by LinkedIn's Cloudflare check.)
    const useProxy = Boolean(account.proxy) && !forceNoProxy;
    const userDataDir = resolve('./profiles', accountId);
    console.log(`\n🌐 Opening Google Chrome (proxy: ${useProxy ? 'yes' : 'no'})...`);
    if (useProxy && account.proxy?.username) {
      console.log('   Chrome will ask for the proxy username/password in the browser window.');
    }

    const chrome = await openRealChrome({
      userDataDir,
      url: 'https://www.linkedin.com/login',
      proxyServer: useProxy ? account.proxy?.server : undefined,
    });
    if (chrome.closedLeftovers > 0) {
      logger.warn('Account Connector → closed a Chrome that was still running on this profile', { count: chrome.closedLeftovers });
    }

    console.log('\n╔═══════════════════════════════════════════════════════════════╗');
    console.log('║  📝 INSTRUCTIONS                                              ║');
    console.log('║                                                               ║');
    console.log('║  1. A Google Chrome window has opened with LinkedIn           ║');
    console.log('║  2. Log in to your LinkedIn account (skip if already in)     ║');
    console.log('║  3. If prompted, complete any 2FA/security verification      ║');
    console.log('║  4. Once your LinkedIn feed is showing,                       ║');
    console.log('║     return here and press ENTER                              ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝\n');

    try {
      for (;;) {
        await rl.question('⏳ Waiting... Press ENTER when logged in: ');
        if (await hasLinkedInAuthCookie(chrome.context)) break;
        console.log('⚠️  Not logged in yet. Finish logging in to LinkedIn in Chrome, then press ENTER again.');
      }

      const url = chrome.currentPage()?.url();
      console.log(`\n📍 Current URL: ${url}`);
      logger.info('Account Connector → saving storage state', { currentUrl: url });

      console.log('💾 Saving session to database...');
      const storageState = await chrome.context.storageState();
      try {
        const storageStateEnc = encryptJson(storageState);
        await AccountModel.findOneAndUpdate(
          { accountId },
          {
            $set: {
              storageStateEnc,
              storageStateUpdatedAt: new Date(),
              authStatus: 'valid',
              linkStatus: 'linked',
              lastAuthError: undefined,
            },
          },
          { new: true }
        ).lean();

        console.log('  ✅ Session saved successfully!');
        logger.info('Account Connector → saved storage state to MongoDB', { accountId });

        console.log('\n╔═══════════════════════════════════════════════════════════════╗');
        console.log('║  ✅ SUCCESS! Your account is now connected.                   ║');
        console.log('║                                                               ║');
        console.log('║  Chrome will now close. Start the worker to begin             ║');
        console.log('║  publishing articles on your behalf.                          ║');
        console.log('╚═══════════════════════════════════════════════════════════════╝\n');
      } catch (err) {
        console.error('❌ Failed to save session:', err);
        logger.warn('Account Connector → failed to save storage state to MongoDB', { error: String(err) });
      }
    } finally {
      logger.info('Account Connector → closing browser');
      await chrome.close();
    }

    process.exit(0);
  } catch (err) {
    console.error('\n❌ Fatal error:', err);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
