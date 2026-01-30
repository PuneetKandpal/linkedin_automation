import { ArticleModel } from '../db/models/ArticleModel';
import { AccountModel, AccountDoc } from '../db/models/AccountModel';
import { PublishJobModel } from '../db/models/PublishJobModel';
import { AutoScheduleConfigModel, AutoScheduleConfigDoc } from '../db/models/AutoScheduleConfigModel';
import type { Logger } from '../engine/logger';

interface AutoScheduleParams {
  startFromDate?: Date;
  articleIds?: string[];
  articleCount?: number;
  configOverride?: Partial<AutoScheduleConfigDoc>;
  dryRun?: boolean;
  logger: Logger;
}

interface ScheduleSlot {
  accountId: string;
  companyPageUrl?: string;
  companyPageName?: string;
  accountIdleRank: number;
}

export async function autoScheduleArticles(params: AutoScheduleParams) {
  const { startFromDate, articleIds, articleCount, configOverride, dryRun, logger } = params;

  const stored = (await AutoScheduleConfigModel.findOne({ configId: 'default' }).lean()) as AutoScheduleConfigDoc | null;
  if (!stored) throw new Error('Auto-schedule configuration not found');

  const config: AutoScheduleConfigDoc = { ...(stored as any), ...(configOverride as any) };

  const finalArticleIds = Array.isArray(articleIds) ? articleIds.filter(Boolean) : [];
  const finalArticleCount = typeof articleCount === 'number' && articleCount > 0
    ? Math.floor(articleCount)
    : finalArticleIds.length;

  const activeAccounts = (await AccountModel.find({
    status: 'active',
    authStatus: 'valid',
    linkStatus: 'linked',
    'companyPages.0': { $exists: true },
  }).lean()) as AccountDoc[];

  if (activeAccounts.length === 0) {
    throw new Error('No active linked accounts with company pages found');
  }

  const publishMs = minutesToMs(config.estimatedPublishDurationMinutes);
  const sameCompanyGapMs = minutesToMs(config.minGapMinutesSameCompanyPage);
  const sameAccountGapMs = minutesToMs(config.minGapMinutesCompanyPagesSameAccount);
  const acrossAccountsGapMs = minutesToMs(config.minGapMinutesAcrossAccounts);
  const jitterMs = minutesToMs(config.jitterMinutes);

  const nowMs = Date.now();
  const baseStartTime = startFromDate
    ? startFromDate.getTime()
    : nowMs + minutesToMs(config.defaultStartOffsetMinutes);

  const jobWindowJobs = await PublishJobModel.find(
    { status: { $in: ['pending', 'running', 'success', 'failed'] } },
    { accountId: 1, companyPageUrl: 1, companyPageName: 1, runAt: 1, finishedAt: 1, status: 1 }
  )
    .sort({ runAt: 1 })
    .lean();

  const lastPerAccount = new Map<string, number>();
  const lastPerCompany = new Map<string, number>();
  const articlesPerCompany = new Map<string, number>();
  let lastGlobalMs = 0;

  for (const job of jobWindowJobs as any[]) {
    const runAtMs = job.runAt ? new Date(job.runAt).getTime() : 0;
    const finishedAtMs = job.finishedAt ? new Date(job.finishedAt).getTime() : 0;

    // Treat the "busy until" time as finishedAt when available, otherwise estimate runAt + publishDuration.
    const busyUntilMs = finishedAtMs > 0
      ? finishedAtMs
      : runAtMs > 0
        ? runAtMs + publishMs
        : 0;

    if (!busyUntilMs) continue;

    if (typeof job.accountId === 'string') {
      lastPerAccount.set(job.accountId, Math.max(lastPerAccount.get(job.accountId) ?? 0, busyUntilMs));
    }

    const companyKey = companyPageKey({ companyPageUrl: job.companyPageUrl, companyPageName: job.companyPageName });
    if (companyKey) {
      lastPerCompany.set(companyKey, Math.max(lastPerCompany.get(companyKey) ?? 0, busyUntilMs));
      if (job.status === 'pending' || job.status === 'running') {
        articlesPerCompany.set(companyKey, (articlesPerCompany.get(companyKey) ?? 0) + 1);
      }
    }

    lastGlobalMs = Math.max(lastGlobalMs, busyUntilMs);
  }

  const idleAgg = await PublishJobModel.aggregate([
    { $match: { status: 'success', finishedAt: { $exists: true, $ne: null } } },
    { $group: { _id: '$accountId', lastFinishedAt: { $max: '$finishedAt' } } },
  ]);

  const lastSuccessPerAccount = new Map<string, number>();
  for (const row of idleAgg as any[]) {
    if (typeof row._id === 'string' && row.lastFinishedAt) {
      lastSuccessPerAccount.set(row._id, new Date(row.lastFinishedAt).getTime());
    }
  }

  const idleSorted = [...activeAccounts].sort((a, b) => {
    const ta = lastSuccessPerAccount.get(a.accountId) ?? 0;
    const tb = lastSuccessPerAccount.get(b.accountId) ?? 0;
    return ta - tb;
  });

  const idleRank = new Map<string, number>();
  idleSorted.forEach((acc, idx) => idleRank.set(acc.accountId, idx));

  const slots: ScheduleSlot[] = [];
  for (const account of idleSorted) {
    const companyPages = (account as any).companyPages || [];
    for (const page of companyPages) {
      const companyKey = companyPageKey({ companyPageUrl: page.url, companyPageName: page.name });
      const currentCount = companyKey ? (articlesPerCompany.get(companyKey) ?? 0) : 0;
      if (currentCount >= config.maxArticlesPerCompanyPage) continue;
      slots.push({
        accountId: account.accountId,
        companyPageUrl: page.url,
        companyPageName: page.name,
        accountIdleRank: idleRank.get(account.accountId) ?? 0,
      });
    }
  }

  if (slots.length === 0) throw new Error('No available company pages for scheduling (all at max capacity)');

  const articleIdsToSchedule: string[] = [];

  if (finalArticleIds.length > 0) {
    const existingForArticles = await PublishJobModel.find(
      { articleId: { $in: finalArticleIds }, status: { $in: ['pending', 'running'] } },
      { articleId: 1 }
    ).lean();
    const blocked = new Set((existingForArticles as any[]).map(j => j.articleId).filter(Boolean));
    for (const id of finalArticleIds) {
      if (!blocked.has(id)) articleIdsToSchedule.push(id);
    }
  } else {
    if (dryRun && finalArticleCount > 0) {
      for (let i = 0; i < finalArticleCount; i++) {
        articleIdsToSchedule.push(`preview_${i + 1}`);
      }
    } else {
      const readyArticles = await ArticleModel.find({ status: 'ready' }, { articleId: 1 })
        .sort({ createdAt: 1 })
        .limit(finalArticleCount > 0 ? finalArticleCount : 10_000)
        .lean();
      articleIdsToSchedule.push(...(readyArticles as any[]).map(a => a.articleId).filter(Boolean));
    }
  }

  const wantedCount = finalArticleCount > 0 ? Math.min(finalArticleCount, articleIdsToSchedule.length || finalArticleCount) : articleIdsToSchedule.length;
  const effectiveCount = finalArticleIds.length > 0 ? articleIdsToSchedule.length : wantedCount;
  if (effectiveCount <= 0) {
    logger.info('No articles to schedule');
    return { jobIds: [], scheduled: 0, estimatedFinishAt: null, estimatedDurationMinutes: 0 };
  }

  const createdJobIds: string[] = [];
  let maxEndMs = 0;

  for (let i = 0; i < effectiveCount; i++) {
    const articleId = articleIdsToSchedule[i];
    const isPreviewArticle = typeof articleId === 'string' && articleId.startsWith('preview_');

    let bestSlot: ScheduleSlot | null = null;
    let bestMs = 0;

    for (const slot of slots) {
      const companyKey = companyPageKey({ companyPageUrl: slot.companyPageUrl, companyPageName: slot.companyPageName });
      const currentCount = companyKey ? (articlesPerCompany.get(companyKey) ?? 0) : 0;
      if (currentCount >= config.maxArticlesPerCompanyPage) continue;

      const lastAccMs = lastPerAccount.get(slot.accountId) ?? 0;
      const lastCompMs = companyKey ? (lastPerCompany.get(companyKey) ?? 0) : 0;

      const accReady = lastAccMs > 0 ? lastAccMs + sameAccountGapMs : 0;
      const compReady = lastCompMs > 0 ? lastCompMs + sameCompanyGapMs : 0;
      const globalReady = lastGlobalMs > 0 ? lastGlobalMs + acrossAccountsGapMs : 0;

      const candidate = Math.max(baseStartTime, accReady, compReady, globalReady, nowMs);

      if (!bestSlot || candidate < bestMs || (candidate === bestMs && slot.accountIdleRank < bestSlot.accountIdleRank)) {
        bestSlot = slot;
        bestMs = candidate;
      }
    }

    if (!bestSlot) break;

    const companyKey = companyPageKey({ companyPageUrl: bestSlot.companyPageUrl, companyPageName: bestSlot.companyPageName });
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
    const scheduledMs = bestMs + jitter;
    const runAtDate = new Date(scheduledMs);

    maxEndMs = Math.max(maxEndMs, scheduledMs + publishMs);

    if (!dryRun) {
      if (typeof articleId === 'string' && !isPreviewArticle) {
        const jobId = `job_auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await PublishJobModel.create({
          jobId,
          accountId: bestSlot.accountId,
          articleId,
          runAt: runAtDate,
          requestedRunAt: runAtDate,
          delayProfile: 'default',
          typingProfile: 'medium',
          companyPageUrl: bestSlot.companyPageUrl,
          companyPageName: bestSlot.companyPageName,
          schedulePolicy: {
            minGapMinutesSameCompanyPage: config.minGapMinutesSameCompanyPage,
            minGapMinutesCompanyPagesSameAccount: config.minGapMinutesCompanyPagesSameAccount,
            minGapMinutesAcrossAccounts: config.minGapMinutesAcrossAccounts,
            estimatedPublishDurationMinutes: config.estimatedPublishDurationMinutes,
            jitterMinutes: config.jitterMinutes,
          },
          status: 'pending',
        });

        await ArticleModel.updateOne(
          { articleId },
          { $set: { status: 'scheduled', scheduledAt: runAtDate } }
        );

        createdJobIds.push(jobId);
      }
    }

    lastPerAccount.set(bestSlot.accountId, scheduledMs + publishMs);
    lastGlobalMs = scheduledMs + publishMs;
    if (companyKey) {
      lastPerCompany.set(companyKey, scheduledMs + publishMs);
      articlesPerCompany.set(companyKey, (articlesPerCompany.get(companyKey) ?? 0) + 1);
    }
  }

  const estimatedFinishAtMs = maxEndMs > 0 ? maxEndMs : 0;
  const estimatedDurationMinutes = estimatedFinishAtMs > 0
    ? Math.max(0, Math.ceil((estimatedFinishAtMs - baseStartTime) / 60_000))
    : 0;

  return {
    jobIds: createdJobIds,
    scheduled: dryRun ? effectiveCount : createdJobIds.length,
    estimatedFinishAt: estimatedFinishAtMs ? new Date(estimatedFinishAtMs).toISOString() : null,
    estimatedDurationMinutes,
  };
}

function companyPageKey(page: { companyPageUrl?: string; companyPageName?: string }): string | null {
  if (page.companyPageUrl && page.companyPageUrl.trim().length > 0) {
    return `url:${page.companyPageUrl.trim()}`;
  }
  if (page.companyPageName && page.companyPageName.trim().length > 0) {
    return `name:${page.companyPageName.trim()}`;
  }
  return null;
}

function minutesToMs(mins: unknown): number {
  if (typeof mins !== 'number' || Number.isNaN(mins) || mins <= 0) return 0;
  return Math.floor(mins * 60_000);
}
