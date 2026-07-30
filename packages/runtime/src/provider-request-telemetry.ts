import {
  capturePreparedProviderRequest,
  type PreparedProviderRequestCapture,
  type PreparedRequestSegment,
} from './request-shape.js';
import { rawFinishReasonString } from './model-protocol.js';

export type ProviderRequestCacheValueSource = 'provider' | 'derived';

export interface ProviderRequestUsage {
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheReadInputSource?: ProviderRequestCacheValueSource;
  cacheMissInputTokens?: number;
  cacheMissInputSource?: ProviderRequestCacheValueSource;
  cacheWriteInputTokens?: number;
  cacheWriteInputSource?: ProviderRequestCacheValueSource;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface ProviderRequestUsageLike {
  inputTokens?:
    | number
    | { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: number | { total?: number; text?: number; reasoning?: number };
  raw?: Record<string, unknown>;
}

export type ProviderRequestAttemptStatus = 'completed' | 'failed' | 'interrupted' | 'aborted';

export interface ProviderRequestCaptureRecord extends PreparedProviderRequestCapture {
  traceId: string;
  captureId: string;
  turnId: string;
  step: number;
  providerId: string;
  modelId: string;
}

export interface ProviderRequestCaptureRef {
  captureId: string;
  artifactId: string;
}

export type ProviderRequestCaptureLedgerRecord = Omit<
  ProviderRequestCaptureRecord,
  'serializedRequest'
> & {
  artifactId: string;
};

export interface ProviderRequestAttemptRecord extends ProviderRequestUsage {
  traceId: string;
  attemptId: string;
  turnId: string;
  step: number;
  attempt: number;
  captureId: string;
  captureArtifactId: string;
  providerId: string;
  modelId: string;
  contextWindow?: number;
  requestHash: string;
  requestBytes: number;
  segments: PreparedRequestSegment[];
  startedAt: number;
  completedAt: number;
  status: ProviderRequestAttemptStatus;
  finishReason?: string;
  latencyMs: number;
  timeToFirstTokenMs?: number;
}

export interface ProviderRequestTrackerInput {
  traceId: string;
  turnId: string;
  contextWindow?: number;
  now: () => number;
  newId: () => string;
  persistCapture: (
    capture: ProviderRequestCaptureRecord,
  ) => Promise<Pick<ProviderRequestCaptureRef, 'artifactId'>>;
  recordAttempt: (attempt: ProviderRequestAttemptRecord) => void | Promise<void>;
}

export interface ProviderRequestCaptureRecorderInput {
  persistArtifact: (
    capture: ProviderRequestCaptureRecord,
  ) => Promise<Pick<ProviderRequestCaptureRef, 'artifactId'>>;
  recordLedger: (capture: ProviderRequestCaptureLedgerRecord) => Promise<void>;
}

export interface TrackProviderStreamInput {
  providerId: string;
  modelId: string;
  params: Record<string, unknown>;
  abortSignal?: AbortSignal;
  doStream: () => PromiseLike<ProviderStreamResult>;
}

export interface TrackProviderGenerateInput {
  providerId: string;
  modelId: string;
  params: Record<string, unknown>;
  abortSignal?: AbortSignal;
  doGenerate: () => PromiseLike<ProviderGenerateResult>;
}

export function createProviderRequestCaptureRecorder(
  input: ProviderRequestCaptureRecorderInput,
): (
  capture: ProviderRequestCaptureRecord,
) => Promise<Pick<ProviderRequestCaptureRef, 'artifactId'>> {
  return async (capture) => {
    const artifact = await input.persistArtifact(capture);
    const { serializedRequest: _serializedRequest, ...metadata } = capture;
    await input.recordLedger({ ...metadata, artifactId: artifact.artifactId });
    return artifact;
  };
}

export interface ProviderStreamResult {
  stream: ReadableStream<unknown>;
  request?: unknown;
  response?: unknown;
}

export interface ProviderGenerateResult {
  finishReason?: unknown;
  usage?: ProviderRequestUsageLike;
  request?: unknown;
  response?: unknown;
  [key: string]: unknown;
}

interface StoredCapture {
  capture: ProviderRequestCaptureRecord;
  ref: ProviderRequestCaptureRef;
}

export class ProviderRequestTracker {
  private step = 0;
  private readonly attemptsByStep = new Map<number, number>();
  private readonly captures = new Map<string, Promise<StoredCapture>>();

  constructor(private readonly input: ProviderRequestTrackerInput) {}

  get traceId(): string {
    return this.input.traceId;
  }

  setStep(step: number): void {
    this.step = step;
  }

  async trackStream(input: TrackProviderStreamInput): Promise<ProviderStreamResult> {
    throwIfAbortedBeforeDispatch(input.abortSignal);
    const step = this.step;
    const capture = await this.capture(step, input);
    throwIfAbortedBeforeDispatch(input.abortSignal);
    let sawOutput = false;
    const attempt = this.beginAttempt(step, capture, input);

    let result: ProviderStreamResult;
    try {
      result = await input.doStream();
    } catch (error) {
      await attempt.finalize(abortStatus(input.abortSignal, error));
      throw error;
    }

    const reader = result.stream.getReader();
    const stream = new ReadableStream<unknown>({
      pull: async (controller) => {
        try {
          const next = await reader.read();
          if (next.done) {
            await attempt.finalize(input.abortSignal?.aborted ? 'aborted' : 'interrupted');
            controller.close();
            return;
          }
          const part = asRecord(next.value);
          if (part && isOutputPart(part.type)) {
            sawOutput = true;
            attempt.observeOutput();
          }
          if (part?.type === 'finish') {
            await attempt.finalize(input.abortSignal?.aborted ? 'aborted' : 'completed', {
              reason: rawFinishReasonString(part.finishReason),
              usage: asUsage(part.usage),
            });
          } else if (part?.type === 'error') {
            await attempt.finalize(
              input.abortSignal?.aborted ? 'aborted' : sawOutput ? 'interrupted' : 'failed',
            );
          }
          controller.enqueue(next.value);
        } catch (error) {
          await attempt.finalize(
            input.abortSignal?.aborted
              ? 'aborted'
              : sawOutput
                ? 'interrupted'
                : abortStatus(input.abortSignal, error),
          );
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        try {
          await reader.cancel(reason);
        } finally {
          await attempt.finalize(input.abortSignal?.aborted ? 'aborted' : 'interrupted');
        }
      },
    });
    return { ...result, stream };
  }

  async trackGenerate(input: TrackProviderGenerateInput): Promise<ProviderGenerateResult> {
    throwIfAbortedBeforeDispatch(input.abortSignal);
    const step = this.step;
    const capture = await this.capture(step, input);
    throwIfAbortedBeforeDispatch(input.abortSignal);
    const attempt = this.beginAttempt(step, capture, input);
    try {
      const result = await input.doGenerate();
      await attempt.finalize(input.abortSignal?.aborted ? 'aborted' : 'completed', {
        reason: rawFinishReasonString(result.finishReason),
        usage: result.usage,
      });
      return result;
    } catch (error) {
      await attempt.finalize(abortStatus(input.abortSignal, error));
      throw error;
    }
  }

  private beginAttempt(
    step: number,
    capture: StoredCapture,
    input: Pick<
      TrackProviderStreamInput | TrackProviderGenerateInput,
      'providerId' | 'modelId' | 'abortSignal'
    >,
  ): {
    observeOutput(): void;
    finalize(
      status: ProviderRequestAttemptStatus,
      finish?: { reason?: string; usage?: ProviderRequestUsageLike },
    ): Promise<void>;
  } {
    const attempt = (this.attemptsByStep.get(step) ?? 0) + 1;
    this.attemptsByStep.set(step, attempt);
    const attemptId = this.input.newId();
    const startedAt = this.input.now();
    let timeToFirstTokenMs: number | undefined;
    let finished = false;
    let abortListener: (() => void) | undefined;
    const finalize = async (
      status: ProviderRequestAttemptStatus,
      finish?: { reason?: string; usage?: ProviderRequestUsageLike },
    ): Promise<void> => {
      if (finished) return;
      finished = true;
      if (abortListener) input.abortSignal?.removeEventListener('abort', abortListener);
      const completedAt = this.input.now();
      const usage = strictProviderRequestUsage(finish?.usage);
      const contextWindow = positiveInteger(this.input.contextWindow);
      const record: ProviderRequestAttemptRecord = {
        traceId: this.input.traceId,
        attemptId,
        turnId: this.input.turnId,
        step,
        attempt,
        captureId: capture.ref.captureId,
        captureArtifactId: capture.ref.artifactId,
        providerId: input.providerId,
        modelId: input.modelId,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        requestHash: capture.capture.requestHash,
        requestBytes: capture.capture.requestBytes,
        segments: capture.capture.segments,
        startedAt,
        completedAt,
        status,
        ...(finish?.reason !== undefined ? { finishReason: finish.reason } : {}),
        latencyMs: Math.max(0, completedAt - startedAt),
        ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
        ...(usage ?? {}),
      };
      try {
        await this.input.recordAttempt(record);
      } catch {
        // Attempt telemetry is diagnostic. The provider outcome remains authoritative.
      }
    };
    const observeOutput = () => {
      if (timeToFirstTokenMs === undefined) {
        timeToFirstTokenMs = Math.max(0, this.input.now() - startedAt);
      }
    };
    if (input.abortSignal) {
      abortListener = () => {
        void finalize('aborted');
      };
      if (input.abortSignal.aborted) void finalize('aborted');
      else input.abortSignal.addEventListener('abort', abortListener, { once: true });
    }
    return { observeOutput, finalize };
  }

  private async capture(
    step: number,
    input: TrackProviderStreamInput | TrackProviderGenerateInput,
  ): Promise<StoredCapture> {
    const prepared = preparedCapture(input.providerId, input.modelId, input.params);
    const key = `${step}:${prepared.requestHash}`;
    const existing = this.captures.get(key);
    if (existing) return await existing;

    const pending = (async (): Promise<StoredCapture> => {
      const captureId = this.input.newId();
      const capture: ProviderRequestCaptureRecord = {
        ...prepared,
        traceId: this.input.traceId,
        captureId,
        turnId: this.input.turnId,
        step,
        providerId: input.providerId,
        modelId: input.modelId,
      };
      const persisted = await this.input.persistCapture(capture);
      return { capture, ref: { captureId, artifactId: persisted.artifactId } };
    })();
    this.captures.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.captures.delete(key);
      throw error;
    }
  }
}

function throwIfAbortedBeforeDispatch(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('The provider request was cancelled before dispatch', 'AbortError');
  }
}

function preparedCapture(
  providerId: string,
  modelId: string,
  params: Record<string, unknown>,
): PreparedProviderRequestCapture {
  const prompt = Array.isArray(params.prompt) ? params.prompt : [];
  const instructions: unknown[] = [];
  const messages: unknown[] = [];
  for (const item of prompt) {
    const record = asRecord(item);
    if (record?.role === 'system') instructions.push(record.content);
    else messages.push(item);
  }
  const tools = Array.isArray(params.tools) ? params.tools : [];
  const providerOptions = asRecord(params.providerOptions);
  return capturePreparedProviderRequest({
    providerId,
    modelId,
    instructions,
    messages,
    tools,
    ...(providerOptions ? { providerOptions } : {}),
    requestPayload: secretFreeParams(params),
  });
}

function secretFreeParams(params: Record<string, unknown>): Record<string, unknown> {
  const { abortSignal: _abortSignal, headers: _headers, ...safe } = params;
  return safe;
}

function abortStatus(signal: AbortSignal | undefined, error: unknown): 'failed' | 'aborted' {
  if (signal?.aborted) return 'aborted';
  return error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'failed';
}

function isOutputPart(type: unknown): boolean {
  return (
    typeof type === 'string' &&
    ![
      'stream-start',
      'response-metadata',
      'raw',
      'finish',
      'error',
      'text-start',
      'text-end',
      'reasoning-start',
      'reasoning-end',
      'tool-input-start',
      'tool-input-end',
    ].includes(type)
  );
}

function asUsage(value: unknown): ProviderRequestUsageLike | undefined {
  return asRecord(value) as ProviderRequestUsageLike | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extract provider-request usage without inheriting adapter-filled zeroes.
 * Cache evidence is read from the raw provider payload; only cache miss may be
 * derived, and only when the total plus every cache component needed for the
 * subtraction was explicitly reported.
 */
export function strictProviderRequestUsage(
  usage: ProviderRequestUsageLike | undefined,
): ProviderRequestUsage | undefined {
  if (!usage) return undefined;
  const raw = usage.raw;
  const normalizedInputTokens = tokenTotal(usage.inputTokens);
  const normalizedOutputTokens = tokenTotal(usage.outputTokens);
  const inputTokens = canUseNormalizedTotal(raw, [
    'prompt_tokens',
    'input_tokens',
    'promptTokenCount',
  ])
    ? normalizedInputTokens
    : undefined;
  const outputTokens = canUseNormalizedTotal(raw, [
    'completion_tokens',
    'output_tokens',
    'candidatesTokenCount',
  ])
    ? normalizedOutputTokens
    : undefined;
  const result: ProviderRequestUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };

  if (raw) {
    const normalizedCacheMiss =
      typeof usage.inputTokens === 'object' && usage.inputTokens !== null
        ? finiteToken(usage.inputTokens.noCache)
        : undefined;
    applyAnthropicCacheUsage(result, raw, normalizedCacheMiss);
    applyOpenAiCacheUsage(result, raw);
    applyGoogleCacheUsage(result, raw);
    const reasoningTokens = firstToken(
      nestedToken(raw, 'completion_tokens_details', 'reasoning_tokens'),
      nestedToken(raw, 'output_tokens_details', 'reasoning_tokens'),
      ownToken(raw, 'thoughtsTokenCount'),
    );
    if (reasoningTokens !== undefined) result.reasoningTokens = reasoningTokens;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function applyGoogleCacheUsage(result: ProviderRequestUsage, raw: Record<string, unknown>): void {
  const totalInput = ownToken(raw, 'promptTokenCount');
  const cacheRead = ownToken(raw, 'cachedContentTokenCount');
  if (cacheRead === undefined) return;
  result.cacheReadInputTokens = cacheRead;
  result.cacheReadInputSource = 'provider';
  if (totalInput === undefined || cacheRead > totalInput) return;
  result.cacheMissInputTokens = totalInput - cacheRead;
  result.cacheMissInputSource = 'derived';
}

function applyAnthropicCacheUsage(
  result: ProviderRequestUsage,
  raw: Record<string, unknown>,
  normalizedCacheMiss: number | undefined,
): void {
  const cacheRead = ownToken(raw, 'cache_read_input_tokens');
  const cacheWrite = ownToken(raw, 'cache_creation_input_tokens');
  if (cacheRead !== undefined) {
    result.cacheReadInputTokens = cacheRead;
    result.cacheReadInputSource = 'provider';
  }
  if (cacheWrite !== undefined) {
    result.cacheWriteInputTokens = cacheWrite;
    result.cacheWriteInputSource = 'provider';
  }
  // Anthropic defines input_tokens as the non-cached input component. Treat it
  // as cache-miss evidence only when this is recognizably an Anthropic cache
  // usage object, rather than an OpenAI Responses usage object with the same
  // top-level input_tokens spelling.
  if (cacheRead !== undefined || cacheWrite !== undefined) {
    const rawCacheMiss = ownToken(raw, 'input_tokens');
    if (rawCacheMiss !== undefined) {
      result.cacheMissInputTokens = normalizedCacheMiss ?? rawCacheMiss;
      result.cacheMissInputSource = 'provider';
    }
  }
}

function applyOpenAiCacheUsage(result: ProviderRequestUsage, raw: Record<string, unknown>): void {
  const promptInput = ownToken(raw, 'prompt_tokens');
  const responsesInput = ownToken(raw, 'input_tokens');
  const cacheRead = firstToken(
    nestedToken(raw, 'prompt_tokens_details', 'cached_tokens'),
    nestedToken(raw, 'input_tokens_details', 'cached_tokens'),
  );
  const cacheWrite = firstToken(
    nestedToken(raw, 'prompt_tokens_details', 'cache_write_tokens'),
    nestedToken(raw, 'input_tokens_details', 'cache_write_tokens'),
  );
  if (cacheRead === undefined && cacheWrite === undefined) return;

  if (cacheRead !== undefined) {
    result.cacheReadInputTokens = cacheRead;
    result.cacheReadInputSource = 'provider';
  }
  if (cacheWrite !== undefined) {
    result.cacheWriteInputTokens = cacheWrite;
    result.cacheWriteInputSource = 'provider';
  }
  const totalInput = promptInput ?? responsesInput;
  if (totalInput === undefined || cacheRead === undefined) return;
  const accountedInput = cacheRead + (cacheWrite ?? 0);
  if (accountedInput > totalInput) return;
  result.cacheMissInputTokens = totalInput - accountedInput;
  result.cacheMissInputSource = 'derived';
}

function canUseNormalizedTotal(
  raw: Record<string, unknown> | undefined,
  keys: readonly string[],
): boolean {
  return raw === undefined || keys.some((key) => ownToken(raw, key) !== undefined);
}

function tokenTotal(
  value: ProviderRequestUsageLike['inputTokens'] | ProviderRequestUsageLike['outputTokens'],
): number | undefined {
  return finiteToken(typeof value === 'object' && value !== null ? value.total : value);
}

function ownToken(value: Record<string, unknown>, key: string): number | undefined {
  return Object.hasOwn(value, key) ? finiteToken(value[key]) : undefined;
}

function nestedToken(
  value: Record<string, unknown>,
  key: string,
  nestedKey: string,
): number | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  const nested = value[key];
  if (!nested || typeof nested !== 'object' || !Object.hasOwn(nested, nestedKey)) return undefined;
  return finiteToken((nested as Record<string, unknown>)[nestedKey]);
}

function firstToken(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => value !== undefined);
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
