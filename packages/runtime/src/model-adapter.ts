import type { ErrorEvent, CompleteEvent } from '@maka/core/events';
import { providerAuthRequiresSecret, type LlmConnection } from '@maka/core/llm-connections';
import { lookupModelMetadata } from '@maka/core/model-metadata';
import { generalizedErrorMessage } from '@maka/core/redaction';
import type { CacheMissInputSource } from '@maka/core/usage-stats/types';
import type {
  ModelMessage,
  NormalizedUsage,
  RawUsageFields,
  ModelStreamEvent,
  ModelStreamResult,
  ModelFinishReason,
  ModelFailure,
  ModelFailureKind,
  ModelRequestMetadata,
  ModelToolSet,
  ToolCallPart,
} from './model-protocol.js';
export type {
  NormalizedUsage,
  RawUsageFields,
  ModelStreamEvent,
  ModelStreamResult,
  ModelFinishReason,
  ModelFailure,
  ModelFailureKind,
  ModelRequestMetadata,
  ModelToolSet,
} from './model-protocol.js';

import { resolveModelRuntime } from './model-runtime.js';
import {
  classifyError,
  errorPresentationFromClass,
  providerRetryMetadata,
} from './provider-error-classification.js';
import type { ProviderRequestTracker } from './provider-request-telemetry.js';
import {
  createKimiOpenAiTransportState,
  kimiReasoningFieldProviderOptions,
  restoreKimiEmptyReasoning,
  type KimiOpenAiTransportState,
} from './kimi-openai-transport.js';

/**
 * Build an ai-sdk LanguageModel from a single input object.
 * Matches the signature exported by `runtime/model-factory.ts` (@kabi):
 *   `getAIModel(input: ModelFactoryInput): LanguageModelV2`
 *
 * We type-erase the return as `unknown` here to avoid pulling ai-sdk's
 * `LanguageModelV2` type into core's dependency graph.
 */
export interface ModelFactoryInput {
  connection: LlmConnection;
  apiKey: string;
  modelId: string;
  kimiOpenAiTransportState?: KimiOpenAiTransportState;
}
export type ModelFactory = (input: ModelFactoryInput) => unknown;

export interface RepairableAiSdkToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
  providerExecuted?: boolean;
  providerMetadata?: unknown;
}

export interface ModelAdapterInput {
  connection: LlmConnection;
  apiKey: string;
  modelId: string;
  modelFactory: ModelFactory;
  providerOptions?: Record<string, unknown>;
  newId: () => string;
  now: () => number;
}

export interface CompactSummaryRequest {
  model: unknown;
  system: string;
  messages: readonly ModelMessage[];
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}

export interface CompactSummaryResult {
  text: string;
  usage?: NormalizedAiSdkUsage;
  finishReason?: string;
  providerRequestId?: string;
}

export interface ModelAdapterStreamInput {
  model: unknown;
  messages: ModelMessage[];
  tools: ModelToolSet;
  activeTools: string[];
  system?: string;
  abortSignal: AbortSignal;
  repairToolCall: (input: {
    toolCall: RepairableAiSdkToolCall;
    error: unknown;
  }) => RepairableAiSdkToolCall | null | Promise<RepairableAiSdkToolCall | null>;
  /** Main-agent provider-call tracker. Auxiliary model calls intentionally omit it. */
  providerRequestTracker?: ProviderRequestTracker;
}

interface ProviderMiddlewareStreamInput {
  doStream: () => PromiseLike<{
    stream: ReadableStream<unknown>;
    request?: unknown;
    response?: unknown;
  }>;
  params: Record<string, unknown> & { abortSignal?: AbortSignal };
  model: { provider: string; modelId: string };
}

export class ModelAdapter {
  private readonly kimiOpenAiTransportState = createKimiOpenAiTransportState();

  constructor(private readonly input: ModelAdapterInput) {}

  runtimeEventReplaySupport(): ModelAdapterRuntimeEventReplaySupport {
    return {
      toolCalls: true,
      toolResults: true,
      signedThinking: usesAnthropicMessages(this.input.connection, this.input.modelId),
      unsignedThinking: usesKimiOpenAiChat(this.input.connection, this.input.modelId),
    };
  }

  resolveModel(): unknown {
    if (providerAuthRequiresSecret(this.input.connection.providerType) && !this.input.apiKey) {
      throw new Error(`No API key stored for connection "${this.input.connection.slug}"`);
    }
    return this.input.modelFactory({
      connection: this.input.connection,
      apiKey: this.input.apiKey,
      modelId: this.input.modelId,
      ...(usesKimiOpenAiChat(this.input.connection, this.input.modelId)
        ? { kimiOpenAiTransportState: this.kimiOpenAiTransportState }
        : {}),
    });
  }

  async startStream(input: ModelAdapterStreamInput): Promise<ModelStreamResult> {
    const ai = await import('ai').catch((err) => {
      throw new Error(
        `Failed to load 'ai' package. Run \`npm install ai\`. Inner: ${(err as Error).message}`,
      );
    });
    const { streamText, wrapLanguageModel } = ai as unknown as {
      streamText: (opts: Record<string, unknown>) => SdkStreamResult;
      wrapLanguageModel: (input: Record<string, unknown>) => unknown;
    };

    const maxOutputTokens = selectedModelMaxOutputTokens(
      this.input.connection,
      this.input.modelId,
      this.input.providerOptions,
    );
    const trackedModel = input.providerRequestTracker
      ? wrapLanguageModel({
          model: input.model,
          middleware: {
            wrapStream: async ({ doStream, params, model }: ProviderMiddlewareStreamInput) =>
              await input.providerRequestTracker!.trackStream({
                providerId: model.provider,
                modelId: model.modelId,
                params,
                abortSignal: input.abortSignal,
                doStream,
              }),
          },
        })
      : input.model;
    const schemaOnlyTools: ModelToolSet = Object.fromEntries(
      Object.entries(input.tools).map(([name, definition]) => [
        name,
        {
          ...(definition.description !== undefined ? { description: definition.description } : {}),
          inputSchema: definition.inputSchema,
        },
      ]),
    );
    const sdkResult = streamText({
      model: trackedModel,
      messages: input.messages,
      tools: schemaOnlyTools,
      activeTools: input.activeTools,
      repairToolCall: input.repairToolCall,
      ...(input.system ? { instructions: input.system } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      providerOptions: this.input.providerOptions,
      maxRetries: 0,
      // Preserve the final request's Maka-owned message projection without
      // retaining the provider request body. ProviderRequestTracker owns body
      // capture; duplicating it here can retain large base64 image payloads.
      include: { requestMessages: true },
      // With no continuation predicate, streamText performs one provider step.
      // Continuation belongs to the Runtime above this adapter.
      abortSignal: input.abortSignal,
      // The SDK default onError console.errors the raw error object (stack,
      // request bodies), which lands on the terminal outside the TUI
      // transcript. Stream failures already surface through the stream
      // `error` event → ErrorEvent path, so silence the default.
      onError: () => {},
    }) as unknown as SdkStreamResult;
    return this.toModelStreamResult(sdkResult);
  }

  /**
   * Lower an AI SDK `streamText` result into the Maka-owned `ModelStreamResult`.
   * The raw SDK chunk stream is translated lazily to `ModelStreamEvent`s so
   * streaming stays live; failures, usage, finish reason, and request messages
   * are normalized to Maka-owned contracts. No AI SDK type escapes this method.
   */
  private toModelStreamResult(sdk: SdkStreamResult): ModelStreamResult {
    const kimiOpenAiTransportState = usesKimiOpenAiChat(this.input.connection, this.input.modelId)
      ? this.kimiOpenAiTransportState
      : undefined;
    const events: AsyncIterable<ModelStreamEvent> = {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const chunk of sdk.stream as AsyncIterable<AiSdkStreamChunk>) {
            for (const event of translateChunk(chunk, kimiOpenAiTransportState)) yield event;
          }
        } catch (error) {
          yield { kind: 'error', failure: normalizeModelFailure(error) };
        }
      },
    };
    const usage = (async () => {
      const [sdkUsage, sdkFinishReason] = await Promise.all([
        sdk.usage.catch(() => undefined),
        sdk.finishReason.catch(() => undefined),
      ]);
      return normalizeAiSdkUsage(sdkUsage, { rawFinishReason: sdkFinishReason });
    })();
    const finishReason = (async () =>
      rawFinishReasonString(await sdk.finishReason.catch(() => undefined)))();
    const request = Promise.resolve(sdk.request)
      .then(normalizeRequestMetadata)
      .catch(() => undefined);
    return { events, usage, finishReason, request };
  }

  async generateCompactSummary(input: CompactSummaryRequest): Promise<CompactSummaryResult> {
    const ai = await import('ai').catch((err) => {
      throw new Error(
        `Failed to load 'ai' package. Run \`npm install ai\`. Inner: ${(err as Error).message}`,
      );
    });
    const { generateText } = ai as unknown as {
      generateText: (opts: Record<string, unknown>) => Promise<{
        text?: string;
        usage?: AiSdkUsageLike;
        finishReason?: unknown;
        providerMetadata?: unknown;
        finalStep?: { response?: { id?: string } };
      }>;
    };

    const result = await generateText({
      model: input.model,
      instructions: input.system,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
      abortSignal: input.abortSignal,
    });
    const usage = normalizeAiSdkUsage(result.usage, {
      rawFinishReason: result.finishReason,
    });
    return {
      text: result.text ?? '',
      ...(usage ? { usage } : {}),
      ...(result.finishReason !== undefined
        ? { finishReason: rawFinishReasonString(result.finishReason) }
        : {}),
      ...(typeof result.finalStep?.response?.id === 'string'
        ? { providerRequestId: result.finalStep.response.id }
        : {}),
    };
  }

  /**
   * Translate one raw AI SDK stream chunk into zero or more Maka-owned
   * `ModelStreamEvent`s. This is the sole place that parses SDK chunk names
   * (`text-delta` / `reasoning-delta` / `finish-step` / `finish` / `error` / …);
   * the backend never sees them. Pure and side-effect-free so it is directly
   * testable through the Maka-owned event contract.
   */
  translateChunk(chunk: AiSdkStreamChunk): ModelStreamEvent[] {
    return translateChunk(
      chunk,
      usesKimiOpenAiChat(this.input.connection, this.input.modelId)
        ? this.kimiOpenAiTransportState
        : undefined,
    );
  }

  makeErrorEvent(turnId: string, err: unknown): ErrorEvent {
    const failure = normalizeModelFailure(err);
    return {
      type: 'error',
      id: this.input.newId(),
      turnId,
      ts: this.input.now(),
      recoverable: false,
      ...(failure.code !== undefined ? { code: failure.code } : {}),
      ...(failure.kind !== 'abort' && failure.kind !== 'unknown' ? { reason: failure.kind } : {}),
      message: failure.message,
    };
  }

  normalizeFailure(error: unknown): ModelFailure {
    return normalizeModelFailure(error);
  }

  classifyError(error: unknown): string {
    if (isModelFailure(error)) return errorClassFromFailureKind(error.kind);
    return classifyError(error);
  }

  mapFinishReason(reason: unknown): CompleteEvent['stopReason'] {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'content-filter':
        return 'error';
      case 'error':
        return 'error';
      case 'tool-calls':
        return 'end_turn';
      default:
        return 'end_turn';
    }
  }
}

function selectedModelMaxOutputTokens(
  connection: LlmConnection,
  modelId: string,
  providerOptions: Record<string, unknown> | undefined,
): number | undefined {
  const anthropicMessages = usesAnthropicMessages(connection, modelId);
  const kimiOpenAiChat = usesKimiOpenAiChat(connection, modelId);
  if (!anthropicMessages && !kimiOpenAiChat) return undefined;
  const wireOutputLimit =
    connection.models?.find((model) => model.id === modelId)?.maxOutputTokens ??
    lookupModelMetadata(connection.providerType, modelId).maxOutputTokens;
  if (wireOutputLimit === undefined) return undefined;
  return anthropicMessages
    ? wireOutputLimit - fixedAnthropicThinkingBudget(providerOptions)
    : wireOutputLimit;
}

function usesAnthropicMessages(connection: LlmConnection, modelId: string): boolean {
  const { adapter, apiProtocol } = resolveModelRuntime(connection, modelId);
  return (
    adapter.kind === 'anthropic' ||
    adapter.kind === 'claude-subscription' ||
    (adapter.kind === 'github-copilot' && apiProtocol === 'anthropic-messages')
  );
}

function usesKimiOpenAiChat(connection: LlmConnection, modelId: string): boolean {
  return (
    connection.providerType === 'kimi-coding-plan' &&
    resolveModelRuntime(connection, modelId).apiProtocol === 'openai-chat'
  );
}

function fixedAnthropicThinkingBudget(
  providerOptions: Record<string, unknown> | undefined,
): number {
  const anthropic = providerOptions?.anthropic;
  if (!anthropic || typeof anthropic !== 'object' || Array.isArray(anthropic)) return 0;
  const thinking = (anthropic as { thinking?: unknown }).thinking;
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) return 0;
  const { type, budgetTokens } = thinking as { type?: unknown; budgetTokens?: unknown };
  return type === 'enabled' && typeof budgetTokens === 'number' ? budgetTokens : 0;
}

export interface ModelAdapterRuntimeEventReplaySupport {
  toolCalls: boolean;
  toolResults: boolean;
  signedThinking: boolean;
  unsignedThinking: boolean;
}

/**
 * Internal, adapter-only shape of an AI SDK `streamText` stream chunk. This
 * type never crosses the `ModelAdapter` boundary — `ModelAdapter.translateChunk`
 * consumes it and emits the Maka-owned `ModelStreamEvent`. It mirrors the AI
 * SDK chunk union just enough to read the fields Maka cares about.
 */
interface AiSdkStreamChunk {
  type: string;
  text?: string;
  delta?: string;
  textDelta?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  args?: unknown;
  providerExecuted?: boolean;
  result?: unknown;
  usage?: AiSdkUsageLike;
  finishReason?: unknown;
  error?: unknown;
  /** Provider-specific metadata; carries the Anthropic reasoning signature. */
  providerMetadata?: unknown;
}

/**
 * Internal, adapter-only shape of an AI SDK `streamText` result. The public
 * boundary contract is `ModelStreamResult`; this exists only to type the
 * lowering cast inside `ModelAdapter`.
 */
interface SdkStreamResult {
  stream: AsyncIterable<AiSdkStreamChunk>;
  usage: Promise<AiSdkUsageLike | undefined>;
  finishReason: Promise<unknown>;
  request: PromiseLike<{
    messages?: ModelMessage[];
  }>;
}

/**
 * Extract the provider-signed reasoning signature from a stream chunk.
 * Anthropic delivers it via `providerMetadata.anthropic.signature`; other
 * providers omit it and this returns undefined.
 */
function reasoningSignatureFromChunk(chunk: AiSdkStreamChunk): string | undefined {
  const meta = chunk.providerMetadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const anthropic = (meta as { anthropic?: unknown }).anthropic;
  if (!anthropic || typeof anthropic !== 'object') return undefined;
  const signature = (anthropic as { signature?: unknown }).signature;
  return typeof signature === 'string' && signature.length > 0 ? signature : undefined;
}

/**
 * Translate one raw AI SDK stream chunk into zero or more Maka-owned
 * `ModelStreamEvent`s. The sole site that parses SDK chunk names; the backend
 * never sees raw chunks. Pure and side-effect-free.
 */
function translateChunk(
  chunk: AiSdkStreamChunk,
  kimiOpenAiTransportState?: KimiOpenAiTransportState,
): ModelStreamEvent[] {
  switch (chunk.type) {
    case 'text-delta': {
      const text = chunk.text ?? chunk.textDelta ?? chunk.delta ?? '';
      return text ? [{ kind: 'text', text }] : [];
    }
    case 'reasoning':
    case 'reasoning-delta': {
      const text =
        typeof chunk.text === 'string'
          ? chunk.text
          : typeof chunk.textDelta === 'string'
            ? chunk.textDelta
            : typeof chunk.delta === 'string'
              ? chunk.delta
              : undefined;
      const signature = reasoningSignatureFromChunk(chunk);
      const events: ModelStreamEvent[] = [];
      if (signature) events.push({ kind: 'thinking-signature', signature });
      // The signed reasoning chunk arrives as a standalone delta with empty
      // text; preserve provider-authored empty reasoning, but do not surface a
      // signature-only carrier as an additional empty reasoning fragment.
      if (text !== undefined && (text.length > 0 || signature === undefined)) {
        events.push({
          kind: 'thinking',
          text: restoreKimiEmptyReasoning(text),
          ...(kimiOpenAiTransportState
            ? {
                providerOptions: kimiReasoningFieldProviderOptions(
                  kimiOpenAiTransportState.reasoningField,
                ),
              }
            : {}),
        });
      }
      return events;
    }
    case 'reasoning-end': {
      const signature = reasoningSignatureFromChunk(chunk);
      return signature ? [{ kind: 'thinking-signature', signature }] : [];
    }
    // Step boundaries (`start-step` / `finish-step`) and the terminal `finish`
    // carry no text/thinking to stream. The backend owns step accounting: it
    // counts and flushes one AssistantMessage per step and rotates the
    // messageId at each `finish-step`. `step-finish` is legacy replay fixture
    // compatibility — handled as a step boundary, not a text carrier.
    case 'finish-step':
    case 'step-finish': {
      const finishReason = rawFinishReasonString(chunk.finishReason);
      const usage = normalizeAiSdkUsage(chunk.usage, { rawFinishReason: chunk.finishReason });
      return [
        {
          kind: 'step-finish',
          ...(usage ? { usage } : {}),
          ...(finishReason ? { finishReason } : {}),
        },
      ];
    }
    case 'finish': {
      const finishReason = rawFinishReasonString(chunk.finishReason);
      return [{ kind: 'finish', ...(finishReason ? { finishReason } : {}) }];
    }
    case 'reasoning-start':
    case 'start-step':
    case 'tool-result':
      return [];
    case 'tool-call': {
      if (typeof chunk.toolCallId !== 'string' || typeof chunk.toolName !== 'string') return [];
      const toolCall: ToolCallPart = {
        type: 'tool-call',
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input ?? chunk.args,
        ...(chunk.providerExecuted !== undefined
          ? { providerExecuted: chunk.providerExecuted }
          : {}),
        ...(chunk.providerMetadata !== undefined
          ? { providerOptions: chunk.providerMetadata as ToolCallPart['providerOptions'] }
          : {}),
      };
      return [{ kind: 'tool-call', toolCall }];
    }
    case 'error':
      return [{ kind: 'error', failure: normalizeModelFailure(chunk.error) }];
    default:
      return [];
  }
}

function normalizeModelFailure(error: unknown): ModelFailure {
  if (isModelFailure(error)) return error;
  const errorClass = classifyError(error);
  const presentation = errorPresentationFromClass(errorClass);
  const retry = providerRetryMetadata(error);
  const code =
    error instanceof Error && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  return {
    type: 'model_failure',
    kind: modelFailureKind(errorClass),
    retryable: retry.retryable,
    ...(retry.retryAfterMs !== undefined ? { retryAfterMs: retry.retryAfterMs } : {}),
    ...(code !== undefined ? { code } : {}),
    message: presentation.message ?? generalizedErrorMessage(error),
  };
}

function isModelFailure(value: unknown): value is ModelFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'model_failure' &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

function modelFailureKind(errorClass: string): ModelFailureKind {
  switch (errorClass) {
    case 'Abort':
      return 'abort';
    case 'Auth':
      return 'auth';
    case 'ContextLength':
      return 'context_overflow';
    case 'Network':
      return 'network';
    case 'ProviderBilling':
      return 'provider_billing';
    case 'ProviderUnavailable':
      return 'provider_unavailable';
    case 'RateLimit':
      return 'rate_limit';
    case 'Timeout':
      return 'timeout';
    default:
      return 'unknown';
  }
}

function errorClassFromFailureKind(kind: ModelFailureKind): string {
  switch (kind) {
    case 'abort':
      return 'Abort';
    case 'auth':
      return 'Auth';
    case 'context_overflow':
      return 'ContextLength';
    case 'network':
      return 'Network';
    case 'provider_billing':
      return 'ProviderBilling';
    case 'provider_unavailable':
      return 'ProviderUnavailable';
    case 'rate_limit':
      return 'RateLimit';
    case 'timeout':
      return 'Timeout';
    case 'unknown':
      return 'Other';
  }
}

function normalizeRequestMetadata(
  metadata:
    | {
        messages?: ModelMessage[];
      }
    | undefined,
): ModelRequestMetadata | undefined {
  return metadata?.messages === undefined ? undefined : { messages: metadata.messages };
}

type TokenCountBreakdown = {
  total?: number;
  noCache?: number;
  cacheRead?: number;
  cacheWrite?: number;
  text?: number;
  reasoning?: number;
};

/**
 * Internal, adapter-only mirror of the AI SDK raw usage fields. The public
 * `RawUsageFields` contract lives in `model-protocol.ts`; this stays here as
 * the lowering input shape and is assigned to `NormalizedUsage.raw`.
 */
export type AiSdkRawUsageFields = RawUsageFields;

export interface AiSdkUsageLike {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  inputTokens?: number | TokenCountBreakdown;
  outputTokens?: number | TokenCountBreakdown;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  inputTokenDetails?: {
    cachedTokens?: number;
    cacheMissTokens?: number;
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
  raw?: AiSdkRawUsageFields;
}

/**
 * @deprecated alias for the Maka-owned `NormalizedUsage` contract exported
 * from `model-protocol.ts`. Kept for backward compatibility with existing
 * internal import sites during the slice-1 transition.
 */
export type NormalizedAiSdkUsage = NormalizedUsage;

export function normalizeAiSdkUsage(
  usage: AiSdkUsageLike | undefined,
  options: { rawFinishReason?: unknown } = {},
): NormalizedUsage | undefined {
  if (!usage) return undefined;
  const reportedInputTokens =
    finiteTokenFromValueOrBreakdown(usage.inputTokens, 'total') ??
    finiteTokenBreakdownSum(usage.inputTokens, ['noCache', 'cacheRead', 'cacheWrite']) ??
    finiteToken(usage.promptTokens) ??
    finiteToken(usage.raw?.prompt_tokens) ??
    finiteToken(usage.prompt_tokens) ??
    finiteTokenSum([
      usage.inputTokenDetails?.noCacheTokens,
      usage.inputTokenDetails?.cacheReadTokens,
      usage.inputTokenDetails?.cacheWriteTokens,
    ]);
  const reportedOutputTokens =
    finiteTokenFromValueOrBreakdown(usage.outputTokens, 'total') ??
    finiteTokenBreakdownSum(usage.outputTokens, ['text', 'reasoning']) ??
    finiteToken(usage.completionTokens) ??
    finiteToken(usage.raw?.completion_tokens) ??
    finiteToken(usage.completion_tokens) ??
    finiteTokenSum([
      usage.outputTokenDetails?.textTokens,
      usage.outputTokenDetails?.reasoningTokens,
    ]);
  const reportedCacheHitInputTokens =
    finiteToken(usage.cacheHitInputTokens) ??
    finiteToken(usage.cachedInputTokens) ??
    finiteToken(usage.cacheReadInputTokens) ??
    finiteToken(usage.raw?.prompt_cache_hit_tokens) ??
    finiteToken(usage.prompt_cache_hit_tokens) ??
    finiteToken(usage.raw?.prompt_tokens_details?.cached_tokens) ??
    finiteToken(usage.prompt_tokens_details?.cached_tokens) ??
    finiteTokenFromBreakdown(usage.inputTokens, 'cacheRead') ??
    finiteToken(usage.inputTokenDetails?.cacheReadTokens) ??
    finiteToken(usage.inputTokenDetails?.cachedTokens);
  const reportedCacheWriteInputTokens =
    finiteToken(usage.cacheWriteInputTokens) ??
    finiteToken(usage.cacheCreationInputTokens) ??
    finiteTokenFromBreakdown(usage.inputTokens, 'cacheWrite') ??
    finiteToken(usage.inputTokenDetails?.cacheWriteTokens);
  const explicitCacheMissInputTokens =
    finiteToken(usage.cacheMissInputTokens) ??
    finiteToken(usage.raw?.prompt_cache_miss_tokens) ??
    finiteToken(usage.prompt_cache_miss_tokens) ??
    finiteTokenFromBreakdown(usage.inputTokens, 'noCache') ??
    finiteToken(usage.inputTokenDetails?.noCacheTokens) ??
    finiteToken(usage.inputTokenDetails?.cacheMissTokens);
  const reportedReasoningTokens =
    finiteToken(usage.reasoningTokens) ??
    finiteTokenFromBreakdown(usage.outputTokens, 'reasoning') ??
    finiteToken(usage.outputTokenDetails?.reasoningTokens) ??
    finiteToken(usage.raw?.completion_tokens_details?.reasoning_tokens) ??
    finiteToken(usage.completion_tokens_details?.reasoning_tokens) ??
    finiteToken(usage.inputTokenDetails?.reasoningTokens);
  const reportedTotalTokens =
    finiteToken(usage.totalTokens) ??
    finiteToken(usage.raw?.total_tokens) ??
    finiteToken(usage.total_tokens);
  const inputTokens =
    reportedInputTokens ??
    (reportedTotalTokens !== undefined &&
    reportedOutputTokens !== undefined &&
    reportedTotalTokens >= reportedOutputTokens
      ? reportedTotalTokens - reportedOutputTokens
      : undefined);
  const outputTokens =
    reportedOutputTokens ??
    (reportedTotalTokens !== undefined &&
    reportedInputTokens !== undefined &&
    reportedTotalTokens >= reportedInputTokens
      ? reportedTotalTokens - reportedInputTokens
      : undefined);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheHitInputTokens = reportedCacheHitInputTokens ?? 0;
  const cacheWriteInputTokens = reportedCacheWriteInputTokens ?? 0;
  const cacheMissInputTokens =
    explicitCacheMissInputTokens ??
    Math.max(0, inputTokens - cacheHitInputTokens - cacheWriteInputTokens);
  const cacheMissInputSource: CacheMissInputSource =
    explicitCacheMissInputTokens !== undefined ? 'explicit' : 'derived';
  const reasoningTokens = reportedReasoningTokens ?? 0;
  const totalTokens = reportedTotalTokens ?? inputTokens + outputTokens;
  const raw = rawUsageFields(usage);
  const rawFinishReason = rawFinishReasonString(options.rawFinishReason);
  return {
    inputTokens,
    outputTokens,
    cacheHitInputTokens,
    cacheMissInputTokens,
    cacheMissInputSource,
    cacheWriteInputTokens,
    reasoningTokens,
    totalTokens,
    ...(rawFinishReason !== undefined ? { rawFinishReason } : {}),
    ...(raw !== undefined ? { raw } : {}),
    cachedInputTokens: cacheHitInputTokens,
  };
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteTokenFromBreakdown(
  value: number | TokenCountBreakdown | undefined,
  key: keyof TokenCountBreakdown,
): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return finiteToken(value[key]);
}

function finiteTokenFromValueOrBreakdown(
  value: number | TokenCountBreakdown | undefined,
  key: keyof TokenCountBreakdown,
): number | undefined {
  return finiteToken(value) ?? finiteTokenFromBreakdown(value, key);
}

function finiteTokenBreakdownSum(
  value: number | TokenCountBreakdown | undefined,
  keys: readonly (keyof TokenCountBreakdown)[],
): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const parts = keys.map((key) => finiteToken(value[key]));
  return parts.every((part) => part === undefined)
    ? undefined
    : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

function finiteTokenSum(values: readonly unknown[]): number | undefined {
  const tokens = values.map(finiteToken);
  return tokens.every((token) => token === undefined)
    ? undefined
    : tokens.reduce<number>((sum, token) => sum + (token ?? 0), 0);
}

function rawUsageFields(usage: AiSdkUsageLike): AiSdkRawUsageFields | undefined {
  const raw: AiSdkRawUsageFields = {};
  const promptTokens = finiteToken(usage.prompt_tokens) ?? finiteToken(usage.raw?.prompt_tokens);
  if (promptTokens !== undefined) raw.prompt_tokens = promptTokens;
  const completionTokens =
    finiteToken(usage.completion_tokens) ?? finiteToken(usage.raw?.completion_tokens);
  if (completionTokens !== undefined) raw.completion_tokens = completionTokens;
  const totalTokens = finiteToken(usage.total_tokens) ?? finiteToken(usage.raw?.total_tokens);
  if (totalTokens !== undefined) raw.total_tokens = totalTokens;
  const promptCacheHitTokens =
    finiteToken(usage.prompt_cache_hit_tokens) ?? finiteToken(usage.raw?.prompt_cache_hit_tokens);
  if (promptCacheHitTokens !== undefined) raw.prompt_cache_hit_tokens = promptCacheHitTokens;
  const promptCacheMissTokens =
    finiteToken(usage.prompt_cache_miss_tokens) ?? finiteToken(usage.raw?.prompt_cache_miss_tokens);
  if (promptCacheMissTokens !== undefined) raw.prompt_cache_miss_tokens = promptCacheMissTokens;
  const cachedTokens =
    finiteToken(usage.prompt_tokens_details?.cached_tokens) ??
    finiteToken(usage.raw?.prompt_tokens_details?.cached_tokens);
  if (cachedTokens !== undefined) raw.prompt_tokens_details = { cached_tokens: cachedTokens };
  const reasoningTokens =
    finiteToken(usage.completion_tokens_details?.reasoning_tokens) ??
    finiteToken(usage.raw?.completion_tokens_details?.reasoning_tokens);
  if (reasoningTokens !== undefined) {
    raw.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  return Object.keys(raw).length > 0 ? raw : undefined;
}

export function rawFinishReasonString(reason: unknown): string | undefined {
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason === 'object') {
    const raw = (reason as { raw?: unknown }).raw;
    if (typeof raw === 'string') return raw;
    const unified = (reason as { unified?: unknown }).unified;
    if (typeof unified === 'string') return unified;
  }
  return undefined;
}
