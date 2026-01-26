import { BrowserContext } from '@playwright/test';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { AppConfig, PublishJob, ArticleContentBlock } from './config/types';
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

export interface PublishResult {
  success: boolean;
  jobId: string;
  accountId: string;
  articleId: string;
  articleUrl?: string;
  error?: string;
  timestamp: string;
}

function resolveArticleBlocks(article: { markdownContent?: string; content?: ArticleContentBlock[] }): ArticleContentBlock[] {
  if (article.markdownContent && article.markdownContent.trim().length > 0) {
    return markdownToBlocks(article.markdownContent);
  }
  throw new Error('Article has no markdownContent');
}

export function markdownToBlocks(markdown: string): ArticleContentBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: ArticleContentBlock[] = [];

  let paragraph: string[] = [];
  let list: string[] = [];
  let listStyle: 'bullet' | 'ordered' | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ').trim();
    if (text) blocks.push({ type: 'paragraph', text });
    paragraph = [];
  };

  const flushList = () => {
    if (list.length === 0) return;
    const text = list.join('\n').trim();
    if (text) blocks.push({ type: 'list', text, listStyle: listStyle || 'bullet' });
    list = [];
    listStyle = null;
  };

  const flushQuote = () => {
    if (quote.length === 0) return;
    const text = quote.join('\n').trimEnd();
    if (text) blocks.push({ type: 'quote', text });
    quote = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      flushParagraph();
      flushQuote();
      continue;
    }

    // horizontal rules (treat as blank separator)
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushList();
      flushParagraph();
      flushQuote();
      continue;
    }

    // image embeds → convert to descriptive paragraph
    const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imageMatch) {
      flushList();
      flushParagraph();
      flushQuote();
      const alt = imageMatch[1] || 'Image';
      const url = imageMatch[2];
      blocks.push({ type: 'paragraph', text: `${alt} (${url})` });
      continue;
    }

    // headings
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushList();
      flushQuote();
      flushParagraph();
      const headingText = headingMatch[2].trim();
      if (headingText) blocks.push({ type: 'heading', text: headingText });
      continue;
    }

    // blockquote
    const quoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushList();
      flushParagraph();
      quote.push(quoteMatch[1].trim());
      continue;
    }

    flushQuote();

    // unordered list items
    const ulMatch = trimmed.match(/^([-*+])\s+(.*)$/);
    if (ulMatch) {
      flushParagraph();
      if (listStyle && listStyle !== 'bullet') flushList();
      listStyle = 'bullet';
      list.push(ulMatch[2].trim());
      continue;
    }

    // ordered list items
    const olMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (olMatch) {
      flushParagraph();
      if (listStyle && listStyle !== 'ordered') flushList();
      listStyle = 'ordered';
      list.push(olMatch[2].trim());
      continue;
    }

    // normal paragraph line (wrap)
    flushList();
    paragraph.push(trimmed);
  }

  flushList();
  flushParagraph();
  flushQuote();
  return blocks;
}

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
      await articleEditorPage.maybeUploadCoverImage(
        article.coverImagePath
          ? /^https?:\/\//i.test(article.coverImagePath)
            ? article.coverImagePath
            : resolve(article.coverImagePath)
          : undefined
      );
      await articleEditorPage.typeTitle(article.title);
      const blocks = resolveArticleBlocks(article);
      await articleEditorPage.typeContent(blocks);

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
