import { chromium, BrowserContext } from '@playwright/test';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { Account, GlobalConfig } from '../config/types';
import { Logger } from '../engine/logger';

function isProxyConnectionFailure(err: unknown): boolean {
  const msg = String(err);
  return msg.includes('ERR_PROXY_CONNECTION_FAILED') || msg.includes('net::ERR_PROXY_CONNECTION_FAILED');
}

export class BrowserContextFactory {
  private context: BrowserContext | null = null;

  constructor(
    private globalConfig: GlobalConfig,
    private logger: Logger
  ) {}

  async createContext(account: Account): Promise<BrowserContext> {
    this.logger.info('Launching browser context', { accountId: account.accountId });

    const userDataDir = resolve(account.profileDir);
    mkdirSync(userDataDir, { recursive: true });

    const storageStatePath = resolve(userDataDir, 'storageState.json');
    this.logger.info('Session state', {
      accountId: account.accountId,
      profileDir: userDataDir,
      storageStateExists: existsSync(storageStatePath),
      storageStatePath,
    });

    const forceNoProxy = process.env.NO_PROXY === '1' || process.env.NO_PROXY === 'true';

    const launch = async (useProxy: boolean): Promise<BrowserContext> => {
      const launchOptions: any = {
        headless: this.globalConfig.browser.headless,
        slowMo: this.globalConfig.browser.slowMo,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
        ],
      };

      if (useProxy && account.proxy) {
        launchOptions.proxy = {
          server: account.proxy.server,
          username: account.proxy.username,
          password: account.proxy.password,
        };
      }

      const context = await chromium.launchPersistentContext(userDataDir, {
        ...launchOptions,
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: account.timezone,
        permissions: [],
        bypassCSP: false,
      });

      // Quick connectivity check: if proxy is broken we want to fail fast and retry.
      // We keep this lightweight (domcontentloaded) to avoid slowing normal runs.
      const page = context.pages()[0] || (await context.newPage());
      await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });

      return context;
    };

    try {
      const useProxy = Boolean(account.proxy) && !forceNoProxy;
      this.logger.info('Proxy mode', { accountId: account.accountId, useProxy, forceNoProxy });
      this.context = await launch(useProxy);
    } catch (err) {
      // If the proxy is configured but broken, retry once without proxy.
      if (!forceNoProxy && Boolean(account.proxy) && isProxyConnectionFailure(err)) {
        this.logger.warn('Proxy failed, retrying without proxy', { accountId: account.accountId, error: String(err) });
        try {
          if (this.context) {
            await this.context.close();
            this.context = null;
          }
        } catch {
          // ignore
        }
        this.context = await launch(false);
      } else {
        throw err;
      }
    }

    this.logger.info('Browser context created', { 
      accountId: account.accountId,
      profileDir: userDataDir 
    });

    return this.context;
  }

  async closeContext(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.logger.info('Browser context closed');
      this.context = null;
    }
  }

  isActive(): boolean {
    return this.context !== null;
  }
}
