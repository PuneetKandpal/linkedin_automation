#!/usr/bin/env node
import '../env';
import { spawn, spawnSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { createInterface } from 'readline';
import { Logger } from '../engine/logger';
import { BATCH_PRICE_FACTOR, BatchEvent, BatchRunner, createBatchClient, findPendingRun, PendingRun, pendingRuns } from '../services/generate-batch';
import { BatchMonitor, newRunId, RunStatus } from '../services/generate-monitor';
import { estimateCost, GenerateConfig, loadGenerateConfig, parseModelSpec } from '../services/generate-config';
import { GenerateWorkbook, loadGenerateWorkbook } from '../services/generate-excel';
import {
  buildPrompt,
  columnKey,
  detectFormat,
  finalPrompt,
  FORMAT_LABELS,
  LINK_LABELS,
  OutputFormat,
  ProviderName,
  wordTarget,
} from '../services/generate-prompt';
import { checkKey, cleanKey, currentKey, KEY_NAMES, keysFilePath, loadKeys, looksLikeKeyProblem, maskKey, saveKeys } from '../services/generate-keys';
import { ContentGenerator, createGenerator, missingApiKey } from '../services/generate-providers';
import { ArticleJob, GenerateRunner, GenerateRunSummary, ProgressEvent } from '../services/generate-runner';

const FORMATS: OutputFormat[] = ['html', 'markdown'];
const PROVIDER_LABELS: Record<ProviderName, string> = { claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI' };
/** Someone at the keyboard: the tool may ask questions and open the file chooser. */
const INTERACTIVE = Boolean(process.stdin.isTTY && process.stdout.isTTY);
/** The workflow waited 5 minutes and retried forever; a minute clears most rate limits, and retries are capped. */
const RETRY_WAIT_MS = 60_000;

// CLI banner
console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          Content Generation CLI v1.2.0                        ║
║                                                               ║
║  Writes an article for each row of an Excel workbook: HTML    ║
║  rows with Claude, Markdown rows with a low-cost model.       ║
╚═══════════════════════════════════════════════════════════════╝
`);

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.findIndex(a => a === flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

/** Every value of a flag that may repeat, e.g. --var a=1 --var b=2. */
function getArgValues(flag: string): string[] {
  return process.argv.flatMap((a, i) => (a === flag && i + 1 < process.argv.length ? [process.argv[i + 1]] : []));
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

/** A whole-number flag: the fallback when it is absent, NaN when it is not a whole number of at least `min`. */
function intArg(flag: string, fallback: number, min: number): number {
  const raw = getArgValue(flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min ? value : NaN;
}

function printUsage(config?: GenerateConfig): void {
  const now = (text: string) => (config ? ` (now: ${text})` : '');
  console.log('Usage:');
  console.log('  li-generate                                 asks for the Excel file, then the questions below');
  console.log('  li-generate --file "<input.xlsx>" [options]');
  console.log('');
  console.log('In a terminal window the tool asks, with the usual answer typed in so Enter accepts it: the format, the model,');
  console.log('how many articles, live or batch, and values for placeholders the Excel file has no column for. An option');
  console.log('below answers its question instead; --yes skips them all and uses the defaults.');
  console.log('');
  console.log('By default each row is written in the format its template asks for, by the model set for that format in');
  console.log(`config/generate.json${config ? ` (now: HTML → ${config.html.model}, Markdown → ${config.markdown.model})` : ''}.`);
  console.log(`Runs of ${config?.batchMinArticles ?? 10} or more articles use the providers' batch queue: half price, results usually`);
  console.log('within an hour (Claude) or a few hours (Gemini). Smaller runs are written live.');
  console.log('');
  console.log('Options:');
  console.log('  --batch / --live          Use the batch queue (half price, later) or write live (now, full price)');
  console.log('  --html-model <model>      Model for HTML rows, e.g. claude-sonnet-5-5');
  console.log('  --markdown-model <model>  Model for Markdown rows, e.g. claude-haiku-5-5 or gemini:gemini-2.5-flash');
  console.log('  --format html|markdown    Write every row in this format, whatever its template asks for');
  console.log(`  --parallel N              Live runs: articles written at the same time${now(String(config?.parallel))}`);
  console.log('  --max-tokens N            Longest reply allowed per article, thinking included');
  console.log('  --var name=value          Value for {{name}} in every template, e.g. --var base_year=2025');
  console.log('                            (repeatable; a column with that name overrides it row by row)');
  console.log('  --limit N                 Only the first N rows that still need an article');
  console.log(`  --retries N               Live runs: extra attempts after a rate limit or empty reply${now(`${config?.retries}, a minute apart`)}`);
  console.log('  --status                  Show batch runs still waiting (checked with the providers now) and the latest finished');
  console.log('  --collect                 Collect every batch run still waiting, waiting for those still being written');
  console.log('  --dry-run                 Check the workbook and show the exact prompts; nothing is sent or written');
  console.log('  --keys                    Enter or replace the API keys (saved to config/api-keys.txt)');
  console.log('  --yes                     Start without asking for confirmation');
  console.log('');
  console.log('API keys come from config/api-keys.txt (or .env): ANTHROPIC_API_KEY (Claude), GEMINI_API_KEY (Gemini), OPENAI_API_KEY (OpenAI).');
  console.log('The tool asks for a key it does not have; --keys (or "Change API Keys") replaces them.');
  console.log('');
  console.log('Articles are saved to "<input name> - Output (DD_MM_YY_HHMMSS).xlsx" next to the input as they arrive.');
  console.log('To fill in rows that failed, run again on that output file: rows that already have an article are skipped.');
  console.log('A batch whose window was closed (or whose laptop slept or restarted) is collected the next time the tool is');
  console.log('opened, or with --collect; it is never sent twice. --status shows what is waiting. Every batch, and the raw');
  console.log('reply of every failure, is recorded in Batch Monitor.xlsx in the tool folder, with the cost of each run.');
  console.log('');
}

/**
 * Asks one question in the terminal. Resolves null on Ctrl+C or a closed input, so the caller can stop
 * cleanly. The callback form answers before 'close' fires, even when the line and end of input arrive together.
 */
function ask(question: string, prefill = ''): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string | null>(done => {
    rl.on('SIGINT', () => {
      done(null);
      rl.close();
    });
    rl.on('close', () => done(null));
    rl.question(question, answer => {
      done(answer);
      rl.close();
    });
    // Typed in for the user, who can change it or press Enter to accept it.
    if (prefill) rl.write(prefill);
  });
}

let stepNumber = 0;
function stepTitle(title: string): void {
  console.log(`[${++stepNumber}] ${title}`);
}

/** A numbered choice, the preset one typed in already: Enter accepts it. Null on Ctrl+C. */
async function choose<T>(options: { label: string; value: T }[], preset: number): Promise<T | null> {
  options.forEach((option, i) => console.log(`    ${i + 1}) ${option.label}`));
  for (;;) {
    const answer = await ask('    Type a number and press Enter: ', String(preset + 1));
    if (answer === null) return null;
    const n = answer.trim() === '' ? preset + 1 : Number(answer.trim());
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      console.log('');
      return options[n - 1].value;
    }
    console.log(`    Type a number from 1 to ${options.length}.`);
  }
}

/** A path typed or dragged into the terminal: macOS escapes spaces with backslashes, Windows wraps it in quotes. */
function cleanDroppedPath(text: string): string {
  const value = text.trim();
  if (/^(['"]).*\1$/.test(value)) return value.slice(1, -1);
  return process.platform === 'win32' ? value : value.replace(/\\(.)/g, '$1');
}

const KEY_PAGES: Record<ProviderName, string> = {
  claude: 'https://console.anthropic.com/settings/keys',
  gemini: 'https://aistudio.google.com/apikey',
  openai: 'https://platform.openai.com/api-keys',
};
const KEY_HINT = 'To replace an API key, double-click "Change API Keys" in the tool folder (or run with --keys).';

/**
 * Asks for each provider's API key, checks it with the provider and saves it to config/api-keys.txt. `replace`: offer to change keys
 * already set (Enter keeps them); otherwise only missing keys are asked for. Returns false on Ctrl+C.
 */
async function setupKeys(providers: ProviderName[], models: Partial<Record<ProviderName, string>>, replace: boolean): Promise<boolean> {
  for (const provider of providers) {
    const name = KEY_NAMES[provider];
    const current = currentKey(provider);
    if (current && !replace) continue;
    console.log(`${PROVIDER_LABELS[provider]} API key (${name}): ${current ? `now ${maskKey(current)}` : 'not set yet'}`);
    console.log(`  Create one at ${KEY_PAGES[provider]}`);
    for (;;) {
      const answer = await ask(`  Paste the key and press Enter${current ? ' (or just Enter to keep the current one)' : ' (or just Enter to skip)'}: `);
      if (answer === null) return false;
      if (answer.trim() === '') {
        console.log(current ? '  Kept.' : '  Skipped.');
        break;
      }
      const key = cleanKey(answer);
      if (!key) {
        console.log('  That does not look like an API key. Copy the whole key and paste it again.');
        continue;
      }
      process.stdout.write('  Checking it with the provider... ');
      const check = await checkKey(provider, key, models[provider] ?? parseModelSpec(provider)?.model ?? '');
      if (check.result === 'refused') {
        console.log(`not accepted: ${check.message.slice(0, 200)}`);
        console.log('  Check that it is the right key for this provider, then paste it again.');
        continue;
      }
      try {
        saveKeys(keysFilePath(), { [name]: key });
      } catch (err) {
        console.log('');
        console.error(`❌ Cannot save the key to ${keysFilePath()}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      process.env[name] = key;
      if (provider === 'gemini') delete process.env.GOOGLE_API_KEY;
      console.log(check.result === 'ok' ? 'accepted and saved.' : `saved, but it could not be checked now (${check.message.slice(0, 120)}).`);
      break;
    }
    console.log('');
  }
  return true;
}

/** The workflow's run id format (DD_MM_YY_HHMMSS, its Search_By_Id), so output files read the same. */
function runStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(now.getDate())}_${pad(now.getMonth() + 1)}_${String(now.getFullYear()).slice(-2)}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function defaultOutputPath(inputPath: string, now: Date): string {
  return join(dirname(inputPath), `${basename(inputPath, extname(inputPath))} - Output (${runStamp(now)}).xlsx`);
}

const money = (usd: number) => `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)}`;
const thousands = (n: number) => n.toLocaleString('en-US');

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function printProgress(event: ProgressEvent, position: string): void {
  const { rowIndex, title } = event.job.row;
  if (event.type === 'saved') {
    const cost = event.cost === null ? '' : `, ${money(event.cost)}`;
    console.log(`  ✓ ${position} row ${rowIndex}  ${title} — ${thousands(event.words)} words${cost}`);
    if (event.issues.length > 0) console.log(`      ⚠ check before publishing: ${event.issues.join('; ')}`);
  } else if (event.type === 'failed') {
    console.log(`  ✗ ${position} row ${rowIndex}  ${title} — failed: ${event.message}`);
  } else {
    console.log(`  … row ${rowIndex}  ${title} — ${event.message}; trying again in ${duration(event.waitMs)} (attempt ${event.attempt} of ${event.attempts})`);
  }
}

/** Prints article lines as they arrive, counting them; `total` is how many are expected. */
function progressPrinter(total: number, words: Record<OutputFormat, number[]>): (event: ProgressEvent) => void {
  let finished = 0;
  return event => {
    if (event.type === 'saved') words[event.job.format].push(event.words);
    printProgress(event, event.type === 'retrying' ? '' : `[${++finished}/${total}]`);
  };
}

/** Prints batch events: each batch as it is sent, and while waiting a line when something changes (else every 5 minutes). */
function batchPrinter(): (event: BatchEvent) => void {
  let last = '';
  let lastAt = 0;
  return event => {
    if (event.type === 'submitted') {
      const { batch } = event;
      console.log(`  → ${batch.jobs.length} ${FORMAT_LABELS[batch.format]} article(s) sent to ${PROVIDER_LABELS[batch.provider]} (${batch.model})`);
      return;
    }
    const states = event.pending.map(({ batch, state }) => `${PROVIDER_LABELS[batch.provider]} ${state.replace(/^JOB_STATE_/, '').toLowerCase().replace(/_/g, ' ')}`).join(', ');
    if (states === last && Date.now() - lastAt < 5 * 60_000) return;
    console.log(`  … ${duration(event.elapsedMs)} so far — ${states}`);
    last = states;
    lastAt = Date.now();
  };
}

/** The words of saved articles per format, against what their templates ask for. */
function wordsLine(words: number[], templates: string[]): string {
  const [low, high] = [Math.min(...words), Math.max(...words)];
  const range = low === high ? thousands(low) : `${thousands(low)}–${thousands(high)}`;
  const targets = templates.map(wordTarget).filter(Boolean) as { min: number | null; max: number }[];
  if (targets.length === 0) return range;
  const max = Math.max(...targets.map(t => t.max));
  const mins = targets.map(t => t.min).filter((min): min is number => min !== null);
  return mins.length > 0
    ? `${range} (templates ask for ${thousands(Math.min(...mins))}–${thousands(max)})`
    : `${range} (templates allow up to ${thousands(max)})`;
}

/** `outputPath` is null when the run wrote no article and its empty output file was removed. */
function printSummary(
  summary: GenerateRunSummary,
  words: Record<OutputFormat, number[]>,
  templates: Record<OutputFormat, string[]>,
  total: number,
  outputPath: string | null,
  inputPath: string,
  elapsedMs: number
): void {
  console.log('');
  console.log(`Finished in ${duration(elapsedMs)}.`);
  console.log(`  Articles written:         ${summary.generated} of ${total}`);
  if (summary.failed > 0) console.log(`  Failed:                   ${summary.failed}`);
  if (summary.needsReview > 0) console.log(`  Check before publishing:  ${summary.needsReview} (marked ⚠ above)`);
  for (const format of FORMATS) {
    if (words[format].length > 0) console.log(`  ${`${FORMAT_LABELS[format]} words:`.padEnd(26)}${wordsLine(words[format], templates[format])}`);
  }
  const unpriced = summary.unpricedCalls > 0 ? ` (plus ${summary.unpricedCalls} call(s) to models without a price in config/generate.json)` : '';
  console.log(`  Cost:                     ${money(summary.cost)}${unpriced}`);
  if (summary.stopReason) console.log(`  Stopped early:            ${summary.stopReason}`);
  if (summary.stopReason && looksLikeKeyProblem(summary.stopReason)) console.log(`  ${KEY_HINT}`);
  console.log(`  Saved to:                 ${outputPath ?? 'nothing (no article was written, so no output file was kept)'}`);
  if (summary.failed > 0 || summary.stopReason) {
    console.log('');
    console.log(
      outputPath
        ? `To fill in the rows still without an article, run again with --file "${outputPath}".`
        : `Fix the problem above, then run again with --file "${inputPath}".`
    );
  }
}

/** A sleeping Mac pauses a long run mid-call. caffeinate exits by itself when this process does. */
function keepAwake(): void {
  if (process.platform !== 'darwin') return;
  try {
    spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // keep-awake is a courtesy; the run works without it
  }
}

function createLogger(): Logger {
  const runTs = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = resolve('./output/logs');
  // The terminal shows the progress lines; the log file keeps the detail.
  return new Logger({
    logFilePath: resolve(logDir, `generate_${runTs}.log`),
    latestLogPath: resolve(logDir, 'latest_generate.log'),
    console: false,
  });
}

/** What Ctrl+C prints before the tool exits; it changes once articles are in a provider's batch queue. */
let interruptMessage = 'Stopped.';
/** Runs before the tool exits early: records an interrupted live run, and keeps monitor changes not saved yet. */
let beforeExit: () => void = () => undefined;
let interruptHandled = false;
/** Ctrl+C, a closed Terminal window (SIGHUP) and a shutdown (SIGTERM) all end the tool the same way. */
function onInterrupt(): void {
  if (interruptHandled) return;
  interruptHandled = true;
  const stop = (signal: NodeJS.Signals) => {
    beforeExit();
    // A closed window leaves nobody to read a message.
    if (signal === 'SIGINT') console.log(`\n${interruptMessage}`);
    process.exit(130);
  };
  for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM'] as const) process.once(signal, () => stop(signal));
}

/**
 * The system's file chooser for the input workbook: Finder on a Mac, Explorer on Windows. Null when the person
 * cancels; undefined when no chooser can be shown here, and the drag-and-drop prompt is used instead.
 */
function chooseExcelFile(): string | null | undefined {
  if (process.platform === 'darwin') {
    const script = 'POSIX path of (choose file with prompt "Choose the Excel file with the input records" of type {"org.openxmlformats.spreadsheetml.sheet", "xlsx"})';
    const result = spawnSync('osascript', ['-e', script], { encoding: 'utf-8' });
    if (result.error) return undefined;
    // -128 is AppleScript's "User canceled."
    if (result.status !== 0) return /-128/.test(result.stderr) ? null : undefined;
    return result.stdout.trim() || null;
  }
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      // An invisible always-on-top owner keeps the dialog in front of the console window.
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      "$dialog.Title = 'Choose the Excel file with the input records'",
      "$dialog.Filter = 'Excel workbooks (*.xlsx)|*.xlsx'",
      "if ($dialog.ShowDialog($owner) -eq 'OK') { $dialog.FileName }",
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf-8' });
    if (result.error || result.status !== 0) return undefined;
    return result.stdout.trim() || null;
  }
  return undefined;
}

/** The input workbook, chosen in the system's file chooser, or dragged into the window where there is none. */
/** Asks for the input file: dragged into the window, or chosen in a file window on an empty Enter. */
async function pickInputFile(): Promise<string | undefined> {
  stepTitle('Excel file with the input records');
  for (;;) {
    const answer = await ask('    Drag the file into this window and press Enter (or just press Enter to choose it in a window): ');
    if (answer === null) return undefined;
    let file = answer.trim() ? cleanDroppedPath(answer) : undefined;
    if (!file) {
      const chosen = chooseExcelFile();
      if (chosen === null) continue;
      if (!chosen) {
        console.log('    No file window is available here: drag the file into this window instead.');
        continue;
      }
      file = chosen;
      console.log(`    ${file}`);
    }
    if (existsSync(file)) {
      console.log('');
      return file;
    }
    console.log(`    There is no file at "${file}". Drag the Excel file itself into this window.`);
  }
}

const MODEL_CHOICES: Record<OutputFormat, string[]> = {
  html: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  markdown: ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'claude-haiku-5-5'],
};
const MODEL_NOTES: Record<string, string> = {
  'claude-haiku-5-5': 'Claude Haiku 5.5: good quality, low cost',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5: similar quality to Haiku 5.5, about 7 times the cost',
  'claude-opus-5-5': 'Claude Opus 5.5: the richest analysis, about 20 times the cost',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite: lowest cost; LinkedIn articles run a little long',
  'gemini-2.5-flash': 'Gemini 2.5 Flash: the workflow\'s original model',
};

interface PreparedJobs {
  /** Each pending row with its prompt filled, before anything is changed in the workbook. */
  jobs: (ArticleJob & { prompt: string })[];
  problems: string[];
  unfilled: Map<string, number>;
}

/** Fills every pending row's placeholders, so problems surface before anything is sent to a model. Changes nothing. */
function prepareJobs(workbook: GenerateWorkbook, vars: Record<string, string>, forcedFormat: OutputFormat | undefined): PreparedJobs {
  const problems: string[] = [];
  const unfilled = new Map<string, number>();
  const jobs: PreparedJobs['jobs'] = [];
  for (const row of workbook.pendingRows) {
    const missing = [!row.title && 'Report Title', !row.prompt && 'Prompt Template'].filter(Boolean);
    if (missing.length > 0) {
      problems.push(`row ${row.rowIndex}: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} empty`);
      continue;
    }
    const built = buildPrompt({ title: row.title, template: row.prompt, links: row.links, values: { ...vars, ...workbook.templateValues(row) } });
    for (const link of built.unresolvedLinks) {
      problems.push(
        link.kind
          ? `row ${row.rowIndex}: the template has "${link.placeholder}" but the ${LINK_LABELS[link.kind]} cell is empty`
          : `row ${row.rowIndex}: the template has "${link.placeholder}" without saying which link goes there`
      );
    }
    for (const name of built.unfilled) unfilled.set(name, (unfilled.get(name) || 0) + 1);
    jobs.push({ row, prompt: built.prompt, format: forcedFormat ?? detectFormat(built.prompt), placedLinks: built.placedLinks });
  }
  return { jobs, problems, unfilled };
}

interface RunChoices {
  forcedFormat?: OutputFormat;
  limit: number;
  mode?: 'batch' | 'live';
}

/**
 * The questions before a run, each answer typed in already so Enter accepts it: format, model, how many rows,
 * live or batch, and values for empty placeholders. A question whose flag was given is not asked. Null on Ctrl+C.
 */
async function askRunChoices(
  prepared: PreparedJobs,
  config: GenerateConfig,
  vars: Record<string, string>,
  given: RunChoices,
  maxTokens: number
): Promise<RunChoices | null> {
  const choices = { ...given };
  const detected = { html: 0, markdown: 0 };
  prepared.jobs.forEach(job => detected[detectFormat(job.prompt)]++);
  const counts = FORMATS.filter(format => detected[format] > 0).map(format => `${detected[format]} ask for ${FORMAT_LABELS[format]}`);

  if (!given.forcedFormat && !hasFlag('--format')) {
    stepTitle(`Article format (the templates of the ${prepared.jobs.length} row(s) to write: ${counts.join(', ')})`);
    const mixed = counts.length > 1;
    const options: { label: string; value: OutputFormat | undefined }[] = [
      { label: 'Markdown (LinkedIn articles)', value: 'markdown' },
      { label: 'HTML (website articles)', value: 'html' },
    ];
    if (mixed) options.push({ label: 'As each row\'s template asks', value: undefined });
    const preset = mixed ? 2 : detected.html > 0 ? 1 : 0;
    const format = await choose(options, preset);
    if (format === null) return null;
    choices.forcedFormat = format;
  }

  const formatOf = (job: PreparedJobs['jobs'][number]) => choices.forcedFormat ?? job.format;
  const formatsUsed = FORMATS.filter(format => prepared.jobs.some(job => formatOf(job) === format));
  for (const format of formatsUsed) {
    if (getArgValue(`--${format}-model`) !== undefined) continue;
    const sample = prepared.jobs.find(job => formatOf(job) === format) as PreparedJobs['jobs'][number];
    const current = config[format];
    const models = [current.model, ...MODEL_CHOICES[format].filter(model => model !== current.model)];
    const options = models.map(model => {
      const route = model === current.model ? current : (parseModelSpec(model) as typeof current);
      const cost = estimateCost(config, model, finalPrompt(sample.prompt, route.provider, format).length);
      const price = cost === null ? '' : ` (about ${money(cost)} per article)`;
      return { label: `${MODEL_NOTES[model] ?? model}${price}${model === current.model ? ' [default]' : ''}`, value: route };
    });
    stepTitle(`Model for the ${FORMAT_LABELS[format]} articles`);
    const route = await choose(options, 0);
    if (route === null) return null;
    config[format] = maxTokens > 0 ? { ...route, maxTokens } : route;
  }

  if (!hasFlag('--limit') && prepared.jobs.length > 1) {
    stepTitle(`How many articles? (${prepared.jobs.length} row(s) still need one; the first rows are written first)`);
    for (;;) {
      const answer = await ask('    Number of articles, then Enter: ', String(prepared.jobs.length));
      if (answer === null) return null;
      const n = answer.trim() === '' ? prepared.jobs.length : Number(answer.trim());
      if (Number.isInteger(n) && n >= 1 && n <= prepared.jobs.length) {
        choices.limit = n;
        console.log('');
        break;
      }
      console.log(`    Type a number from 1 to ${prepared.jobs.length}.`);
    }
  }

  const batchable = formatsUsed.every(format => config[format].provider !== 'openai');
  if (batchable && !hasFlag('--batch') && !hasFlag('--live')) {
    const count = Math.min(choices.limit, prepared.jobs.length);
    stepTitle('Write now, or use the half-price batch queue?');
    const mode = await choose<'batch' | 'live'>(
      [
        { label: 'Live: written now, one by one, at full price', value: 'live' },
        { label: 'Batch queue: half price; results usually within an hour, and the laptop may sleep meanwhile', value: 'batch' },
      ],
      count >= config.batchMinArticles ? 1 : 0
    );
    if (mode === null) return null;
    choices.mode = mode;
  }

  if (prepared.unfilled.size > 0) {
    const names = [...prepared.unfilled.keys()];
    stepTitle(`The templates use ${names.join(', ')}, but the Excel file has no column for ${names.length > 1 ? 'them' : 'it'}`);
    const fill = await choose(
      [
        { label: 'Let the model estimate them for each market', value: false },
        { label: 'Type one value for each now, used in every row (Enter on an empty value leaves it to the model)', value: true },
      ],
      0
    );
    if (fill === null) return null;
    if (fill) {
      for (const name of names) {
        const answer = await ask(`    ${name} = `);
        if (answer === null) return null;
        if (answer.trim()) vars[columnKey(name.replace(/[{}]/g, ''))] = answer.trim();
      }
      console.log('');
    }
  }
  return choices;
}

/** Makes sure the run is recorded in Batch Monitor.xlsx, asking to close it in Excel if it is open there. */
async function saveMonitor(monitor: BatchMonitor, interactive: boolean): Promise<void> {
  for (let tries = 0; interactive && tries < 3 && !monitor.flush(); tries++) {
    const answer = await ask(`${basename(monitor.path)} is open in Excel, so this run is not recorded in it yet. Close it there, then press Enter: `);
    if (answer === null) break;
  }
  if (!monitor.flush()) {
    monitor.keepUnsaved();
    console.log(`  (${basename(monitor.path)} could not be updated now; this run is added to it the next time the tool runs.)`);
  }
}

function batchKeptMessage(inputPath: string): string {
  return `   The batch is kept. Close the output file in Excel if it is open, then open the tool again (or run it on "${inputPath}") to collect the articles; they are not charged again.`;
}

function batchInterruptMessage(inputPath: string, providers: ProviderName[]): string {
  const names = [...new Set(providers)].map(p => PROVIDER_LABELS[p]).join(' and ');
  return `Stopped waiting. The batch keeps running at ${names}, and nothing is lost: open the tool again later (or run it on "${inputPath}") to collect the articles. They will not be sent (or charged) again.`;
}

const sentAtOf = (run: PendingRun) =>
  new Date(Math.min(...run.state.batches.filter(batch => !batch.collected).map(batch => Date.parse(batch.submittedAt)))).toLocaleString();

/** "5 Markdown articles to Gemini", for each uncollected batch of a run. */
function describeRun(run: PendingRun): string {
  return run.state.batches
    .filter(batch => !batch.collected)
    .map(batch => `${batch.jobs.length} ${FORMAT_LABELS[batch.format]} article(s) to ${PROVIDER_LABELS[batch.provider]}`)
    .join(' + ');
}

/** Asks the providers how each uncollected batch of a run is doing: ready when all of them have ended. */
async function checkRun(run: PendingRun): Promise<{ ready: boolean; text: string }> {
  const states: string[] = [];
  let ready = true;
  for (const batch of run.state.batches.filter(b => !b.collected)) {
    try {
      const status = await createBatchClient(batch.provider).status(batch.id);
      if (!status.done) ready = false;
      states.push(status.done ? (status.failure ? `${PROVIDER_LABELS[batch.provider]} failed` : `${PROVIDER_LABELS[batch.provider]} ready`) : `${PROVIDER_LABELS[batch.provider]} still writing`);
    } catch (err) {
      ready = false;
      states.push(`${PROVIDER_LABELS[batch.provider]}: could not check (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { ready, text: states.join(', ') };
}

/** Collects a batch an earlier run sent, into that run's output file. */
async function collectPendingBatch(pending: PendingRun, inputPath: string, config: GenerateConfig, dryRun: boolean, monitor: BatchMonitor): Promise<number> {
  const { outputPath, state, statePath } = pending;
  const batches = state.batches.filter(batch => !batch.collected);
  const total = batches.reduce((sum, batch) => sum + batch.jobs.length, 0);
  console.log(`${total} article(s) were sent to the batch queue on ${sentAtOf(pending)} and not collected yet.`);
  console.log(`Output:     ${outputPath}`);
  if (dryRun) {
    console.log('Dry run: run without --dry-run to collect them.');
    return 0;
  }
  console.log('Collecting them now, instead of sending (and paying for) them again.');
  console.log('');

  let workbook: GenerateWorkbook;
  try {
    workbook = loadGenerateWorkbook(outputPath);
    workbook.writeTo(outputPath);
  } catch (err) {
    console.error(`❌ Cannot open the output workbook "${outputPath}": ${String(err)}`);
    console.error('   Close it in Excel if it is open, then retry.');
    return 1;
  }

  keepAwake();
  const logger = createLogger();
  logger.info('Generate CLI → collecting a pending batch', { output: outputPath, batches: batches.map(batch => batch.id) });
  interruptMessage = batchInterruptMessage(inputPath, batches.map(batch => batch.provider));
  beforeExit = () => monitor.keepUnsaved();
  onInterrupt();

  const started = Date.now();
  const words: Record<OutputFormat, number[]> = { html: [], markdown: [] };
  const runner = new BatchRunner({ workbook, outputPath, statePath, input: state.input, config, logger, monitor, onProgress: progressPrinter(total, words), onBatch: batchPrinter() });
  console.log('Waiting for the results. You can close this window: open the tool again later to collect them.');
  let summary: GenerateRunSummary;
  try {
    summary = await runner.collect(state);
  } catch (err) {
    logger.error('Generate CLI → collecting failed', { error: String(err) });
    console.error(`❌ Collecting failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(batchKeptMessage(inputPath));
    await saveMonitor(monitor, INTERACTIVE);
    return 1;
  }
  const templates = { html: [] as string[], markdown: [] as string[] };
  for (const batch of batches) {
    for (const ref of batch.jobs) templates[batch.format].push(workbook.rows[ref.index]?.prompt ?? '');
  }
  printSummary(summary, words, templates, total, outputPath, inputPath, Date.now() - started);
  await saveMonitor(monitor, INTERACTIVE);
  return summary.failed > 0 || summary.stopReason ? 1 : 0;
}

/** --status: every run still waiting, checked with the providers now, and the latest finished batches. */
async function showStatus(monitor: BatchMonitor): Promise<number> {
  const runs = pendingRuns(monitor.read().batches);
  if (runs.length === 0) console.log('No batch run is waiting to be collected.');
  else console.log(`Waiting to be collected (${runs.length}):`);
  for (const run of runs) {
    const check = run.outputExists ? (await checkRun(run)).text : `output file missing: ${run.outputPath}`;
    console.log(`  • ${basename(run.outputPath)}: ${describeRun(run)}, sent ${sentAtOf(run)} — ${check}`);
  }
  const runsSoFar = monitor.read().runs;
  const latest = runsSoFar.filter(run => run.status !== 'waiting').slice(-5).reverse();
  if (latest.length > 0) {
    console.log('');
    console.log('Latest finished runs:');
    for (const run of latest) {
      console.log(`  • ${basename(run.output)}: ${run.mode} run ${run.status}, ${run.written} written, ${run.failed} failed, ${money(run.cost)} (${run.finishedAt || run.startedAt})${run.note ? ` — ${run.note}` : ''}`);
    }
  }
  const spent = runsSoFar.reduce((sum, run) => sum + run.cost, 0);
  console.log('');
  console.log(`Spent so far: ${money(spent)} over ${runsSoFar.length} run(s).`);
  console.log(`Every run, batch and failure (with the provider's raw reply): ${monitor.path}`);
  return 0;
}

/**
 * Runs from earlier that are not collected yet: collects the ones that are ready, and those still being written
 * if `waitForRunning` says so. Returns how many runs had a problem.
 */
async function collectWaitingRuns(monitor: BatchMonitor, config: GenerateConfig, waitForRunning: (count: number) => Promise<boolean>): Promise<number> {
  const runs = pendingRuns(monitor.read().batches);
  if (runs.length === 0) return 0;
  console.log(`Batch run(s) from earlier, not collected yet:`);
  const checked = [];
  for (const run of runs) {
    const check = run.outputExists ? await checkRun(run) : { ready: false, text: `the output file is missing: ${run.outputPath}` };
    console.log(`  • ${basename(run.outputPath)}: ${describeRun(run)}, sent ${sentAtOf(run)} — ${check.text}`);
    checked.push({ run, ...check });
  }
  for (const { run } of checked.filter(c => !c.run.outputExists)) {
    console.log(`    Put "${basename(run.outputPath)}" back in ${dirname(run.outputPath)}, or drag it into the tool from where it is now, to collect its articles.`);
  }
  console.log('');

  let problems = checked.filter(c => !c.run.outputExists).length;
  for (const { run } of checked.filter(c => c.ready && c.run.outputExists)) {
    problems += await collectPendingBatch(run, run.state.input || run.outputPath, config, false, monitor);
    console.log('');
  }
  const running = checked.filter(c => !c.ready && c.run.outputExists);
  if (running.length > 0 && (await waitForRunning(running.length))) {
    for (const { run } of running) {
      problems += await collectPendingBatch(run, run.state.input || run.outputPath, config, false, monitor);
      console.log('');
    }
  }
  return problems;
}

async function main(): Promise<number> {
  loadKeys();
  let config: GenerateConfig;
  try {
    config = loadGenerateConfig();
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (hasFlag('--help') || hasFlag('-h')) {
    printUsage(config);
    return 0;
  }

  // Flags change config/generate.json's settings for this run only.
  for (const format of FORMATS) {
    const spec = getArgValue(`--${format}-model`);
    if (spec === undefined) continue;
    const route = parseModelSpec(spec);
    if (!route) {
      console.error(`❌ --${format}-model "${spec}": name a Claude, Gemini or OpenAI model, e.g. claude-sonnet-5-5 or gemini:gemini-2.5-flash.`);
      return 1;
    }
    config[format] = route;
  }
  const maxTokens = intArg('--max-tokens', 0, 1);
  const parallel = intArg('--parallel', config.parallel, 1);
  const retries = intArg('--retries', config.retries, 0);
  const limit = intArg('--limit', Number.POSITIVE_INFINITY, 1);
  for (const [flag, value] of [['--max-tokens', maxTokens], ['--parallel', parallel], ['--retries', retries], ['--limit', limit]] as const) {
    if (Number.isNaN(value)) {
      console.error(`❌ ${flag} needs a whole number.`);
      return 1;
    }
  }
  if (maxTokens > 0) FORMATS.forEach(format => (config[format].maxTokens = maxTokens));
  config.parallel = parallel;
  config.retries = retries;
  if (hasFlag('--batch') && hasFlag('--live')) {
    console.error('❌ Choose --batch or --live, not both.');
    return 1;
  }

  // Keys: asked for when missing (a package shipped without them), replaced with --keys.
  const routes = [config.html, config.markdown];
  const models: Partial<Record<ProviderName, string>> = {};
  for (const route of routes) models[route.provider] ??= route.model;
  if (hasFlag('--keys')) {
    if (!INTERACTIVE) {
      console.error(`❌ --keys asks for the keys in a terminal window. Or edit ${keysFilePath()} directly.`);
      return 1;
    }
    const providers = [...new Set<ProviderName>(['claude', 'gemini', ...routes.map(route => route.provider)])];
    console.log(`Enter the API keys. They are saved on this computer only, in ${keysFilePath()}`);
    console.log('');
    if (!(await setupKeys(providers, models, true))) return 1;
    console.log('Done. Double-click "Generate Articles" to write articles with these keys.');
    return 0;
  }
  if (INTERACTIVE && !hasFlag('--dry-run')) {
    const missing = [...new Set(routes.map(route => route.provider))].filter(provider => !currentKey(provider));
    if (missing.length > 0) {
      console.log('Before the first run, the tool needs these API keys. They are saved on this computer and asked for only once.');
      console.log('');
      if (!(await setupKeys(missing, models, false))) return 1;
    }
  }

  const monitor = new BatchMonitor();
  if (hasFlag('--status')) return showStatus(monitor);
  if (hasFlag('--collect')) {
    if (pendingRuns(monitor.read().batches).length === 0) {
      console.log('Nothing is waiting to be collected.');
      return 0;
    }
    return (await collectWaitingRuns(monitor, config, async () => true)) > 0 ? 1 : 0;
  }

  const forcedFormat = getArgValue('--format')?.trim().toLowerCase() as OutputFormat | undefined;
  if (forcedFormat !== undefined && !FORMATS.includes(forcedFormat)) {
    console.error('❌ --format must be html or markdown.');
    return 1;
  }
  const vars: Record<string, string> = {};
  for (const pair of getArgValues('--var')) {
    const eq = pair.indexOf('=');
    const key = eq > 0 ? columnKey(pair.slice(0, eq)) : '';
    if (!key) {
      console.error(`❌ --var needs name=value, e.g. --var base_year=2025 (got "${pair}").`);
      return 1;
    }
    vars[key] = pair.slice(eq + 1).trim();
  }

  const interactive = INTERACTIVE;
  const dryRun = hasFlag('--dry-run');
  let file = getArgValue('--file');
  if (!file && interactive) {
    // After a sleep, a closed window or a restart: first check the batch runs not collected yet.
    const hadRuns = pendingRuns(monitor.read().batches).length > 0;
    await collectWaitingRuns(monitor, config, async count => {
      const answer = await ask(`Wait here for the ${count === 1 ? 'run' : `${count} runs`} still being written? Press Enter to wait, or type N and press Enter to skip: `);
      console.log('');
      return answer !== null && answer.trim().toLowerCase() !== 'n';
    });
    if (hadRuns) {
      const next = await ask('Press Enter to choose an Excel file for a new run, or close this window: ');
      console.log('');
      if (next === null) return 0;
    }
    file = await pickInputFile();
    console.log('');
    if (!file) {
      console.log('No file chosen, so nothing was started.');
      return 0;
    }
  }
  if (!file) {
    console.error('❌ Choose the Excel file with --file "<input.xlsx>".');
    const waiting = pendingRuns(monitor.read().batches).length;
    if (waiting > 0) console.error(`   ${waiting} batch run(s) are waiting to be collected: run with --collect, or --status to see them.`);
    printUsage(config);
    return 1;
  }

  const inputPath = resolve(file);
  let workbook: GenerateWorkbook;
  try {
    workbook = loadGenerateWorkbook(inputPath);
  } catch (err) {
    console.error(`❌ Cannot read the workbook "${file}": ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // Articles an earlier run put in a batch queue are collected first, so running again never pays twice.
  const pending = findPendingRun(inputPath, monitor.read().batches);
  const elsewhere = pendingRuns(monitor.read().batches).filter(run => !(pending?.kind === 'pending' && run.statePath === pending.run.statePath)).length;
  if (elsewhere > 0) {
    console.log(`Note: ${elsewhere} other batch run(s) are waiting to be collected; open the tool without a file, or use --status, to see them.`);
    console.log('');
  }
  if (pending?.kind === 'pending') return collectPendingBatch(pending.run, inputPath, config, dryRun, monitor);
  if (pending?.kind === 'output missing') {
    const sent = new Date(Math.min(...pending.state.batches.map(batch => Date.parse(batch.submittedAt)))).toLocaleString();
    console.error(`❌ Articles from this file were sent to the batch queue on ${sent} and are not collected yet,`);
    console.error(`   but their output file is not where it was: ${pending.expectedOutput}`);
    console.error('   Put that file back, or drag it into the tool from where it is now, to collect them.');
    console.error('   Starting over would send (and charge for) the same articles again. To do that anyway, delete:');
    console.error(`   ${pending.statePath}`);
    return 1;
  }

  // Fill every pending row's placeholders now, so problems surface before anything is sent to a model.
  let prepared = prepareJobs(workbook, vars, forcedFormat);
  let choices: RunChoices = { forcedFormat, limit };
  if (interactive && !hasFlag('--yes') && prepared.problems.length === 0 && prepared.jobs.length > 0) {
    const answered = await askRunChoices(prepared, config, vars, choices, maxTokens);
    if (answered === null) {
      console.log('\nCancelled. Nothing was sent.');
      return 1;
    }
    choices = answered;
    prepared = prepareJobs(workbook, vars, choices.forcedFormat);
    // A model chosen above may need a key not entered yet.
    const needed = [...new Set([config.html, config.markdown].map(route => route.provider))].filter(provider => !currentKey(provider));
    const models: Partial<Record<ProviderName, string>> = { [config.html.provider]: config.html.model, [config.markdown.provider]: config.markdown.model };
    if (needed.length > 0 && !dryRun && !(await setupKeys(needed, models, false))) return 1;
  }
  const { problems, unfilled } = prepared;
  const jobs: ArticleJob[] = prepared.jobs.map(({ prompt, ...job }) => {
    job.row.prompt = prompt;
    return job;
  });

  const batch = jobs.slice(0, choices.limit);
  const formatsUsed = FORMATS.filter(format => batch.some(job => job.format === format));
  const outputPath = workbook.isOutput ? inputPath : defaultOutputPath(inputPath, new Date());

  // Runs of batchMinArticles or more go to the half-price batch queue; OpenAI has no batch support here.
  const batchable = formatsUsed.every(format => config[format].provider !== 'openai');
  if (hasFlag('--batch') && !batchable) {
    console.error('❌ The batch queue works with Claude and Gemini models only; run with --live for OpenAI.');
    return 1;
  }
  const useBatch = batchable && (choices.mode ? choices.mode === 'batch' : !hasFlag('--live') && (hasFlag('--batch') || batch.length >= config.batchMinArticles));

  let estimate = 0;
  const unpricedModels = new Set<string>();
  for (const job of batch) {
    const route = config[job.format];
    const cost = estimateCost(config, route.model, finalPrompt(job.row.prompt, route.provider, job.format).length);
    if (cost === null) unpricedModels.add(route.model);
    else estimate += cost * (useBatch ? BATCH_PRICE_FACTOR : 1);
  }

  console.log(`Workbook:   ${basename(inputPath)} (${workbook.rows.length} rows, ${workbook.pendingRows.length} still need an article)`);
  if (batch.length > 0) {
    const plan = formatsUsed.map(format => `${batch.filter(job => job.format === format).length} ${FORMAT_LABELS[format]} → ${config[format].model}`);
    console.log(`Articles:   ${plan.join(' · ')}`);
    console.log(
      useBatch
        ? `Mode:       batch queue: half price; results usually within an hour (Claude) or a few hours (Gemini)`
        : `Mode:       live: each article is written now${batchable ? ` (runs of ${config.batchMinArticles}+ articles use the half-price batch queue)` : ''}`
    );
    const unknown = unpricedModels.size > 0 ? `; no price in config/generate.json for ${[...unpricedModels].join(', ')}` : '';
    console.log(`Estimate:   about ${money(estimate)}${unknown}`);
    console.log(`Output:     ${outputPath}${workbook.isOutput ? ' (continuing this file)' : ''}`);
  }
  console.log('');

  if (problems.length > 0) {
    console.error('❌ Fix these rows first; nothing was sent to a model:');
    problems.forEach(problem => console.error(`   ${problem}`));
    return 1;
  }
  if (batch.length === 0) {
    console.log('Nothing to generate: every row already has an article. Clear the Generated Content cells you want written again.');
    return 0;
  }
  if (unfilled.size > 0) {
    console.log('⚠️  No value for these template placeholders (the model is told never to print them):');
    for (const [name, rows] of unfilled) console.log(`   ${name} in ${rows} row(s)`);
    console.log('   To use real figures, add a column with that name, or pass --var name=value for every row.');
    console.log('');
  }

  if (dryRun) {
    for (const format of formatsUsed) {
      const first = batch.find(job => job.format === format) as ArticleJob;
      console.log(`──────── ${FORMAT_LABELS[format]} prompt for row ${first.row.rowIndex}, exactly as it would be sent to ${config[format].model} ────────`);
      console.log(finalPrompt(first.row.prompt, config[format].provider, format));
      console.log('');
    }
    console.log('Dry run: nothing was sent and no file was written.');
    return 0;
  }

  const missingKeys = [...new Set(formatsUsed.map(format => missingApiKey(config[format].provider)).filter(Boolean))];
  if (missingKeys.length > 0) {
    console.error(`❌ ${missingKeys.join(' and ')} ${missingKeys.length > 1 ? 'are' : 'is'} not set. Add ${missingKeys.length > 1 ? 'them' : 'it'} with --keys`);
    console.error('   (or double-click "Change API Keys" in the tool folder), then try again.');
    return 1;
  }

  if (interactive && !hasFlag('--yes')) {
    const go = await ask('Press Enter to start, or Ctrl+C to cancel: ');
    if (go === null) {
      console.log('\nCancelled. Nothing was sent.');
      return 1;
    }
    console.log('');
  }

  // Fail now, not after paying for an article, if results could not be saved (e.g. open in Excel).
  try {
    workbook.writeTo(outputPath);
  } catch (err) {
    console.error(`❌ Cannot write the output workbook "${outputPath}": ${String(err)}`);
    console.error('   Close it in Excel if it is open, then retry.');
    return 1;
  }

  keepAwake();
  const logger = createLogger();
  logger.info('Generate CLI → starting', { file: inputPath, output: outputPath, articles: batch.length, mode: useBatch ? 'batch' : 'live', html: config.html, markdown: config.markdown });
  interruptMessage = `Stopped. Articles finished so far are saved in "${outputPath}"; run again on that file to continue.`;
  onInterrupt();

  // Every run gets a line in Batch Monitor.xlsx with its cost: a live run's when it ends, a batch run's as its batches do.
  const runId = newRunId();
  monitor.runStarted({ runId, mode: useBatch ? 'batch' : 'live', input: inputPath, output: outputPath, articles: batch.length });
  let liveRunner: GenerateRunner | undefined;
  const recordLiveRun = (status?: RunStatus) => {
    if (!liveRunner) return;
    const s = liveRunner.summary;
    monitor.runFinished(runId, { status: status ?? (s.generated === 0 ? 'failed' : s.stopReason ? 'stopped' : 'done'), written: s.generated, failed: s.failed, cost: s.cost, note: s.stopReason ?? undefined });
  };
  beforeExit = () => {
    recordLiveRun('stopped');
    monitor.keepUnsaved();
  };

  const started = Date.now();
  const words: Record<OutputFormat, number[]> = { html: [], markdown: [] };
  let summary: GenerateRunSummary;
  try {
    if (useBatch) {
      const runner = new BatchRunner({ workbook, outputPath, input: inputPath, runId, config, logger, monitor, onProgress: progressPrinter(batch.length, words), onBatch: batchPrinter() });
      console.log(`Sending ${batch.length} article(s) to the batch queue:`);
      interruptMessage = batchInterruptMessage(inputPath, formatsUsed.map(format => config[format].provider));
      const state = await runner.submit(batch);
      if (state.batches.length > 0) console.log('Waiting for the results. You can close this window: open the tool again later to collect them.');
      summary = await runner.collect(state);
    } else {
      const generators: Partial<Record<OutputFormat, ContentGenerator>> = {};
      for (const format of formatsUsed) generators[format] = createGenerator(config[format]);
      console.log(`Writing ${batch.length} article(s), ${Math.min(config.parallel, batch.length)} at a time:`);
      liveRunner = new GenerateRunner({ workbook, jobs: batch, generators, config, retryWaitMs: RETRY_WAIT_MS, logger, onProgress: progressPrinter(batch.length, words) });
      summary = await liveRunner.run();
      recordLiveRun();
    }
  } catch (err) {
    logger.error('Generate CLI → run failed', { error: String(err) });
    console.error(`❌ Run failed: ${err instanceof Error ? err.message : String(err)}`);
    if (looksLikeKeyProblem(String(err))) console.error(`   ${KEY_HINT}`);
    console.error(useBatch ? batchKeptMessage(inputPath) : `   Articles finished before this point are saved in "${outputPath}".`);
    recordLiveRun('stopped');
    await saveMonitor(monitor, interactive);
    return 1;
  }
  beforeExit = () => monitor.keepUnsaved();

  // A run that wrote no article leaves no empty output file behind; the next run starts from the input again.
  const keepOutput = summary.generated > 0 || workbook.isOutput;
  if (!keepOutput) {
    try {
      unlinkSync(outputPath);
    } catch {
      // already gone
    }
  }

  const templates = { html: [] as string[], markdown: [] as string[] };
  batch.forEach(job => templates[job.format].push(job.row.prompt));
  printSummary(summary, words, templates, batch.length, keepOutput ? outputPath : null, inputPath, Date.now() - started);
  await saveMonitor(monitor, interactive);
  return summary.failed > 0 || summary.stopReason ? 1 : 0;
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(err => {
    // eslint-disable-next-line no-console
    console.error('❌ Fatal:', err);
    process.exitCode = 1;
  });
