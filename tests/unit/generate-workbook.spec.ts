import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadGenerateWorkbook } from '../../src/services/generate-excel';

const dir = mkdtempSync(join(tmpdir(), 'generate-workbook-'));
const write = (name: string, aoa: string[][]) => {
  const file = join(dir, name);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  XLSX.writeFile(wb, file);
  return file;
};
const read = (file: string): string[][] =>
  XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(file).Sheets.Sheet1, { header: 1, defval: '' }).map(r => r.map(String));
const OUTPUT_HEADER = ['Report Title', 'Prompt Template', 'Sample Download Link', 'Discount Link', 'Customization Link', 'Generated Content'];

test('LinkedIn records: blank rows are skipped and the output adds Generated Content after the links', () => {
  const f = write('linkedin.xlsx', [
    ['Report Title', 'Prompt Template', 'Sample Download Link', 'Discount Link', 'Customization Link'],
    ['A Market', 'T1', 's1', 'd1', 'c1'],
    ['', '', '', '', ''],
    ['B Market', 'T2', 's2', 'd2', 'c2'],
  ]);
  const wb = loadGenerateWorkbook(f);
  expect(wb.isOutput).toBe(false);
  expect(wb.rows.map(r => [r.rowIndex, r.title, r.links.discount])).toEqual([[2, 'A Market', 'd1'], [4, 'B Market', 'd2']]);

  const out = join(dir, 'linkedin - Output.xlsx');
  wb.writeTo(out);
  wb.markGenerated(wb.rows[1], '# B');
  expect(read(out)).toEqual([OUTPUT_HEADER, ['A Market', 'T1', 's1', 'd1', 'c1', ''], ['B Market', 'T2', 's2', 'd2', 'c2', '# B']]);
  expect(readdirSync(dir).filter(x => x.startsWith('.~'))).toEqual([]);
});

test('Website records (no link columns) get empty link columns, like the workflow output', () => {
  const f = write('website.xlsx', [['Report Title', 'Prompt Template'], ['A Market', 'T1']]);
  const wb = loadGenerateWorkbook(f);
  const out = join(dir, 'website - Output.xlsx');
  wb.writeTo(out);
  expect(read(out)).toEqual([OUTPUT_HEADER, ['A Market', 'T1', '', '', '', '']]);
});

test('an output workbook is continued: rows that have content are no longer pending', () => {
  const f = write('resume.xlsx', [OUTPUT_HEADER, ['A Market', 'P1', '', '', '', '# done'], ['B Market', 'P2', '', '', '', '']]);
  const wb = loadGenerateWorkbook(f);
  expect(wb.isOutput).toBe(true);
  expect(wb.pendingRows.map(r => r.title)).toEqual(['B Market']);
  wb.writeTo(f);
  wb.markGenerated(wb.pendingRows[0], '# B');
  expect(read(f).map(r => r[5])).toEqual(['Generated Content', '# done', '# B']);
});

test('headers match loosely (a Supabase export loads) and other columns are kept and usable in templates', () => {
  const f = write('supabase.xlsx', [
    ['report title', 'Generated Content', 'search_by_id', 'Prompt_Template', 'Sample_Download_Link', 'Discount_Link', 'Custom_Link', 'Base Year'],
    ['A Market', '', 'run(1)', 'P', 's', 'd', 'c', '2025'],
  ]);
  const wb = loadGenerateWorkbook(f);
  const row = wb.rows[0];
  expect(row).toMatchObject({ title: 'A Market', prompt: 'P', links: { sample: 's', discount: 'd', customization: 'c' }, extra: ['run(1)', '2025'] });
  expect(wb.templateValues(row)).toEqual({
    report_title: 'A Market',
    sample_download_link: 's',
    discount_link: 'd',
    customization_link: 'c',
    search_by_id: 'run(1)',
    base_year: '2025',
  });
  wb.writeTo(f);
  expect(read(f)[0]).toEqual([...OUTPUT_HEADER.slice(0, 5), 'search_by_id', 'Base Year', 'Generated Content']);
});

test('a sheet without Report Title and Prompt Template columns is refused', () => {
  const f = write('bad.xlsx', [['Title', 'Prompt'], ['a', 'b']]);
  expect(() => loadGenerateWorkbook(f)).toThrow(/Report Title.*Prompt Template/);
});
