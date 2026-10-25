import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ApiError, GoogleGenAI } from '@google/genai';
import { parse } from 'dotenv';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { ProviderName } from './generate-prompt';

/** The name each provider's API key has in config/api-keys.txt (and in the environment). */
export const KEY_NAMES: Record<ProviderName, string> = { claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' };

/**
 * config/api-keys.txt: a plain text file the client can open and paste into, one NAME=key per line. Looked for where
 * config/generate.json is: the run folder's config, then the tool's own; a new file goes in the tool's own config.
 */
export function keysFilePath(): string {
  const candidates = [resolve(process.env.CONFIG_DIR || './config', 'api-keys.txt'), resolve(__dirname, '../../config/api-keys.txt')];
  return candidates.find(path => existsSync(path)) ?? candidates[1];
}

/**
 * Puts the keys from config/api-keys.txt in the environment, where the providers' SDKs read them. A key in the file
 * wins over one from .env or the environment; an empty line (a key not pasted yet) changes nothing.
 */
export function loadKeys(path = keysFilePath()): void {
  if (!existsSync(path)) return;
  // Notepad may save the file with a byte order mark, which would hide the first key's name.
  const values = parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  for (const name of [...Object.values(KEY_NAMES), 'GOOGLE_API_KEY']) {
    const value = values[name]?.trim();
    if (value) process.env[name] = value;
  }
  if (values.GEMINI_API_KEY?.trim()) delete process.env.GOOGLE_API_KEY;
}

/** The key a provider will use now, or '' when none is set. */
export function currentKey(provider: ProviderName): string {
  if (provider === 'gemini') return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  return process.env[KEY_NAMES[provider]] || '';
}

/** Enough of a key to recognise it on screen, never enough to use it: "sk-ant-…x7Qa". */
export function maskKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : '(set)';
}

/** A key as pasted: surrounding spaces or quotes go, or "NAME=" when a whole NAME=key line was pasted. Null when it cannot be a key. */
export function cleanKey(text: string): string | null {
  let value = text.trim().replace(/^[A-Z_]+_API_KEY\s*=\s*/, '');
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1).trim();
  return value.length >= 20 && /^[\x21-\x7e]+$/.test(value) ? value : null;
}

/**
 * Sets keys in a NAME=value file, keeping every other line: a key's line is replaced where it is, or added at the end.
 * Written to a temporary file first, so a failure never leaves a half-written file.
 */
export function saveKeys(path: string, keys: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r?\n$/, '').split(/\r?\n/) : [];
  for (const [name, value] of Object.entries(keys)) {
    const line = `${name}=${value}`;
    const at = lines.findIndex(text => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(text));
    if (at === -1) lines.push(line);
    else lines[at] = line;
  }
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${lines.filter((text, i) => text !== '' || i > 0).join('\n')}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export type KeyCheck = { result: 'ok' } | { result: 'refused' | 'unchecked'; message: string };

const CHECK_TIMEOUT_MS = 20_000;

/**
 * Asks the provider whether it accepts a key, by looking up the model the tool will use (free). An unknown model
 * still means the key was accepted. 'unchecked': no answer (no internet, an outage), which says nothing about the key.
 */
export async function checkKey(provider: ProviderName, key: string, model: string): Promise<KeyCheck> {
  try {
    if (provider === 'claude') await new Anthropic({ apiKey: key, timeout: CHECK_TIMEOUT_MS, maxRetries: 1 }).models.retrieve(model);
    else if (provider === 'openai') await new OpenAI({ apiKey: key, timeout: CHECK_TIMEOUT_MS, maxRetries: 1 }).models.retrieve(model);
    else await new GoogleGenAI({ apiKey: key, httpOptions: { timeout: CHECK_TIMEOUT_MS } }).models.get({ model });
    return { result: 'ok' };
  } catch (err) {
    const status = err instanceof Anthropic.APIError || err instanceof OpenAI.APIError || err instanceof ApiError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    if (status === 404) return { result: 'ok' };
    // Gemini answers 400 "API key not valid"; the others 401. 403: the key is real but may not use this API.
    if (status === 400 || status === 401 || status === 403) return { result: 'refused', message };
    return { result: 'unchecked', message };
  }
}

/** Whether a failure message is about the API key, so the tool can say how to replace it. */
export function looksLikeKeyProblem(text: string): boolean {
  return /\b40[13]\b|api[ _-]?key|authenticat|permission/i.test(text);
}
