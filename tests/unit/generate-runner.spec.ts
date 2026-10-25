import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GenerateRunner, ProgressEvent } from '../../src/services/generate-runner';
import { loadGenerateWorkbook } from '../../src/services/generate-excel';
import { GenerateConfig } from '../../src/services/generate-config';
import { OutputFormat } from '../../src/services/generate-prompt';
import { actionForStatus, GenerationError } from '../../src/services/generate-providers';

const dir = mkdtempSync(join(tmpdir(), 'generate-runner-'));
const quiet: any = { info() {}, warn() {}, error() {}, debug() {} };
const retry = (message = 'rate limited') => new GenerationError(message, 'retry');
const skip = (message = 'cut off', usage?: { inputTokens: number; outputTokens: number }) => new GenerationError(message, 'skip', usage);
const stop = (message = 'invalid API key') => new GenerationError(message, 'stop');

/** A token reply costs exactly $1 at these prices; the article text is "# <title>" unless scripted. */
const USAGE = { inputTokens: 1_000_000, outputTokens: 0 };
const config = (parallel = 1, retries = 2): GenerateConfig => ({
  html: { provider: 'claude', model: 'html-model', maxTokens: 1000 },
  markdown: { provider: 'gemini', model: 'md-model', maxTokens: 1000 },
  parallel,
  retries,
  pricesPerMillionTokens: { 'html-model': { input: 1, output: 1, typicalOutputTokens: 0 }, 'md-model': { input: 1, output: 1, typicalOutputTokens: 0 } },
});

type Script = Record<string, Array<string | GenerationError>>;

/** Runs titled rows through fake models whose replies are scripted per title. Titles ending in "H" are HTML rows. */
async function run(titles: string[], script: Script = {}, cfg = config(), delays: Record<string, number> = {}) {
  const id = Math.random().toString(36).slice(2);
  const input = join(dir, `in-${id}.xlsx`);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Report Title', 'Prompt Template'], ...titles.map(t => [t, `P-${t}`])]), 'Sheet1');
  XLSX.writeFile(book, input);

  const workbook = loadGenerateWorkbook(input);
  const output = join(dir, `out-${id}.xlsx`);
  workbook.writeTo(output);

  const calls: string[] = [];
  const waits: number[] = [];
  const events: ProgressEvent[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fake = (format: OutputFormat) => ({
    route: cfg[format],
    async generate(prompt: string) {
      const title = titles.find(t => prompt.startsWith(`P-${t}\n`)) as string;
      calls.push(title);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise(done => setTimeout(done, delays[title] ?? 1));
      inFlight--;
      const reply = script[title]?.shift() ?? (format === 'html' ? `<h1>${title}</h1>` : `# ${title}`);
      if (reply instanceof GenerationError) throw reply;
      return { text: reply, usage: USAGE };
    },
  });
  const jobs = workbook.pendingRows.map(row => ({ row, format: (row.title.endsWith('H') ? 'html' : 'markdown') as OutputFormat, placedLinks: [] }));
  const summary = await new GenerateRunner({
    workbook,
    jobs,
    generators: { html: fake('html'), markdown: fake('markdown') },
    config: cfg,
    retryWaitMs: 60_000,
    logger: quiet,
    onProgress: event => events.push(event),
    wait: async ms => {
      waits.push(ms);
    },
  }).run();
  const saved = XLSX.utils
    .sheet_to_json<unknown[]>(XLSX.readFile(output).Sheets.Sheet1, { header: 1, defval: '' })
    .slice(1)
    .map(r => String(r[5]));
  return { summary, calls, waits, saved, events, maxInFlight };
}

test('each row goes to the model for its format and is saved; the cost adds up', async () => {
  const { summary, saved, events } = await run(['Alpha', 'BetaH', 'Gamma']);
  expect(saved).toEqual(['# Alpha', '<h1>BetaH</h1>', '# Gamma']);
  expect(summary).toEqual({ generated: 3, failed: 0, needsReview: 0, cost: 3, unpricedCalls: 0, stopReason: null });
  expect(events.map(e => e.type === 'saved' && e.cost)).toEqual([1, 1, 1]);
});

test('articles are written `parallel` at a time, and all are saved', async () => {
  const titles = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
  const { saved, maxInFlight } = await run(titles, {}, config(3), Object.fromEntries(titles.map(t => [t, 20])));
  expect(maxInFlight).toBe(3);
  expect(saved).toEqual(titles.map(t => `# ${t}`));
});

test('a failure that can pass is retried after the retry wait', async () => {
  const { calls, waits, saved, events } = await run(['Alpha', 'Beta'], { Alpha: [retry(), '# Alpha, second try'] });
  expect(calls).toEqual(['Alpha', 'Alpha', 'Beta']);
  expect(waits).toEqual([60_000]);
  expect(saved).toEqual(['# Alpha, second try', '# Beta']);
  expect(events[0]).toMatchObject({ type: 'retrying', attempt: 2, attempts: 3 });
});

test('a row that keeps failing is left empty and the run moves on', async () => {
  const { summary, calls, saved } = await run(['Alpha', 'Beta'], { Alpha: [retry(), retry(), retry()] }, config(1, 2));
  expect(calls).toEqual(['Alpha', 'Alpha', 'Alpha', 'Beta']);
  expect(saved).toEqual(['', '# Beta']);
  expect(summary).toMatchObject({ generated: 1, failed: 1, stopReason: null });
});

test('a row-specific failure is not retried, and what it was billed still counts', async () => {
  const { calls, saved, summary } = await run(['Alpha', 'Beta'], { Alpha: [skip('cut off', { inputTokens: 0, outputTokens: 2_000_000 })] });
  expect(calls).toEqual(['Alpha', 'Beta']);
  expect(saved).toEqual(['', '# Beta']);
  expect(summary).toMatchObject({ failed: 1, cost: 3 });
});

test('a failure that would hit every row stops the run and leaves that row for the next run', async () => {
  const { summary, calls, saved } = await run(['Alpha', 'Beta', 'Gamma'], { Beta: [stop()] });
  expect(calls).toEqual(['Alpha', 'Beta']);
  expect(saved).toEqual(['# Alpha', '', '']);
  expect(summary).toMatchObject({ generated: 1, failed: 0, stopReason: 'invalid API key' });
});

test('three failed articles in a row stop the run', async () => {
  const { summary, calls } = await run(['A1', 'B1', 'C1', 'D1'], { A1: [skip()], B1: [skip()], C1: [skip('last one')] });
  expect(calls).toEqual(['A1', 'B1', 'C1']);
  expect(summary.stopReason).toBe('3 articles in a row failed (last: last one)');
});

test('replies are cleaned before saving, an empty reply is retried, and problems to check are reported', async () => {
  const article = '<h1>AlphaH</h1>\n' + '<p>A long paragraph about the market.</p>\n'.repeat(5);
  const { saved, calls, summary, events } = await run(['AlphaH', 'Beta'], {
    AlphaH: ['  ', '```html\n<!DOCTYPE html><html><body>\n' + article + '</body></html>\n```\n\n**Word Count: 1,398 words**'],
    Beta: ['Beta Report {{forecast_year}}'],
  });
  expect(calls).toEqual(['AlphaH', 'AlphaH', 'Beta']);
  expect(saved).toEqual([article.trim(), 'Beta Report {{forecast_year}}']);
  expect(summary.needsReview).toBe(1);
  const beta = events.find(e => e.type === 'saved' && e.job.row.title === 'Beta');
  expect(beta).toMatchObject({ issues: ['does not start with a # title', 'prints {{forecast_year}}'] });
});

test('HTTP status decides whether to retry, skip the row or stop', () => {
  for (const status of [undefined, 408, 409, 429, 500, 503, 529]) expect(actionForStatus(status)).toBe('retry');
  for (const status of [400, 401, 402, 403, 404, 422]) expect(actionForStatus(status)).toBe('stop');
  expect(actionForStatus(413)).toBe('skip');
});
