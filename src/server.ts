import './env';
import express, { NextFunction, Request, Response } from 'express';
import { connectMongo } from './db/mongo';
import { AccountModel } from './db/models/AccountModel';
import { ArticleModel } from './db/models/ArticleModel';
import { PublishJobModel } from './db/models/PublishJobModel';
import { AccountIssueModel } from './db/models/AccountIssueModel';
import { Logger } from './engine/logger';
import type { AccountDoc } from './db/models/AccountModel';
import type { ArticleDoc } from './db/models/ArticleModel';
import { StaticConfigLoader } from './config/static-loader';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

async function main() {
  await connectMongo();

  const logger = new Logger({ latestLogPath: './output/logs/latest_api.log' });

  const configDir = process.env.CONFIG_DIR || './config';
  const staticCfg = new StaticConfigLoader(configDir).loadAll();

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info('HTTP', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  app.get('/health', (req: Request, res: Response) => {
    void req;
    return res.json({ ok: true });
  });

  app.get('/accounts', asyncHandler(async (req: Request, res: Response) => {
    void req;
    const accounts = await AccountModel.find({}, { storageStateEnc: 0 }).lean();
    return res.json(accounts);
  }));

  app.post('/accounts', asyncHandler(async (req: Request, res: Response) => {
    const { accountId, displayName, email, timezone, proxy, status } = req.body as Record<string, unknown>;

    if (typeof accountId !== 'string' || accountId.trim().length === 0) {
      return res.status(400).json({ error: 'Missing accountId' });
    }
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      return res.status(400).json({ error: 'Missing displayName' });
    }
    if (typeof email !== 'string' || email.trim().length === 0) {
      return res.status(400).json({ error: 'Missing email' });
    }
    if (typeof timezone !== 'string' || timezone.trim().length === 0) {
      return res.status(400).json({ error: 'Missing timezone' });
    }

    const existing = await AccountModel.findOne({ accountId }).lean();
    if (existing) return res.status(409).json({ error: 'Account already exists' });

    const created = await AccountModel.create({
      accountId,
      displayName,
      email,
      timezone,
      proxy,
      status: status === 'disabled' ? 'disabled' : 'active',
      authStatus: 'unknown',
    });

    logger.info('Account created', { accountId: created.accountId });
    return res.status(201).json({ accountId: created.accountId });
  }));

  app.patch('/accounts/:accountId', asyncHandler(async (req: Request, res: Response) => {
    const { accountId } = req.params;
    if (!accountId) return res.status(400).json({ error: 'Missing accountId' });

    const body = req.body as Record<string, unknown>;
    const update: Record<string, unknown> = {};

    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string' || body.displayName.trim().length === 0) {
        return res.status(400).json({ error: 'displayName must be a non-empty string' });
      }
      update.displayName = body.displayName;
    }

    if (body.email !== undefined) {
      if (typeof body.email !== 'string' || body.email.trim().length === 0) {
        return res.status(400).json({ error: 'email must be a non-empty string' });
      }
      update.email = body.email;
    }

    if (body.timezone !== undefined) {
      if (typeof body.timezone !== 'string' || body.timezone.trim().length === 0) {
        return res.status(400).json({ error: 'timezone must be a non-empty string' });
      }
      update.timezone = body.timezone;
    }

    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'disabled') {
        return res.status(400).json({ error: "status must be 'active' or 'disabled'" });
      }
      update.status = body.status;
    }

    if (body.proxy !== undefined) {
      // Proxy is optional and validated in downstream context creation.
      update.proxy = body.proxy;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No allowed fields provided to update' });
    }

    const updated = await AccountModel.findOneAndUpdate(
      { accountId },
      { $set: update },
      { new: true, projection: { storageStateEnc: 0 } }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Account not found' });
    return res.json(updated);
  }));

  app.get('/accounts/:accountId/issues', asyncHandler(async (req: Request, res: Response) => {
    const issues = await AccountIssueModel.find({ accountId: req.params.accountId }).sort({ createdAt: -1 }).lean();
    return res.json(issues);
  }));

  app.get('/articles', asyncHandler(async (req: Request, res: Response) => {
    const status = req.query.status as string | undefined;
    const query: Record<string, unknown> = status ? { status } : {};
    const articles = await ArticleModel.find(query).sort({ updatedAt: -1 }).lean();
    return res.json(articles);
  }));

  app.post('/articles', asyncHandler(async (req: Request, res: Response) => {
    const { articleId, language, title, markdownContent, coverImagePath, communityPostText } =
      req.body as Record<string, unknown>;

    if (typeof articleId !== 'string' || articleId.trim().length === 0) {
      return res.status(400).json({ error: 'Missing articleId' });
    }
    if (typeof language !== 'string' || language.trim().length === 0) {
      return res.status(400).json({ error: 'Missing language' });
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ error: 'Missing title' });
    }
    if (typeof markdownContent !== 'string' || markdownContent.trim().length === 0) {
      return res.status(400).json({ error: 'Missing markdownContent' });
    }
    if (coverImagePath !== undefined && !isHttpUrl(coverImagePath)) {
      return res.status(400).json({ error: 'coverImagePath must be an http(s) URL' });
    }

    const existing = await ArticleModel.findOne({ articleId }).lean();
    if (existing) return res.status(409).json({ error: 'Article already exists' });

    const created = await ArticleModel.create({
      articleId,
      language,
      title,
      markdownContent,
      coverImagePath,
      communityPostText,
      status: 'draft',
    });

    logger.info('Article created', { articleId: created.articleId });
    return res.status(201).json({ articleId: created.articleId });
  }));

  app.patch('/articles/:articleId', asyncHandler(async (req: Request, res: Response) => {
    const { articleId } = req.params;
    if (!articleId) return res.status(400).json({ error: 'Missing articleId' });

    const body = req.body as Record<string, unknown>;
    const update: Record<string, unknown> = {};

    if (body.language !== undefined) {
      if (typeof body.language !== 'string' || body.language.trim().length === 0) {
        return res.status(400).json({ error: 'language must be a non-empty string' });
      }
      update.language = body.language;
    }

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim().length === 0) {
        return res.status(400).json({ error: 'title must be a non-empty string' });
      }
      update.title = body.title;
    }

    if (body.markdownContent !== undefined) {
      if (typeof body.markdownContent !== 'string' || body.markdownContent.trim().length === 0) {
        return res.status(400).json({ error: 'markdownContent must be a non-empty string' });
      }
      update.markdownContent = body.markdownContent;
    }

    if (body.coverImagePath !== undefined) {
      if (body.coverImagePath !== null && !isHttpUrl(body.coverImagePath)) {
        return res.status(400).json({ error: 'coverImagePath must be an http(s) URL' });
      }
      update.coverImagePath = body.coverImagePath;
    }

    if (body.communityPostText !== undefined) {
      if (body.communityPostText !== null && typeof body.communityPostText !== 'string') {
        return res.status(400).json({ error: 'communityPostText must be a string' });
      }
      update.communityPostText = body.communityPostText;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No allowed fields provided to update' });
    }

    const updated = await ArticleModel.findOneAndUpdate(
      { articleId },
      { $set: update },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Article not found' });
    return res.json(updated);
  }));

  app.post('/articles/:articleId/ready', asyncHandler(async (req: Request, res: Response) => {
    void req.body;
    const existing = (await ArticleModel.findOne({ articleId: req.params.articleId }).lean()) as ArticleDoc | null;
    if (!existing) return res.status(404).json({ error: 'Article not found' });
    if (existing.status === 'published') return res.status(400).json({ error: 'Article already published' });

    const updated = await ArticleModel.findOneAndUpdate(
      { articleId: req.params.articleId },
      { $set: { status: 'ready' } },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: 'Article not found' });
    return res.json(updated);
  }));

  app.get('/publish-jobs', asyncHandler(async (req: Request, res: Response) => {
    const status = req.query.status as string | undefined;
    const query: Record<string, unknown> = status ? { status } : {};
    const jobs = await PublishJobModel.find(query).sort({ runAt: 1 }).lean();
    return res.json(jobs);
  }));

  app.post('/publish-jobs', asyncHandler(async (req: Request, res: Response) => {
    const {
      accountId,
      articleId,
      runAt,
      delayProfile,
      typingProfile,
      jobId,
      companyPageUrl,
      companyPageName,
    } = req.body as Record<string, unknown>;

    if (typeof accountId !== 'string') return res.status(400).json({ error: 'Missing accountId' });
    if (typeof articleId !== 'string') return res.status(400).json({ error: 'Missing articleId' });
    if (typeof runAt !== 'string' && !(runAt instanceof Date)) return res.status(400).json({ error: 'Missing runAt' });

    const account = (await AccountModel.findOne({ accountId }).lean()) as AccountDoc | null;
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.status !== 'active') return res.status(400).json({ error: 'Account is not active' });
    if (!account.storageStateEnc || account.authStatus !== 'valid') {
      return res.status(400).json({ error: 'Account is not authenticated. Run bootstrap to login first.' });
    }

    const article = (await ArticleModel.findOne({ articleId }).lean()) as ArticleDoc | null;
    if (!article) return res.status(404).json({ error: 'Article not found' });
    if (article.status !== 'ready') return res.status(400).json({ error: 'Article must be ready before scheduling' });
    if (!article.markdownContent || article.markdownContent.trim().length === 0) {
      return res.status(400).json({ error: 'Article markdownContent is empty' });
    }

    const parsedRunAt = runAt instanceof Date ? runAt : new Date(runAt);
    if (Number.isNaN(parsedRunAt.getTime())) return res.status(400).json({ error: 'Invalid runAt' });

    const delayKey = typeof delayProfile === 'string' ? delayProfile : 'default';
    const typingKey = typeof typingProfile === 'string' ? typingProfile : 'medium';
    if (!staticCfg.delays[delayKey]) {
      return res.status(400).json({ error: `Unknown delayProfile: ${delayKey}` });
    }
    if (!staticCfg.typingProfiles[typingKey]) {
      return res.status(400).json({ error: `Unknown typingProfile: ${typingKey}` });
    }

    const existingJob = await PublishJobModel.findOne({
      articleId,
      status: { $in: ['pending', 'running'] },
    }).lean();
    if (existingJob) {
      return res.status(409).json({ error: 'Article already has a pending/running job', jobId: (existingJob as any).jobId });
    }

    const finalJobId = typeof jobId === 'string' && jobId.length > 0
      ? jobId
      : `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const finalCompanyPageUrl = typeof companyPageUrl === 'string' && companyPageUrl.trim().length > 0
      ? companyPageUrl.trim()
      : undefined;
    const finalCompanyPageName = typeof companyPageName === 'string' && companyPageName.trim().length > 0
      ? companyPageName.trim()
      : undefined;

    let created;
    try {
      created = await PublishJobModel.create({
        jobId: finalJobId,
        accountId,
        articleId,
        runAt: parsedRunAt,
        delayProfile: delayKey,
        typingProfile: typingKey,
        companyPageUrl: finalCompanyPageUrl,
        companyPageName: finalCompanyPageName,
        status: 'pending',
      });
    } catch (err) {
      const e: any = err;
      if (e && e.code === 11000) {
        return res.status(409).json({ error: 'jobId already exists', jobId: finalJobId });
      }
      throw err;
    }

    await ArticleModel.updateOne(
      { articleId },
      { $set: { status: 'scheduled', scheduledAt: parsedRunAt } }
    );

    logger.info('Publish job scheduled', {
      jobId: created.jobId,
      accountId,
      articleId,
      runAt: parsedRunAt.toISOString(),
    });

    return res.status(201).json({ jobId: created.jobId });
  }));

  app.post('/publish-jobs/:jobId/cancel', asyncHandler(async (req: Request, res: Response) => {
    void req.body;
    const jobToCancel = await PublishJobModel.findOne({ jobId: req.params.jobId }).lean();
    if (!jobToCancel) return res.status(404).json({ error: 'Job not found' });
    if ((jobToCancel as any).status !== 'pending') {
      return res.status(400).json({ error: 'Job not cancelable (only pending jobs can be canceled)' });
    }

    const job = await PublishJobModel.findOneAndUpdate(
      { jobId: req.params.jobId, status: { $in: ['pending'] } },
      { $set: { status: 'canceled', finishedAt: new Date() } },
      { new: true }
    ).lean();
    if (!job) return res.status(404).json({ error: 'Job not found or not cancelable' });

    // If the article was marked scheduled because of this job, revert to ready.
    await ArticleModel.updateOne(
      { articleId: (jobToCancel as any).articleId, status: 'scheduled' },
      { $set: { status: 'ready' } }
    );

    return res.json(job);
  }));

  app.use((err: unknown, req: Request, res: Response, next: unknown) => {
    void req;
    void next;
    logger.error('API error', { error: String(err) });
    return res.status(500).json({ error: String(err) });
  });

  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on :${port}`);
  });
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
