import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { chromium } from '@playwright/test';
import { ConfigLoader } from './config/loader';
import { Logger } from './engine/logger';

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

async function main() {
  const accountId = getArgValue('--account') || process.env.ACCOUNT_ID;
  if (!accountId) {
    console.error('Missing account id. Use: npm run bootstrap -- --account acct_01');
    process.exit(1);
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

  const loader = new ConfigLoader('./config');
  const config = loader.loadAll();
  const account = loader.getAccount(config, accountId);

  const userDataDir = resolve(account.profileDir);
  const storageStatePath = resolve(account.profileDir, 'storageState.json');

  logger.info('Bootstrap → starting', { accountId, userDataDir, storageStatePath });

  const launchAndGoto = async (useProxy: boolean) => {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: account.timezone,
      proxy:
        useProxy && account.proxy
          ? {
              server: account.proxy.server,
              username: account.proxy.username,
              password: account.proxy.password,
            }
          : undefined,
    });

    try {
      const page = context.pages()[0] || (await context.newPage());
      await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded' });
      return { context, page };
    } catch (err) {
      // Important: always close the persistent context if navigation fails.
      // Otherwise Chromium leaves SingletonLock in the profile directory
      // and the next launch attempt will fail with ProcessSingleton errors.
      try {
        await context.close();
      } catch {
        // ignore
      }
      throw err;
    }
  };

  let context;
  let page;
  try {
    const useProxy = Boolean(account.proxy) && !forceNoProxy;
    logger.info('Bootstrap → launching browser', { useProxy, forceNoProxy });
    ({ context, page } = await launchAndGoto(useProxy));
  } catch (err) {
    if (!forceNoProxy && Boolean(account.proxy) && isProxyConnectionFailure(err)) {
      logger.warn('Bootstrap → proxy failed, retrying without proxy', { error: String(err) });
      ({ context, page } = await launchAndGoto(false));
    } else {
      throw err;
    }
  }

  logger.info('Bootstrap → browser opened. Please login manually in the opened window.');
  logger.info('Bootstrap → when done, press ENTER in this terminal to save the session.');

  await new Promise<void>(resolvePromise => {
    process.stdin.resume();
    process.stdin.once('data', () => resolvePromise());
  });

  const url = page.url();
  logger.info('Bootstrap → saving storage state', { currentUrl: url });

  mkdirSync(resolve(account.profileDir), { recursive: true });
  await context.storageState({ path: storageStatePath });

  logger.info('Bootstrap → saved storage state', { storageStatePath });
  logger.info('Bootstrap → closing browser');

  await context.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Bootstrap fatal error:', err);
  process.exit(1);
});
