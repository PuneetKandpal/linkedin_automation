import './env';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
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

function normalizeCompanyPageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return undefined;
  return v.replace(/\/+$/, '');
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v.length > 0 ? v : undefined;
}

function accountHasCompanyPage(account: AccountDoc, params: { companyPageUrl?: string; companyPageName?: string }): boolean {
  const url = normalizeCompanyPageUrl(params.companyPageUrl);
  const name = normalizeText(params.companyPageName);
  if (!url && !name) return true;
  const pages = (account as any).companyPages as Array<{ url?: string; name?: string }> | undefined;
  if (!pages || pages.length === 0) return false;
  return pages.some(p => {
    const pUrl = normalizeCompanyPageUrl(p.url);
    const pName = normalizeText(p.name);
    if (url && pUrl && pUrl.toLowerCase() === url.toLowerCase()) return true;
    if (name && pName && pName.toLowerCase() === name.toLowerCase()) return true;
    return false;
  });
}

function companyPageKeyFrom(job: { companyPageUrl?: string; companyPageName?: string }): string | undefined {
  const url = typeof job.companyPageUrl === 'string' ? job.companyPageUrl.trim() : '';
  if (url.length > 0) return `url:${url.toLowerCase()}`;
  const name = typeof job.companyPageName === 'string' ? job.companyPageName.trim() : '';
  if (name.length > 0) return `name:${name.toLowerCase()}`;
  return undefined;
}

function minutesToMs(mins: unknown): number {
  if (typeof mins !== 'number' || Number.isNaN(mins) || mins <= 0) return 0;
  return Math.floor(mins * 60_000);
}

async function main() {
  await connectMongo();

  const logger = new Logger({ latestLogPath: './output/logs/latest_api.log' });

  const configDir = process.env.CONFIG_DIR || './config';
  const staticCfg = new StaticConfigLoader(configDir).loadAll();

  const app = express();
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  app.use(cors({ origin: corsOrigin === '*' ? corsOrigin : corsOrigin.split(',').map(origin => origin.trim()).filter(Boolean), credentials: true }));
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
      linkStatus: 'unlinked',
      companyPages: [],
    });

    logger.info('Account created', { accountId: created.accountId });
    return res.status(201).json({ accountId: created.accountId });
  }));

  app.post('/accounts/bulk', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const items = (body.items ?? body.accounts) as unknown;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing items/accounts array' });
    }

    const createdIds: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as Record<string, unknown>;
      const accountId = normalizeText(it.accountId);
      const displayName = normalizeText(it.displayName);
      const email = normalizeText(it.email);
      const timezone = normalizeText(it.timezone);
      const statusRaw = normalizeText(it.status);
      const status = statusRaw ? (statusRaw === 'disabled' ? 'disabled' : statusRaw === 'active' ? 'active' : null) : 'active';

      if (!accountId) return res.status(400).json({ error: `Item[${i}] missing accountId`, itemIndex: i, field: 'accountId' });
      if (!displayName) return res.status(400).json({ error: `Item[${i}] missing displayName`, itemIndex: i, field: 'displayName' });
      if (!email) return res.status(400).json({ error: `Item[${i}] missing email`, itemIndex: i, field: 'email' });
      if (!timezone) return res.status(400).json({ error: `Item[${i}] missing timezone`, itemIndex: i, field: 'timezone' });
      if (!status) return res.status(400).json({ error: `Item[${i}] invalid status`, itemIndex: i, field: 'status' });

      const existing = await AccountModel.findOne({ accountId }).lean();
      if (existing) {
        continue;
      }

      await AccountModel.create({
        accountId,
        displayName,
        email,
        timezone,
        proxy: it.proxy,
        status,
        authStatus: 'unknown',
        linkStatus: 'unlinked',
        companyPages: [],
      });
      createdIds.push(accountId);
    }

    return res.status(201).json({ accountIds: createdIds });
  }));

  app.get('/accounts/:accountId/company-pages', asyncHandler(async (req: Request, res: Response) => {
    const accountId = req.params.accountId;
    const account = await AccountModel.findOne({ accountId }, { storageStateEnc: 0 }).lean();
    if (!account) return res.status(404).json({ error: 'Account not found' });
    return res.json((account as any).companyPages || []);
  }));

  app.post('/accounts/:accountId/company-pages', asyncHandler(async (req: Request, res: Response) => {
    const accountId = req.params.accountId;
    const { pageId, name, url } = req.body as Record<string, unknown>;
    const finalPageId = normalizeText(pageId) || `page_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const finalName = normalizeText(name);
    const finalUrl = normalizeCompanyPageUrl(url);

    if (!finalName) return res.status(400).json({ error: 'Missing name' });
    if (!finalUrl) return res.status(400).json({ error: 'Missing/invalid url' });

    const account = await AccountModel.findOne({ accountId }).lean();
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const pages = ((account as any).companyPages as any[]) || [];
    const already = pages.some(p => normalizeCompanyPageUrl(p.url)?.toLowerCase() === finalUrl.toLowerCase());
    if (already) return res.status(409).json({ error: 'Company page already exists for this account' });

    await AccountModel.updateOne(
      { accountId },
      { $push: { companyPages: { pageId: finalPageId, name: finalName, url: finalUrl } } }
    );

    return res.status(201).json({ pageId: finalPageId });
  }));

  app.delete('/accounts/:accountId/company-pages/:pageId', asyncHandler(async (req: Request, res: Response) => {
    const { accountId, pageId } = req.params;
    await AccountModel.updateOne({ accountId }, { $pull: { companyPages: { pageId } } });
    return res.json({ ok: true });
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

  app.post('/articles/bulk', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const items = (body.items ?? body.articles) as unknown;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing items/articles array' });
    }

    const createdIds: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as Record<string, unknown>;
      const articleId = normalizeText(it.articleId);
      const language = normalizeText(it.language);
      const title = normalizeText(it.title);
      const markdownContent = normalizeText(it.markdownContent);
      const coverImagePath = it.coverImagePath;
      const communityPostText = it.communityPostText;

      if (!articleId) return res.status(400).json({ error: `Item[${i}] missing articleId`, itemIndex: i, field: 'articleId' });
      if (!language) return res.status(400).json({ error: `Item[${i}] missing language`, itemIndex: i, field: 'language' });
      if (!title) return res.status(400).json({ error: `Item[${i}] missing title`, itemIndex: i, field: 'title' });
      if (!markdownContent) return res.status(400).json({ error: `Item[${i}] missing markdownContent`, itemIndex: i, field: 'markdownContent' });
      if (coverImagePath !== undefined && coverImagePath !== null && typeof coverImagePath !== 'string') {
        return res.status(400).json({ error: `Item[${i}] coverImagePath must be a string URL`, itemIndex: i, field: 'coverImagePath' });
      }
      if (coverImagePath !== undefined && coverImagePath !== null && !isHttpUrl(coverImagePath)) {
        return res.status(400).json({ error: `Item[${i}] coverImagePath must be an http(s) URL`, itemIndex: i, field: 'coverImagePath' });
      }

      const existing = await ArticleModel.findOne({ articleId }).lean();
      if (existing) continue;

      await ArticleModel.create({
        articleId,
        language,
        title,
        markdownContent,
        coverImagePath,
        communityPostText,
        status: 'draft',
      });
      createdIds.push(articleId);
    }

    return res.status(201).json({ articleIds: createdIds });
  }));

  app.post('/articles/ready/bulk', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const articleIds = body.articleIds as unknown;
    if (!Array.isArray(articleIds) || articleIds.length === 0) {
      return res.status(400).json({ error: 'Missing articleIds array' });
    }

    const ids = articleIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim());
    await ArticleModel.updateMany(
      { articleId: { $in: ids }, status: { $ne: 'published' } },
      { $set: { status: 'ready' } }
    );
    return res.json({ ok: true, articleIds: ids });
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

  app.post('/publish-jobs/bulk', asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const items = (body.items ?? body.jobs) as unknown;

    const schedulePolicy = typeof body.schedulePolicy === 'object' && body.schedulePolicy
      ? (body.schedulePolicy as Record<string, unknown>)
      : undefined;

    const minGapMinutesPerAccount = schedulePolicy ? (schedulePolicy.minGapMinutesPerAccount as unknown) : undefined;
    const minGapMinutesPerCompanyPage = schedulePolicy ? (schedulePolicy.minGapMinutesPerCompanyPage as unknown) : undefined;
    const minGapAccountMs = minutesToMs(minGapMinutesPerAccount);
    const minGapCompanyMs = minutesToMs(minGapMinutesPerCompanyPage);

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing items/jobs array' });
    }

    let normalized: Array<{
      idx: number;
      jobId: string;
      accountId: string;
      articleId: string;
      requestedRunAt: Date;
      delayProfile: string;
      typingProfile: string;
      companyPageUrl?: string;
      companyPageName?: string;
    }>;

    try {
      normalized = items.map((raw, idx) => {
        const it = raw as Record<string, unknown>;
        const accountId = it.accountId;
        const articleId = it.articleId;
        const runAt = it.runAt;

        if (typeof accountId !== 'string' || accountId.trim().length === 0) {
          throw Object.assign(new Error('Missing accountId'), { itemIndex: idx, field: 'accountId' });
        }
        if (typeof articleId !== 'string' || articleId.trim().length === 0) {
          throw Object.assign(new Error('Missing articleId'), { itemIndex: idx, field: 'articleId' });
        }

        const parsedRequestedRunAt = runAt instanceof Date ? runAt : (typeof runAt === 'string' ? new Date(runAt) : new Date());
        if (Number.isNaN(parsedRequestedRunAt.getTime())) {
          throw Object.assign(new Error('Invalid runAt'), { itemIndex: idx, field: 'runAt' });
        }

        const delayProfile = typeof it.delayProfile === 'string' ? it.delayProfile : 'default';
        const typingProfile = typeof it.typingProfile === 'string' ? it.typingProfile : 'medium';
        if (!staticCfg.delays[delayProfile]) {
          throw Object.assign(new Error(`Unknown delayProfile: ${delayProfile}`), { itemIndex: idx, field: 'delayProfile' });
        }
        if (!staticCfg.typingProfiles[typingProfile]) {
          throw Object.assign(new Error(`Unknown typingProfile: ${typingProfile}`), { itemIndex: idx, field: 'typingProfile' });
        }

        const companyPageUrl = typeof it.companyPageUrl === 'string' && it.companyPageUrl.trim().length > 0
          ? it.companyPageUrl.trim()
          : undefined;
        const companyPageName = typeof it.companyPageName === 'string' && it.companyPageName.trim().length > 0
          ? it.companyPageName.trim()
          : undefined;

        const jobId = typeof it.jobId === 'string' && it.jobId.trim().length > 0
          ? it.jobId.trim()
          : `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${idx}`;

        return {
          idx,
          jobId,
          accountId: accountId.trim(),
          articleId: articleId.trim(),
          requestedRunAt: parsedRequestedRunAt,
          delayProfile,
          typingProfile,
          companyPageUrl,
          companyPageName,
        };
      });
    } catch (e) {
      const err = e as any;
      const itemIndex = typeof err.itemIndex === 'number' ? err.itemIndex : undefined;
      const field = typeof err.field === 'string' ? err.field : undefined;
      return res.status(400).json({ error: (err && err.message) ? err.message : 'Invalid bulk item', itemIndex, field });
    }

    const accountIds = Array.from(new Set(normalized.map(n => n.accountId)));
    const companyKeys = Array.from(
      new Set(
        normalized
          .map(n => companyPageKeyFrom(n))
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
      )
    );

    const existingJobs = await PublishJobModel.find(
      {
        status: { $in: ['pending', 'running'] },
        $or: [
          { accountId: { $in: accountIds } },
          ...(companyKeys.length > 0
            ? [{ $or: companyKeys.map(k => (k.startsWith('url:') ? { companyPageUrl: k.slice(4) } : { companyPageName: k.slice(5) })) }]
            : []),
        ],
      },
      { jobId: 1, accountId: 1, runAt: 1, companyPageUrl: 1, companyPageName: 1 }
    )
      .sort({ runAt: 1 })
      .lean();

    const lastPerAccount = new Map<string, number>();
    const lastPerCompany = new Map<string, number>();

    for (const j of existingJobs as any[]) {
      if (typeof j.accountId === 'string' && j.runAt) {
        const t = new Date(j.runAt).getTime();
        lastPerAccount.set(j.accountId, Math.max(lastPerAccount.get(j.accountId) ?? 0, t));
      }
      const key = companyPageKeyFrom({ companyPageUrl: j.companyPageUrl, companyPageName: j.companyPageName });
      if (key && j.runAt) {
        const t = new Date(j.runAt).getTime();
        lastPerCompany.set(key, Math.max(lastPerCompany.get(key) ?? 0, t));
      }
    }

    const createdJobIds: string[] = [];
    const computed: Array<{ jobId: string; runAt: string; requestedRunAt: string; accountId: string; articleId: string }> = [];

    for (const n of normalized) {
      const account = (await AccountModel.findOne({ accountId: n.accountId }).lean()) as AccountDoc | null;
      if (!account) {
        return res.status(404).json({ error: `Account not found: ${n.accountId}`, itemIndex: n.idx, field: 'accountId' });
      }
      if (account.status !== 'active') {
        return res.status(400).json({ error: `Account is not active: ${n.accountId}`, itemIndex: n.idx, field: 'accountId' });
      }
      if (!account.storageStateEnc || account.authStatus !== 'valid' || (account as any).linkStatus !== 'linked') {
        return res.status(400).json({ error: `Account not authenticated: ${n.accountId}`, itemIndex: n.idx, field: 'accountId' });
      }

      if (!accountHasCompanyPage(account, { companyPageUrl: n.companyPageUrl, companyPageName: n.companyPageName })) {
        return res.status(400).json({ error: `Company page not linked to account: ${n.accountId}`, itemIndex: n.idx, field: 'companyPageUrl' });
      }

      const article = (await ArticleModel.findOne({ articleId: n.articleId }).lean()) as ArticleDoc | null;
      if (!article) {
        return res.status(404).json({ error: `Article not found: ${n.articleId}`, itemIndex: n.idx, field: 'articleId' });
      }
      if (!article.markdownContent || article.markdownContent.trim().length === 0) {
        return res.status(400).json({ error: `Article markdownContent empty: ${n.articleId}`, itemIndex: n.idx, field: 'articleId' });
      }

      const existingForArticle = await PublishJobModel.findOne({
        articleId: n.articleId,
        status: { $in: ['pending', 'running'] },
      }).lean();
      if (existingForArticle) {
        return res.status(409).json({ error: `Article already has a pending/running job: ${n.articleId}`, itemIndex: n.idx, field: 'articleId' });
      }

      const requestedMs = n.requestedRunAt.getTime();
      const lastAccMs = lastPerAccount.get(n.accountId) ?? 0;
      const accReady = lastAccMs > 0 ? lastAccMs + minGapAccountMs : 0;

      const companyKey = companyPageKeyFrom(n);
      const lastCompMs = companyKey ? (lastPerCompany.get(companyKey) ?? 0) : 0;
      const compReady = companyKey && lastCompMs > 0 ? lastCompMs + minGapCompanyMs : 0;

      const scheduledMs = Math.max(requestedMs, accReady, compReady, Date.now());
      const runAtDate = new Date(scheduledMs);

      await PublishJobModel.create({
        jobId: n.jobId,
        accountId: n.accountId,
        articleId: n.articleId,
        runAt: runAtDate,
        requestedRunAt: n.requestedRunAt,
        delayProfile: n.delayProfile,
        typingProfile: n.typingProfile,
        companyPageUrl: n.companyPageUrl,
        companyPageName: n.companyPageName,
        schedulePolicy: {
          minGapMinutesPerAccount: typeof minGapMinutesPerAccount === 'number' ? minGapMinutesPerAccount : undefined,
          minGapMinutesPerCompanyPage: typeof minGapMinutesPerCompanyPage === 'number' ? minGapMinutesPerCompanyPage : undefined,
        },
        status: 'pending',
      });

      await ArticleModel.updateOne(
        { articleId: n.articleId },
        { $set: { status: 'scheduled', scheduledAt: runAtDate } }
      );

      lastPerAccount.set(n.accountId, scheduledMs);
      if (companyKey) lastPerCompany.set(companyKey, scheduledMs);

      createdJobIds.push(n.jobId);
      computed.push({
        jobId: n.jobId,
        runAt: runAtDate.toISOString(),
        requestedRunAt: n.requestedRunAt.toISOString(),
        accountId: n.accountId,
        articleId: n.articleId,
      });
    }

    logger.info('Bulk publish jobs scheduled', {
      count: createdJobIds.length,
      minGapMinutesPerAccount,
      minGapMinutesPerCompanyPage,
    });

    return res.status(201).json({ jobIds: createdJobIds, items: computed });
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
    if (!account.storageStateEnc || account.authStatus !== 'valid' || (account as any).linkStatus !== 'linked') {
      return res.status(400).json({ error: 'Account is not authenticated. Run bootstrap to login first.' });
    }

    if (!accountHasCompanyPage(account, { companyPageUrl: companyPageUrl as any, companyPageName: companyPageName as any })) {
      return res.status(400).json({ error: 'Company page not linked to this account' });
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
        requestedRunAt: parsedRunAt,
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
