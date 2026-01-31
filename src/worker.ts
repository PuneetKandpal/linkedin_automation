import './env';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { connectMongo } from './db/mongo';
import { decryptJson } from './db/crypto';
import { AccountModel } from './db/models/AccountModel';
import { ArticleModel } from './db/models/ArticleModel';
import { PublishJobModel } from './db/models/PublishJobModel';
import { AccountIssueModel } from './db/models/AccountIssueModel';
import { StaticConfigLoader } from './config/static-loader';
import { Logger } from './engine/logger';
import { DelayEngine } from './engine/delay.engine';
import { HumanEngine } from './engine/human.engine';
import { BrowserContextFactory } from './browser/context.factory';
import { SessionPage } from './pages/SessionPage';
import { ArticleEditorPage } from './pages/ArticleEditorPage';
import { PublishConfirmPage } from './pages/PublishConfirmPage';
import { ProfilePage } from './pages/ProfilePage';
import { ErrorCode, PublisherError } from './errors/error.types';
import { markdownToLinkedInHtml } from './markdown/linkedin';

function setupGlobalErrorHandlers() {
  process.on('unhandledRejection', err => {
    // eslint-disable-next-line no-console
    console.error('Worker → unhandledRejection', err);
  });

  process.on('uncaughtException', err => {
    // eslint-disable-next-line no-console
    console.error('Worker → uncaughtException', err);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function normalizeCompanyPageUrl(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '').toLowerCase();
}

async function runOne(jobId: string, configDir: string): Promise<void> {
  const loader = new StaticConfigLoader(configDir);
  const cfg = loader.loadAll();

  const runTs = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = resolve('./output/logs');
  mkdirSync(logDir, { recursive: true });

  const logger = new Logger({
    logFilePath: resolve(logDir, `worker_${jobId}_${runTs}.log`),
    latestLogPath: resolve(logDir, 'latest_worker.log'),
  });

  logger.info('Worker → starting job run', { jobId });

  let job = await PublishJobModel.findOne({ jobId }).lean();
  if (!job) throw new Error(`Job not found: ${jobId}`);

  if (!process.env.STORAGE_STATE_SECRET) {
    throw new Error('Missing STORAGE_STATE_SECRET');
  }

  logger.info('Worker → loaded job', {
    jobId: job.jobId,
    accountId: job.accountId,
    articleId: job.articleId,
    runAt: job.runAt,
    delayProfile: job.delayProfile,
    typingProfile: job.typingProfile,
    companyPageUrl: (job as any).companyPageUrl,
    companyPageName: (job as any).companyPageName,
  });

  let account = await AccountModel.findOne({ accountId: job.accountId }).lean();
  if (!account) throw new Error(`Account not found: ${job.accountId}`);

  logger.info('Worker → loaded account', {
    jobId: job.jobId,
    accountId: account.accountId,
    status: account.status,
    authStatus: account.authStatus,
    hasProxy: Boolean(account.proxy),
    hasStorageState: Boolean(account.storageStateEnc),
  });

  let article = await ArticleModel.findOne({ articleId: job.articleId }).lean();
  if (!article) throw new Error(`Article not found: ${job.articleId}`);

  logger.info('Worker → loaded article', {
    jobId: job.jobId,
    articleId: article.articleId,
    status: article.status,
    hasMarkdown: Boolean(article.markdownContent && article.markdownContent.trim().length > 0),
    hasCoverUrl: Boolean(article.coverImagePath),
  });

  if (!article.markdownContent || article.markdownContent.trim().length === 0) {
    throw new Error(`Article has empty markdownContent: ${article.articleId}`);
  }

  let contextFactory: BrowserContextFactory | null = null;

  try {
    if (account.status !== 'active') {
      throw new Error(`Account is not active: ${account.accountId}`);
    }

    if (!account.storageStateEnc) {
      throw new Error(`Account has no storage state: ${account.accountId}`);
    }

    const storageState = decryptJson<unknown>(account.storageStateEnc);

    const delayProfile = cfg.delays[job.delayProfile];
    const typingProfile = cfg.typingProfiles[job.typingProfile];
    if (!delayProfile) throw new Error(`Delay profile not found: ${job.delayProfile}`);
    if (!typingProfile) throw new Error(`Typing profile not found: ${job.typingProfile}`);

    const delayEngine = new DelayEngine(delayProfile, logger);
    contextFactory = new BrowserContextFactory(cfg.global, logger);

    await ArticleModel.updateOne(
      { articleId: article.articleId },
      { $set: { status: 'publishing', lastError: undefined } }
    );

    const context = await contextFactory.createContext({
      accountId: account.accountId,
      proxy: account.proxy,
      timezone: account.timezone,
      status: 'active',
      displayName: account.displayName,
      email: account.email,
      storageState,
    });

    const page = context.pages()[0] || (await context.newPage());

    const humanEngine = new HumanEngine(page, typingProfile, logger);

    const sessionPage = new SessionPage(
      page,
      logger,
      humanEngine,
      delayEngine,
      cfg.selectors.login,
      cfg.selectors.common
    );

    const articleEditorPage = new ArticleEditorPage(
      page,
      logger,
      humanEngine,
      delayEngine,
      cfg.selectors.articleEditor
    );

    const publishPage = new PublishConfirmPage(
      page,
      logger,
      humanEngine,
      delayEngine,
      cfg.selectors.publish
    );

    const profilePage = new ProfilePage(page, logger, humanEngine, delayEngine);

    await sessionPage.navigateToLinkedIn();
    await sessionPage.ensureLoggedIn();

    const rawCompanyPageUrl = typeof (job as any).companyPageUrl === 'string' ? (job as any).companyPageUrl : undefined;
    let companyPageUrl = rawCompanyPageUrl && rawCompanyPageUrl.trim().length > 0 ? rawCompanyPageUrl.trim() : undefined;
    let companyPageName = typeof (job as any).companyPageName === 'string' && (job as any).companyPageName.trim().length > 0
      ? (job as any).companyPageName.trim()
      : undefined;

    if (!companyPageName && companyPageUrl) {
      const accountPages = Array.isArray((account as any).companyPages) ? ((account as any).companyPages as Array<{ url?: string; name?: string }>) : [];
      const normalizedTarget = normalizeCompanyPageUrl(companyPageUrl);
      const matched = accountPages.find(p => normalizeCompanyPageUrl(p.url) === normalizedTarget);
      if (matched?.name) {
        companyPageName = matched.name;
      }
    }
    if ((companyPageUrl && companyPageUrl.trim().length > 0) || (companyPageName && companyPageName.trim().length > 0)) {
      await articleEditorPage.openNewCompanyPageArticle({ companyPageUrl, companyPageName });
    } else {
      await articleEditorPage.openNewArticle();
    }

    const coverUrl = article.coverImagePath;
    if (coverUrl && !/^https?:\/\//i.test(coverUrl)) {
      logger.warn('Worker → coverImagePath is not an http(s) URL, skipping cover upload', {
        jobId: job.jobId,
        articleId: article.articleId,
        coverImagePath: coverUrl,
      });
    }
    const uploadedCover = await articleEditorPage.maybeUploadCoverImage(
      coverUrl && /^https?:\/\//i.test(coverUrl) ? coverUrl : undefined
    );

    if (uploadedCover) {
      logger.info('Worker → waiting 10s after cover upload before typing title', { jobId: job.jobId });
      await delayEngine.wait(10_000);
    }
    await articleEditorPage.typeTitle(article.title);

    const html = markdownToLinkedInHtml(article.markdownContent);
    await articleEditorPage.pasteHtmlContent(html);

    await publishPage.publish({ communityPostText: article.communityPostText });

    const articleUrl = await publishPage.getPublishedArticleUrl();
    if (articleUrl) {
      const verified = await profilePage.verifyArticlePublished(articleUrl);
      if (!verified) {
        logger.warn('Article verification failed', { articleUrl });
      }

      await ArticleModel.updateOne(
        { articleId: article.articleId },
        {
          $set: {
            status: 'published',
            publishedAt: new Date(),
            publishedUrl: articleUrl,
            publishedByAccountId: account.accountId,
            publishedByAccountName: account.displayName,
            publishedFromCompanyPageUrl: companyPageUrl,
            publishedFromCompanyPageName: companyPageName,
            lastError: undefined,
          },
        }
      );

      await PublishJobModel.updateOne(
        { jobId: job.jobId },
        { $set: { status: 'success', finishedAt: new Date(), articleUrl } }
      );

      await AccountModel.updateOne(
        { accountId: account.accountId },
        { $set: { authStatus: 'valid', lastAuthError: undefined } }
      );
    } else {
      throw new Error('No article URL captured');
    }
  } catch (err) {
    const msg = String(err);
    logger.error('Worker job failed', { jobId, error: msg });

    let code: string = ErrorCode.UNKNOWN;
    let metadata: Record<string, unknown> | undefined;

    if (err instanceof PublisherError) {
      code = err.code;
      metadata = err.metadata;
    }

    const step =
      (metadata && typeof (metadata as any).step === 'string' ? String((metadata as any).step) : undefined) ||
      (err && typeof (err as any).name === 'string' ? String((err as any).name) : undefined);

    if (job) {
      await PublishJobModel.updateOne(
        { jobId },
        { $set: { status: 'failed', finishedAt: new Date(), error: msg, errorCode: code, errorStep: step } }
      );

      await ArticleModel.updateOne(
        { articleId: job.articleId },
        { $set: { status: 'failed', lastError: msg } }
      );

      await AccountIssueModel.create({
        accountId: job.accountId,
        code,
        message: msg,
        metadata,
        status: 'open',
      });
    }

    if (
      code === ErrorCode.CAPTCHA_DETECTED ||
      code === ErrorCode.OTP_REQUIRED ||
      code === ErrorCode.LOGIN_REDIRECT ||
      code === ErrorCode.SESSION_INVALID
    ) {
      await AccountModel.updateOne(
        { accountId: job.accountId },
        { $set: { authStatus: 'needs_reauth', lastAuthError: msg } }
      );
    }
  } finally {
    if (contextFactory) {
      await contextFactory.closeContext();
    }
  }
}

async function main() {
  const configDir = process.env.CONFIG_DIR || './config';
  const pollMs = Number(process.env.WORKER_POLL_MS || 5000);

  await connectMongo();

  for (;;) {
    try {
      const now = new Date();

      const job = await PublishJobModel.findOneAndUpdate(
        { status: 'pending', runAt: { $lte: now } },
        { $set: { status: 'running', startedAt: new Date() } },
        { sort: { runAt: 1 }, new: true }
      ).lean();

      if (!job) {
        await sleep(pollMs);
        continue;
      }

      await runOne(job.jobId, configDir);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Worker → loop error', err);
      await sleep(pollMs);
    }
  }
}

setupGlobalErrorHandlers();

function start() {
  void main().catch(err => {
    // eslint-disable-next-line no-console
    console.error('Worker → main failed', err);
    setTimeout(start, 2_000);
  });
}

start();
