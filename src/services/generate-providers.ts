import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ApiError, FinishReason, GenerateContentResponse, GoogleGenAI } from '@google/genai';
import { ModelRoute, Usage } from './generate-config';
import { ProviderName } from './generate-prompt';

/**
 * What a failed call means for the run: try the row again after a pause, give up on this row only,
 * or stop, because every row would fail the same way (wrong API key, unknown model, no credit).
 */
export type FailureAction = 'retry' | 'skip' | 'stop';

export class GenerationError extends Error {
  /**
   * `usage` is what the failed call was still billed for (an article cut off at the token limit). `detail` is
   * the provider's raw reply or error body, kept for debugging in the batch monitor.
   */
  constructor(message: string, readonly action: FailureAction, readonly usage?: Usage, readonly detail?: string) {
    super(message);
    this.name = 'GenerationError';
  }
}

export interface Generation {
  text: string;
  usage: Usage;
}

export interface ContentGenerator {
  readonly route: ModelRoute;
  /** The model's reply to one prompt. Failures are thrown as GenerationError. */
  generate(prompt: string): Promise<Generation>;
}

/** The environment variable a provider's API key is missing from, or null when it is set. */
export function missingApiKey(provider: ProviderName): string | null {
  if (provider === 'openai') return process.env.OPENAI_API_KEY ? null : 'OPENAI_API_KEY';
  if (provider === 'gemini') return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? null : 'GEMINI_API_KEY';
  // The Anthropic SDK also signs in with `ant auth login` profiles, so an unset ANTHROPIC_API_KEY proves nothing.
  return null;
}

/**
 * HTTP status -> next step. Rate limits, overload and server errors pass with time; other 4xx answers
 * (wrong key, unknown model, bad request) would come back for every row. No status: there was no answer.
 */
export function actionForStatus(status: number | undefined): FailureAction {
  if (status === undefined || status === 408 || status === 409 || status === 429 || status >= 500) return 'retry';
  if (status === 413) return 'skip';
  return 'stop';
}

export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

export function apiError(provider: string, status: number | undefined, err: unknown, action = actionForStatus(status)): GenerationError {
  // The SDKs keep the parsed error body on .error (Anthropic, OpenAI); Gemini puts it in the message.
  const body = (err as { error?: unknown } | null)?.error;
  const detail = JSON.stringify({ status, message: err instanceof Error ? err.message : String(err), body });
  return new GenerationError(`${provider} API error: ${errorText(err)}`, action, undefined, detail);
}

function cutOff(maxTokens: number, usage: Usage): GenerationError {
  return new GenerationError(`the article was cut off at the ${maxTokens}-token limit; raise --max-tokens`, 'skip', usage);
}

/**
 * Errors from a plain (not streamed) Claude request. Without an HTTP status, the SDK's own errors (a lost
 * connection) pass with time, while a plain Error is a setup problem, such as no credentials being found.
 */
export function claudeRequestError(err: unknown): GenerationError {
  if (err instanceof GenerationError) return err;
  if (err instanceof Anthropic.APIError) return apiError('Claude', err.status, err);
  return new GenerationError(`Claude: ${errorText(err)}`, err instanceof Anthropic.AnthropicError ? 'retry' : 'stop');
}

export function geminiRequestError(err: unknown): GenerationError {
  if (err instanceof GenerationError) return err;
  if (err instanceof ApiError) return apiError('Gemini', err.status, err);
  // No HTTP answer at all (the connection failed): worth another try.
  return new GenerationError(`Gemini: ${errorText(err)}`, 'retry');
}

/** A finished Claude reply as an article, or the GenerationError it amounts to. Live and batch replies alike. */
export function claudeGeneration(message: Anthropic.Message, maxTokens: number): Generation {
  // output_tokens includes the model's thinking.
  const usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
  if (message.stop_reason === 'max_tokens') throw cutOff(maxTokens, usage);
  if (message.stop_reason === 'refusal') throw new GenerationError('Claude declined to write this article', 'skip', usage);
  return { text: message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join(''), usage };
}

/** A finished Gemini reply as an article, or the GenerationError it amounts to. Live and batch replies alike. */
export function geminiGeneration(response: GenerateContentResponse, maxTokens: number): Generation {
  const meta = response.usageMetadata;
  const usage = {
    inputTokens: meta?.promptTokenCount ?? 0,
    // Thinking tokens are billed as output.
    outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
  };
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) throw new GenerationError(`Gemini blocked the prompt (${blocked})`, 'skip', usage);
  const candidate = response.candidates?.[0];
  if (candidate?.finishReason === FinishReason.MAX_TOKENS) throw cutOff(maxTokens, usage);
  if (candidate?.finishReason && candidate.finishReason !== FinishReason.STOP) {
    throw new GenerationError(`Gemini stopped the article early (${candidate.finishReason})`, 'retry', usage);
  }
  // Read the parts directly: batch replies arrive as plain JSON, without the SDK's .text getter. Thoughts are skipped.
  const parts = candidate?.content?.parts ?? [];
  return { text: parts.flatMap(part => (typeof part.text === 'string' && !part.thought ? [part.text] : [])).join(''), usage };
}

class OpenAIGenerator implements ContentGenerator {
  private client = new OpenAI();

  constructor(readonly route: ModelRoute) {}

  async generate(prompt: string): Promise<Generation> {
    const { model, maxTokens } = this.route;
    const response = await this.client.responses
      .create({ model, input: prompt, max_output_tokens: maxTokens, store: false })
      .catch((err: unknown) => {
        if (err instanceof OpenAI.APIError) {
          // A 429 is usually a rate limit worth waiting out, but not when the account has run out of credit.
          throw apiError('OpenAI', err.status, err, err.code === 'insufficient_quota' ? 'stop' : undefined);
        }
        // The SDK's own errors pass with time; any other error is a setup problem.
        throw new GenerationError(`OpenAI: ${errorText(err)}`, err instanceof OpenAI.OpenAIError ? 'retry' : 'stop');
      });

    const usage = { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 };
    if (response.status === 'incomplete') {
      const reason = response.incomplete_details?.reason;
      if (reason === 'max_output_tokens') throw cutOff(maxTokens, usage);
      throw new GenerationError(`OpenAI stopped the article early (${reason ?? 'no reason given'})`, reason === 'content_filter' ? 'skip' : 'retry', usage);
    }
    return { text: response.output_text, usage };
  }
}

class GeminiGenerator implements ContentGenerator {
  private client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });

  constructor(readonly route: ModelRoute) {}

  async generate(prompt: string): Promise<Generation> {
    const { model, maxTokens } = this.route;
    const response = await this.client.models
      // temperature 0.5 as in the workflow's "Gemini - Generate Content1" node
      .generateContent({ model, contents: prompt, config: { temperature: 0.5, maxOutputTokens: maxTokens } })
      .catch((err: unknown) => {
        throw geminiRequestError(err);
      });
    return geminiGeneration(response, maxTokens);
  }
}

class ClaudeGenerator implements ContentGenerator {
  private client = new Anthropic();
  private access: Promise<void> | null = null;

  constructor(readonly route: ModelRoute) {}

  async generate(prompt: string): Promise<Generation> {
    // Checked once per run; articles running in parallel wait on the same check.
    await (this.access ??= this.checkAccess());

    const { model, maxTokens } = this.route;
    // Streamed so a long article cannot run into an HTTP timeout; finalMessage() collects the whole reply.
    const message = await this.client.messages
      .stream({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
      .finalMessage()
      .catch((err: unknown) => {
        if (err instanceof Anthropic.APIError) throw apiError('Claude', err.status, err);
        // Anything else broke the stream itself (checkAccess has ruled out a missing key): worth another try.
        throw new GenerationError(`Claude: ${errorText(err)}`, 'retry');
      });
    return claudeGeneration(message, maxTokens);
  }

  /**
   * One plain request before the first article. A stream reports every error as an AnthropicError, so a
   * missing API key would look like a dropped connection and be retried; here it arrives as a plain Error.
   * An unknown model id is caught here too.
   */
  private async checkAccess(): Promise<void> {
    try {
      await this.client.models.retrieve(this.route.model);
    } catch (err) {
      const error = claudeRequestError(err);
      // A rate limit or an outage says nothing about the key; the article request retries those.
      if (error.action === 'stop') throw error;
    }
  }
}

export function createGenerator(route: ModelRoute): ContentGenerator {
  if (route.provider === 'openai') return new OpenAIGenerator(route);
  if (route.provider === 'gemini') return new GeminiGenerator(route);
  return new ClaudeGenerator(route);
}
