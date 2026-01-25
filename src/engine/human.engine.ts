import { Page } from '@playwright/test';
import { TypingProfile } from '../config/types';
import { Logger } from './logger';

/**
 * Encapsulates every action that should imitate a human.
 * Handles typing cadence, scroll/hover sequencing, and minor “imperfections”.
 */
export class HumanEngine {
  constructor(
    private page: Page,
    private typingProfile: TypingProfile,
    private logger: Logger
  ) {}

  private randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private shouldSimulateTypo(): boolean {
    return Math.random() < this.typingProfile.typoChance;
  }

  private shouldPauseToThink(): boolean {
    return Math.random() < this.typingProfile.thinkingPauseChance;
  }

  private getRandomTypoChar(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    return chars[Math.floor(Math.random() * chars.length)];
  }

  async typeHumanLike(text: string, selector: string): Promise<void> {
    const element = this.page.locator(selector).first();
    await element.click();

    this.logger.info('HumanEngine → typing start', {
      selector,
      charCount: text.length,
      typingProfile: this.typingProfile,
    });

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      if (this.shouldPauseToThink()) {
        const pause = this.randomBetween(300, 800);
        this.logger.debug('HumanEngine → thinking pause', { charIndex: i, pause });
        await this.page.waitForTimeout(pause);
      }

      if (this.shouldSimulateTypo()) {
        const typoChar = this.getRandomTypoChar();
        this.logger.debug('HumanEngine → simulated typo', { charIndex: i, typoChar });
        await element.pressSequentially(typoChar, {
          delay: this.randomBetween(this.typingProfile.minDelay, this.typingProfile.maxDelay),
        });
        await this.page.waitForTimeout(this.randomBetween(100, 300));
        await element.press('Backspace');
        await this.page.waitForTimeout(this.randomBetween(50, 150));
      }

      await element.pressSequentially(char, {
        delay: this.randomBetween(this.typingProfile.minDelay, this.typingProfile.maxDelay),
      });
    }

    this.logger.info('HumanEngine → typing complete', { selector });
  }

  async scrollToElement(selector: string): Promise<void> {
    const element = this.page.locator(selector).first();
    await element.scrollIntoViewIfNeeded();
    await this.page.waitForTimeout(this.randomBetween(200, 600));
    this.logger.debug('HumanEngine → scrolled to element', { selector });
  }

  async hoverElement(selector: string): Promise<void> {
    const element = this.page.locator(selector).first();
    await element.hover();
    await this.page.waitForTimeout(this.randomBetween(300, 700));
    this.logger.debug('HumanEngine → hovered element', { selector });
  }

  async clickWithDelay(selector: string, preDelay: [number, number] = [200, 500]): Promise<void> {
    await this.scrollToElement(selector);
    await this.hoverElement(selector);
    const delay = this.randomBetween(preDelay[0], preDelay[1]);
    await this.page.waitForTimeout(delay);
    
    const element = this.page.locator(selector).first();
    await element.click();
    
    this.logger.debug('HumanEngine → clicked element', { selector, delayBeforeClick: delay });
  }

  async naturalScroll(distance: number = 300): Promise<void> {
    await this.page.mouse.wheel(0, distance);
    await this.page.waitForTimeout(this.randomBetween(400, 900));
    this.logger.debug('HumanEngine → natural scroll', { distance });
  }
}
