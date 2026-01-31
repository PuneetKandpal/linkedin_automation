import { apiFetchJson } from './http';

export type AutoScheduleConfig = {
  configId: string;
  maxArticlesPerCompanyPage: number;
  maxArticlesPerCompanyPageOptions?: number[];
  minGapMinutesSameCompanyPage: number;
  minGapMinutesSameCompanyPageOptions?: number[];
  minGapMinutesCompanyPagesSameAccount: number;
  minGapMinutesCompanyPagesSameAccountOptions?: number[];
  minGapMinutesAcrossAccounts: number;
  minGapMinutesAcrossAccountsOptions?: number[];
  estimatedPublishDurationMinutes: number;
  estimatedPublishDurationMinutesOptions?: number[];
  jitterMinutes: number;
  jitterMinutesOptions?: number[];
  defaultStartOffsetMinutes: number;
  defaultStartOffsetMinutesOptions?: number[];
  createdAt?: string;
  updatedAt?: string;
};

export type AutoScheduleConfigUpdate = {
  maxArticlesPerCompanyPage?: number;
  maxArticlesPerCompanyPageOptions?: number[];
  minGapMinutesSameCompanyPage?: number;
  minGapMinutesSameCompanyPageOptions?: number[];
  minGapMinutesCompanyPagesSameAccount?: number;
  minGapMinutesCompanyPagesSameAccountOptions?: number[];
  minGapMinutesAcrossAccounts?: number;
  minGapMinutesAcrossAccountsOptions?: number[];
  estimatedPublishDurationMinutes?: number;
  estimatedPublishDurationMinutesOptions?: number[];
  jitterMinutes?: number;
  jitterMinutesOptions?: number[];
  defaultStartOffsetMinutes?: number;
  defaultStartOffsetMinutesOptions?: number[];
};

export type AutoScheduleExecuteParams = {
  startFromDate?: string;
  articleIds?: string[];
  configOverride?: AutoScheduleConfigUpdate;
  clientSuffix?: string;
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
