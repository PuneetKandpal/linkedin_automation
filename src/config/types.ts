export interface GlobalConfig {
  browser: {
    headless: boolean;
    slowMo: number;
    defaultTimeout: number;
    initialPageLoadTimeoutMs: number;
    /** 'chrome' = installed Google Chrome with the account's saved profile; 'playwright' = bundled Chromium. */
    engine?: 'chrome' | 'playwright';
    /** engine 'chrome' only: 'background' (default) = no window shown, no focus taken (macOS + Windows); 'visible' = normal window. */
    chromeWindow?: 'background' | 'visible';
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
  companyPageUrl?: string;
  companyPageName?: string;
  schedulePolicy?: {
    minGapMinutesPerAccount?: number;
    minGapMinutesPerCompanyPage?: number;
  };
}

export interface DelayRange {
  preLaunch: [number, number];
  beforeEditorFocus: [number, number];
  betweenParagraphs: [number, number];
  beforePublish: [number, number];
  afterPublish: [number, number];
  betweenFollows?: [number, number];
  betweenChecks?: [number, number];
  beforeFollowClick?: [number, number];
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

export interface FollowSelectors {
  topCard: string;
  topCardAlt?: string;
  topCardByKey?: string;
  adminNav?: string;
  challengeWall: string;
  challengeWallText?: string;
  pageNotFound: string;
  followButton: string;
  followButtonAlt?: string;
  followButtonByLabel?: string;
  followingButton: string;
  followingButtonAlt?: string;
  followingButtonByLabel?: string;
  [key: string]: string | undefined;
}

export interface AllSelectors {
  common: Selectors;
  login: Selectors;
  articleEditor: Selectors;
  publish: Selectors;
  follow: FollowSelectors;
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
