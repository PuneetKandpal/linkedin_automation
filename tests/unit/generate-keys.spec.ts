import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanKey, loadKeys, looksLikeKeyProblem, maskKey, saveKeys } from '../../src/services/generate-keys';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

test('a pasted key is cleaned of spaces, quotes and a pasted NAME=', () => {
  expect(cleanKey(`  ${KEY}  `)).toBe(KEY);
  expect(cleanKey(`"${KEY}"`)).toBe(KEY);
  expect(cleanKey(`ANTHROPIC_API_KEY=${KEY}`)).toBe(KEY);
  expect(cleanKey('hello')).toBeNull();
  expect(cleanKey(`${KEY} ${KEY}`)).toBeNull();
});

test('a key on screen shows only its start and end', () => {
  expect(maskKey(KEY)).toBe('sk-ant-…6789');
  expect(maskKey(KEY)).not.toContain('abcdef');
});

test('saving a key replaces its line and keeps every other line', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'generate-keys-')), '.env');
  writeFileSync(path, '# keys\nANTHROPIC_API_KEY=old\nMONGODB_URI=mongodb://x\n');
  saveKeys(path, { ANTHROPIC_API_KEY: KEY, GEMINI_API_KEY: 'AIza-new' });
  expect(readFileSync(path, 'utf8')).toBe(`# keys\nANTHROPIC_API_KEY=${KEY}\nMONGODB_URI=mongodb://x\nGEMINI_API_KEY=AIza-new\n`);
});

test('saving a key creates the .env file when there is none, and handles Windows line endings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'generate-keys-'));
  saveKeys(join(dir, '.env'), { GEMINI_API_KEY: 'AIza-new' });
  expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('GEMINI_API_KEY=AIza-new\n');

  writeFileSync(join(dir, 'win.env'), 'GEMINI_API_KEY=\r\nANTHROPIC_API_KEY=\r\n');
  saveKeys(join(dir, 'win.env'), { ANTHROPIC_API_KEY: KEY });
  expect(readFileSync(join(dir, 'win.env'), 'utf8')).toBe(`GEMINI_API_KEY=\nANTHROPIC_API_KEY=${KEY}\n`);
});

test('keys pasted into config/api-keys.txt are used; empty lines and a Notepad byte order mark are fine', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'generate-keys-')), 'api-keys.txt');
  const before = { ...process.env };
  try {
    process.env.ANTHROPIC_API_KEY = 'from-dotenv';
    process.env.GEMINI_API_KEY = 'from-dotenv';
    process.env.GOOGLE_API_KEY = 'from-dotenv';
    writeFileSync(path, `﻿# paste keys after =\r\nANTHROPIC_API_KEY= ${KEY}\r\nGEMINI_API_KEY=\r\n`);
    loadKeys(path);
    expect(process.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(process.env.GEMINI_API_KEY).toBe('from-dotenv');
    expect(process.env.GOOGLE_API_KEY).toBe('from-dotenv');

    writeFileSync(path, 'GEMINI_API_KEY="AIza-pasted"\n');
    loadKeys(path);
    expect(process.env.GEMINI_API_KEY).toBe('AIza-pasted');
    expect(process.env.GOOGLE_API_KEY).toBeUndefined();
  } finally {
    process.env = before;
  }
});

test('key failures are told apart from others, so the tool can say how to replace the key', () => {
  expect(looksLikeKeyProblem('Claude API error: 401 {"type":"authentication_error","message":"invalid x-api-key"}')).toBe(true);
  expect(looksLikeKeyProblem('Gemini API error: API key not valid. Please pass a valid API key.')).toBe(true);
  expect(looksLikeKeyProblem('3 articles in a row failed: overloaded')).toBe(false);
});
