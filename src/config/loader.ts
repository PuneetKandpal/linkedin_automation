import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  AppConfig,
  GlobalConfig,
  Account,
  Article,
  PublishJob,
  DelayProfiles,
  TypingProfiles,
  AllSelectors,
} from './types';
import { ErrorCode, PublisherError } from '../errors/error.types';

export class ConfigLoader {
  private configDir: string;

  constructor(configDir: string = './config') {
    this.configDir = resolve(configDir);
  }

  private loadJSON<T>(relativePath: string): T {
    try {
      const fullPath = join(this.configDir, relativePath);
      const content = readFileSync(fullPath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error) {
      throw new PublisherError(
        ErrorCode.CONFIG_INVALID,
        `Failed to load config: ${relativePath}`,
        { error: String(error) }
      );
    }
  }

  loadAll(): AppConfig {
    const global = this.loadJSON<GlobalConfig>('global.json');
    const accounts = this.loadJSON<Account[]>('accounts.json');
    const articles = this.loadJSON<Article[]>('articles.json');
    const publishPlan = this.loadJSON<PublishJob[]>('publish-plan.json');
    const delays = this.loadJSON<DelayProfiles>('delays.json');
    const typingProfiles = this.loadJSON<TypingProfiles>('typing-profiles.json');

    const selectors: AllSelectors = {
      common: this.loadJSON('selectors/common.json'),
      login: this.loadJSON('selectors/login.json'),
      articleEditor: this.loadJSON('selectors/article-editor.json'),
      publish: this.loadJSON('selectors/publish.json'),
    };

    return {
      global,
      accounts,
      articles,
      publishPlan,
      delays,
      typingProfiles,
      selectors,
    };
  }

  getAccount(config: AppConfig, accountId: string): Account {
    const account = config.accounts.find(a => a.accountId === accountId);
    if (!account) {
      throw new PublisherError(
        ErrorCode.ACCOUNT_NOT_FOUND,
        `Account not found: ${accountId}`
      );
    }
    return account;
  }

  getArticle(config: AppConfig, articleId: string): Article {
    const article = config.articles.find(a => a.articleId === articleId);
    if (!article) {
      throw new PublisherError(
        ErrorCode.ARTICLE_NOT_FOUND,
        `Article not found: ${articleId}`
      );
    }
    return article;
  }
}
