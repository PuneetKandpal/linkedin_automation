export interface GlobalConfig {
  browser: {
    headless: boolean;
    slowMo: number;
    defaultTimeout: number;
  };
  execution: {
    maxArticlesPerRun: number;
    closeBrowserOnFailure: boolean;
  };
  captcha: {
    provider: string;
    timeoutMs: number;
    maxAttempts: number;
  };
}

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface Account {
  accountId: string;
  displayName: string;
  email: string;
  profileDir?: string;
  proxy?: ProxyConfig;
  timezone: string;
  status: 'active' | 'disabled';
  storageState?: unknown;
}

export interface ArticleContentBlock {
  type: 'paragraph' | 'heading' | 'list' | 'quote' | 'code' | 'hr';
  text: string;
  listStyle?: 'bullet' | 'ordered';
}

export interface Article {
  articleId: string;
  language: string;
  title: string;
  content?: ArticleContentBlock[];
  markdownContent?: string;
  coverImagePath?: string;
  communityPostText?: string;
}

export interface PublishJob {
  jobId: string;
  accountId: string;
  articleId: string;
  delayProfile: string;
  typingProfile: string;
}

export interface DelayRange {
  preLaunch: [number, number];
  beforeEditorFocus: [number, number];
  betweenParagraphs: [number, number];
  beforePublish: [number, number];
  afterPublish: [number, number];
}

export interface DelayProfiles {
  [profileName: string]: DelayRange;
}

export interface TypingProfile {
  minDelay: number;
  maxDelay: number;
  typoChance: number;
  thinkingPauseChance: number;
}

export interface TypingProfiles {
  [profileName: string]: TypingProfile;
}

export interface Selectors {
  [key: string]: string;
}

export interface AllSelectors {
  common: Selectors;
  login: Selectors;
  articleEditor: Selectors;
  publish: Selectors;
}

export interface AppConfig {
  global: GlobalConfig;
  accounts: Account[];
  articles: Article[];
  publishPlan: PublishJob[];
  delays: DelayProfiles;
  typingProfiles: TypingProfiles;
  selectors: AllSelectors;
}
