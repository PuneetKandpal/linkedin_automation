import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { mkdirSync, mkdtempSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FollowRunner, pickProfileSlug } from '../../src/services/follow-runner';
import { loadFollowWorkbook } from '../../src/services/follow-excel';
import { BrowserClosedError, ErrorCode, LoginRedirectError, PageUnresponsiveError, PublisherError } from '../../src/errors/error.types';

const dir = mkdtempSync(join(tmpdir(), 'follow-runner-'));
const quiet: any = { info() {}, warn() {}, error() {}, debug() {} };

type Spec = { slug: string; url?: string; status?: string };
type Scenario = {
  rows: Spec[];
  states?: Record<string, string>;
  followResult?: Record<string, boolean>;
  afterClick?: Record<string, string>;
  throwOn?: Record<string, () => Error>;
  maxPerRun?: number;
};

const realRandom = Math.random;
let cwd = process.cwd();
test.beforeAll(() => {
  cwd = process.cwd();
  process.chdir(dir); // failure screenshots go to ./output/screenshots
  Math.random = () => 0.9999999; // Fisher-Yates becomes the identity: rows keep sheet order
});
test.afterAll(() => {
  Math.random = realRandom;
  process.chdir(cwd);
});

async function run(s: Scenario) {
  const file = join(dir, `run-${realRandom().toString(36).slice(2)}.xlsx`);
  const aoa = [['Page Name', 'URL', 'UNIT'], ...s.rows.map(r => [r.slug, r.url ?? `https://www.linkedin.com/company/${r.slug}/?viewAsMember=true`, r.status || ''])];
  const wbk = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbk, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  XLSX.writeFile(wbk, file);

  let shots = 0;
  let delays = 0;
  let followPauses = 0;
  const visits: string[] = [];
  const page: any = {
    url: () => 'https://www.linkedin.com/feed/',
    goto: async () => {},
    evaluate: async () => 'complete',
    context: () => ({ cookies: async () => [{ name: 'li_at', value: 'x' }] }),
    locator: () => ({ first: () => ({ isVisible: async () => false, getAttribute: async () => null, waitFor: async () => { throw new Error('t'); } }) }),
    getByRole: () => ({ first: () => ({ waitFor: async () => { throw new Error('t'); } }) }),
    screenshot: async () => { shots++; },
    waitForTimeout: async () => {},
  };
  const delayEngine: any = { wait: async () => {}, betweenFollows: async () => { delays++; followPauses++; }, betweenChecks: async () => { delays++; }, beforeFollowClick: async () => {} };
  const runner: any = new FollowRunner({
    account: { accountId: 'unit', profileSlug: '' },
    excelPath: file,
    maxPerRun: s.maxPerRun ?? 100,
    logger: quiet,
    delayEngine,
    humanEngine: {} as any,
    selectors: { login: { otpInput: 'x' }, common: { captchaIframe: 'x' }, follow: {} } as any,
    page,
  });

  const slugOf = (u: string) => (u.match(/\/company\/([^/?#]+)/i) || [])[1].toLowerCase();
  let current = '';
  let afterFirst: Record<string, number> = {};
  runner.followPage = {
    openCompany: async (url: string) => {
      current = slugOf(url);
      visits.push(current);
      const t = s.throwOn?.[current];
      if (t) throw t();
    },
    detectState: async () => {
      afterFirst[current] = (afterFirst[current] || 0) + 1;
      if (s.afterClick?.[current] && afterFirst[current] > 1) return s.afterClick[current];
      return s.states?.[current] || 'following';
    },
    follow: async () => s.followResult?.[current] ?? true,
  };

  let error: any = null;
  let summary: any = null;
  try {
    summary = await runner.run();
  } catch (e) {
    error = e;
  }
  const byRow = loadFollowWorkbook(file, 'unit').rows.map(r => `${r.status || '(blank)'}${r.note ? ` [${r.note}]` : ''}`);
  unlinkSync(file);
  return { error, summary, byRow, visits, shots, delays, followPauses };
}
const rows = (...slugs: string[]): Spec[] => slugs.map(slug => ({ slug }));

test.describe('duplicates', () => {
  test('a company listed twice (case, sub-page, typo) is visited once', async () => {
    const r = await run({ rows: [{ slug: 'a' }, { slug: 'A', url: 'https://www.linkedin.com/company/A/about/?viewAsMember=truee' }, { slug: 'c' }] });
    expect(r.visits).toEqual(['a', 'c']);
    expect(r.byRow[1]).toBe('Already following [Duplicate of row 2]');
    expect(r.delays).toBe(1);
  });

  test('a duplicate of a row finished in an earlier run is not revisited', async () => {
    const r = await run({ rows: [{ slug: 'a', status: 'Followed' }, { slug: 'a' }, { slug: 'b' }] });
    expect(r.visits).toEqual(['b']);
    expect(r.byRow[1]).toBe('Already following [Duplicate of row 2]');
  });
});

test.describe('stopping early', () => {
  test('4 unrecognised pages in a row stop the run; the rest stay blank; screenshots capped at 3', async () => {
    const states = Object.fromEntries('abcdef'.split('').map(c => [c, 'unknown']));
    const r = await run({ rows: rows(...'abcdef'.split('')), states });
    expect(r.error).toBeInstanceOf(PublisherError);
    expect((r.error as PublisherError).code).toBe(ErrorCode.CONFIG_INVALID);
    expect(r.byRow.filter(x => x.startsWith('Failed'))).toHaveLength(4);
    expect(r.byRow.filter(x => x === '(blank)')).toHaveLength(2);
    expect(r.shots).toBe(3);
  });

  test('a success resets the counter', async () => {
    const states: Record<string, string> = { a: 'unknown', b: 'unknown', c: 'unknown', d: 'following', e: 'unknown', f: 'unknown', g: 'unknown', h: 'following' };
    const r = await run({ rows: rows(...Object.keys(states)), states });
    expect(r.error).toBeNull();
    expect(r.byRow.filter(x => x.startsWith('Failed'))).toHaveLength(6);
  });

  test('4 page errors in a row also stop the run', async () => {
    const boom = () => new Error('net::ERR_INTERNET_DISCONNECTED');
    const r = await run({ rows: rows('a', 'b', 'c', 'd', 'e'), throwOn: { a: boom, b: boom, c: boom, d: boom } });
    expect((r.error as PublisherError).code).toBe(ErrorCode.CONFIG_INVALID);
    expect(r.byRow[4]).toBe('(blank)');
  });

  test('4 follows in a row that never persist stop the run', async () => {
    const all = ['a', 'b', 'c', 'd', 'e'];
    const r = await run({
      rows: rows(...all),
      states: Object.fromEntries(all.map(c => [c, 'follow'])),
      followResult: Object.fromEntries(all.map(c => [c, false])),
      afterClick: Object.fromEntries(all.map(c => [c, 'follow'])),
    });
    expect((r.error as PublisherError).code).toBe(ErrorCode.CONFIG_INVALID);
    expect(r.byRow.slice(0, 4).every(x => x === 'Failed [Follow not confirmed]')).toBe(true);
    expect(r.byRow[4]).toBe('(blank)');
  });

  test('signed out mid-run halts and leaves the remaining rows blank, not Failed', async () => {
    const r = await run({ rows: rows('a', 'b', 'c', 'd'), states: { c: 'loggedout' } });
    expect(r.error).toBeInstanceOf(LoginRedirectError);
    expect(r.byRow).toEqual(['Already following', 'Already following', '(blank)', '(blank)']);
  });

  test('signed out right after a Follow click halts too', async () => {
    const r = await run({ rows: rows('a', 'b'), states: { a: 'follow', b: 'following' }, followResult: { a: false }, afterClick: { a: 'loggedout' } });
    expect(r.error).toBeInstanceOf(LoginRedirectError);
    expect(r.byRow[0]).toBe('(blank)');
  });

  test('a frozen tab halts and leaves that row blank', async () => {
    const r = await run({ rows: rows('a', 'b', 'c'), throwOn: { b: () => new PageUnresponsiveError('frozen') } });
    expect(r.error).toBeInstanceOf(PageUnresponsiveError);
    expect(r.byRow).toEqual(['Already following', '(blank)', '(blank)']);
  });

  test('a challenge wall stops the run and always saves its screenshot', async () => {
    const r = await run({ rows: rows('a', 'b', 'c'), states: { b: 'challenge' } });
    expect(r.error).toBeNull();
    expect(r.summary.challengeHalt).toBe(true);
    expect(r.byRow[2]).toBe('(blank)');
    expect(r.shots).toBe(1);
  });
});

test.describe('row outcomes', () => {
  test('Followed / not confirmed / challenge after the click', async () => {
    const r = await run({
      rows: rows('a', 'b', 'c'),
      states: { a: 'follow', b: 'follow', c: 'follow' },
      followResult: { a: true, b: false, c: false },
      afterClick: { c: 'challenge' },
    });
    expect(r.byRow[0]).toBe('Followed');
    expect(r.byRow[1]).toBe('Failed [Follow not confirmed]');
    expect(r.byRow[2]).toMatch(/^Failed \[Challenge/);
    expect(r.summary.challengeHalt).toBe(true);
  });

  test('admin, not found, and junk URLs; invalid rows never trip the breaker', async () => {
    const r = await run({
      rows: [{ slug: 'a' }, { slug: 'b' }, { slug: 'c', url: 'not a url' }, { slug: 'd', url: '' }, { slug: 'e', url: 'https://www.linkedin.com/in/some-person/' }, { slug: 'f' }],
      states: { a: 'admin', b: 'notfound', f: 'following' },
    });
    expect(r.byRow[0]).toBe('Failed [Admin dashboard shown instead of member view]');
    expect(r.byRow[1]).toBe('Failed [Page not found]');
    expect(r.byRow.slice(2, 5)).toEqual(Array(3).fill('Failed [Invalid company URL]'));
    expect(r.error).toBeNull();
    expect(r.byRow[5]).toBe('Already following');
  });

  test('Followed / Already following rows are skipped; Failed and blank rows are retried', async () => {
    const r = await run({ rows: [{ slug: 'a', status: 'Followed' }, { slug: 'b', status: 'Already following' }, { slug: 'c', status: 'Failed' }, { slug: 'd' }] });
    expect(r.visits).toEqual(['c', 'd']);
  });

  test('--max-per-run caps the batch', async () => {
    const r = await run({ rows: rows('a', 'b', 'c', 'd', 'e'), maxPerRun: 3 });
    expect(r.visits).toHaveLength(3);
  });
});

test.describe('pacing', () => {
  test('only page visits are paced', async () => {
    expect((await run({ rows: [{ slug: 'a' }, { slug: 'x', url: 'junk' }, { slug: 'y', url: '' }] })).delays).toBe(0);
    expect((await run({ rows: [{ slug: 'a' }, { slug: 'x', url: 'junk' }, { slug: 'b' }] })).delays).toBe(1);
    expect((await run({ rows: rows('a', 'A') })).delays).toBe(0);
    expect((await run({ rows: rows('a', 'b', 'c') })).delays).toBe(2);
  });
});

test.describe('own profile slug from the feed', () => {
  const link = (slug: string) => `https://www.linkedin.com/in/${slug}/`;

  test('the post box link wins when present', () => {
    expect(pickProfileSlug(link('me-123'), [link('someone-else'), link('someone-else')])).toBe('me-123');
  });

  test('without it, the clear majority of the first links wins (profile card links the member 3-4 times)', () => {
    const first = [link('sumit-kalekar-297151204'), link('sumit-kalekar-297151204'), link('sumit-kalekar-297151204'), link('sumit-kalekar-297151204'), link('atharva-joshi07'), link('atharva-joshi07')];
    expect(pickProfileSlug(null, first)).toBe('sumit-kalekar-297151204');
  });

  test('ambiguous or thin evidence returns null rather than a wrong slug', () => {
    expect(pickProfileSlug(null, [])).toBeNull();
    expect(pickProfileSlug(null, [link('a'), link('b'), link('c')])).toBeNull();
    expect(pickProfileSlug(null, [link('a'), link('a'), link('b'), link('b')])).toBeNull();
    expect(pickProfileSlug(null, [link('a'), link('a'), link('b')])).toBeNull();
  });

  test('url-encoded slugs are decoded', () => {
    expect(pickProfileSlug('https://www.linkedin.com/in/jos%C3%A9-p/', [])).toBe('josé-p');
  });
});

test.describe('browser closed mid-run', () => {
  test('halts at the first dead-browser error and leaves the row blank (no Failed marks)', async () => {
    const dead = () => new Error('page.goto: Target page, context or browser has been closed');
    const r = await run({ rows: rows('a', 'b', 'c', 'd', 'e'), throwOn: { b: dead, c: dead, d: dead } });
    expect(r.error).toBeInstanceOf(BrowserClosedError);
    expect(r.byRow).toEqual(['Already following', '(blank)', '(blank)', '(blank)', '(blank)']);
  });
});

test.describe('pause length', () => {
  test('the long pause follows a real follow; pages needing no click get the short one', async () => {
    const r = await run({ rows: rows('a', 'b', 'c', 'd'), states: { a: 'follow', b: 'following', c: 'follow', d: 'following' } });
    expect(r.byRow).toEqual(['Followed', 'Already following', 'Followed', 'Already following']);
    expect(r.delays).toBe(3);
    expect(r.followPauses).toBe(2); // after a and c; b got the short pause
  });
});
