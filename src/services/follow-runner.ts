import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { Page } from '@playwright/test';
import { AllSelectors } from '../config/types';
import { Logger } from '../engine/logger';
import { DelayEngine } from '../engine/delay.engine';
import { HumanEngine } from '../engine/human.engine';
import { SessionPage } from '../pages/SessionPage';
import { CompanyFollowPage } from '../pages/CompanyFollowPage';
import { FollowRow, FollowWorkbook, loadFollowWorkbook } from './follow-excel';
import { AccountModel } from '../db/models/AccountModel';
import { ErrorCode, LoginRedirectError, PageUnresponsiveError, PublisherError } from '../errors/error.types';

export interface FollowRunSummary {
  processed: number;
  followed: number;
  alreadyFollowing: number;
  failed: number;
  challengeHalt: boolean;
}

export interface FollowRunnerOptions {
  account: { accountId: string; profileSlug?: string };
  excelPath: string;
  maxPerRun: number;
  logger: Logger;
  delayEngine: DelayEngine;
  humanEngine: HumanEngine;
  selectors: AllSelectors;
  page: Page;
}

/** Failure screenshots are for diagnosis, not a log; a broken selector would otherwise save one per row. */
const MAX_SCREENSHOTS_PER_RUN = 3;

/**
 * Rows in a row that fail, or show no recognizable Follow/Following button, before the run stops. A changed
 * LinkedIn layout or an outage hits every page, and carrying on would only mark the whole sheet Failed.
 */
const MAX_CONSECUTIVE_PROBLEMS = 4;

/** Errors that say nothing about one company but make continuing pointless. The current row stays blank. */
function isRunHalting(err: unknown): boolean {
  return err instanceof PageUnresponsiveError || err instanceof LoginRedirectError;
}

/** Fisher-Yates shuffle — varies the visit order per run so the footprint is not identical every time. */
export function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** The member's own slug: the post box's link if present, else the clear majority of the first profile links. */
export function pickProfileSlug(ownHref: string | null, firstHrefs: string[]): string | null {
  const slugOf = (href: string | null) => {
    const match = (href || '').match(/\/in\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  };
  const own = slugOf(ownHref);
  if (own) return own;

  const counts = new Map<string, number>();
  for (const href of firstHrefs) {
    const slug = slugOf(href);
    if (slug) counts.set(slug.toLowerCase(), (counts.get(slug.toLowerCase()) || 0) + 1);
  }
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || ranked[0][1] < 3) return null;
  if (ranked.length > 1 && ranked[1][1] * 2 > ranked[0][1]) return null;
  const winner = ranked[0][0];
  const original = firstHrefs.map(slugOf).find(sl => sl && sl.toLowerCase() === winner);
  return original || winner;
}

function slugFromNormalizedUrl(url: string | null): string | null {
  const match = (url || '').match(/\/company\/([^/?#]+)/i);
  return match ? match[1] : null;
}

function toNote(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

/**
 * One-shot follow run for a single account and workbook (no daemon loop).
 * Rows already marked Followed / Already following are skipped; Failed rows
 * are retried. A LinkedIn challenge wall halts the whole run immediately so
 * the remaining rows stay blank for the next invocation.
 */
export class FollowRunner {
  private followPage: CompanyFollowPage;
  private screenshotsTaken = 0;

  constructor(private options: FollowRunnerOptions) {
    this.followPage = new CompanyFollowPage(
      options.page,
      options.selectors.follow,
      options.humanEngine,
      options.delayEngine,
      options.logger
    );
  }

  async run(): Promise<FollowRunSummary> {
    const { account, excelPath, maxPerRun, logger, selectors, page, humanEngine, delayEngine } = this.options;
    const summary: FollowRunSummary = { processed: 0, followed: 0, alreadyFollowing: 0, failed: 0, challengeHalt: false };

    const sessionPage = new SessionPage(page, logger, humanEngine, delayEngine, selectors.login, selectors.common);
    await sessionPage.navigateToLinkedIn();
    await sessionPage.ensureLoggedIn();
    await this.verifyIdentity();

    const workbook = loadFollowWorkbook(excelPath, account.accountId);
    const pending = shuffle(workbook.pendingRows);
    const batch = pending.slice(0, maxPerRun);

    // A company listed twice is resolved once: the later row copies the outcome instead of revisiting the page.
    const resolved = new Map<string, FollowRow>();
    for (const r of workbook.rows) {
      if ((r.status === 'Followed' || r.status === 'Already following') && r.normalizedUrl) {
        resolved.set(r.normalizedUrl.toLowerCase(), r);
      }
    }

    if (workbook.customRows.length > 0) {
      logger.warn(`Follow → ${workbook.customRows.length} rows have text in the '${account.accountId}' column that this tool did not write; they are left untouched`, {
        rows: workbook.customRows.slice(0, 20).map(r => r.rowIndex),
      });
    }

    logger.info('Follow → run plan', {
      accountId: account.accountId,
      totalRows: workbook.rows.length,
      pendingRows: pending.length,
      scheduledThisRun: batch.length,
      maxPerRun,
    });

    let consecutiveProblems = 0;
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      const slug = slugFromNormalizedUrl(row.normalizedUrl) ?? row.name;
      const key = row.normalizedUrl?.toLowerCase();

      const earlier = key ? resolved.get(key) : undefined;
      if (earlier) {
        workbook.markStatus(row, 'Already following', `Duplicate of row ${earlier.rowIndex}`);
        summary.processed++;
        summary.alreadyFollowing++;
        logger.info(`Follow → ${slug} → duplicate of row ${earlier.rowIndex}, not revisited`, { rowIndex: row.rowIndex });
        continue;
      }

      let problem = false;
      try {
        const outcome = await this.processRow(workbook, row);
        if (row.status === 'Followed') summary.followed++;
        else if (row.status === 'Already following') summary.alreadyFollowing++;
        else summary.failed++;
        if (outcome === 'challenge') summary.challengeHalt = true;
        problem = outcome === 'problem';
      } catch (err) {
        // Signed out or a frozen tab says nothing about this company; leave the row blank and stop the run.
        if (isRunHalting(err)) throw err;
        summary.failed++;
        problem = true;
        workbook.markStatus(row, 'Failed', toNote(err));
        logger.error('Follow → row failed', { rowIndex: row.rowIndex, url: row.url, error: String(err) });
        await this.captureScreenshot(`error_row${row.rowIndex}`);
      }

      if (key && (row.status === 'Followed' || row.status === 'Already following')) resolved.set(key, row);
      consecutiveProblems = problem ? consecutiveProblems + 1 : 0;

      summary.processed++;
      logger.info(`Follow → ${slug} → ${row.status}`, {
        rowIndex: row.rowIndex,
        url: row.normalizedUrl || row.url,
        status: row.status,
        note: row.note || undefined,
      });

      if (summary.challengeHalt) {
        logger.error('Follow → challenge wall detected, halting run', {
          rowIndex: row.rowIndex,
          url: row.normalizedUrl || row.url,
          remainingRows: batch.length - i - 1,
        });
        break;
      }

      if (consecutiveProblems >= MAX_CONSECUTIVE_PROBLEMS) {
        throw new PublisherError(
          ErrorCode.CONFIG_INVALID,
          `Stopped after ${consecutiveProblems} pages in a row failed or showed no Follow/Following button. LinkedIn's ` +
            `layout may have changed (check config/selectors/follow.json and output/screenshots), or LinkedIn/the network is having trouble.`,
          { rowIndex: row.rowIndex, remainingRows: batch.length - i - 1 }
        );
      }

      // Pace page visits only: a row that never opened LinkedIn, or has nothing left to visit after it, needs no wait.
      const visitLater = batch.slice(i + 1).some(r => r.normalizedUrl && !resolved.has(r.normalizedUrl.toLowerCase()));
      if (row.normalizedUrl && visitLater) {
        await delayEngine.betweenFollows();
      }
    }

    logger.info('Follow → run finished', { ...summary });
    return summary;
  }

  private async processRow(workbook: FollowWorkbook, row: FollowRow): Promise<'ok' | 'challenge' | 'problem'> {
    if (!row.normalizedUrl) {
      workbook.markStatus(row, 'Failed', 'invalid company URL');
      return 'ok';
    }

    await this.followPage.openCompany(row.normalizedUrl);
    let state = await this.followPage.detectState();
    if (state === 'unknown') {
      // The top card can still be hydrating; look once more before giving up on the page.
      await this.options.delayEngine.wait(2500);
      state = await this.followPage.detectState();
    }

    if (state === 'loggedout') throw this.signedOutError(row);
    if (state === 'challenge') {
      workbook.markStatus(row, 'Failed', 'challenge wall — resume later');
      await this.captureScreenshot(`challenge_row${row.rowIndex}`, true);
      return 'challenge';
    }
    if (state === 'admin') {
      workbook.markStatus(row, 'Failed', 'admin dashboard shown instead of member view');
      return 'ok';
    }
    if (state === 'following') {
      workbook.markStatus(row, 'Already following');
      return 'ok';
    }
    if (state === 'follow') {
      const followed = await this.followPage.follow();
      if (followed) {
        workbook.markStatus(row, 'Followed');
        return 'ok';
      }
      // A challenge wall can appear in response to the click itself, or LinkedIn can sign the account out.
      const afterClick = await this.followPage.detectState();
      if (afterClick === 'loggedout') throw this.signedOutError(row);
      if (afterClick === 'challenge') {
        workbook.markStatus(row, 'Failed', 'challenge wall — resume later');
        await this.captureScreenshot(`challenge_row${row.rowIndex}`, true);
        return 'challenge';
      }
      workbook.markStatus(row, 'Failed', 'follow not confirmed');
      await this.captureScreenshot(`notconfirmed_row${row.rowIndex}`);
      return 'problem';
    }
    if (state === 'notfound') {
      workbook.markStatus(row, 'Failed', 'page not found');
      return 'ok';
    }
    workbook.markStatus(row, 'Failed', 'follow button not found');
    await this.captureScreenshot(`unknown_row${row.rowIndex}`);
    return 'problem';
  }

  private signedOutError(row: FollowRow): LoginRedirectError {
    return new LoginRedirectError('LinkedIn signed the account out during the run. Reconnect it with li-connect, then re-run.', {
      rowIndex: row.rowIndex,
      url: this.options.page.url(),
    });
  }

  /**
   * Reads the logged-in profile slug and guards
   * against driving the wrong LinkedIn account. When the account has no stored
   * slug yet, the observed one is saved so future runs are guarded.
   */
  private async verifyIdentity(): Promise<void> {
    const { account, logger } = this.options;
    const expected = (account.profileSlug || '').trim();
    const observed = await this.readLoggedInProfileSlug();

    if (!observed) {
      logger.warn('Follow → could not read logged-in profile slug, continuing without identity check', {
        accountId: account.accountId,
      });
      return;
    }

    if (!expected) {
      await AccountModel.updateOne({ accountId: account.accountId }, { $set: { profileSlug: observed } });
      account.profileSlug = observed;
      logger.info('Follow → stored profile slug for future identity checks', {
        accountId: account.accountId,
        profileSlug: observed,
      });
      return;
    }

    if (expected.toLowerCase() !== observed.toLowerCase()) {
      throw new PublisherError(
        ErrorCode.SESSION_INVALID,
        `Logged-in profile '${observed}' does not match account '${account.accountId}' (${expected}) — connect the correct account first`,
        { observed, expected, accountId: account.accountId, step: 'identity_check' }
      );
    }

    logger.info('Follow → identity check passed', { accountId: account.accountId, profileSlug: observed });
  }

  /**
   * Reads the signed-in member's profile slug from their own feed. /me/ no longer redirects to /in/<slug>.
   * The feed's "start a post" box links to the member's own profile; failing that, the member's profile
   * card links to it several times in a row, so the slug that clearly dominates the first links wins.
   * Anything ambiguous returns null: a wrong slug stored here would later block the right account.
   */
  private async readLoggedInProfileSlug(): Promise<string | null> {
    const { page, logger, delayEngine } = this.options;
    try {
      if (!/^\/feed\/?$/.test(new URL(page.url()).pathname)) {
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      await page
        .waitForFunction(`document.querySelectorAll('a[href*="/in/"]').length >= 3`, undefined, { timeout: 10000 })
        .catch(() => undefined);
      await delayEngine.wait(500);

      const found = (await page.evaluate(`(() => {
        const own = document.querySelector('#shareboxProfilePictureComponentRef a[href*="/in/"]');
        const first = Array.from(document.querySelectorAll('a[href*="/in/"]')).slice(0, 8).map(a => a.getAttribute('href') || '');
        return { own: own ? own.getAttribute('href') : null, first };
      })()`)) as { own: string | null; first: string[] };
      return pickProfileSlug(found.own, found.first);
    } catch (err) {
      logger.warn('Follow → could not read the profile slug from the feed', { error: String(err) });
      return null;
    }
  }

  private async captureScreenshot(label: string, always = false): Promise<void> {
    if (!always && this.screenshotsTaken >= MAX_SCREENSHOTS_PER_RUN) return;
    this.screenshotsTaken++;
    try {
      const dir = resolve('./output/screenshots');
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const path = resolve(dir, `follow_${this.options.account.accountId}_${label}_${ts}.png`);
      await this.options.page.screenshot({ path, fullPage: false, timeout: 10000 });
      this.options.logger.info('Follow → screenshot saved', { path });
    } catch (err) {
      this.options.logger.warn('Follow → screenshot failed', { error: String(err) });
    }
  }
}
