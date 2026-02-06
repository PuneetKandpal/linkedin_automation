import { apiFetchJson } from './http';
import type { PublishJob } from './types';

export type CreateJobInput = {
  jobId?: string;
  accountId: string;
  articleId: string;
  runAt: string;
  delayProfile: string;
  typingProfile: string;
  companyPageUrl?: string;
  companyPageName?: string;
};

export type BulkSchedulePolicy = {
  minGapMinutesPerAccount?: number;
  minGapMinutesPerCompanyPage?: number;
};

export type BulkJobItem = {
  jobId?: string;
  accountId: string;
  articleId: string;
  runAt: string;
  delayProfile?: string;
  typingProfile?: string;
  companyPageUrl?: string;
  companyPageName?: string;
};

export const JobsApi = {
  list: (status?: string) => {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return apiFetchJson<PublishJob[]>(`/publish-jobs${q}`);
  },

  create: (input: CreateJobInput) =>
    apiFetchJson<{ jobId: string }>('/publish-jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  bulk: (input: { schedulePolicy?: BulkSchedulePolicy; items: BulkJobItem[] }) =>
    apiFetchJson<{ jobIds: string[]; items: Array<{ jobId: string; runAt: string; requestedRunAt: string; accountId: string; articleId: string }> }>(
      '/publish-jobs/bulk',
      {
        method: 'POST',
        body: JSON.stringify(input),
      }
    ),

  cancel: (jobId: string) =>
    apiFetchJson<PublishJob>(`/publish-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  bulkCancel: (jobIds: string[]) =>
    apiFetchJson<{ ok: boolean; canceledJobIds: string[]; missing: string[]; notCancelable?: Array<{ jobId: string; status: string }> }>(
      '/publish-jobs/cancel/bulk',
      {
        method: 'POST',
        body: JSON.stringify({ jobIds }),
      }
    ),

  bulkDelete: (jobIds: string[]) =>
    apiFetchJson<{ ok: boolean; deletedCount: number; jobIds: string[]; missing: string[]; runningJobIds?: string[] }>(
      '/publish-jobs/bulk-delete',
      {
        method: 'POST',
        body: JSON.stringify({ jobIds }),
      }
    ),
};
