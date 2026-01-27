export type AccountStatus = 'active' | 'disabled';
export type AccountAuthStatus = 'unknown' | 'valid' | 'invalid';

export type ProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

export type Account = {
  accountId: string;
  displayName: string;
  email: string;
  timezone: string;
  status: AccountStatus;
  authStatus?: AccountAuthStatus;
  lastAuthError?: string;
  proxy?: ProxyConfig;
  storageStateUpdatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type AccountIssue = {
  accountId: string;
  code?: string;
  message: string;
  createdAt?: string;
};

export type ArticleStatus =
  | 'draft'
  | 'ready'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed';

export type Article = {
  articleId: string;
  language: string;
  title: string;
  markdownContent?: string;
  coverImagePath?: string;
  communityPostText?: string;
  status?: ArticleStatus;
  publishedUrl?: string;
  lastError?: string;
  updatedAt?: string;
};

export type PublishJobStatus = 'pending' | 'running' | 'success' | 'failed' | 'canceled';

export type PublishJob = {
  jobId: string;
  accountId: string;
  articleId: string;
  runAt: string;
  delayProfile: string;
  typingProfile: string;
  status: PublishJobStatus;
  articleUrl?: string;
  error?: string;
  errorCode?: string;
  errorStep?: string;
  startedAt?: string;
  createdAt?: string;
  finishedAt?: string;
};

export type Health = { ok: boolean };
