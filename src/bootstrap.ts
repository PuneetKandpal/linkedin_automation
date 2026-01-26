import './env';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { chromium } from '@playwright/test';
import { Logger } from './engine/logger';
import { connectMongo } from './db/mongo';
import { encryptJson } from './db/crypto';
import { AccountModel } from './db/models/AccountModel';
import mongoose from 'mongoose';

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.findIndex(a => a === flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function isProxyConnectionFailure(err: unknown): boolean {
  const msg = String(err);
  return msg.includes('ERR_PROXY_CONNECTION_FAILED') || msg.includes('net::ERR_PROXY_CONNECTION_FAILED');
}

async function promptValue(
  rl: ReturnType<typeof createInterface>,
  label: string,
  options?: { defaultValue?: string; required?: boolean; allowEmpty?: boolean }
): Promise<string> {
  const required = options?.required ?? true;
  const allowEmpty = options?.allowEmpty ?? false;

  while (true) {
    const suffix = options?.defaultValue !== undefined ? ` (default: ${options.defaultValue})` : '';
    const raw = await rl.question(`${label}${suffix}: `);
    const value = raw.trim().length > 0 ? raw.trim() : (options?.defaultValue ?? '');
    if (allowEmpty) return value;
    if (!required) return value;
    if (value.trim().length > 0) return value;
  }
}

function normalizeBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'y' || v === 'yes' || v === 'true' || v === '1';
}

async function main() {
  const rl = createInterface({ input, output });
  try {
    let accountId = getArgValue('--account') || process.env.ACCOUNT_ID;
    if (!accountId || accountId.trim().length === 0) {
      accountId = await promptValue(rl, 'Account ID', { required: true });
    }

    if (!process.env.MONGODB_URI) {
      process.env.MONGODB_URI = await promptValue(rl, 'MONGODB_URI', { required: true });
    }

    if (!process.env.STORAGE_STATE_SECRET) {
      process.env.STORAGE_STATE_SECRET = await promptValue(rl, 'STORAGE_STATE_SECRET', { required: true });
    }

    const forceNoProxy =
      hasFlag('--no-proxy') || process.env.NO_PROXY === '1' || process.env.NO_PROXY === 'true';

    const runTs = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = resolve('./output/logs');
    mkdirSync(logDir, { recursive: true });

    const logger = new Logger({
      logFilePath: resolve(logDir, `bootstrap_${accountId}_${runTs}.log`),
      latestLogPath: resolve(logDir, 'latest.log'),
    });

    await connectMongo();

    logger.info('Bootstrap → MongoDB connected', {
      db: mongoose.connection.name,
      collection: AccountModel.collection.name,
    });

    const existing = await AccountModel.findOne({ accountId }).lean();

    const displayNameDefault =
      getArgValue('--display-name') || process.env.DISPLAY_NAME || existing?.displayName || '';
    const emailDefault = getArgValue('--email') || process.env.EMAIL || existing?.email || '';
    const timezoneDefault =
      getArgValue('--timezone') || process.env.TIMEZONE || existing?.timezone || 'UTC';

    const displayName = await promptValue(rl, 'Display name', {
      defaultValue: displayNameDefault || undefined,
      required: true,
    });

    const email = await promptValue(rl, 'Email', {
      defaultValue: emailDefault || undefined,
      required: true,
    });

    const timezone = await promptValue(rl, 'Timezone (e.g. Asia/Kolkata)', {
      defaultValue: timezoneDefault || 'UTC',
      required: true,
    });

    const proxyServerArg = getArgValue('--proxy-server') || process.env.PROXY_SERVER;
    const proxyUsernameArg = getArgValue('--proxy-username') || process.env.PROXY_USERNAME;
    const proxyPasswordArg = getArgValue('--proxy-password') || process.env.PROXY_PASSWORD;

    let proxyServer: string | undefined = proxyServerArg || existing?.proxy?.server || undefined;
    let proxyUsername: string | undefined = proxyUsernameArg || existing?.proxy?.username || undefined;
    let proxyPassword: string | undefined = proxyPasswordArg || existing?.proxy?.password || undefined;

    if (!proxyServerArg) {
      const wantsProxyRaw = await promptValue(rl, 'Use proxy? (y/N)', {
        defaultValue: proxyServer ? 'Y' : 'N',
        required: false,
        allowEmpty: true,
      });
      const wantsProxy = normalizeBool(wantsProxyRaw || '');

      if (!wantsProxy) {
        proxyServer = undefined;
        proxyUsername = undefined;
        proxyPassword = undefined;
      } else {
        proxyServer = await promptValue(rl, 'Proxy server (e.g. http://host:port)', {
          defaultValue: proxyServer,
          required: true,
        });
        const u = await promptValue(rl, 'Proxy username (optional)', {
          defaultValue: proxyUsername,
          required: false,
          allowEmpty: true,
        });
        const p = await promptValue(rl, 'Proxy password (optional)', {
          defaultValue: proxyPassword,
          required: false,
          allowEmpty: true,
        });
        proxyUsername = u.trim().length > 0 ? u : undefined;
        proxyPassword = p.trim().length > 0 ? p : undefined;
      }
    }

    const account = await AccountModel.findOneAndUpdate(
      { accountId },
      {
        $set: {
          accountId,
          displayName,
          email,
          timezone,
          status: 'active',
          proxy: proxyServer
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

    logger.info('Bootstrap → starting', { accountId });

  const launchAndGoto = async (useProxy: boolean) => {
    const browser = await chromium.launch({
      headless: false,
      proxy:
        useProxy && account.proxy
          ? {
              server: account.proxy.server,
              username: account.proxy.username,
              password: account.proxy.password,
            }
          : undefined,
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: account.timezone,
    });

    try {
      const page = context.pages()[0] || (await context.newPage());
      await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded' });
      return { browser, context, page };
    } catch (err) {
      try {
        await context.close();
      } catch {
        // ignore
      }
      try {
        await browser.close();
      } catch {
        // ignore
      }
      throw err;
    }
  };

  let browser;
  let context;
  let page;
  try {
    const useProxy = Boolean(account.proxy) && !forceNoProxy;
    logger.info('Bootstrap → launching browser', { useProxy, forceNoProxy });
    ({ browser, context, page } = await launchAndGoto(useProxy));
  } catch (err) {
    if (!forceNoProxy && Boolean(account.proxy) && isProxyConnectionFailure(err)) {
      logger.warn('Bootstrap → proxy failed, retrying without proxy', { error: String(err) });
      ({ browser, context, page } = await launchAndGoto(false));
    } else {
      throw err;
    }
  }

    logger.info('Bootstrap → browser opened. Please login manually in the opened window.');
    await rl.question('When done, press ENTER here to save the session: ');

  const url = page.url();
  logger.info('Bootstrap → saving storage state', { currentUrl: url });

  const storageState = await context.storageState();

  try {
    const storageStateEnc = encryptJson(storageState);
    await AccountModel.findOneAndUpdate(
      { accountId },
      {
        $set: {
          storageStateEnc,
          storageStateUpdatedAt: new Date(),
          authStatus: 'valid',
          lastAuthError: undefined,
        },
      },
      { new: true }
    ).lean();

    logger.info('Bootstrap → saved storage state to MongoDB', { accountId });
  } catch (err) {
    logger.warn('Bootstrap → failed to save storage state to MongoDB', { error: String(err) });
  }

  logger.info('Bootstrap → closing browser');

  await context.close();
  if (browser) {
    await browser.close();
  }
    process.exit(0);
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error('Bootstrap fatal error:', err);
  process.exit(1);
});
