import { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { Logger } from '../engine/logger';
import { HumanEngine } from '../engine/human.engine';
import { DelayEngine } from '../engine/delay.engine';

export class ProfilePage extends BasePage {
  constructor(
    page: Page,
    logger: Logger,
    humanEngine: HumanEngine,
    delayEngine: DelayEngine
  ) {
    super(page, logger, humanEngine, delayEngine);
  }

  async verifyArticlePublished(articleUrl: string): Promise<boolean> {
    this.logger.info('Verifying article publication', { url: articleUrl });

    try {
      await this.navigateTo(articleUrl);
      await this.delayEngine.wait(3000);

      const currentUrl = await this.getCurrentUrl();
      const isValid = currentUrl === articleUrl || currentUrl.includes('/posts/');

      if (isValid) {
        this.logger.info('Article verification successful');
      } else {
        this.logger.warn('Article verification failed - URL mismatch', { 
          expected: articleUrl, 
          actual: currentUrl 
        });
      }

      return isValid;
    } catch (error) {
      this.logger.error('Article verification error', { error: String(error) });
      return false;
    }
  }

  async navigateToProfile(): Promise<void> {
    this.logger.info('Navigating to profile');
    await this.navigateTo('https://www.linkedin.com/in/me/');
    await this.delayEngine.wait(2000);
  }
}
