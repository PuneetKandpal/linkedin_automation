import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BatchMonitor, RunInfo } from '../../src/services/generate-monitor';

const workbookPath = () => join(mkdtempSync(join(tmpdir(), 'generate-monitor-')), 'Batch Monitor.xlsx');
const run = (path: string, runId = 'run-1'): RunInfo => ({ runId, input: '/in/Records.xlsx', output: '/in/Records - Output (1).xlsx', statePath: join(path, '..', '.state.json') });
const batch = { provider: 'gemini' as const, model: 'gemini-3.1-flash-lite', format: 'markdown' as const, id: 'batches/abc', articles: 2, sentAt: new Date().toISOString() };

test('the workbook is the record: a new process reads back exactly what an earlier one wrote', () => {
  const path = workbookPath();
  const first = new BatchMonitor(path);
  first.runStarted({ runId: 'run-1', mode: 'batch', input: '/in/Records.xlsx', output: '/in/Records - Output (1).xlsx', articles: 2 });
  first.sent(run(path), batch);
  first.articleFailed(run(path), batch, { rowIndex: 3, title: 'Beta' }, 'cut off', '{"finishReason":"MAX_TOKENS"}');

  // After a restart: nothing in memory, only the workbook.
  const later = new BatchMonitor(path).read();
  expect(later.runs).toMatchObject([{ runId: 'run-1', mode: 'batch', status: 'waiting', articles: 2 }]);
  expect(later.batches).toMatchObject([{ provider: 'gemini', batchId: 'batches/abc', status: 'waiting', statePath: run(path).statePath, articles: 2 }]);
  expect(later.errors).toMatchObject([{ rowIndex: 3, title: 'Beta', message: 'cut off', detail: '{"finishReason":"MAX_TOKENS"}' }]);
  expect(XLSX.readFile(path).SheetNames).toEqual(['Runs', 'Batches', 'Errors']);
});

test('a batch run\'s line adds up its batches as they finish; a live run records its own cost', () => {
  const path = workbookPath();
  const monitor = new BatchMonitor(path);
  monitor.runStarted({ runId: 'run-1', mode: 'batch', input: 'in', output: 'out', articles: 3 });
  monitor.sent(run(path), batch);
  monitor.sent(run(path), { ...batch, provider: 'claude', id: 'msgbatch_1', articles: 1, format: 'html' });
  monitor.finished('gemini', 'batches/abc', { status: 'collected', written: 2, failed: 0, cost: 0.0048 });
  expect(monitor.read().runs[0]).toMatchObject({ status: 'waiting', written: 2, cost: 0.0048 });
  monitor.finished('claude', 'msgbatch_1', { status: 'collected', written: 0, failed: 1, cost: 0.002 });
  expect(monitor.read().runs[0]).toMatchObject({ status: 'done', written: 2, failed: 1, cost: 0.0068 });

  monitor.runStarted({ runId: 'run-2', mode: 'live', input: 'in', output: 'out', articles: 5 });
  expect(monitor.read().runs[1].status).toBe('running');
  monitor.runFinished('run-2', { status: 'done', written: 5, failed: 0, cost: 0.0442 });
  const sheet = XLSX.utils.sheet_to_json<Record<string, unknown>>(XLSX.readFile(path).Sheets.Runs);
  // Newest first, as people read it.
  expect(sheet.map(r => [r.Mode, r.Status, r.Written, r['Cost (US$)']])).toEqual([['live', 'done', 5, 0.0442], ['batch', 'done', 2, 0.0068]]);
});

test('a change that cannot be saved waits for the next save, and the workbook is still readable meanwhile', () => {
  const path = workbookPath();
  const folder = join(path, '..');
  const monitor = new BatchMonitor(path);
  monitor.runStarted({ runId: 'run-1', mode: 'live', input: 'in', output: 'out', articles: 1 });

  // Readable but not writable, as a workbook open in Excel on Windows.
  chmodSync(folder, 0o555);
  try {
    monitor.runFinished('run-1', { status: 'done', written: 1, failed: 0, cost: 0.005 });
    expect(monitor.unsaved).toBe(true);
    expect(monitor.read().runs).toMatchObject([{ status: 'done', cost: 0.005 }]);
    expect(new BatchMonitor(path).read().runs).toMatchObject([{ status: 'running' }]);
  } finally {
    chmodSync(folder, 0o755);
  }
  expect(monitor.flush()).toBe(true);
  expect(new BatchMonitor(path).read().runs).toMatchObject([{ status: 'done', cost: 0.005 }]);
});

test('changes still unsaved when the tool exits are saved by the next run', () => {
  const path = workbookPath();
  // A workbook that cannot be read or written right now.
  mkdirSync(path);
  const monitor = new BatchMonitor(path);
  monitor.runStarted({ runId: 'run-1', mode: 'live', input: 'in', output: 'out', articles: 1 });
  expect(monitor.unsaved).toBe(true);
  monitor.keepUnsaved();
  rmdirSync(path);

  const next = new BatchMonitor(path);
  expect(next.unsaved).toBe(false);
  expect(next.read().runs).toMatchObject([{ runId: 'run-1', status: 'running' }]);
  expect(readdirSync(join(path, '..')).filter(name => name.endsWith('.unsaved.json'))).toEqual([]);
});

test('a workbook that cannot be read is never overwritten with only this run\'s records', () => {
  const path = workbookPath();
  writeFileSync(path, 'not a workbook');
  const monitor = new BatchMonitor(path);
  monitor.runStarted({ runId: 'run-1', mode: 'live', input: 'in', output: 'out', articles: 1 });
  expect(readFileSync(path, 'utf-8')).toBe('not a workbook');
  expect(monitor.unsaved).toBe(true);
});

test('raw replies are cut to a size an Excel cell can hold', () => {
  const path = workbookPath();
  const monitor = new BatchMonitor(path);
  monitor.articleFailed(run(path), batch, { rowIndex: 2, title: 'Alpha' }, 'too long', 'x'.repeat(20_000));
  const detail = new BatchMonitor(path).read().errors[0].detail;
  expect(detail.length).toBeLessThan(8100);
  expect(detail).toMatch(/12000 more characters\]$/);
});
