import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { ProviderName } from './generate-prompt';

export interface ModelRoute {
  provider: ProviderName;
  model: string;
  /** Longest reply allowed, thinking included. Only what is generated is billed. */
  maxTokens: number;
}

export interface ModelPrice {
  /** US$ per million tokens. Thinking tokens are billed as output. */
  input: number;
  output: number;
  /** Output tokens of a typical article, thinking included; only used for the estimate before a run. */
  typicalOutputTokens: number;
}

/** config/generate.json: which model writes each format, how many articles run at once, and model prices. */
export interface GenerateConfig {
  html: ModelRoute;
  markdown: ModelRoute;
  parallel: number;
  retries: number;
  /** Runs with at least this many articles go through the half-price batch APIs; smaller runs are written live. */
  batchMinArticles: number;
  pricesPerMillionTokens: Record<string, ModelPrice>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export const PROVIDERS: ProviderName[] = ['claude', 'gemini', 'openai'];

/**
 * What a bare provider name in --html-model / --markdown-model stands for. Claude's thinking alone can pass
 * 25,000 tokens on a long article, and a cut-off article is paid for and lost; gpt-4o caps replies at 16,384.
 */
const PROVIDER_DEFAULTS: Record<ProviderName, Omit<ModelRoute, 'provider'>> = {
  claude: { model: 'claude-haiku-5-5', maxTokens: 64000 },
  gemini: { model: 'gemini-3.1-flash-lite', maxTokens: 16000 },
  openai: { model: 'gpt-4o', maxTokens: 16000 },
};

const isWhole = (value: unknown, min: number) => typeof value === 'number' && Number.isInteger(value) && value >= min;

function checkRoute(route: ModelRoute | undefined, name: string): void {
  if (!route || !PROVIDERS.includes(route.provider) || typeof route.model !== 'string' || !route.model.trim() || !isWhole(route.maxTokens, 1)) {
    throw new Error(`"${name}" needs a provider (${PROVIDERS.join(', ')}), a model and a whole-number maxTokens`);
  }
}

/** config/generate.json from the working folder's config, else from the tool's own. */
export function loadGenerateConfig(): GenerateConfig {
  const candidates = [resolve(process.env.CONFIG_DIR || './config', 'generate.json'), resolve(__dirname, '../../config/generate.json')];
  const file = candidates.find(path => existsSync(path));
  if (!file) throw new Error(`config/generate.json not found (looked for ${candidates.join(' and ')})`);

  let config: GenerateConfig;
  try {
    config = JSON.parse(readFileSync(file, 'utf-8')) as GenerateConfig;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  checkRoute(config.html, 'html');
  checkRoute(config.markdown, 'markdown');
  config.batchMinArticles ??= 10;
  if (!isWhole(config.parallel, 1) || !isWhole(config.retries, 0) || !isWhole(config.batchMinArticles, 0)) {
    throw new Error(`${file}: "parallel" must be a whole number of at least 1, "retries" and "batchMinArticles" at least 0`);
  }
  config.pricesPerMillionTokens = config.pricesPerMillionTokens || {};
  return config;
}

/**
 * --html-model / --markdown-model values: "claude:claude-sonnet-5-5", a bare model id whose name gives the
 * provider ("claude-sonnet-5-5", "gemini-2.5-flash", "gpt-4o"), or a provider for its default model ("claude").
 */
export function parseModelSpec(spec: string): ModelRoute | null {
  const [head, ...rest] = spec.trim().split(':');
  const name = head.toLowerCase() as ProviderName;
  const model = rest.join(':').trim();
  if (PROVIDERS.includes(name)) {
    return { provider: name, ...PROVIDER_DEFAULTS[name], ...(model ? { model } : {}) };
  }
  if (model) return null;
  const provider: ProviderName | null = /^claude/i.test(head) ? 'claude' : /^gemini/i.test(head) ? 'gemini' : /^(gpt|o\d|chatgpt)/i.test(head) ? 'openai' : null;
  return provider ? { provider, maxTokens: PROVIDER_DEFAULTS[provider].maxTokens, model: head } : null;
}

/** US$ for one call; null when the config has no price for the model. */
export function callCost(config: GenerateConfig, model: string, usage: Usage): number | null {
  const price = config.pricesPerMillionTokens[model];
  return price ? (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1e6 : null;
}

/** Rough US$ for one article before it is written: about 4 characters per prompt token plus a typical reply. */
export function estimateCost(config: GenerateConfig, model: string, promptChars: number): number | null {
  const price = config.pricesPerMillionTokens[model];
  return price ? ((promptChars / 4) * price.input + price.typicalOutputTokens * price.output) / 1e6 : null;
}
