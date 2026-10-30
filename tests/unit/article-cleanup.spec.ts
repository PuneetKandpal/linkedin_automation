import { test, expect } from '@playwright/test';
import { buildOldArticleFilter, getArticleRetentionHours, getCleanupAuthKey } from '../../src/services/articleCleanup';

test('retention defaults to 3 days and reads ARTICLE_RETENTION_HOURS', () => {
  expect(getArticleRetentionHours({})).toBe(72);
  expect(getArticleRetentionHours({ ARTICLE_RETENTION_HOURS: '168' })).toBe(168);
});

test('an invalid retention falls back to the default instead of deleting everything', () => {
  for (const value of ['0', '-5', 'abc', '']) {
    expect(getArticleRetentionHours({ ARTICLE_RETENTION_HOURS: value })).toBe(72);
  }
});

test('only finished articles idle past the retention, with no active job, are selected', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const filter = buildOldArticleFilter(now, 72, ['DHR_OCT_7838']);

  expect(filter.status.$in).toEqual(['published', 'failed']);
  expect(filter.updatedAt.$lt.toISOString()).toBe('2026-10-27T12:00:00.000Z');
  expect(filter.articleId.$nin).toEqual(['DHR_OCT_7838']);
});

test('the manual cleanup endpoint has no built-in key', () => {
  const before = process.env.CLEANUP_AUTH_KEY;
  try {
    delete process.env.CLEANUP_AUTH_KEY;
    expect(getCleanupAuthKey()).toBeUndefined();
    process.env.CLEANUP_AUTH_KEY = '  ';
    expect(getCleanupAuthKey()).toBeUndefined();
    process.env.CLEANUP_AUTH_KEY = 'secret';
    expect(getCleanupAuthKey()).toBe('secret');
  } finally {
    if (before === undefined) delete process.env.CLEANUP_AUTH_KEY;
    else process.env.CLEANUP_AUTH_KEY = before;
  }
});
