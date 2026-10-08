import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatStatusCell, loadFollowWorkbook, parseStatusCell } from '../../src/services/follow-excel';

const dir = mkdtempSync(join(tmpdir(), 'follow-workbook-'));
const write = (name: string, aoa: string[][]) => {
  const file = join(dir, name);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  XLSX.writeFile(wb, file);
  return file;
};
const read = (file: string): string[][] =>
  XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(file).Sheets.Sheet1, { header: 1, defval: '' }).map(r => r.map(String));
const base = (n: number) => [
  ['Page Name', 'URL'],
  ...Array.from({ length: n }, (_, i) => [`Co ${i + 1}`, `https://www.linkedin.com/company/co-${i + 1}/?viewAsMember=true`]),
];

test.describe('status cell text', () => {
  test('notes go in parentheses, capitalised, on one line', () => {
    expect(formatStatusCell('Followed')).toBe('Followed');
    expect(formatStatusCell('Already following', 'duplicate of row 87')).toBe('Already following (Duplicate of row 87)');
    expect(formatStatusCell('Failed', 'Error: boom\n  at x\n  at y')).toBe('Failed (Error: boom at x at y)');
  });

  for (const [text, status, note, custom] of [
    ['Followed', 'Followed', '', false],
    ['already following', 'Already following', '', false],
    ['Already following (Duplicate of row 87)', 'Already following', 'Duplicate of row 87', false],
    ['Failed (Error (x))', 'Failed', 'Error (x)', false],
    ['  FAILED  ', 'Failed', '', false],
    ['', '', '', false],
    ['DO NOT FOLLOW', '', '', true],
    ['Followed maybe?', '', '', true],
  ] as const) {
    test(`parses ${JSON.stringify(text)}`, () => {
      expect(parseStatusCell(text)).toEqual({ status, note, custom });
    });
  }
});

test.describe('one column per user', () => {
  test('a new user gets a column headed by the userid; nothing else changes', () => {
    const f = write('one.xlsx', base(3));
    const wb = loadFollowWorkbook(f, 'puneet');
    expect(wb.createdUserColumn).toBe(true);
    wb.markStatus(wb.rows[0], 'Followed');
    wb.markStatus(wb.rows[1], 'Already following', 'duplicate of row 2');
    const sheet = read(f);
    expect(sheet[0]).toEqual(['Page Name', 'URL', 'puneet']);
    expect(sheet.map(r => r[2])).toEqual(['puneet', 'Followed', 'Already following (Duplicate of row 2)', '']);
    expect(sheet[1].slice(0, 2)).toEqual(['Co 1', 'https://www.linkedin.com/company/co-1/?viewAsMember=true']);
    expect(readdirSync(dir).filter(x => x.startsWith('.~'))).toEqual([]);
  });

  test('reopening reads statuses back and does not add another column', () => {
    const f = write('reopen.xlsx', base(3));
    let wb = loadFollowWorkbook(f, 'puneet');
    wb.markStatus(wb.rows[0], 'Followed');
    wb.markStatus(wb.rows[1], 'Already following');
    wb = loadFollowWorkbook(f, 'puneet');
    expect(wb.createdUserColumn).toBe(false);
    expect(read(f)[0]).toHaveLength(3);
    expect(wb.pendingRows.map(r => r.name)).toEqual(['Co 3']);
  });

  test('a second user gets their own column and never touches the first', () => {
    const f = write('two.xlsx', base(3));
    let wb = loadFollowWorkbook(f, 'puneet');
    wb.markStatus(wb.rows[0], 'Followed');
    wb = loadFollowWorkbook(f, 'sumit');
    expect(wb.pendingRows).toHaveLength(3);
    wb.markStatus(wb.rows[2], 'Failed', 'page not found');
    const sheet = read(f);
    expect(sheet[0]).toEqual(['Page Name', 'URL', 'puneet', 'sumit']);
    expect(sheet.map(r => r[2])).toEqual(['puneet', 'Followed', '', '']);
    expect(sheet.map(r => r[3])).toEqual(['sumit', '', '', 'Failed (Page not found)']);
  });

  test('the header matches the userid ignoring case and padding', () => {
    const f = write('case.xlsx', [['Page Name', 'URL', ' Sumit '], ['A', 'linkedin.com/company/a', 'Followed'], ['B', 'linkedin.com/company/b', '']]);
    const wb = loadFollowWorkbook(f, 'sumit');
    expect(wb.createdUserColumn).toBe(false);
    expect(wb.pendingRows).toHaveLength(1);
    expect(read(f)[0]).toHaveLength(3);
  });

  test('hand-typed text is reported, skipped, and never overwritten', () => {
    const f = write('custom.xlsx', [['Page Name', 'URL', 'sumit'], ['A', 'linkedin.com/company/a', 'DO NOT FOLLOW'], ['B', 'linkedin.com/company/b', '']]);
    const wb = loadFollowWorkbook(f, 'sumit');
    expect(wb.customRows).toHaveLength(1);
    expect(wb.pendingRows.map(r => r.name)).toEqual(['B']);
    wb.markStatus(wb.rows[1], 'Followed');
    expect(read(f).map(r => r[2])).toEqual(['sumit', 'DO NOT FOLLOW', 'Followed']);
  });

  test('legacy Status / Followed At / Notes columns are ignored and left as they were', () => {
    const f = write('legacy.xlsx', [['Page Name', 'URL', 'Status', 'Followed At', 'Notes'], ['A', 'linkedin.com/company/a', 'Followed', '2026-10-08', ''], ['B', 'linkedin.com/company/b', '', '', '']]);
    const wb = loadFollowWorkbook(f, 'sumit');
    expect(wb.pendingRows).toHaveLength(2);
    wb.markStatus(wb.rows[0], 'Already following');
    const sheet = read(f);
    expect(sheet[0]).toEqual(['Page Name', 'URL', 'Status', 'Followed At', 'Notes', 'sumit']);
    expect(sheet[1].slice(2, 4)).toEqual(['Followed', '2026-10-08']);
  });

  test('other columns keep their data; the user column goes far right', () => {
    const f = write('extra.xlsx', [['Page Name', 'URL', 'Industry'], ['A', 'linkedin.com/company/a', 'Marketing']]);
    const wb = loadFollowWorkbook(f, 'sumit');
    wb.markStatus(wb.rows[0], 'Followed');
    expect(read(f)).toEqual([['Page Name', 'URL', 'Industry', 'sumit'], ['A', 'linkedin.com/company/a', 'Marketing', 'Followed']]);
  });

  test('a userid equal to a data column is refused and the file untouched', () => {
    const f = write('collide.xlsx', base(1));
    expect(() => loadFollowWorkbook(f, 'url')).toThrow(/URL column/);
    expect(() => loadFollowWorkbook(f, 'Page Name')).toThrow(/column/);
    expect(read(f)[0]).toEqual(['Page Name', 'URL']);
  });

  test('opened without a user it only reads: nothing written, no results recorded', () => {
    const f = write('readonly-use.xlsx', base(2));
    const before = readFileSync(f);
    const wb = loadFollowWorkbook(f);
    expect(wb.pendingRows).toHaveLength(2);
    expect(Buffer.compare(before, readFileSync(f))).toBe(0);
    expect(() => wb.markStatus(wb.rows[0], 'Followed')).toThrow(/user id/);
  });

  test('a read-only workbook throws and leaves no temp file', () => {
    const f = write('locked.xlsx', base(2));
    chmodSync(f, 0o444);
    const wb = loadFollowWorkbook(f, 'sumit');
    try {
      expect(() => wb.markStatus(wb.rows[0], 'Followed')).toThrow(/EACCES/);
    } finally {
      chmodSync(f, 0o644);
    }
    expect(read(f)[0]).toEqual(['Page Name', 'URL']);
    expect(readdirSync(dir).filter(x => x.startsWith('.~'))).toEqual([]);
  });

  test('100 users make exactly 100 columns, each holding only its own result', () => {
    const f = write('hundred.xlsx', base(10));
    for (let u = 1; u <= 100; u++) {
      const w = loadFollowWorkbook(f, `user${u}`);
      w.markStatus(w.rows[u % 10], u % 3 === 0 ? 'Followed' : 'Already following', u % 7 === 0 ? 'duplicate of row 3' : undefined);
    }
    const sheet = read(f);
    expect(sheet[0]).toHaveLength(102);
    for (let u = 1; u <= 100; u++) {
      const filled = sheet.slice(1).map((r, i) => [i, r[u + 1]] as const).filter(([, v]) => v !== '');
      const status = u % 3 === 0 ? 'Followed' : 'Already following';
      expect(filled).toEqual([[u % 10, u % 7 === 0 ? `${status} (Duplicate of row 3)` : status]]);
    }
  });
});
