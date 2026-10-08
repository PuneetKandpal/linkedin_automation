import { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { Logger } from '../engine/logger';
import { HumanEngine } from '../engine/human.engine';
import { DelayEngine } from '../engine/delay.engine';
import { Selectors } from '../config/types';
import { CaptchaError, LoginRedirectError, OtpRequiredError, SessionError } from '../errors/error.types';

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

    await this.assertPageResponsive();

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

    // An expired session does not always redirect to /login: linkedin.com just renders the
    // signed-out guest homepage. Check the auth cookie and what the page actually shows.
    if (!(await this.hasAuthCookie())) {
      this.logger.error('LinkedIn auth cookie (li_at) missing - session expired');
      throw new SessionError('LinkedIn session expired (li_at cookie missing) - reconnect the account', {
        url: currentUrl,
        step: 'session_check',
      });
    }

    const pageState = await this.detectPageState();
    if (pageState === 'signed_out') {
      this.logger.error('LinkedIn is showing the signed-out page - session expired', { url: this.page.url() });
      throw new SessionError('LinkedIn session expired (signed-out page shown) - reconnect the account', {
        url: this.page.url(),
        step: 'session_check',
      });
    }
    if (pageState === 'unknown') {
      this.logger.warn('Could not confirm signed-in navigation bar, continuing', { url: this.page.url() });
    }

    this.logger.info('Session validation passed', { url: this.page.url() });
  }

  private isLoginPage(url: string): boolean {
    if (url.includes('/login') || url.includes('/uas/login') || url.includes('/authwall')) return true;
    // /hp and /signup are the signed-out landing pages LinkedIn redirects guests to.
    const path = url.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
    return path === '/hp' || path.startsWith('/hp/') || path.startsWith('/signup');
  }

  private async hasAuthCookie(): Promise<boolean> {
    const cookies = await this.page.context().cookies('https://www.linkedin.com');
    return cookies.some(c => c.name === 'li_at' && c.value.length > 0);
  }

  private async detectPageState(): Promise<'signed_in' | 'signed_out' | 'unknown'> {
    // Signed-out visitors are never served the feed.
    if (new URL(this.page.url()).pathname.startsWith('/feed')) return 'signed_in';

    const signedIn = this.page.locator('#global-nav, header.global-nav, nav.global-nav').first();
    const signedOut = this.page.getByRole('link', { name: /^(sign in|join now)$/i }).first();

    try {
      return await Promise.race([
        signedIn.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'signed_in' as const),
        signedOut.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'signed_out' as const),
      ]);
    } catch {
      return 'unknown';
    }
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
