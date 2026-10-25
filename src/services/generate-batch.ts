import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI, JobState } from '@google/genai';
import { Logger } from '../engine/logger';
import { GenerateConfig, ModelRoute } from './generate-config';
import { GenerateRow, GenerateWorkbook } from './generate-excel';
import { BatchMonitor, BatchRecord, newRunId, RunInfo } from './generate-monitor';
import { finalPrompt, OutputFormat, ProviderName } from './generate-prompt';
import {
  claudeGeneration,
  claudeRequestError,
  Generation,
  GenerationError,
  geminiGeneration,
  geminiRequestError,
} from './generate-providers';
import { ArticleJob, articleFrom, GenerateRunSummary, ProgressEvent, RunRecorder } from './generate-runner';

/** Both batch APIs bill half the standard price. */
export const BATCH_PRICE_FACTOR = 0.5;

/** Articles per batch. Gemini caps a batch's inline requests at 20 MB in total; a LinkedIn prompt is about 8 KB. */
const BATCH_SIZE = 500;

const FORMATS: OutputFormat[] = ['html', 'markdown'];

export interface BatchRequest {
  key: string;
  prompt: string;
}

export interface BatchStatus {
  done: boolean;
  /** The provider's own name for the state, for the progress line. */
  state: string;
  /** Set when the whole batch failed, expired or was cancelled. */
  failure?: string;
  /** The provider's raw batch record, kept with a failure for debugging. */
  detail?: string;
}

/** One provider's batch API. Errors are thrown as GenerationError. */
export interface BatchClient {
  submit(route: ModelRoute, requests: BatchRequest[]): Promise<string>;
  status(id: string): Promise<BatchStatus>;
  /** Each request's article or error, by key. `keys` are the requests' keys in the order they were sent. */
  results(id: string, route: ModelRoute, keys: string[]): Promise<Map<string, Generation | GenerationError>>;
}

/** The article a finished reply amounts to, or the error it amounts to, with the raw reply kept for debugging. */
function settle(read: () => Generation, raw: () => string): Generation | GenerationError {
  try {
    return read();
  } catch (err) {
    const error = err instanceof GenerationError ? err : new GenerationError(String(err), 'skip');
    return new GenerationError(error.message, error.action, error.usage, error.detail ?? raw());
  }
}

class ClaudeBatchClient implements BatchClient {
  private client = new Anthropic();

  async submit(route: ModelRoute, requests: BatchRequest[]): Promise<string> {
    const batch = await this.client.messages.batches
      .create({
        requests: requests.map(request => ({
          custom_id: request.key,
          params: { model: route.model, max_tokens: route.maxTokens, messages: [{ role: 'user', content: request.prompt }] },
        })),
      })
      .catch((err: unknown) => {
        throw claudeRequestError(err);
      });
    return batch.id;
  }

  async status(id: string): Promise<BatchStatus> {
    const batch = await this.client.messages.batches.retrieve(id).catch((err: unknown) => {
      throw claudeRequestError(err);
    });
    return { done: batch.processing_status === 'ended', state: batch.processing_status };
  }

  async results(id: string, route: ModelRoute): Promise<Map<string, Generation | GenerationError>> {
    const results = new Map<string, Generation | GenerationError>();
    try {
      // Results come in any order; custom_id says which article each one is.
      for await (const item of await this.client.messages.batches.results(id)) {
        const result = item.result;
        const raw = () => JSON.stringify(item);
        if (result.type === 'succeeded') {
          results.set(item.custom_id, settle(() => claudeGeneration(result.message, route.maxTokens), raw));
        } else if (result.type === 'errored') {
          results.set(item.custom_id, new GenerationError(`Claude: ${result.error.error.message}`, 'skip', undefined, raw()));
        } else {
          const message = result.type === 'expired' ? 'the batch expired before this article was written' : 'the batch was cancelled';
          results.set(item.custom_id, new GenerationError(message, 'skip', undefined, raw()));
        }
      }
    } catch (err) {
      throw claudeRequestError(err);
    }
    return results;
  }
}

class GeminiBatchClient implements BatchClient {
  private client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });

  async submit(route: ModelRoute, requests: BatchRequest[]): Promise<string> {
    const job = await this.client.batches
      .create({
        model: route.model,
        src: requests.map(request => ({
          contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
          metadata: { key: request.key },
          // temperature 0.5 as in the workflow's "Gemini - Generate Content1" node
          config: { temperature: 0.5, maxOutputTokens: route.maxTokens },
        })),
        config: { displayName: `li-generate ${new Date().toISOString()}` },
      })
      .catch((err: unknown) => {
        throw geminiRequestError(err);
      });
    if (!job.name) throw new GenerationError('Gemini did not return a batch id', 'stop', undefined, JSON.stringify(job));
    return job.name;
  }

  async status(name: string): Promise<BatchStatus> {
    const job = await this.client.batches.get({ name }).catch((err: unknown) => {
      throw geminiRequestError(err);
    });
    const state = job.state ?? JobState.JOB_STATE_UNSPECIFIED;
    if (state === JobState.JOB_STATE_SUCCEEDED) return { done: true, state };
    if (state === JobState.JOB_STATE_FAILED || state === JobState.JOB_STATE_CANCELLED || state === JobState.JOB_STATE_EXPIRED) {
      const { dest: _dest, ...record } = job;
      return {
        done: true,
        state,
        failure: `the Gemini batch ended as ${state}${job.error?.message ? `: ${job.error.message}` : ''}`,
        detail: JSON.stringify(record),
      };
    }
    return { done: false, state };
  }

  async results(name: string, route: ModelRoute, keys: string[]): Promise<Map<string, Generation | GenerationError>> {
    const job = await this.client.batches.get({ name }).catch((err: unknown) => {
      throw geminiRequestError(err);
    });
    const results = new Map<string, Generation | GenerationError>();
    // Responses come back in request order, each with the metadata it was sent with.
    (job.dest?.inlinedResponses ?? []).forEach((item, i) => {
      const key = item.metadata?.key ?? keys[i];
      if (!key) return;
      const raw = () => JSON.stringify(item);
      const response = item.response;
      if (item.error || !response) {
        results.set(key, new GenerationError(`Gemini: ${item.error?.message ?? 'no reply for this article'}`, 'skip', undefined, raw()));
      } else {
        results.set(key, settle(() => geminiGeneration(response, route.maxTokens), raw));
      }
    });
    return results;
  }
}

export function createBatchClient(provider: ProviderName): BatchClient {
  if (provider === 'claude') return new ClaudeBatchClient();
  if (provider === 'gemini') return new GeminiBatchClient();
  throw new GenerationError('batch mode works with Claude and Gemini models only; run with --live for OpenAI', 'stop');
}

/** A batch as recorded next to the output: enough to collect it in a later run. */
export interface SubmittedBatch {
  provider: ProviderName;
  model: string;
  maxTokens: number;
  format: OutputFormat;
  id: string;
  submittedAt: string;
  /** Rows by their position in the output workbook, with the title that checks it is still the same row. */
  jobs: { key: string; index: number; title: string; placedLinks: string[] }[];
  collected: boolean;
}

export interface BatchState {
  /** Ties the batches to their lines in the batch monitor. */
  runId?: string;
  input?: string;
  batches: SubmittedBatch[];
}

/** The recovery file of an output workbook: a hidden ".<output name>.batch.json" next to it. */
export function batchStatePath(outputPath: string): string {
  return join(dirname(outputPath), `.${basename(outputPath, extname(outputPath))}.batch.json`);
}

function readStateFile(statePath: string): BatchState | null {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as BatchState;
  } catch {
    return null;
  }
}

export function readBatchState(outputPath: string): BatchState | null {
  return readStateFile(batchStatePath(outputPath));
}

function writeStateFile(statePath: string, state: BatchState): void {
  writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${statePath}.tmp`, statePath);
}

function removeStateFile(statePath: string): void {
  try {
    unlinkSync(statePath);
  } catch {
    // already gone
  }
}

const isPending = (state: BatchState | null): state is BatchState => Boolean(state && state.batches.some(batch => !batch.collected));

export interface PendingRun {
  /** The workbook the articles are saved into. */
  outputPath: string;
  statePath: string;
  state: BatchState;
}

/** Either a run whose articles can be collected now, or one whose output file is no longer where it was. */
export type PendingLookup = { kind: 'pending'; run: PendingRun } | { kind: 'output missing'; expectedOutput: string; statePath: string; state: BatchState };

/**
 * A run with batches not yet collected, for this workbook, so a new run never sends (and pays for) the same
 * articles twice. In order: the workbook's own recovery file; one started from it (a hidden file next to it for
 * "<its name> - Output (...)"); one the monitor knows under this file's name, saved elsewhere at the time (the
 * output was moved, while its hidden recovery file stayed behind); or one whose output has disappeared.
 */
export function findPendingRun(workbookPath: string, records: BatchRecord[] = []): PendingLookup | null {
  const own = batchStatePath(workbookPath);
  const ownState = readStateFile(own);
  if (isPending(ownState)) return { kind: 'pending', run: { outputPath: workbookPath, statePath: own, state: ownState } };

  let missing: PendingLookup | null = null;
  const dir = dirname(workbookPath);
  const prefix = `.${basename(workbookPath, extname(workbookPath))} - Output (`;
  for (const name of readdirSync(dir).filter(n => n.startsWith(prefix) && n.endsWith('.batch.json')).sort()) {
    const statePath = join(dir, name);
    const state = readStateFile(statePath);
    if (!isPending(state)) continue;
    const outputPath = join(dir, `${name.slice(1, -'.batch.json'.length)}.xlsx`);
    if (existsSync(outputPath)) return { kind: 'pending', run: { outputPath, statePath, state } };
    missing ??= { kind: 'output missing', expectedOutput: outputPath, statePath, state };
  }

  for (const record of records.filter(r => r.status === 'waiting')) {
    const state = readStateFile(record.statePath);
    if (!isPending(state)) continue;
    if (basename(record.output) === basename(workbookPath) && resolve(record.output) !== resolve(workbookPath)) {
      return { kind: 'pending', run: { outputPath: workbookPath, statePath: record.statePath, state } };
    }
    if (resolve(record.input) === resolve(workbookPath) && !existsSync(record.output)) {
      missing ??= { kind: 'output missing', expectedOutput: record.output, statePath: record.statePath, state };
    }
  }
  return missing;
}

/** Every run the monitor knows with batches not yet collected, whether or not its output is still in place. */
export function pendingRuns(records: BatchRecord[]): Array<PendingRun & { outputExists: boolean }> {
  const runs = new Map<string, PendingRun & { outputExists: boolean }>();
  for (const record of records.filter(r => r.status === 'waiting')) {
    if (runs.has(record.statePath)) continue;
    const state = readStateFile(record.statePath);
    if (isPending(state)) runs.set(record.statePath, { outputPath: record.output, statePath: record.statePath, state, outputExists: existsSync(record.output) });
  }
  return [...runs.values()];
}

export type BatchEvent =
  | { type: 'submitted'; batch: SubmittedBatch }
  | { type: 'waiting'; pending: Array<{ batch: SubmittedBatch; state: string }>; elapsedMs: number };

export interface BatchRunnerOptions {
  /** The output workbook, its rows in output order. */
  workbook: GenerateWorkbook;
  outputPath: string;
  /** The recovery file; next to the output unless the output was moved after its batches were sent. */
  statePath?: string;
  /** The input workbook, for the monitor. */
  input?: string;
  /** The run's id in the monitor; a new one when left out. */
  runId?: string;
  config: GenerateConfig;
  logger: Logger;
  monitor?: BatchMonitor;
  onProgress?: (event: ProgressEvent) => void;
  onBatch?: (event: BatchEvent) => void;
  pollMs?: number;
  wait?: (ms: number) => Promise<void>;
  clients?: Partial<Record<ProviderName, BatchClient>>;
}

/**
 * Writes articles through the providers' batch APIs at half price. submit() sends one batch per format (more for
 * very large runs) and records each in the recovery file before anything else; collect() waits for the batches
 * and saves each one's articles as soon as it ends. A later run can collect what an earlier run submitted.
 */
export class BatchRunner {
  private record: RunRecorder;
  private clients: Partial<Record<ProviderName, BatchClient>>;
  private wait: (ms: number) => Promise<void>;
  private statePath: string;

  constructor(private options: BatchRunnerOptions) {
    this.record = new RunRecorder(options.workbook, options.config, options.logger, options.onProgress);
    this.clients = { ...options.clients };
    this.wait = options.wait ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
    this.statePath = options.statePath ?? batchStatePath(options.outputPath);
  }

  private client(provider: ProviderName): BatchClient {
    return (this.clients[provider] ??= createBatchClient(provider));
  }

  private runInfo(state: BatchState): RunInfo {
    return { runId: state.runId ?? '', input: state.input ?? this.options.input ?? '', output: this.options.outputPath, statePath: this.statePath };
  }

  /** Sends the jobs. A format whose batch cannot be sent (bad key, no batch access) is reported; the rest go ahead. */
  async submit(jobs: ArticleJob[]): Promise<BatchState> {
    const { workbook, config, logger, monitor, onBatch } = this.options;
    const state: BatchState = { runId: this.options.runId ?? newRunId(), input: this.options.input, batches: [] };
    for (const format of FORMATS) {
      const route = config[format];
      const group = jobs.filter(job => job.format === format);
      for (let start = 0; start < group.length; start += BATCH_SIZE) {
        const chunk = group.slice(start, start + BATCH_SIZE).map(job => ({ job, key: `row-${workbook.rows.indexOf(job.row)}` }));
        const sentAt = new Date().toISOString();
        let id: string;
        try {
          id = await this.client(route.provider).submit(
            route,
            chunk.map(({ job, key }) => ({ key, prompt: finalPrompt(job.row.prompt, route.provider, format) }))
          );
        } catch (err) {
          const error = err instanceof GenerationError ? err : new GenerationError(String(err), 'stop');
          this.record.summary.stopReason ??= `could not send the ${format === 'html' ? 'HTML' : 'Markdown'} batch: ${error.message}`;
          logger.error('Generate → batch not sent', { format, model: route.model, articles: chunk.length, error: error.message });
          monitor?.notSent(this.runInfo(state), { provider: route.provider, model: route.model, format, articles: chunk.length, sentAt }, error.message, error.detail);
          break;
        }
        const batch: SubmittedBatch = {
          provider: route.provider,
          model: route.model,
          maxTokens: route.maxTokens,
          format,
          id,
          submittedAt: sentAt,
          jobs: chunk.map(({ job, key }) => ({ key, index: workbook.rows.indexOf(job.row), title: job.row.title, placedLinks: job.placedLinks })),
          collected: false,
        };
        state.batches.push(batch);
        writeStateFile(this.statePath, state);
        monitor?.sent(this.runInfo(state), { provider: route.provider, model: route.model, format, id, articles: chunk.length, sentAt });
        logger.info('Generate → batch sent', { id, provider: route.provider, model: route.model, articles: chunk.length });
        onBatch?.({ type: 'submitted', batch });
      }
    }
    return state;
  }

  /**
   * Waits for every uncollected batch to end, saving each one's articles as soon as it does. If the output file
   * cannot be written (open in Excel, say), this throws and keeps the batch on record: the provider keeps the
   * results, a later run fetches them again, and rows already saved are skipped, so nothing is paid or written twice.
   */
  async collect(state: BatchState): Promise<GenerateRunSummary> {
    const { logger, monitor, onBatch } = this.options;
    const pollMs = this.options.pollMs ?? 30_000;
    const started = Date.now();

    for (;;) {
      const waiting: Array<{ batch: SubmittedBatch; state: string }> = [];
      for (const batch of state.batches.filter(b => !b.collected)) {
        const route = { provider: batch.provider, model: batch.model, maxTokens: batch.maxTokens };
        try {
          const status = await this.client(batch.provider).status(batch.id);
          monitor?.checked(batch.provider, batch.id, status.state);
          if (!status.done) {
            waiting.push({ batch, state: status.state });
            continue;
          }
          if (status.failure) this.failAll(state, batch, status.failure, status.detail);
          else this.save(state, batch, await this.client(batch.provider).results(batch.id, route, batch.jobs.map(ref => ref.key)));
        } catch (err) {
          if (!(err instanceof GenerationError)) throw err;
          if (err.action !== 'stop') {
            logger.warn('Generate → could not read a batch; trying again', { id: batch.id, error: err.message });
            waiting.push({ batch, state: 'checking again' });
            continue;
          }
          // The batch cannot be read with this key (or no longer exists): its rows stay empty for a new run.
          this.failAll(state, batch, err.message, err.detail);
        }
        batch.collected = true;
        writeStateFile(this.statePath, state);
      }
      if (waiting.length === 0) break;
      onBatch?.({ type: 'waiting', pending: waiting, elapsedMs: Date.now() - started });
      await this.wait(pollMs);
    }

    removeStateFile(this.statePath);
    logger.info('Generate → batches collected', { ...this.record.summary });
    return this.record.summary;
  }

  private save(state: BatchState, batch: SubmittedBatch, results: Map<string, Generation | GenerationError>): void {
    const outcome = { written: 0, failed: 0, cost: 0 };
    const fail = (job: ArticleJob, message: string, detail?: string) => {
      outcome.failed++;
      this.record.failed(job, message);
      this.options.monitor?.articleFailed(this.runInfo(state), batch, { rowIndex: job.row.rowIndex, title: job.row.title }, message, detail);
    };

    for (const ref of batch.jobs) {
      const job = this.jobFor(state, batch, ref);
      if (!job) {
        if (job === null) outcome.failed++;
        continue;
      }
      const result = results.get(ref.key);
      if (!result) {
        fail(job, 'no reply came back for this article');
        continue;
      }
      if (result instanceof GenerationError) {
        if (result.usage) outcome.cost += this.record.bill(batch.model, result.usage, BATCH_PRICE_FACTOR) ?? 0;
        fail(job, result.message, result.detail);
        continue;
      }
      const cost = this.record.bill(batch.model, result.usage, BATCH_PRICE_FACTOR);
      outcome.cost += cost ?? 0;
      let content: string;
      try {
        content = articleFrom(result.text, batch.format);
      } catch (err) {
        fail(job, err instanceof Error ? err.message : String(err), result.text.slice(0, 2000));
        continue;
      }
      // A failed save throws: the batch stays on record to be collected again.
      this.record.saved(job, content, cost);
      outcome.written++;
    }
    this.options.monitor?.finished(batch.provider, batch.id, { status: 'collected', ...outcome });
  }

  private failAll(state: BatchState, batch: SubmittedBatch, message: string, detail?: string): void {
    let failed = 0;
    for (const ref of batch.jobs) {
      const job = this.jobFor(state, batch, ref);
      if (job) this.record.failed(job, message);
      if (job !== undefined) failed++;
    }
    this.options.monitor?.articleFailed(this.runInfo(state), batch, null, message, detail);
    this.options.monitor?.finished(batch.provider, batch.id, { status: 'failed', written: 0, failed, cost: 0, note: message });
  }

  /**
   * The row a batch result belongs to: same position and title as when the batch was sent, and still empty.
   * null: the row moved or changed (reported as failed); undefined: it already has an article (left alone).
   */
  private jobFor(state: BatchState, batch: SubmittedBatch, ref: SubmittedBatch['jobs'][number]): ArticleJob | null | undefined {
    const row = this.options.workbook.rows[ref.index];
    if (!row || row.title !== ref.title) {
      const placeholder: GenerateRow = { rowIndex: ref.index + 2, title: ref.title, prompt: '', links: { sample: '', discount: '', customization: '' }, extra: [], content: '' };
      const message = 'the row moved or changed in the output file since the batch was sent';
      this.record.failed({ row: placeholder, format: batch.format, placedLinks: [] }, message);
      this.options.monitor?.articleFailed(this.runInfo(state), batch, { rowIndex: ref.index + 2, title: ref.title }, message, JSON.stringify({ expectedTitle: ref.title, foundTitle: row?.title ?? null }));
      return null;
    }
    if (row.content) {
      this.options.logger.warn('Generate → row already has an article; batch result not written', { rowIndex: row.rowIndex });
      return undefined;
    }
    return { row, format: batch.format, placedLinks: ref.placedLinks };
  }
}
