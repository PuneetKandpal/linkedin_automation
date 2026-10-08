import { Locator, Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { Logger } from '../engine/logger';
import { HumanEngine } from '../engine/human.engine';
import { DelayEngine } from '../engine/delay.engine';
import { PageUnresponsiveError } from '../errors/error.types';

/** Rejects with `onTimeout()` if `work` has not settled within `ms`. */
export function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * BasePage centralises helpers shared by all LinkedIn screens.
 * We log navigation + selector waits to make debugging Playwright runs easier.
 */
export abstract class BasePage {
  constructor(
    protected page: Page,
    protected logger: Logger,
    protected humanEngine: HumanEngine,
    protected delayEngine: DelayEngine
  ) {}

  async navigateTo(url: string): Promise<void> {
    this.logger.info('BasePage → navigating', { url });
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  async waitForSelector(selector: string, timeout?: number): Promise<void> {
    this.logger.debug('BasePage → wait for selector', { selector, timeout });
    await this.page.waitForSelector(selector, { timeout });
  }

  async isVisible(selector: string): Promise<boolean> {
    try {
      return await this.isLocatorVisible(this.page.locator(selector).first());
    } catch {
      return false;
    }
  }

  /** Playwright ignores isVisible's timeout option, so a frozen tab would block here forever. */
  protected isLocatorVisible(locator: Locator, timeoutMs = 5000): Promise<boolean> {
    return withTimeout(locator.isVisible(), timeoutMs, () => new Error(`isVisible timed out after ${timeoutMs}ms`));
  }

  /**
   * Throws PageUnresponsiveError if the tab does not answer a trivial script within `timeoutMs`.
   * A tab stuck in a busy loop never answers, and every later page call would wait on it forever.
   */
  protected async assertPageResponsive(timeoutMs = 10000): Promise<void> {
    try {
      await withTimeout(
        this.page.evaluate('document.readyState'),
        timeoutMs,
        () =>
          new PageUnresponsiveError(
            'LinkedIn tab is not responding (the page froze). This usually means LinkedIn rejected the saved ' +
              'session: check the Chrome window and, if it shows a login page, reconnect the account with li-connect.',
            { step: 'page_unresponsive', url: this.page.url(), timeoutMs }
          )
      );
    } catch (err) {
      if (err instanceof PageUnresponsiveError) throw err;
      // Any other failure (e.g. a navigation replaced the page mid-call) means the tab is alive.
    }
  }

  async getText(selector: string): Promise<string> {
    this.logger.debug('BasePage → get text', { selector });
    const element = this.page.locator(selector).first();
    return (await element.textContent()) || '';
  }

  async safeClick(selector: string): Promise<void> {
    await this.humanEngine.clickWithDelay(selector);
  }

  async getCurrentUrl(): Promise<string> {
    this.logger.debug('BasePage → capture URL');
    return this.page.url();
  }

  async screenshot(name: string): Promise<void> {
    mkdirSync('./screenshots', { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await this.page.screenshot({ 
      path: `./screenshots/${name}_${timestamp}.png`,
      fullPage: true 
    });
    this.logger.info(`Screenshot saved: ${name}`);
  }
}
