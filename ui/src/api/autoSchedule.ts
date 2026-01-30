import { apiFetchJson } from './http';

export type AutoScheduleConfig = {
  configId: string;
  maxArticlesPerCompanyPage: number;
  minGapMinutesSameCompanyPage: number;
  minGapMinutesCompanyPagesSameAccount: number;
  minGapMinutesAcrossAccounts: number;
  estimatedPublishDurationMinutes: number;
  jitterMinutes: number;
  defaultStartOffsetMinutes: number;
  createdAt?: string;
  updatedAt?: string;
};

export type AutoScheduleConfigUpdate = {
  maxArticlesPerCompanyPage?: number;
  minGapMinutesSameCompanyPage?: number;
  minGapMinutesCompanyPagesSameAccount?: number;
  minGapMinutesAcrossAccounts?: number;
  estimatedPublishDurationMinutes?: number;
  jitterMinutes?: number;
  defaultStartOffsetMinutes?: number;
};

export type AutoScheduleExecuteParams = {
  startFromDate?: string;
  articleIds?: string[];
  configOverride?: AutoScheduleConfigUpdate;
};

export type AutoScheduleResult = {
  jobIds: string[];
  scheduled: number;
  estimatedFinishAt?: string | null;
  estimatedDurationMinutes?: number;
};

export type AutoSchedulePreviewParams = {
  startFromDate?: string;
  articleCount?: number;
  configOverride?: AutoScheduleConfigUpdate;
};

export const AutoScheduleApi = {
  async getConfig(): Promise<AutoScheduleConfig> {
    return apiFetchJson<AutoScheduleConfig>('/auto-schedule/config', { method: 'GET' });
  },

  async updateConfig(update: AutoScheduleConfigUpdate): Promise<AutoScheduleConfig> {
    return apiFetchJson<AutoScheduleConfig>('/auto-schedule/config', {
      method: 'PUT',
      body: JSON.stringify(update),
    });
  },

  async execute(params: AutoScheduleExecuteParams): Promise<AutoScheduleResult> {
    return apiFetchJson<AutoScheduleResult>('/auto-schedule/execute', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  async preview(params: AutoSchedulePreviewParams): Promise<AutoScheduleResult> {
    return apiFetchJson<AutoScheduleResult>('/auto-schedule/preview', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },
};
