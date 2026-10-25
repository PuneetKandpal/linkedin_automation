import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import * as XLSX from 'xlsx';
import { OutputFormat, ProviderName } from './generate-prompt';

/** Raw replies kept for debugging are cut to this many characters (an Excel cell holds 32,767). */
const DETAIL_LIMIT = 8000;
/** The oldest failures are dropped beyond this many, so the monitor stays small enough to open. */
const MAX_ERRORS = 2000;
/** While a batch is waiting, its "last checked" time is written at most this often. */
const CHECK_WRITE_MS = 10 * 60_000;

export type RunMode = 'live' | 'batch';
/** running: a live run in progress · waiting: a batch run's articles are at the provider · done · stopped: a live run was interrupted · failed: nothing was written */
export type RunStatus = 'running' | 'waiting' | 'done' | 'stopped' | 'failed';
/** waiting: at the provider · collected: its articles were saved · failed: the whole batch failed · not sent: sending failed */
export type BatchRecordStatus = 'waiting' | 'collected' | 'failed' | 'not sent';

export interface RunRecord {
  runId: string;
  startedAt: string;
  mode: RunMode;
  status: RunStatus;
  input: string;
  output: string;
  articles: number;
  written: number;
  failed: number;
  /** US$, at batch prices for batch runs, failed attempts included. */
  cost: number;
  finishedAt: string;
  note: string;
}

export interface BatchRecord {
  runId: string;
  input: string;
  output: string;
  /** The run's recovery file, next to the output as it was when the batch was sent. */
  statePath: string;
  provider: ProviderName;
  model: string;
  format: OutputFormat;
  /** Empty when the batch could not be sent. */
  batchId: string;
  articles: number;
  sentAt: string;
  status: BatchRecordStatus;
  /** What the provider last reported, e.g. "in_progress" or "JOB_STATE_RUNNING". */
  providerState: string;
  lastCheckedAt: string;
  finishedAt: string;
  written: number;
  failed: number;
  cost: number;
  note: string;
}

export interface ErrorRecord {
  at: string;
  runId: string;
  output: string;
  /** Sheet row of the article, or null when the error is about a whole batch. */
  rowIndex: number | null;
  title: string;
  provider: ProviderName;
  model: string;
  batchId: string;
  message: string;
  /** The provider's raw reply or error body. */
  detail: string;
}

export interface MonitorData {
  runs: RunRecord[];
  batches: BatchRecord[];
  errors: ErrorRecord[];
}

/** The run a batch belongs to: one input workbook, one output workbook, one recovery file. */
export interface RunInfo {
  runId: string;
  input: string;
  output: string;
  statePath: string;
}

export interface BatchInfo {
  provider: ProviderName;
  model: string;
  format: OutputFormat;
  id: string;
  articles: number;
  sentAt: string;
}

type Columns<T> = Array<[header: string, field: keyof T]>;

/** Each sheet's columns: the header people see and the field it holds. The tool reads the sheets back by these headers. */
const RUN_COLUMNS: Columns<RunRecord> = [
  ['Started', 'startedAt'], ['Mode', 'mode'], ['Status', 'status'], ['Input file', 'input'], ['Output file', 'output'],
  ['Articles', 'articles'], ['Written', 'written'], ['Failed', 'failed'], ['Cost (US$)', 'cost'], ['Finished', 'finishedAt'],
  ['Note', 'note'], ['Run id', 'runId'],
];
const BATCH_COLUMNS: Columns<BatchRecord> = [
  ['Sent', 'sentAt'], ['Status', 'status'], ['Input file', 'input'], ['Output file', 'output'], ['Provider', 'provider'],
  ['Model', 'model'], ['Format', 'format'], ['Articles', 'articles'], ['Written', 'written'], ['Failed', 'failed'],
  ['Cost (US$)', 'cost'], ['Provider state', 'providerState'], ['Last checked', 'lastCheckedAt'], ['Finished', 'finishedAt'],
  ['Batch id', 'batchId'], ['Note', 'note'], ['Run id', 'runId'], ['Recovery file', 'statePath'],
];
const ERROR_COLUMNS: Columns<ErrorRecord> = [
  ['When', 'at'], ['Output file', 'output'], ['Row', 'rowIndex'], ['Report Title', 'title'], ['Provider', 'provider'],
  ['Model', 'model'], ['Batch id', 'batchId'], ['Error', 'message'], ['Raw response', 'detail'], ['Run id', 'runId'],
];
const NUMBERS = new Set(['articles', 'written', 'failed', 'cost']);
const SHEETS = { runs: ['Runs', RUN_COLUMNS], batches: ['Batches', BATCH_COLUMNS], errors: ['Errors', ERROR_COLUMNS] } as const;

const emptyData = (): MonitorData => ({ runs: [], batches: [], errors: [] });

/** A run's id: when it started, plus a few random letters. */
export function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Times as people read them in the workbook, in the computer's time zone: "2026-10-23 20:10:33". */
function localTime(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Costs are kept to a millionth of a dollar: articles cost fractions of a cent, and their sums must add up. */
const dollars = (usd: number) => Number(usd.toFixed(6));

function clip(text: string | undefined): string {
  const value = text ?? '';
  return value.length > DETAIL_LIMIT ? `${value.slice(0, DETAIL_LIMIT)}… [${value.length - DETAIL_LIMIT} more characters]` : value;
}

/** Sheet rows (newest first, as people read them) back into records (oldest first). */
function readSheet<T>(workbook: XLSX.WorkBook, name: string, columns: Columns<T>): T[] {
  const sheet = workbook.Sheets[name];
  if (!sheet) return [];
  return XLSX.utils
    .sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })
    .map(row => {
      const record: Record<string, unknown> = {};
      for (const [header, field] of columns) {
        const name = field as string;
        const value = row[header];
        if (name === 'rowIndex') record[name] = value === '' || value === undefined ? null : Number(value);
        else record[name] = NUMBERS.has(name) ? Number(value) || 0 : String(value ?? '');
      }
      return record as T;
    })
    .reverse();
}

/** Folds records saved while the workbook could not be written into the workbook's records: theirs win, nothing is lost. */
function mergeSaved(data: MonitorData, saved: MonitorData): void {
  const batchKey = (b: BatchRecord) => `${b.provider}|${b.batchId || `${b.runId}|${b.format}|${b.sentAt}`}`;
  const errorKey = (e: ErrorRecord) => `${e.at}|${e.runId}|${e.batchId}|${e.rowIndex}|${e.message}`;
  for (const run of saved.runs) {
    const i = data.runs.findIndex(r => r.runId === run.runId);
    if (i >= 0) data.runs[i] = run;
    else data.runs.push(run);
  }
  for (const batch of saved.batches) {
    const i = data.batches.findIndex(b => batchKey(b) === batchKey(batch));
    if (i >= 0) data.batches[i] = batch;
    else data.batches.push(batch);
  }
  const known = new Set(data.errors.map(errorKey));
  data.errors.push(...saved.errors.filter(e => !known.has(errorKey(e))));
}

function sheetFor<T>(records: T[], columns: Columns<T>): XLSX.WorkSheet {
  const aoa = [columns.map(([header]) => header), ...[...records].reverse().map(record => columns.map(([, field]) => record[field] ?? ''))];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet['!cols'] = columns.map((_, col) => {
    const longest = aoa.reduce((max, row) => Math.max(max, String(row[col] ?? '').length), 0);
    return { wch: Math.min(60, Math.max(10, longest + 2)) };
  });
  return sheet;
}

/**
 * Batch Monitor.xlsx, at the top of the tool's folder: every run with its cost (Runs), every batch sent to a provider
 * and how it is doing (Batches), and every failed article with the provider's raw reply (Errors). It is also the tool's
 * record of what is still waiting: after a sleep, a closed window or a restart, the tool reads it to find the batches
 * to check and collect. A change that cannot be saved (the workbook is open in Excel) is kept and saved with the next
 * one; the hidden recovery file next to each output still lets a run be collected meanwhile.
 */
export class BatchMonitor {
  readonly path: string;
  /** Changes not saved yet because the workbook could not be written; re-applied on top of the file at each save. */
  private pending: Array<(data: MonitorData) => void> = [];
  /** The workbook's content as last read or written, for when it cannot be read. */
  private lastFile: MonitorData = emptyData();
  /** The workbook was read or written by this process at least once; until then an unreadable one is never overwritten. */
  private loaded = false;
  private lastCheckWrite = new Map<string, number>();

  constructor(path = resolve(__dirname, '../..', 'Batch Monitor.xlsx')) {
    this.path = path;
    // Records an earlier run could not save (the workbook was open in Excel when it ended) go in first.
    try {
      const saved = JSON.parse(readFileSync(this.unsavedPath, 'utf-8')) as MonitorData;
      this.pending.push(data => mergeSaved(data, saved));
      this.save();
    } catch {
      // nothing left over
    }
  }

  /** True while some change is not saved in the workbook yet. */
  get unsaved(): boolean {
    return this.pending.length > 0;
  }

  /** Where records that could not be saved wait for the next run: a hidden file next to the workbook. */
  private get unsavedPath(): string {
    return join(dirname(this.path), `.${basename(this.path)}.unsaved.json`);
  }

  /** Before the tool exits: keeps changes that could not be saved, so the next run saves them. */
  keepUnsaved(): void {
    if (this.pending.length === 0) return;
    try {
      writeFileSync(this.unsavedPath, JSON.stringify(this.read()));
    } catch {
      // the recovery file next to each output still holds what a batch run needs
    }
  }

  /** The records, including changes this run could not save yet. */
  read(): MonitorData {
    const data = this.readFile() ?? structuredClone(this.lastFile);
    for (const change of this.pending) change(data);
    return data;
  }

  /** Saves changes that could not be saved earlier. True when nothing is left unsaved. */
  flush(): boolean {
    return this.pending.length === 0 || this.save();
  }

  /** Creates the workbook with its three empty sheets (for a new copy of the tool). */
  initialize(): boolean {
    return existsSync(this.path) || this.writeFile(emptyData());
  }

  runStarted(run: { runId: string; mode: RunMode; input: string; output: string; articles: number }): void {
    this.update(data => {
      data.runs.push({ ...run, startedAt: localTime(), status: run.mode === 'live' ? 'running' : 'waiting', written: 0, failed: 0, cost: 0, finishedAt: '', note: '' });
    });
  }

  /** A live run's result. Batch runs are summed from their batches as these finish. */
  runFinished(runId: string, outcome: { status: RunStatus; written: number; failed: number; cost: number; note?: string }): void {
    this.update(data => {
      const run = data.runs.find(r => r.runId === runId);
      if (run) Object.assign(run, outcome, { cost: dollars(outcome.cost), finishedAt: localTime(), note: outcome.note ?? run.note });
    });
  }

  sent(run: RunInfo, batch: BatchInfo): void {
    this.update(data => {
      data.batches.push({
        ...run,
        provider: batch.provider,
        model: batch.model,
        format: batch.format,
        batchId: batch.id,
        articles: batch.articles,
        sentAt: localTime(new Date(batch.sentAt)),
        status: 'waiting',
        providerState: 'sent',
        lastCheckedAt: '',
        finishedAt: '',
        written: 0,
        failed: 0,
        cost: 0,
        note: '',
      });
      this.sumRun(data, run.runId);
    });
  }

  notSent(run: RunInfo, batch: Omit<BatchInfo, 'id'>, message: string, detail?: string): void {
    this.update(data => {
      data.batches.push({
        ...run,
        provider: batch.provider,
        model: batch.model,
        format: batch.format,
        batchId: '',
        articles: batch.articles,
        sentAt: localTime(new Date(batch.sentAt)),
        status: 'not sent',
        providerState: '',
        lastCheckedAt: '',
        finishedAt: localTime(),
        written: 0,
        failed: batch.articles,
        cost: 0,
        note: message,
      });
      this.addError(data, { run, provider: batch.provider, model: batch.model, batchId: '', row: null, message, detail });
      this.sumRun(data, run.runId);
    });
  }

  /** The provider's state at a check. Saved when it changes, else at most every 10 minutes. */
  checked(provider: ProviderName, batchId: string, providerState: string): void {
    const key = `${provider}:${batchId}`;
    const record = this.find(this.read(), provider, batchId);
    if (record && record.providerState === providerState && Date.now() - (this.lastCheckWrite.get(key) ?? 0) < CHECK_WRITE_MS) return;
    this.lastCheckWrite.set(key, Date.now());
    this.update(data => {
      const target = this.find(data, provider, batchId);
      if (target) Object.assign(target, { providerState, lastCheckedAt: localTime() });
    });
  }

  articleFailed(run: RunInfo, batch: { provider: ProviderName; model: string; id: string }, row: { rowIndex: number; title: string } | null, message: string, detail?: string): void {
    this.update(data => this.addError(data, { run, provider: batch.provider, model: batch.model, batchId: batch.id, row, message, detail }));
  }

  finished(provider: ProviderName, batchId: string, outcome: { status: 'collected' | 'failed'; written: number; failed: number; cost: number; note?: string }): void {
    this.update(data => {
      const target = this.find(data, provider, batchId);
      if (!target) return;
      Object.assign(target, outcome, { cost: dollars(outcome.cost), finishedAt: localTime(), lastCheckedAt: localTime(), note: outcome.note ?? target.note });
      this.sumRun(data, target.runId);
    });
  }

  /** A batch id is unique within its provider only. */
  private find(data: MonitorData, provider: ProviderName, batchId: string): BatchRecord | undefined {
    return data.batches.find(b => b.provider === provider && b.batchId === batchId);
  }

  /** A batch run's totals and status, from its batches. A run collected without its Runs row gets one. */
  private sumRun(data: MonitorData, runId: string): void {
    const batches = data.batches.filter(b => b.runId === runId);
    if (!runId || batches.length === 0) return;
    let run = data.runs.find(r => r.runId === runId);
    if (!run) {
      const first = batches[0];
      run = { runId, startedAt: first.sentAt, mode: 'batch', status: 'waiting', input: first.input, output: first.output, articles: 0, written: 0, failed: 0, cost: 0, finishedAt: '', note: '' };
      data.runs.push(run);
    }
    if (run.mode !== 'batch') return;
    const sum = (field: 'articles' | 'written' | 'failed' | 'cost') => batches.reduce((total, b) => total + b[field], 0);
    Object.assign(run, { articles: sum('articles'), written: sum('written'), failed: sum('failed'), cost: dollars(sum('cost')) });
    if (batches.some(b => b.status === 'waiting')) {
      run.status = 'waiting';
    } else if (run.status === 'waiting') {
      run.status = run.written > 0 ? 'done' : 'failed';
      run.finishedAt = localTime();
    }
  }

  private addError(
    data: MonitorData,
    error: { run: RunInfo; provider: ProviderName; model: string; batchId: string; row: { rowIndex: number; title: string } | null; message: string; detail?: string }
  ): void {
    data.errors.push({
      at: localTime(),
      runId: error.run.runId,
      output: error.run.output,
      rowIndex: error.row?.rowIndex ?? null,
      title: error.row?.title ?? '',
      provider: error.provider,
      model: error.model,
      batchId: error.batchId,
      message: error.message,
      detail: clip(error.detail),
    });
    if (data.errors.length > MAX_ERRORS) data.errors.splice(0, data.errors.length - MAX_ERRORS);
  }

  private update(change: (data: MonitorData) => void): void {
    this.pending.push(change);
    this.save();
  }

  /** Applies every unsaved change on top of the workbook as it is now (another window may have written it) and saves. */
  private save(): boolean {
    const base = this.readFile();
    // A workbook this process could never read is not overwritten: that would lose its history.
    if (base === null && !this.loaded) return false;
    const data = base ?? structuredClone(this.lastFile);
    for (const change of this.pending) change(data);
    if (!this.writeFile(data)) return false;
    this.pending = [];
    this.lastFile = data;
    this.loaded = true;
    if (existsSync(this.unsavedPath)) {
      try {
        unlinkSync(this.unsavedPath);
      } catch {
        // merged already; a leftover is merged again harmlessly
      }
    }
    return true;
  }

  /** The workbook's records, or null when it exists but cannot be read right now. */
  private readFile(): MonitorData | null {
    if (!existsSync(this.path)) {
      this.loaded = true;
      return emptyData();
    }
    try {
      const workbook = XLSX.readFile(this.path);
      // Any text file reads as a one-sheet workbook; only one with the monitor's own sheets is the monitor.
      if (!workbook.SheetNames.some(name => name === SHEETS.runs[0] || name === SHEETS.batches[0] || name === SHEETS.errors[0])) return null;
      const data: MonitorData = {
        runs: readSheet(workbook, SHEETS.runs[0], SHEETS.runs[1]),
        batches: readSheet(workbook, SHEETS.batches[0], SHEETS.batches[1]),
        errors: readSheet(workbook, SHEETS.errors[0], SHEETS.errors[1]),
      };
      this.lastFile = data;
      this.loaded = true;
      return structuredClone(data);
    } catch {
      return null;
    }
  }

  private writeFile(data: MonitorData): boolean {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheetFor(data.runs, RUN_COLUMNS), SHEETS.runs[0]);
    XLSX.utils.book_append_sheet(workbook, sheetFor(data.batches, BATCH_COLUMNS), SHEETS.batches[0]);
    XLSX.utils.book_append_sheet(workbook, sheetFor(data.errors, ERROR_COLUMNS), SHEETS.errors[0]);
    const temp = `${this.path}.~tmp.xlsx`;
    try {
      XLSX.writeFile(workbook, temp, { bookSST: true });
      renameSync(temp, this.path);
      return true;
    } catch {
      try {
        unlinkSync(temp);
      } catch {
        // nothing to clean up
      }
      return false;
    }
  }
}
