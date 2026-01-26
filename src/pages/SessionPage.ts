import { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { Logger } from '../engine/logger';
import { HumanEngine } from '../engine/human.engine';
import { DelayEngine } from '../engine/delay.engine';
import { Selectors } from '../config/types';
import { CaptchaError, LoginRedirectError, OtpRequiredError } from '../errors/error.types';

export class SessionPage extends BasePage {
  constructor(
    page: Page,
    logger: Logger,
    humanEngine: HumanEngine,
    delayEngine: DelayEngine,
    private loginSelectors: Selectors,
    private commonSelectors: Selectors
  ) {
    super(page, logger, humanEngine, delayEngine);
  }

  async ensureLoggedIn(): Promise<void> {
    this.logger.info('Validating session state');

    const currentUrl = await this.getCurrentUrl();

    if (this.isLoginPage(currentUrl)) {
      this.logger.error('Redirected to login page - session invalid');
      throw new LoginRedirectError('User not logged in', { url: currentUrl });
    }

    if (await this.isCaptchaPresent()) {
      this.logger.error('CAPTCHA detected');
      throw new CaptchaError('CAPTCHA challenge detected', { url: currentUrl });
    }

    if (await this.isOtpRequired()) {
      this.logger.error('OTP verification required');
      throw new OtpRequiredError('OTP verification required', { url: currentUrl });
    }

    this.logger.info('Session validation passed');
  }

  private isLoginPage(url: string): boolean {
    return url.includes('/login') || url.includes('/uas/login');
  }

  private async isCaptchaPresent(): Promise<boolean> {
    return await this.isVisible(this.commonSelectors.captchaIframe);
  }

  private async isOtpRequired(): Promise<boolean> {
    return await this.isVisible(this.loginSelectors.otpInput);
  }

  async navigateToLinkedIn(): Promise<void> {
    await this.navigateTo('https://www.linkedin.com');
    await this.delayEngine.wait(2000);
  }
}
