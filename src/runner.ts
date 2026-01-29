import { BrowserContext } from '@playwright/test';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { AppConfig, PublishJob } from './config/types';
import { ConfigLoader } from './config/loader';
import { Logger } from './engine/logger';
import { DelayEngine } from './engine/delay.engine';
import { HumanEngine } from './engine/human.engine';
import { BrowserContextFactory } from './browser/context.factory';
import { SessionPage } from './pages/SessionPage';
import { ArticleEditorPage } from './pages/ArticleEditorPage';
import { PublishConfirmPage } from './pages/PublishConfirmPage';
import { ProfilePage } from './pages/ProfilePage';
import { PublisherError } from './errors/error.types';
import { markdownToLinkedInHtml } from './markdown/linkedin';

export interface PublishResult {
  success: boolean;
  jobId: string;
  accountId: string;
  articleId: string;
  articleUrl?: string;
  error?: string;
  timestamp: string;
}

// markdownToBlocks removed from runner flow (rich HTML paste is now used).

/**
 * High-level orchestrator that executes publish jobs sequentially.
 * It wires config, engines and Page Objects together and records
 * structured telemetry for every important step.
 */
export class ArticlePublisherRunner {
  private logger: Logger;
  private config: AppConfig;
  private configLoader: ConfigLoader;
  private contextFactory: BrowserContextFactory;

  constructor(configDir: string = './config') {
    const runTs = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = resolve('./output/logs');
    mkdirSync(logDir, { recursive: true });

    this.logger = new Logger({
      logFilePath: resolve(logDir, `run_${runTs}.log`),
      latestLogPath: resolve(logDir, 'latest.log'),
    });
    this.configLoader = new ConfigLoader(configDir);
    this.config = this.configLoader.loadAll();
    this.contextFactory = new BrowserContextFactory(this.config.global, this.logger);
  }

  async run(): Promise<PublishResult[]> {
    const results: PublishResult[] = [];

    const jobsToRun = this.config.publishPlan.slice(
      0,
      this.config.global.execution.maxArticlesPerRun
    );

    this.logger.info('Runner → starting publisher run', { jobs: jobsToRun.length });

    for (const job of jobsToRun) {
      const result = await this.executeJob(job);
      results.push(result);

      if (!result.success && this.config.global.execution.closeBrowserOnFailure) {
        this.logger.warn('Runner → halting after failure (closeBrowserOnFailure=true)');
        break;
      }
    }

    this.logger.info('Runner → publisher run completed', { 
      total: results.length,
      successful: results.filter(r => r.success).length 
    });

    return results;
  }

  /**
   * Executes a single publish job end-to-end. The method is intentionally
   * verbose so logs paint a clear timeline when debugging human-behaviour flows.
   */
  private async executeJob(job: PublishJob): Promise<PublishResult> {
    this.logger.info('Runner → executing job', { jobId: job.jobId, job });

    const result: PublishResult = {
      success: false,
      jobId: job.jobId,
      accountId: job.accountId,
      articleId: job.articleId,
      timestamp: new Date().toISOString(),
    };

    let context: BrowserContext | null = null;
    const traceEnabled = process.env.PW_TRACE === '1' || process.env.PW_TRACE === 'true';
    const screenshotOnError =
      process.env.PW_SCREENSHOT_ON_ERROR === '1' || process.env.PW_SCREENSHOT_ON_ERROR === 'true';
    const traceDir = resolve('./output/traces');
    const traceJobZip = resolve(traceDir, `${job.jobId}.zip`);
    const traceLatestZip = resolve(traceDir, 'latest.zip');

    try {
      const account = this.configLoader.getAccount(this.config, job.accountId);
      const article = this.configLoader.getArticle(this.config, job.articleId);
      const delayProfile = this.config.delays[job.delayProfile];
      const typingProfile = this.config.typingProfiles[job.typingProfile];

      if (!delayProfile) {
        throw new Error(`Delay profile not found: ${job.delayProfile}`);
      }

      if (!typingProfile) {
        throw new Error(`Typing profile not found: ${job.typingProfile}`);
      }

      const delayEngine = new DelayEngine(delayProfile, this.logger);

      this.logger.info('Runner → applying pre-launch delay');
      await delayEngine.preLaunch();

      context = await this.contextFactory.createContext(account);
      const page = context.pages()[0] || await context.newPage();
      this.logger.debug('Runner → acquired Playwright page', { hasExistingPage: context.pages().length > 0 });

      if (traceEnabled) {
        mkdirSync(traceDir, { recursive: true });
        this.logger.info('Runner → starting Playwright tracing', { traceJobZip });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      }

      const humanEngine = new HumanEngine(page, typingProfile, this.logger);

      const sessionPage = new SessionPage(
        page,
        this.logger,
        humanEngine,
        delayEngine,
        this.config.selectors.login,
        this.config.selectors.common
      );

      const articleEditorPage = new ArticleEditorPage(
        page,
        this.logger,
        humanEngine,
        delayEngine,
        this.config.selectors.articleEditor
      );

      const publishPage = new PublishConfirmPage(
        page,
        this.logger,
        humanEngine,
        delayEngine,
        this.config.selectors.publish
      );

      const profilePage = new ProfilePage(
        page,
        this.logger,
        humanEngine,
        delayEngine
      );

      await sessionPage.navigateToLinkedIn();
      await sessionPage.ensureLoggedIn();

      await articleEditorPage.openNewArticle();
      const uploadedCover = await articleEditorPage.maybeUploadCoverImage(
        article.coverImagePath
          ? /^https?:\/\//i.test(article.coverImagePath)
            ? article.coverImagePath
            : resolve(article.coverImagePath)
          : undefined
      );
      if (uploadedCover) {
        this.logger.info('Runner → waiting 10s after cover upload before typing title', { articleId: article.articleId });
        await delayEngine.wait(10_000);
      }
      await articleEditorPage.typeTitle(article.title);
      const html = markdownToLinkedInHtml(article.markdownContent || '');
      await articleEditorPage.pasteHtmlContent(html);

      await publishPage.publish({
        communityPostText: article.communityPostText,
      });

      const articleUrl = await publishPage.getPublishedArticleUrl();
      if (articleUrl) {
        result.articleUrl = articleUrl;
        
        const verified = await profilePage.verifyArticlePublished(articleUrl);
        if (verified) {
          this.logger.info('Article verified successfully');
        }
      }

      result.success = true;
      this.logger.info(`Job completed successfully: ${job.jobId}`);

    } catch (error) {
      this.logger.error('Runner → job failed', { jobId: job.jobId, error: String(error) });

      if (screenshotOnError && context) {
        try {
          const page = context.pages()[0];
          if (page) {
            mkdirSync(resolve('./screenshots'), { recursive: true });
            await page.screenshot({
              path: resolve('./screenshots', `error_${job.jobId}.png`),
              fullPage: true,
            });
            this.logger.info('Runner → saved error screenshot', { jobId: job.jobId });
          }
        } catch (screenshotError) {
          this.logger.warn('Runner → failed to capture error screenshot', { error: String(screenshotError) });
        }
      }
      
      if (error instanceof PublisherError) {
        result.error = `[${error.code}] ${error.message}`;
      } else if (error instanceof Error) {
        result.error = error.message;
      } else {
        result.error = String(error);
      }
    } finally {
      if (traceEnabled && context) {
        try {
          await context.tracing.stop({ path: traceJobZip });
          // keep a stable pointer for convenience
          mkdirSync(traceDir, { recursive: true });
          copyFileSync(traceJobZip, traceLatestZip);
          this.logger.info('Runner → trace saved', { traceJobZip, traceLatestZip });
        } catch (traceError) {
          this.logger.warn('Runner → failed to save trace', { error: String(traceError) });
        }
      }
      await this.contextFactory.closeContext();
    }

    return result;
  }

  getLogger(): Logger {
    return this.logger;
  }
}
