import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { PublisherError, ErrorCode } from '../errors/error.types';
import { AllSelectors, DelayProfiles, GlobalConfig, TypingProfiles } from './types';

export interface StaticConfig {
  global: GlobalConfig;
  delays: DelayProfiles;
  typingProfiles: TypingProfiles;
  selectors: AllSelectors;
}

export class StaticConfigLoader {
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

  loadAll(): StaticConfig {
    const global = this.loadJSON<GlobalConfig>('global.json');
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
      delays,
      typingProfiles,
      selectors,
    };
  }
}
