import { ArticleModel } from '../db/models/ArticleModel';
import { PublishJobModel } from '../db/models/PublishJobModel';
import { AccountIssueModel } from '../db/models/AccountIssueModel';
import { Logger } from '../engine/logger';

const CLEANUP_INTERVAL_HOURS = 12;
const DEFAULT_ARTICLE_RETENTION_HOURS = 3 * 24;
const ISSUE_AGE_HOURS = 24;

// Only finished articles are ever removed. Drafts, ready and scheduled articles are kept
// however old they are, so nothing waiting to be published can disappear.
const FINISHED_ARTICLE_STATUSES = ['published', 'failed'];

let cleanupInterval: NodeJS.Timeout | null = null;
const logger = new Logger({ latestLogPath: './output/logs/cleanup.log' });

/** Manual cleanup endpoint key. Unset means the endpoint is disabled. */
export function getCleanupAuthKey(): string | undefined {
  const key = process.env.CLEANUP_AUTH_KEY?.trim();
  return key ? key : undefined;
}

/** Hours a finished article is kept after its last activity, from ARTICLE_RETENTION_HOURS (default 3 days). */
export function getArticleRetentionHours(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.ARTICLE_RETENTION_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_ARTICLE_RETENTION_HOURS;
}

/**
 * Selects articles that are safe to delete: finished, untouched for the retention period, and with
 * no pending or running job. Age is measured from updatedAt, which moves on every re-upload,
 * schedule and publish, so an article re-imported or scheduled recently is never treated as old.
 */
export function buildOldArticleFilter(now: Date, retentionHours: number, activeArticleIds: string[]) {
  const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000);
  return {
    status: { $in: FINISHED_ARTICLE_STATUSES },
    updatedAt: { $lt: cutoff },
    articleId: { $nin: activeArticleIds },
  };
}

export async function deleteOldArticles(): Promise<{ articlesDeleted: number; jobsDeleted: number; issuesDeleted: number }> {
  try {
    const now = new Date();
    const retentionHours = getArticleRetentionHours();

    // Always delete old account issues (these are shown in the UI as "Recent issues")
    const issuesResult = await AccountIssueModel.deleteMany({
      createdAt: { $lt: new Date(now.getTime() - ISSUE_AGE_HOURS * 60 * 60 * 1000) },
    });
    const issuesDeleted = issuesResult.deletedCount || 0;

    const activeArticleIds = (await PublishJobModel.distinct('articleId', {
      status: { $in: ['pending', 'running'] },
    })) as string[];

    const oldArticles = await ArticleModel.find(
      buildOldArticleFilter(now, retentionHours, activeArticleIds),
      { articleId: 1 }
    ).lean();

    const oldArticleIds = oldArticles.map((a: { articleId: string }) => a.articleId);

    if (oldArticleIds.length === 0) {
      logger.info(`No finished articles older than ${retentionHours} hours found`);
      if (issuesDeleted > 0) {
        console.log(`[Cleanup] Deleted ${issuesDeleted} account issues (> ${ISSUE_AGE_HOURS}h old)`);
      }
      return { articlesDeleted: 0, jobsDeleted: 0, issuesDeleted };
    }

    // Delete publish jobs linked to old articles (all finished, active ones were excluded above)
    const jobsResult = await PublishJobModel.deleteMany({
      articleId: { $in: oldArticleIds },
      status: { $nin: ['pending', 'running'] },
    });
    const jobsDeleted = jobsResult.deletedCount || 0;

    // Delete exactly the articles selected above, not a fresh query
    const articlesResult = await ArticleModel.deleteMany({
      articleId: { $in: oldArticleIds },
    });
    const articlesDeleted = articlesResult.deletedCount || 0;

    logger.info(
      `Cleanup completed - deleted ${articlesDeleted} finished articles (> ${retentionHours}h since last activity), ${jobsDeleted} jobs, ${issuesDeleted} account issues (> ${ISSUE_AGE_HOURS}h old)`
    );
    console.log(
      `[Cleanup] Deleted ${articlesDeleted} finished articles (> ${retentionHours}h since last activity), ${jobsDeleted} linked jobs, ${issuesDeleted} account issues (> ${ISSUE_AGE_HOURS}h old)`
    );

    return { articlesDeleted, jobsDeleted, issuesDeleted };
  } catch (error) {
    logger.error('Article cleanup failed', { error: String(error) });
    console.error('[Cleanup] Error:', error);
    throw error;
  }
}

export function startArticleCleanup(): void {
  if (cleanupInterval) {
    console.log('[Cleanup] Article cleanup already running');
    return;
  }

  const retentionHours = getArticleRetentionHours();
  console.log(`[Cleanup] Starting article cleanup service - runs every ${CLEANUP_INTERVAL_HOURS} hours`);
  console.log(
    `[Cleanup] Will delete published/failed articles with no activity for ${retentionHours} hours and their finished jobs`
  );

  // Run immediately on start
  deleteOldArticles().catch(err => {
    console.error('[Cleanup] Initial cleanup failed:', err);
  });

  // Schedule recurring cleanup
  cleanupInterval = setInterval(() => {
    deleteOldArticles().catch(err => {
      console.error('[Cleanup] Scheduled cleanup failed:', err);
    });
  }, CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000);
}

export function stopArticleCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('[Cleanup] Article cleanup service stopped');
  }
}
