import { Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { Logger } from '../engine/logger';
import { HumanEngine } from '../engine/human.engine';
import { DelayEngine } from '../engine/delay.engine';

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
      const element = this.page.locator(selector).first();
      return await element.isVisible({ timeout: 5000 });
    } catch {
      return false;
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
