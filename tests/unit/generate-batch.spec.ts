import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { existsSync, mkdirSync, mkdtempSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { BatchClient, BatchRunner, batchStatePath, findPendingRun, pendingRuns, readBatchState } from '../../src/services/generate-batch';
import { GenerateConfig, ModelRoute } from '../../src/services/generate-config';
import { loadGenerateWorkbook } from '../../src/services/generate-excel';
import { BatchMonitor } from '../../src/services/generate-monitor';
import { OutputFormat } from '../../src/services/generate-prompt';
import { Generation, GenerationError } from '../../src/services/generate-providers';
import { ArticleJob, ProgressEvent } from '../../src/services/generate-runner';

const quiet: any = { info() {}, warn() {}, error() {}, debug() {} };
/** At $1 per million tokens, one reply costs $1 at standard price, $0.50 in a batch. */
const USAGE = { inputTokens: 1_000_000, outputTokens: 0 };
const config: GenerateConfig = {
  html: { provider: 'claude', model: 'html-model', maxTokens: 1000 },
  markdown: { provider: 'gemini', model: 'md-model', maxTokens: 1000 },
  parallel: 1,
  retries: 0,
  batchMinArticles: 10,
  pricesPerMillionTokens: { 'html-model': { input: 1, output: 1, typicalOutputTokens: 0 }, 'md-model': { input: 1, output: 1, typicalOutputTokens: 0 } },
};

interface Script {
  /** Polls that report "running" before the batch ends. */
  runningPolls?: number;
  failure?: string;
  submitError?: GenerationError;
  statusErrors?: number;
  reply?: (title: string) => Generation | GenerationError | undefined;
}

/** A provider batch API that answers each request with "# <title>" (or the scripted reply) once it has ended. */
class FakeBatchClient implements BatchClient {
  sent: Array<{ route: ModelRoute; keys: string[] }> = [];
  /** What the provider was sent; a later run's client sees the same prompts, as the real batch APIs keep them. */
  prompts = new Map<string, string>();
  private polls = 0;
  constructor(private script: Script = {}) {}

  async submit(route: ModelRoute, requests: { key: string; prompt: string }[]): Promise<string> {
    if (this.script.submitError) throw this.script.submitError;
    requests.forEach(r => this.prompts.set(r.key, r.prompt));
    this.sent.push({ route, keys: requests.map(r => r.key) });
    return `batch-${this.sent.length}`;
  }

  async status() {
    if ((this.script.statusErrors ?? 0) > 0) {
      this.script.statusErrors!--;
      throw new GenerationError('connection reset', 'retry');
    }
    this.polls++;
    return { done: this.polls > (this.script.runningPolls ?? 0), state: 'running', failure: this.script.failure, detail: this.script.failure ? '{"state":"EXPIRED"}' : undefined };
  }

  async results(_id: string, _route: ModelRoute, keys: string[]) {
    const results = new Map<string, Generation | GenerationError>();
    for (const key of keys) {
      const title = (this.prompts.get(key) || '').split('\n')[0].replace(/^P-/, '');
      const reply = this.script.reply ? this.script.reply(title) : { text: title.endsWith('H') ? `<h1>${title}</h1>` : `# ${title}`, usage: USAGE };
      if (reply) results.set(key, reply);
    }
    return results;
  }
}

/** An input workbook of titled rows and its output file, named the way the CLI names it. Titles ending in "H" are HTML. */
function setup(titles: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'generate-batch-'));
  const input = join(dir, 'Records.xlsx');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Report Title', 'Prompt Template'], ...titles.map(t => [t, `P-${t}`])]), 'Sheet1');
  XLSX.writeFile(book, input);
  const output = join(dir, 'Records - Output (23_10_26_120000).xlsx');
  const workbook = loadGenerateWorkbook(input);
  workbook.writeTo(output);
  const jobs: ArticleJob[] = workbook.pendingRows.map(row => ({ row, format: (row.title.endsWith('H') ? 'html' : 'markdown') as OutputFormat, placedLinks: [] }));
  const monitor = new BatchMonitor(join(dir, 'Batch Monitor.xlsx'));
  return { dir, input, output, workbook, jobs, monitor };
}

const saved = (file: string) =>
  XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(file).Sheets.Sheet1, { header: 1, defval: '' }).slice(1).map(r => String(r[5]));

/** The state of the pending run found for a workbook, or a failed test. */
function pendingState(path: string, monitor?: BatchMonitor) {
  const found = findPendingRun(path, monitor?.read().batches);
  if (found?.kind !== 'pending') throw new Error(`no pending run for ${path}`);
  return found.run;
}

function runner(
  workbook: ReturnType<typeof setup>['workbook'],
  output: string,
  clients: Record<string, BatchClient>,
  extra: { events?: ProgressEvent[]; waits?: number[]; monitor?: BatchMonitor; statePath?: string; input?: string } = {}
) {
  return new BatchRunner({
    workbook,
    outputPath: output,
    statePath: extra.statePath,
    input: extra.input,
    config,
    logger: quiet,
    monitor: extra.monitor,
    clients,
    onProgress: e => extra.events?.push(e),
    wait: async ms => {
      extra.waits?.push(ms);
    },
  });
}

test('one batch per format; articles are saved when the batch ends, at half price; the recovery file is kept only meanwhile', async () => {
  const { output, workbook, jobs } = setup(['AlphaH', 'Beta', 'GammaH']);
  const claude = new FakeBatchClient({ runningPolls: 2 });
  const gemini = new FakeBatchClient();
  const waits: number[] = [];
  const batches = runner(workbook, output, { claude, gemini }, { waits });

  const state = await batches.submit(jobs);
  expect(claude.sent).toEqual([{ route: config.html, keys: ['row-0', 'row-2'] }]);
  expect(gemini.sent).toEqual([{ route: config.markdown, keys: ['row-1'] }]);
  expect(readBatchState(output)?.batches.map(b => [b.provider, b.id, b.collected])).toEqual([['claude', 'batch-1', false], ['gemini', 'batch-1', false]]);

  const summary = await batches.collect(state);
  expect(saved(output)).toEqual(['<h1>AlphaH</h1>', '# Beta', '<h1>GammaH</h1>']);
  expect(summary).toMatchObject({ generated: 3, failed: 0, cost: 1.5, stopReason: null });
  expect(waits).toEqual([30_000, 30_000]);
  expect(existsSync(batchStatePath(output))).toBe(false);
});

test('a batch sent by an earlier run is found from the input file and collected into its output, not sent again', async () => {
  const first = setup(['AlphaH', 'BetaH']);
  const claude = new FakeBatchClient({ runningPolls: 1000 });
  await runner(first.workbook, first.output, { claude }).submit(first.jobs);
  // The window was closed here. A later run starts from the same input file.

  expect(pendingState(first.input).outputPath).toBe(first.output);
  expect(pendingState(first.output).outputPath).toBe(first.output);

  const later = new FakeBatchClient();
  later.prompts = claude.prompts;
  const workbook = loadGenerateWorkbook(first.output);
  workbook.writeTo(first.output);
  const summary = await runner(workbook, first.output, { claude: later }).collect(pendingState(first.input).state);
  expect(later.sent).toEqual([]);
  expect(saved(first.output)).toEqual(['<h1>AlphaH</h1>', '<h1>BetaH</h1>']);
  expect(summary.generated).toBe(2);
  expect(findPendingRun(first.input)).toBeNull();
});

test('an output moved to another folder is collected there; the monitor knows where its recovery file stayed', async () => {
  const first = setup(['Alpha']);
  const gemini = new FakeBatchClient({ runningPolls: 1000 });
  await runner(first.workbook, first.output, { gemini }, { monitor: first.monitor, input: first.input }).submit(first.jobs);

  // The output is moved in Finder; its hidden recovery file stays behind.
  mkdirSync(join(first.dir, 'Done'));
  const moved = join(first.dir, 'Done', basename(first.output));
  renameSync(first.output, moved);

  // From the input file, the run is not sent again: its output is reported missing.
  expect(findPendingRun(first.input, first.monitor.read().batches)).toMatchObject({ kind: 'output missing', expectedOutput: first.output });
  expect(pendingRuns(first.monitor.read().batches)).toMatchObject([{ outputPath: first.output, outputExists: false }]);

  // From the moved file itself, the run is collected into it.
  const run = pendingState(moved, first.monitor);
  expect(run).toMatchObject({ outputPath: moved, statePath: batchStatePath(first.output) });
  const workbook = loadGenerateWorkbook(moved);
  workbook.writeTo(moved);
  const later = new FakeBatchClient();
  later.prompts = gemini.prompts;
  await runner(workbook, moved, { gemini: later }, { statePath: run.statePath, monitor: first.monitor }).collect(run.state);
  expect(saved(moved)).toEqual(['# Alpha']);
  expect(existsSync(batchStatePath(first.output))).toBe(false);
  expect(pendingRuns(first.monitor.read().batches)).toEqual([]);
});

test('a batch that fails as a whole leaves its rows empty for a new run', async () => {
  const { output, workbook, jobs } = setup(['Alpha', 'Beta']);
  const events: ProgressEvent[] = [];
  const batches = runner(workbook, output, { gemini: new FakeBatchClient({ failure: 'the Gemini batch ended as JOB_STATE_EXPIRED' }) }, { events });
  const summary = await batches.collect(await batches.submit(jobs));
  expect(saved(output)).toEqual(['', '']);
  expect(summary).toMatchObject({ generated: 0, failed: 2 });
  expect(events.map(e => e.type === 'failed' && e.message)).toEqual(['the Gemini batch ended as JOB_STATE_EXPIRED', 'the Gemini batch ended as JOB_STATE_EXPIRED']);
});

test('per-article errors and missing replies fail only those rows; cut-off replies still count toward the cost', async () => {
  const { output, workbook, jobs } = setup(['Alpha', 'Beta', 'Gamma']);
  const reply = (title: string) =>
    title === 'Beta'
      ? new GenerationError('the article was cut off at the 1000-token limit; raise --max-tokens', 'skip', USAGE)
      : title === 'Gamma'
        ? undefined
        : { text: '```markdown\n# Alpha\n```', usage: USAGE };
  const batches = runner(workbook, output, { gemini: new FakeBatchClient({ reply }) });
  const summary = await batches.collect(await batches.submit(jobs));
  expect(saved(output)).toEqual(['# Alpha', '', '']);
  expect(summary).toMatchObject({ generated: 1, failed: 2, cost: 1 });
});

test('if one format\'s batch cannot be sent, the other is still collected and the reason is reported', async () => {
  const { output, workbook, jobs } = setup(['AlphaH', 'Beta']);
  const gemini = new FakeBatchClient({ submitError: new GenerationError('Gemini API error: batch mode needs a paid key', 'stop') });
  const batches = runner(workbook, output, { claude: new FakeBatchClient(), gemini });
  const summary = await batches.collect(await batches.submit(jobs));
  expect(saved(output)).toEqual(['<h1>AlphaH</h1>', '']);
  expect(summary.stopReason).toBe('could not send the Markdown batch: Gemini API error: batch mode needs a paid key');
});

test('a status check that fails for a moment is tried again at the next poll', async () => {
  const { output, workbook, jobs } = setup(['Alpha']);
  const waits: number[] = [];
  const batches = runner(workbook, output, { gemini: new FakeBatchClient({ statusErrors: 2 }) }, { waits });
  const summary = await batches.collect(await batches.submit(jobs));
  expect(summary.generated).toBe(1);
  expect(waits).toHaveLength(2);
});

test('if the output cannot be saved, collecting stops and the batch stays on record; the next run collects it', async () => {
  const first = setup(['Alpha', 'Beta']);
  const gemini = new FakeBatchClient();
  await runner(first.workbook, first.output, { gemini: new FakeBatchClient({ runningPolls: 1000 }) }).submit(first.jobs);

  // A workbook that cannot be written (here: no output chosen), like an output file locked by Excel.
  gemini.prompts = new Map([['row-0', 'P-Alpha'], ['row-1', 'P-Beta']]);
  const unwritable = loadGenerateWorkbook(first.output);
  await expect(runner(unwritable, first.output, { gemini }).collect(pendingState(first.input).state)).rejects.toThrow(/writeTo/);
  expect(pendingState(first.input).state.batches[0].collected).toBe(false);

  const workbook = loadGenerateWorkbook(first.output);
  workbook.writeTo(first.output);
  const summary = await runner(workbook, first.output, { gemini }).collect(pendingState(first.input).state);
  expect(saved(first.output)).toEqual(['# Alpha', '# Beta']);
  expect(summary.generated).toBe(2);
});

test('a row that changed in the output file since the batch was sent is not overwritten', async () => {
  const first = setup(['Alpha', 'Beta']);
  const gemini = new FakeBatchClient({ runningPolls: 1000 });
  await runner(first.workbook, first.output, { gemini }).submit(first.jobs);

  // Someone edits the output: Beta's title changes, and Alpha gets an article by hand.
  const edited = loadGenerateWorkbook(first.output);
  edited.rows[1].title = 'Beta (renamed)';
  edited.writeTo(first.output);
  edited.markGenerated(edited.rows[0], '# written by hand');

  const events: ProgressEvent[] = [];
  const reloaded = loadGenerateWorkbook(first.output);
  reloaded.writeTo(first.output);
  const later = new FakeBatchClient();
  later.prompts = gemini.prompts;
  const summary = await runner(reloaded, first.output, { gemini: later }, { events }).collect(pendingState(first.input).state);
  expect(saved(first.output)).toEqual(['# written by hand', '']);
  expect(summary).toMatchObject({ generated: 0, failed: 1 });
  expect(events[0]).toMatchObject({ type: 'failed', message: 'the row moved or changed in the output file since the batch was sent' });
});

test('the monitor records each batch from sending to collection, and keeps the raw reply of every failure', async () => {
  const { input, output, workbook, jobs, monitor } = setup(['AlphaH', 'Beta', 'Gamma']);
  const reply = (title: string) =>
    title === 'Gamma' ? new GenerationError('Gemini blocked the prompt (PROHIBITED_CONTENT)', 'skip', undefined, '{"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}') : { text: `# ${title}`, usage: USAGE };
  const batches = runner(workbook, output, { claude: new FakeBatchClient(), gemini: new FakeBatchClient({ reply, runningPolls: 1 }) }, { monitor, input });

  const state = await batches.submit(jobs);
  expect(monitor.read().batches.map(b => [b.provider, b.status, b.articles, b.input, b.output])).toEqual([
    ['claude', 'waiting', 1, input, output],
    ['gemini', 'waiting', 2, input, output],
  ]);
  await batches.collect(state);

  const { batches: records, errors } = monitor.read();
  expect(records.map(b => [b.provider, b.status, b.written, b.failed, b.cost])).toEqual([
    ['claude', 'collected', 1, 0, 0.5],
    ['gemini', 'collected', 1, 1, 0.5],
  ]);
  expect(records[1].providerState).toBe('running');
  // The run's line adds up its batches: 2 written, 1 failed, $1 at batch prices.
  expect(monitor.read().runs).toMatchObject([{ mode: 'batch', status: 'done', articles: 3, written: 2, failed: 1, cost: 1, input, output }]);
  expect(errors).toMatchObject([{ rowIndex: 4, title: 'Gamma', provider: 'gemini', message: 'Gemini blocked the prompt (PROHIBITED_CONTENT)', detail: '{"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}' }]);

  const sheet = (name: string) => XLSX.utils.sheet_to_json<unknown[]>(XLSX.readFile(monitor.path).Sheets[name], { header: 1, defval: '' });
  expect(sheet('Batches')[0]).toEqual(['Sent', 'Status', 'Input file', 'Output file', 'Provider', 'Model', 'Format', 'Articles', 'Written', 'Failed', 'Cost (US$)', 'Provider state', 'Last checked', 'Finished', 'Batch id', 'Note', 'Run id', 'Recovery file']);
  expect(sheet('Batches').slice(1).map(r => [r[1], r[4], r[8], r[9]])).toEqual([['collected', 'gemini', 1, 1], ['collected', 'claude', 1, 0]]);
  expect(sheet('Errors').slice(1).map(r => [r[2], r[3], r[7], r[8]])).toEqual([[4, 'Gamma', 'Gemini blocked the prompt (PROHIBITED_CONTENT)', '{"promptFeedback":{"blockReason":"PROHIBITED_CONTENT"}}']]);
});

test('a batch that could not be sent, or failed as a whole, is in the monitor with its raw error', async () => {
  const { input, output, workbook, jobs, monitor } = setup(['AlphaH', 'Beta']);
  const claude = new FakeBatchClient({ submitError: new GenerationError('Claude API error: 401 invalid x-api-key', 'stop', undefined, '{"status":401}') });
  const gemini = new FakeBatchClient({ failure: 'the Gemini batch ended as JOB_STATE_EXPIRED' });
  const batches = runner(workbook, output, { claude, gemini }, { monitor, input });
  await batches.collect(await batches.submit(jobs));

  const { batches: records, errors } = monitor.read();
  expect(records.map(b => [b.provider, b.status, b.failed, b.note])).toEqual([
    ['claude', 'not sent', 1, 'Claude API error: 401 invalid x-api-key'],
    ['gemini', 'failed', 1, 'the Gemini batch ended as JOB_STATE_EXPIRED'],
  ]);
  expect(errors.map(e => [e.provider, e.rowIndex, e.detail])).toEqual([
    ['claude', null, '{"status":401}'],
    ['gemini', null, '{"state":"EXPIRED"}'],
  ]);
});
