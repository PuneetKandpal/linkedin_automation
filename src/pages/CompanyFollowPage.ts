import { Locator, Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { Logger } from '../engine/logger';
import { HumanEngine } from '../engine/human.engine';
import { DelayEngine } from '../engine/delay.engine';
import { FollowSelectors } from '../config/types';

export type CompanyFollowState =
  | 'follow'
  | 'following'
  | 'admin'
  | 'challenge'
  | 'loggedout'
  | 'notfound'
  | 'unknown';

/**
 * Company page follow/unfollow surface. LinkedIn markup changes often, so every
 * state check runs a list of selector candidates and classifies the matched
 * button by its accessible label — "Follow <name>" vs "Following <name>".
 * "Follow" is a substring of "Following", so raw selector matches alone can
 * never be trusted.
 *
 * Buttons are only ever looked up inside the page's own top card: the right
 * rail ("Pages people also viewed", promoted pages) is full of Follow buttons
 * for other companies, and clicking one of those would follow the wrong page.
 *
 * Pages are opened in member view (?viewAsMember=true). An account that
 * administers a page is otherwise redirected to the admin dashboard, which has
 * no Follow button; in member view the same page shows its real follow state.
 */
export class CompanyFollowPage extends BasePage {
  constructor(
    page: Page,
    private followSelectors: FollowSelectors,
    humanEngine: HumanEngine,
    delayEngine: DelayEngine,
    logger: Logger
  ) {
    super(page, logger, humanEngine, delayEngine);
  }

  async openCompany(normalizedUrl: string): Promise<void> {
    const target = `${normalizedUrl}/?viewAsMember=true`;
    this.logger.info('CompanyFollowPage → opening company page', { url: target });
    await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.settle(normalizedUrl);
  }

  /** Waits until the freshly loaded page shows something recognizable. */
  private async settle(url: string): Promise<void> {
    await this.assertPageResponsive();

    if (!this.stateFromUrl()) {
      const settled = await this.waitForAnyVisible(
        [
          this.followSelectors.topCard,
          this.followSelectors.adminNav,
          this.followSelectors.challengeWall,
          this.followSelectors.challengeWallText,
          this.followSelectors.pageNotFound,
        ],
        20000
      );
      if (!settled) {
        this.logger.warn('CompanyFollowPage → no known landmark appeared, continuing with state detection', { url });
      }
    }
    await this.delayEngine.wait(1500);
  }

  /** States LinkedIn signals through the URL alone, so the page itself needs no reading. */
  private stateFromUrl(): CompanyFollowState | null {
    let path: string;
    try {
      path = new URL(this.page.url()).pathname;
    } catch {
      return null;
    }
    // Anchored to the start of the path: a company called "Login Labs" lives at /company/login-labs.
    if (/^\/(login|uas\/login|authwall|signup)/.test(path) || /^\/hp\/?$/.test(path)) return 'loggedout';
    if (/^\/checkpoint(\/|$)/.test(path)) return 'challenge';
    if (/^\/company\/unavailable\/?$/.test(path)) return 'notfound';
    if (/^\/company\/[^/]+\/admin\//.test(path)) return 'admin';
    return null;
  }

  async detectState(): Promise<CompanyFollowState> {
    const fromUrl = this.stateFromUrl();
    if (fromUrl) return fromUrl;

    if (await this.isAnyVisible([this.followSelectors.challengeWall])) return 'challenge';
    if (await this.isAnyVisible([this.followSelectors.adminNav])) return 'admin';

    const scope = await this.resolveScope();
    if (scope) {
      if (await this.locateActionButton(scope, 'following')) return 'following';
      if (await this.locateActionButton(scope, 'follow')) return 'follow';
    }

    // Free-text checks come last: a company's own posts can say "captcha" or "page not found", and
    // must not turn a page that has a real Follow button into a challenge wall or a 404.
    if (await this.isAnyVisible([this.followSelectors.challengeWallText])) return 'challenge';
    if (await this.isAnyVisible([this.followSelectors.pageNotFound])) return 'notfound';
    return 'unknown';
  }

  /**
   * Clicks the primary Follow button with human cadence and confirms the state
   * flipped to "following". If the page already shows "following" it returns
   * true immediately and NEVER clicks (clicking would unfollow).
   */
  async follow(): Promise<boolean> {
    const before = await this.detectState();
    if (before === 'following') return true;
    if (before !== 'follow') return false;

    const scope = await this.resolveScope();
    const target = scope && (await this.locateActionButton(scope, 'follow'));
    if (!target) return false;

    await this.humanEngine.naturalScroll(300);
    await this.humanEngine.naturalScroll(-150);
    await this.delayEngine.beforeFollowClick();

    try {
      await target.scrollIntoViewIfNeeded();
      await target.hover();
      await this.page.waitForTimeout(this.randomBetween(300, 700));
      await target.click({ timeout: 10000 });
      this.logger.info('CompanyFollowPage → follow click dispatched');
    } catch (err) {
      this.logger.warn('CompanyFollowPage → follow click failed', { error: String(err) });
      return false;
    }

    const deadline = Date.now() + 10000;
    for (;;) {
      const state = await this.detectState();
      if (state === 'following') {
        this.logger.info('CompanyFollowPage → state flipped to following');
        return await this.confirmFollowPersisted();
      }
      if (state === 'challenge' || state === 'loggedout' || Date.now() > deadline) {
        this.logger.warn('CompanyFollowPage → follow state did not flip to following', { state });
        return false;
      }
      await this.delayEngine.wait(1200);
    }
  }

  /**
   * LinkedIn flips the button to "Following" before its request has finished, and the request is lost if
   * the browser closes or navigates away first (the last follow of a run was lost exactly this way).
   * So the flip proves nothing: only a "Following" that is still there after a reload counts. A second
   * look covers LinkedIn taking a moment to show the new state.
   */
  private async confirmFollowPersisted(): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await this.delayEngine.wait(this.randomBetween(2500, 4000));
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.settle(this.page.url());

      const state = await this.detectState();
      if (state === 'following') {
        this.logger.info('CompanyFollowPage → follow confirmed after reload');
        return true;
      }
      this.logger.warn('CompanyFollowPage → follow not visible after reload', { attempt, state });
      if (state !== 'follow') return false;
    }
    return false;
  }

  private randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private followButtonCandidates(): string[] {
    return [this.followSelectors.followButton, this.followSelectors.followButtonAlt].filter(
      (s): s is string => typeof s === 'string' && s.length > 0
    );
  }

  private followingButtonCandidates(): string[] {
    return [this.followSelectors.followingButton, this.followSelectors.followingButtonAlt].filter(
      (s): s is string => typeof s === 'string' && s.length > 0
    );
  }

  /** The page's own top card, or null. Never falls back to the whole page (see class doc). */
  private async resolveScope(): Promise<Locator | null> {
    for (const selector of [this.followSelectors.topCard, this.followSelectors.topCardAlt]) {
      if (!selector) continue;
      try {
        const topCard = this.page.locator(selector).first();
        if (await this.isLocatorVisible(topCard, 3000)) return topCard;
      } catch {
        // try the next candidate
      }
    }
    return null;
  }

  private async isAnyVisible(selectors: Array<string | undefined>, timeoutMs = 1500): Promise<boolean> {
    for (const selector of selectors) {
      if (!selector) continue;
      try {
        if (await this.isLocatorVisible(this.page.locator(selector).first(), timeoutMs)) {
          return true;
        }
      } catch {
        // selector not present
      }
    }
    return false;
  }

  private async waitForAnyVisible(selectors: Array<string | undefined>, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isAnyVisible(selectors, 500)) return true;
      await this.delayEngine.wait(400);
    }
    return false;
  }

  /** Finds the first visible action button classified as `kind`, scoped to the top card when present. */
  private async locateActionButton(scope: Locator, kind: 'follow' | 'following'): Promise<Locator | null> {
    const candidates = kind === 'follow' ? this.followButtonCandidates() : this.followingButtonCandidates();
    for (const selector of candidates) {
      let count = 0;
      try {
        count = await scope.locator(selector).count();
      } catch {
        continue;
      }
      for (let i = 0; i < count; i++) {
        const el = scope.locator(selector).nth(i);
        try {
          if (!(await this.isLocatorVisible(el))) continue;
          if ((await this.classifyButton(el)) === kind) {
            return el;
          }
        } catch {
          // element detached, try next
        }
      }
    }
    return null;
  }

  private async classifyButton(el: Locator): Promise<'follow' | 'following' | null> {
    let label = ((await el.getAttribute('aria-label')) || '').trim();
    if (!label) {
      label = ((await el.textContent()) || '').trim();
    }
    const normalized = label.toLowerCase().replace(/^[^a-z]+/, '');
    if (normalized.startsWith('following')) return 'following';
    if (normalized.startsWith('follow')) return 'follow';
    return null;
  }
}
