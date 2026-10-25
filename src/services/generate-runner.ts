import { Logger } from '../engine/logger';
import { callCost, GenerateConfig, Usage } from './generate-config';
import { GenerateRow, GenerateWorkbook } from './generate-excel';
import { cleanGeneratedContent, finalPrompt, OutputFormat, reviewArticle, wordCount } from './generate-prompt';
import { ContentGenerator, GenerationError } from './generate-providers';

/** Excel cannot hold more characters than this in one cell. */
const EXCEL_CELL_LIMIT = 32767;

/** Articles in a row that fail even after their retries before the run stops: by then the rows are not the problem. */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface ArticleJob {
  /** Its prompt already filled (buildPrompt). */
  row: GenerateRow;
  format: OutputFormat;
  /** Links the template placed in the article; each should appear in it exactly once. */
  placedLinks: string[];
}

export type ProgressEvent =
  | { type: 'saved'; job: ArticleJob; words: number; cost: number | null; issues: string[] }
  | { type: 'failed'; job: ArticleJob; message: string }
  | { type: 'retrying'; job: ArticleJob; message: string; attempt: number; attempts: number; waitMs: number };

export interface GenerateRunSummary {
  generated: number;
  failed: number;
  /** Saved articles with something to check before publishing (reviewArticle). */
  needsReview: number;
  /** US$ for every billed call, failed attempts included. Calls to models without a price are only counted. */
  cost: number;
  unpricedCalls: number;
  /** Why the run ended before its last article, if it did. */
  stopReason: string | null;
}

/** The article in a model's reply, or the GenerationError that rejects the reply. */
export function articleFrom(reply: string, format: OutputFormat): string {
  const content = cleanGeneratedContent(reply, format);
  if (content.length === 0) throw new GenerationError('the model returned no text', 'retry');
  if (content.length > EXCEL_CELL_LIMIT) {
    throw new GenerationError(`the article has ${content.length} characters, more than an Excel cell holds (${EXCEL_CELL_LIMIT})`, 'skip');
  }
  return content;
}

/** Records finished and failed articles in the workbook, the summary, the log and the progress callback. */
export class RunRecorder {
  readonly summary: GenerateRunSummary = { generated: 0, failed: 0, needsReview: 0, cost: 0, unpricedCalls: 0, stopReason: null };

  constructor(
    private workbook: GenerateWorkbook,
    private config: GenerateConfig,
    private logger: Logger,
    private onProgress?: (event: ProgressEvent) => void
  ) {}

  /** Adds a call's cost to the run; `priceFactor` is 0.5 for batch calls. Returns the cost, or null without a price. */
  bill(model: string, usage: Usage, priceFactor = 1): number | null {
    const cost = callCost(this.config, model, usage);
    if (cost === null) {
      this.summary.unpricedCalls++;
      return null;
    }
    this.summary.cost += cost * priceFactor;
    return cost * priceFactor;
  }

  /** Writes the article into its row and saves the workbook. */
  saved(job: ArticleJob, content: string, cost: number | null): void {
    const { rowIndex, title } = job.row;
    this.workbook.markGenerated(job.row, content);
    this.summary.generated++;
    const words = wordCount(content);
    const issues = reviewArticle(content, job.format, job.placedLinks);
    if (issues.length > 0) this.summary.needsReview++;
    this.logger.info(`Generate → row ${rowIndex} saved`, { rowIndex, title, format: job.format, words, cost, issues });
    this.onProgress?.({ type: 'saved', job, words, cost, issues });
  }

  failed(job: ArticleJob, message: string): void {
    const { rowIndex, title } = job.row;
    this.summary.failed++;
    this.logger.error(`Generate → row ${rowIndex} failed: ${message}`, { rowIndex, title });
    this.onProgress?.({ type: 'failed', job, message });
  }

  retrying(job: ArticleJob, message: string, attempt: number, attempts: number, waitMs: number): void {
    this.logger.warn(`Generate → row ${job.row.rowIndex}: ${message}; retrying (attempt ${attempt} of ${attempts})`);
    this.onProgress?.({ type: 'retrying', job, message, attempt, attempts, waitMs });
  }
}

export interface GenerateRunnerOptions {
  workbook: GenerateWorkbook;
  jobs: ArticleJob[];
  /** The model client for each format the jobs use. */
  generators: Partial<Record<OutputFormat, ContentGenerator>>;
  /** Prices, `parallel` (articles written at once) and `retries` (extra attempts after a failure that can pass). */
  config: GenerateConfig;
  retryWaitMs: number;
  logger: Logger;
  onProgress?: (event: ProgressEvent) => void;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Writes the jobs' articles live, `config.parallel` at a time, saving each one as soon as it is ready. An article
 * that keeps failing is left empty for a later run; a failure that would hit every article (wrong key, unknown
 * model) stops the run: articles already being written finish, no new ones start.
 */
export class GenerateRunner {
  private wait: (ms: number) => Promise<void>;
  private record: RunRecorder;
  private consecutiveFailures = 0;

  constructor(private options: GenerateRunnerOptions) {
    this.wait = options.wait ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
    this.record = new RunRecorder(options.workbook, options.config, options.logger, options.onProgress);
  }

  /** The run so far: what an interrupted run gets recorded with. */
  get summary(): GenerateRunSummary {
    return this.record.summary;
  }

  async run(): Promise<GenerateRunSummary> {
    const { jobs, config, logger } = this.options;
    const summary = this.record.summary;
    const queue = [...jobs];
    logger.info('Generate → run plan', { articles: jobs.length, parallel: config.parallel, retries: config.retries });

    const worker = async () => {
      while (!summary.stopReason) {
        const job = queue.shift();
        if (!job) return;
        await this.process(job);
      }
    };
    await Promise.all(Array.from({ length: Math.min(config.parallel, jobs.length) }, worker));

    logger.info('Generate → run finished', { ...summary });
    return summary;
  }

  private async process(job: ArticleJob): Promise<void> {
    const summary = this.record.summary;
    const result = await this.generate(job);

    if (result instanceof GenerationError) {
      if (result.action === 'stop') {
        // Says nothing about this row: it stays empty for the next run.
        summary.stopReason ??= result.message;
        this.options.logger.error('Generate → stopping the run', { rowIndex: job.row.rowIndex, error: result.message });
        return;
      }
      this.record.failed(job, result.message);
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        summary.stopReason ??= `${this.consecutiveFailures} articles in a row failed (last: ${result.message})`;
      }
      return;
    }

    this.consecutiveFailures = 0;
    this.record.saved(job, result.content, result.cost);
  }

  /** The cleaned article and the cost of the call that wrote it, or the error that ended this row's attempts. */
  private async generate(job: ArticleJob): Promise<{ content: string; cost: number | null } | GenerationError> {
    const { generators, config, retryWaitMs } = this.options;
    const generator = generators[job.format];
    if (!generator) return new GenerationError(`no model is set up for ${job.format} articles`, 'stop');
    const prompt = finalPrompt(job.row.prompt, generator.route.provider, job.format);
    const attempts = config.retries + 1;

    for (let attempt = 1; ; attempt++) {
      let error: GenerationError;
      try {
        const { text, usage } = await generator.generate(prompt);
        const cost = this.record.bill(generator.route.model, usage);
        return { content: articleFrom(text, job.format), cost };
      } catch (err) {
        error = err instanceof GenerationError ? err : new GenerationError(String(err), 'retry');
        if (error.usage) this.record.bill(generator.route.model, error.usage);
      }

      if (error.action !== 'retry' || attempt >= attempts) return error;
      this.record.retrying(job, error.message, attempt + 1, attempts, retryWaitMs);
      await this.wait(retryWaitMs);
    }
  }
}
