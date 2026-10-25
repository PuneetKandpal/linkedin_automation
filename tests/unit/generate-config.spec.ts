import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { callCost, estimateCost, GenerateConfig, loadGenerateConfig, parseModelSpec } from '../../src/services/generate-config';

const repoConfig = loadGenerateConfig();

test('the shipped config/generate.json loads: HTML with Claude, Markdown with a low-cost model', () => {
  expect(repoConfig.html.provider).toBe('claude');
  expect(repoConfig.markdown.provider).toBe('gemini');
  expect(repoConfig.pricesPerMillionTokens[repoConfig.html.model]).toBeDefined();
  expect(repoConfig.pricesPerMillionTokens[repoConfig.markdown.model]).toBeDefined();
});

test('a broken config is refused with the reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'generate-config-'));
  mkdirSync(join(dir, 'config'));
  const before = process.env.CONFIG_DIR;
  process.env.CONFIG_DIR = join(dir, 'config');
  try {
    writeFileSync(join(dir, 'config', 'generate.json'), JSON.stringify({ ...repoConfig, html: { provider: 'mistral', model: 'x', maxTokens: 10 } }));
    expect(() => loadGenerateConfig()).toThrow(/"html" needs a provider/);
    writeFileSync(join(dir, 'config', 'generate.json'), JSON.stringify({ ...repoConfig, parallel: 0 }));
    expect(() => loadGenerateConfig()).toThrow(/"parallel" must be a whole number/);
    writeFileSync(join(dir, 'config', 'generate.json'), '{ not json');
    expect(() => loadGenerateConfig()).toThrow(/not valid JSON/);
  } finally {
    if (before === undefined) delete process.env.CONFIG_DIR;
    else process.env.CONFIG_DIR = before;
  }
});

test('model names from the command line: provider:model, a bare model id, or a provider alone', () => {
  expect(parseModelSpec('claude:claude-sonnet-5-5')).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5', maxTokens: 64000 });
  expect(parseModelSpec('claude-opus-5-5')).toEqual({ provider: 'claude', model: 'claude-opus-5-5', maxTokens: 64000 });
  expect(parseModelSpec('gemini-2.5-flash')).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash', maxTokens: 16000 });
  expect(parseModelSpec('gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o', maxTokens: 16000 });
  expect(parseModelSpec('Gemini')).toEqual({ provider: 'gemini', model: 'gemini-3.1-flash-lite', maxTokens: 16000 });
  expect(parseModelSpec('mistral-large')).toBeNull();
  expect(parseModelSpec('mistral:large')).toBeNull();
});

test('cost comes from the price table; unknown models have no price', () => {
  const config = { pricesPerMillionTokens: { m: { input: 0.1, output: 0.5, typicalOutputTokens: 12000 } } } as unknown as GenerateConfig;
  expect(callCost(config, 'm', { inputTokens: 2000, outputTokens: 10000 })).toBeCloseTo(0.0052, 10);
  expect(callCost(config, 'other', { inputTokens: 1, outputTokens: 1 })).toBeNull();
  // 8,000 prompt characters is about 2,000 tokens, plus a typical 12,000-token reply.
  expect(estimateCost(config, 'm', 8000)).toBeCloseTo(0.0062, 10);
});
