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
import { markdownToBlocks } from './runner';

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
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

    await articleEditorPage.openNewArticle();

    const coverUrl = article.coverImagePath;
    if (coverUrl && !/^https?:\/\//i.test(coverUrl)) {
      logger.warn('Worker → coverImagePath is not an http(s) URL, skipping cover upload', {
        jobId: job.jobId,
        articleId: article.articleId,
        coverImagePath: coverUrl,
      });
    }
    await articleEditorPage.maybeUploadCoverImage(
      coverUrl && /^https?:\/\//i.test(coverUrl) ? coverUrl : undefined
    );
    await articleEditorPage.typeTitle(article.title);

    const blocks = markdownToBlocks(article.markdownContent);
    await articleEditorPage.typeContent(blocks);

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

    if (job) {
      await PublishJobModel.updateOne(
        { jobId },
        { $set: { status: 'failed', finishedAt: new Date(), error: msg } }
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
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
