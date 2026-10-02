import { resolve } from 'path';
import { chromium, Browser, BrowserContext } from 'playwright';
import { hasLinkedInAuthCookie, openRealChrome, RealChromeSession } from './real-chrome';
import { Account, GlobalConfig } from '../config/types';
import { Logger } from '../engine/logger';

function isProxyConnectionFailure(err: unknown): boolean {
  const msg = String(err);
  return msg.includes('ERR_PROXY_CONNECTION_FAILED') || msg.includes('net::ERR_PROXY_CONNECTION_FAILED');
}

export class BrowserContextFactory {
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;
  private realChrome: RealChromeSession | null = null;

  constructor(
    private globalConfig: GlobalConfig,
    private logger: Logger
  ) {}

  async createContext(account: Account): Promise<BrowserContext> {
    this.logger.info('Launching browser context', {
      accountId: account.accountId,
      headless: this.globalConfig.browser.headless,
      slowMo: this.globalConfig.browser.slowMo,
      hasStorageState: Boolean(account.storageState),
      timezone: account.timezone,
    });

    if (!account.storageState) {
      throw new Error(`Missing storageState for account: ${account.accountId}`);
    }

    const forceNoProxy = process.env.NO_PROXY === '1' || process.env.NO_PROXY === 'true';

    const engine = process.env.BROWSER_ENGINE || this.globalConfig.browser.engine || 'playwright';
    if (engine === 'chrome') {
      this.context = await this.createRealChromeContext(account, forceNoProxy);
      return this.context;
    }

    const launch = async (useProxy: boolean): Promise<BrowserContext> => {
      const launchOptions: any = {
        headless: this.globalConfig.browser.headless,
        slowMo: this.globalConfig.browser.slowMo,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-software-rasterizer',
        ],
      };

      this.logger.info('Browser launch options', {
        headless: launchOptions.headless,
        slowMo: launchOptions.slowMo,
        hasProxy: useProxy && Boolean(account.proxy),
        proxyServer: useProxy && account.proxy ? account.proxy.server : undefined,
      });

      if (useProxy && account.proxy) {
        launchOptions.proxy = {
          server: account.proxy.server,
          username: account.proxy.username,
          password: account.proxy.password,
        };
      }

      this.logger.info('Launching Chromium browser...');

      this.browser = await chromium.launch(launchOptions);
      this.logger.info('Chromium browser launched successfully');

      const context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: account.timezone,
        permissions: [],
        bypassCSP: false,
        storageState: account.storageState as any,
      });
      this.logger.info('Browser context created with storage state');

      const page = context.pages()[0] || (await context.newPage());
      this.logger.info('Navigating to LinkedIn...', {
        url: 'https://www.linkedin.com/',
        timeout: this.globalConfig.browser.initialPageLoadTimeoutMs,
        waitUntil: 'domcontentloaded',
      });

      await page.goto('https://www.linkedin.com/', { waitUntil: 'domcontentloaded', timeout: this.globalConfig.browser.initialPageLoadTimeoutMs });
      this.logger.info('LinkedIn page loaded successfully');
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
    });

    return this.context;
  }

  /**
   * LinkedIn rejects a session whose cookies were created in real Chrome but replayed in
   * Playwright's headless Chromium (feed loads, then the next page hits /authwall). Running in
   * the same Chrome + profile that `npm run bootstrap` used keeps the browser identity identical.
   */
  private async createRealChromeContext(account: Account, forceNoProxy: boolean): Promise<BrowserContext> {
    const userDataDir = resolve('./profiles', account.accountId);
    const useProxy = Boolean(account.proxy) && !forceNoProxy;
    this.logger.info('Launching installed Google Chrome', { accountId: account.accountId, userDataDir, useProxy });

    const background = this.globalConfig.browser.chromeWindow !== 'visible';
    this.realChrome = await openRealChrome({
      userDataDir,
      url: 'about:blank',
      proxyServer: useProxy ? account.proxy?.server : undefined,
      extraArgs: background ? undefined : ['--window-size=1920,1080'],
      background,
    });
    const context = this.realChrome.context;

    if (this.realChrome.closedLeftovers > 0) {
      this.logger.warn('Closed a Chrome that was still running on this profile from an earlier run', {
        count: this.realChrome.closedLeftovers,
      });
    }

    if (this.realChrome.windowPlacement === 'visible') {
      this.logger.warn(
        'Chrome could not keep the window hidden on this machine, so it is shown normally. Set browser.chromeWindow to "visible" to silence this.',
        { platform: process.platform }
      );
    } else if (this.realChrome.windowPlacement) {
      this.logger.info('Chrome running in background', { windowPlacement: this.realChrome.windowPlacement });
    }

    if (await hasLinkedInAuthCookie(context)) {
      this.logger.info('Using LinkedIn session already in the Chrome profile');
    } else {
      const cookies = ((account.storageState as any)?.cookies || []) as any[];
      this.logger.info('Chrome profile not signed in, loading saved session cookies', { cookies: cookies.length });
      await context.addCookies(cookies);
    }

    const page = context.pages()[0] || (await context.newPage());
    this.logger.info('Navigating to LinkedIn...', { url: 'https://www.linkedin.com/' });
    await page.goto('https://www.linkedin.com/', {
      waitUntil: 'domcontentloaded',
      timeout: this.globalConfig.browser.initialPageLoadTimeoutMs,
    });
    this.logger.info('LinkedIn page loaded successfully');
    return context;
  }

  async closeContext(): Promise<void> {
    if (this.realChrome) {
      // The default context of an attached Chrome can't be closed directly; quitting Chrome does it.
      await this.realChrome.close();
      this.logger.info('Chrome closed');
      this.realChrome = null;
      this.context = null;
      return;
    }

    if (this.context) {
      await this.context.close();
      this.logger.info('Browser context closed');
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  isActive(): boolean {
    return this.context !== null;
  }
}
