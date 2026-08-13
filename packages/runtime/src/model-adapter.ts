import type { ErrorEvent, CompleteEvent } from '@maka/core/events';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import {
  providerAuthRequiresSecret,
  type RuntimeExecutionConnection,
} from '@maka/core/llm-connections';
import { lookupModelMetadata } from '@maka/core/model-metadata';
import { generalizedErrorMessage } from '@maka/core/redaction';
import type { CacheMissInputSource } from '@maka/core/usage-stats/types';
import { rawFinishReasonString } from './model-protocol.js';
import type {
  ModelMessage,
  NormalizedUsage,
  RawUsageFields,
  ModelStreamEvent,
  ModelStreamResult,
  ModelStepOutcome,
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
  ModelStepOutcome,
  ModelFinishReason,
  ModelFailure,
  ModelFailureKind,
  ModelRequestMetadata,
  ModelToolSet,
} from './model-protocol.js';

import { resolveModelRuntime, type ResolvedModelRuntime } from './model-runtime.js';
import {
  classifyError,
  errorPresentationFromClass,
  providerFailureSummary,
  providerRetryMetadata,
} from './provider-error-classification.js';
import {
  withProviderGenerateTracking,
  type ProviderRequestTracker,
} from './provider-request-telemetry.js';
import type { ContextDiagnosticsCompaction } from './context-diagnostics.js';
import {
  createOpenAiChatReasoningTransportState,
  openAiChatReasoningFieldProviderOptions,
  restoreOpenAiChatEmptyReasoning,
  type OpenAiChatReasoningTransportState,
} from './openai-chat-reasoning-transport.js';
import type { ModelFactoryInput } from './model-factory.js';
import {
  mergeOpenAiResponsesProviderOptions,
  planOpenAiResponsesContinuation,
} from './openai-responses-continuation.js';
import {
  createOpenAiResponsesTransportState,
  OPENAI_RESPONSES_LANE_HEADER,
  type OpenAiResponsesTransportState,
} from './openai-responses-websocket.js';
import {
  codexV4aApplyPatchProviderTool,
  openAiApplyPatchProviderTool,
} from './openai-apply-patch.js';

/**
 * Build an ai-sdk LanguageModel from a single input object.
 * Matches the signature exported by `runtime/model-factory.ts` (@kabi):
 *   `getAIModel(input: ModelFactoryInput): LanguageModelV2`
 *
 * We type-erase the return as `unknown` here to avoid pulling ai-sdk's
 * `LanguageModelV2` type into core's dependency graph.
 */
export type { ModelFactoryInput };
export type ModelFactory = (input: ModelFactoryInput) => unknown;

export interface RepairableAiSdkToolCall {
  toolCallId: string;
  toolName: string;
  input: string;
  providerExecuted?: boolean;
  providerMetadata?: unknown;
}

export interface ModelAdapterInput {
  sessionId?: string;
  connection: RuntimeExecutionConnection;
  apiKey: string;
  modelId: string;
  modelFactory: ModelFactory;
  providerOptions?: Record<string, unknown>;
  newId: () => string;
  now: () => number;
  /** Test seam; production adapters own one state instance for their lifetime. */
  openAiResponsesTransportState?: OpenAiResponsesTransportState;
}

export interface CompactSummaryRequest {
  model: unknown;
  system: string;
  messages: readonly ModelMessage[];
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
  /**
   * Physical provider-call tracking for this summarization. Attaching it here
   * rather than at the call site keeps "wrap a model with a tracker" in the one
   * place that already owns it for streams.
   */
  providerRequestTracker?: ProviderRequestTracker;
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
  /** Observe each successfully pulled SDK stream part before semantic translation. */
  onStreamActivity: () => void;
  system?: string;
  abortSignal: AbortSignal;
  repairToolCall: (input: {
    toolCall: RepairableAiSdkToolCall;
    error: unknown;
  }) => RepairableAiSdkToolCall | null | Promise<RepairableAiSdkToolCall | null>;
  /** Main-agent provider-call tracker. Auxiliary calls track their own generates. */
  providerRequestTracker?: ProviderRequestTracker;
  /**
   * The compaction boundary the messages of THIS call were projected under
   * (#2323). Travels with the messages rather than being read from session
   * state at settlement, which is why it is an argument here at all: the
   * caller dispatches once per physical request and knows which fold each one
   * was built from; nothing downstream can recover that afterwards.
   */
  historyCompactBoundary?: ContextDiagnosticsCompaction;
  /** Turn-scoped continuation lane. Omitted callers keep the full-request path. */
  continuationKey?: string;
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
  private readonly runtime: ResolvedModelRuntime;
  private readonly openAiChatReasoningTransportState: OpenAiChatReasoningTransportState;
  private readonly openAiResponsesTransportState: OpenAiResponsesTransportState;

  constructor(private readonly input: ModelAdapterInput) {
    this.runtime = resolveModelRuntime(input.connection, input.modelId);
    this.openAiChatReasoningTransportState = createOpenAiChatReasoningTransportState(
      this.runtime.reasoningReplay.kind === 'openai-chat-plaintext'
        ? this.runtime.reasoningReplay.requestField
        : 'observed',
    );
    this.openAiResponsesTransportState =
      input.openAiResponsesTransportState ?? createOpenAiResponsesTransportState();
  }

  runtimeEventReplaySupport(): ModelAdapterRuntimeEventReplaySupport {
    return {
      toolCalls: true,
      toolResults: true,
      signedThinking: this.runtime.reasoningReplay.kind === 'anthropic-signed',
      // openai-compatible transports replay stored reasoning unconditionally:
      // DeepSeek-style endpoints 400 tool calls whose history lacks it, and
      // relays that don't need the field ignore it. Reasoning is still
      // recorded to the event log and rendered regardless.
      unsignedThinking: this.runtime.reasoningReplay.kind === 'openai-chat-plaintext',
      openAiResponsesThinking: this.runtime.reasoningReplay.kind === 'openai-responses-item',
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
      resolvedRuntime: this.runtime,
      ...(this.runtime.reasoningReplay.kind === 'openai-chat-plaintext'
        ? { openAiChatReasoningTransportState: this.openAiChatReasoningTransportState }
        : {}),
      ...(usesNativeOpenAiResponses(this.input.connection, this.runtime)
        ? { openAiResponsesTransportState: this.openAiResponsesTransportState }
        : {}),
    });
  }

  maxOutputTokens(): number | undefined {
    return selectedModelMaxOutputTokens(
      this.input.connection,
      this.input.modelId,
      this.input.providerOptions,
      this.runtime,
    );
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
      this.runtime,
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
                ...(input.historyCompactBoundary
                  ? { historyCompactBoundary: input.historyCompactBoundary }
                  : {}),
              }),
          },
        })
      : input.model;
    const sdkTools = lowerModelTools(input.tools);
    const fullMessages = input.messages;
    const responsesLane =
      input.continuationKey && usesNativeOpenAiResponses(this.input.connection, this.runtime)
        ? input.continuationKey
        : undefined;
    const continuation = responsesLane
      ? planOpenAiResponsesContinuation(
          fullMessages,
          this.openAiResponsesTransportState.semanticBaseline(responsesLane),
        )
      : { messages: fullMessages };
    const providerOptions = usesNativeOpenAiResponses(this.input.connection, this.runtime)
      ? mergeOpenAiResponsesProviderOptions(
          this.input.providerOptions,
          this.input.sessionId ?? this.input.connection.slug,
          continuation.previousResponseId,
        )
      : this.input.providerOptions;
    const sdkResult = streamText({
      model: trackedModel,
      messages: continuation.messages,
      tools: sdkTools,
      activeTools: input.activeTools,
      // An empty active set is an authoritative tool-free request (not merely
      // an empty provider schema).  Some OpenAI-compatible models, including
      // DeepSeek, otherwise keep emitting their native tool-call envelope as
      // ordinary text when the SDK leaves toolChoice at its `auto` default.
      // The child-agent finalization step relies on this boundary to spend its
      // last budgeted request on a summary instead of one more unusable call.
      ...(input.activeTools.length === 0 ? { toolChoice: 'none' } : {}),
      repairToolCall: input.repairToolCall,
      ...(input.system ? { instructions: input.system } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      providerOptions,
      ...(responsesLane ? { headers: { [OPENAI_RESPONSES_LANE_HEADER]: responsesLane } } : {}),
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
    return this.toModelStreamResult(sdkResult, input.onStreamActivity, {
      ...(responsesLane ? { lane: responsesLane } : {}),
      requestMessages: fullMessages,
      abortSignal: input.abortSignal,
    });
  }

  /**
   * Lower an AI SDK `streamText` result into the Maka-owned `ModelStreamResult`.
   * The raw SDK chunk stream is translated lazily to `ModelStreamEvent`s so
   * streaming stays live; failures, usage, finish reason, and request messages
   * are normalized to Maka-owned contracts. No AI SDK type escapes this method.
   */
  private toModelStreamResult(
    sdk: SdkStreamResult,
    onStreamActivity: () => void,
    continuation: { lane?: string; requestMessages: ModelMessage[]; abortSignal: AbortSignal },
  ): ModelStreamResult {
    const openAiChatReasoningTransportState =
      this.runtime.reasoningReplay.kind === 'openai-chat-plaintext'
        ? this.openAiChatReasoningTransportState
        : undefined;
    const openAiResponsesTransportState = this.openAiResponsesTransportState;
    let settleOutcome!: (outcome: ModelStepOutcome) => void;
    const outcome = new Promise<ModelStepOutcome>((resolve) => {
      settleOutcome = resolve;
    });
    const request = { messages: continuation.requestMessages };
    const events: AsyncIterable<ModelStreamEvent> = {
      async *[Symbol.asyncIterator]() {
        let failure: ModelFailure | undefined;
        let sawFinish = false;
        let streamedFinishReason: string | undefined;
        try {
          for await (const chunk of sdk.stream as AsyncIterable<AiSdkStreamChunk>) {
            onStreamActivity();
            for (const event of translateChunk(chunk, openAiChatReasoningTransportState)) {
              if (event.kind === 'error') failure = event.failure;
              if (event.kind === 'finish') sawFinish = true;
              if (event.kind === 'finish' || event.kind === 'step-finish') {
                streamedFinishReason = event.finishReason ?? streamedFinishReason;
              }
              yield event;
            }
          }
        } catch (error) {
          failure = normalizeProviderFailure(error);
          yield { kind: 'error', failure };
        } finally {
          const [sdkUsage, sdkFinishReason] = await Promise.all([
            sdk.usage.catch(() => undefined),
            sdk.finishReason.catch(() => undefined),
          ]);
          const finishReason =
            streamedFinishReason ?? rawFinishReasonString(sdkFinishReason) ?? 'unknown';
          const usage = normalizeAiSdkUsage(sdkUsage, { rawFinishReason: finishReason });
          let settled = settleModelStepOutcome({
            aborted: continuation.abortSignal.aborted,
            failure,
            sawFinish,
            finishReason,
            usage,
            request,
          });

          try {
            if (continuation.lane) {
              if (settled.kind === 'completed') {
                const response = await Promise.resolve(sdk.response).catch(() => undefined);
                if (
                  response?.id &&
                  openAiResponsesTransportState.canRecordSemantic(continuation.lane, response.id)
                ) {
                  openAiResponsesTransportState.recordSemanticRequest(continuation.lane, {
                    requestMessages: structuredClone(continuation.requestMessages),
                    responseId: response.id,
                  });
                  settled = { ...settled, continuation: 'pending' };
                } else {
                  openAiResponsesTransportState.clearSemantic(continuation.lane);
                }
              } else {
                openAiResponsesTransportState.clearSemantic(continuation.lane);
              }
            }
          } finally {
            settleOutcome(settled);
          }
        }
      },
    };
    return { events, outcome };
  }

  endContinuation(lane: string): void {
    this.openAiResponsesTransportState.endLane(lane);
  }

  recordContinuationResponse(lane: string, responseMessages: readonly ModelMessage[]): void {
    this.openAiResponsesTransportState.recordSemanticResponse(lane, responseMessages);
  }

  clearContinuation(lane: string): void {
    this.openAiResponsesTransportState.clearSemantic(lane);
  }

  dispose(): void {
    this.openAiResponsesTransportState.close();
  }

  async generateCompactSummary(input: CompactSummaryRequest): Promise<CompactSummaryResult> {
    const ai = await import('ai').catch((err) => {
      throw new Error(
        `Failed to load 'ai' package. Run \`npm install ai\`. Inner: ${(err as Error).message}`,
      );
    });
    const { generateText, wrapLanguageModel } = ai as unknown as {
      generateText: (opts: Record<string, unknown>) => Promise<{
        text?: string;
        usage?: AiSdkUsageLike;
        finishReason?: unknown;
        providerMetadata?: unknown;
        finalStep?: { response?: { id?: string } };
      }>;
      wrapLanguageModel: (input: Record<string, unknown>) => unknown;
    };

    const trackedModel = input.providerRequestTracker
      ? withProviderGenerateTracking({
          model: input.model,
          wrapLanguageModel,
          tracker: input.providerRequestTracker,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        })
      : input.model;

    const result = await generateText({
      model: trackedModel,
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
      this.runtime.reasoningReplay.kind === 'openai-chat-plaintext'
        ? this.openAiChatReasoningTransportState
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
    return normalizeProviderFailure(error);
  }

  classifyError(error: unknown): string {
    if (isModelFailure(error)) return errorClassFromFailureKind(error.kind);
    return classifyError(error);
  }

  /** Map a successfully settled provider step to its runtime stop reason. */
  mapFinishReason(reason: ModelFinishReason): CompleteEvent['stopReason'] {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'tool-calls':
        return 'end_turn';
      default:
        return 'end_turn';
    }
  }
}

interface ModelStepSettlementEvidence {
  aborted: boolean;
  failure?: ModelFailure;
  sawFinish: boolean;
  finishReason: ModelFinishReason;
  usage?: NormalizedUsage;
  request: ModelRequestMetadata;
}

export function settleModelStepOutcome(evidence: ModelStepSettlementEvidence): ModelStepOutcome {
  const { aborted, failure, sawFinish, finishReason, usage, request } = evidence;
  if (aborted || failure?.kind === 'abort') {
    return failedStepOutcome(
      'aborted',
      failure ?? normalizeModelFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      request,
      usage,
    );
  }
  if (failure) {
    return failedStepOutcome(
      failure.retryable ? 'retryable-failure' : 'terminal-failure',
      failure,
      request,
      usage,
    );
  }
  if (!sawFinish || finishReason === 'other' || finishReason === 'unknown') {
    return failedStepOutcome(
      'truncated',
      modelStepFailure(
        'provider_unavailable',
        `Provider stream ended without finishing (${finishReason})`,
      ),
      request,
      usage,
    );
  }
  if (finishReason === 'content-filter' || finishReason === 'error') {
    return failedStepOutcome(
      'terminal-failure',
      modelStepFailure(
        finishReason === 'content-filter' ? 'unknown' : 'provider_unavailable',
        finishReason === 'content-filter'
          ? 'Provider stopped the stream on a content filter'
          : 'Provider stopped the stream with an error',
      ),
      request,
      usage,
    );
  }
  return {
    kind: 'completed',
    finishReason,
    ...(usage ? { usage } : {}),
    request,
    continuation: 'none',
  };
}

function modelStepFailure(kind: ModelFailureKind, message: string): ModelFailure {
  return { type: 'model_failure', kind, message, retryable: false };
}

function failedStepOutcome(
  kind: Exclude<ModelStepOutcome['kind'], 'completed'>,
  failure: ModelFailure,
  request: ModelRequestMetadata,
  usage?: NormalizedUsage,
): Exclude<ModelStepOutcome, { kind: 'completed' }> {
  return {
    kind,
    failure,
    ...(usage ? { usage } : {}),
    request,
    continuation: 'none',
  };
}

function selectedModelMaxOutputTokens(
  connection: RuntimeExecutionConnection,
  modelId: string,
  providerOptions: Record<string, unknown> | undefined,
  runtime: ResolvedModelRuntime,
): number | undefined {
  const anthropicMessages = runtime.wire === 'anthropic-messages';
  const kimiOpenAiChat =
    connection.providerType === 'kimi-coding-plan' && runtime.wire === 'openai-chat';
  if (!anthropicMessages && !kimiOpenAiChat) return undefined;
  const wireOutputLimit =
    connection.models?.find((model) => model.id === modelId)?.maxOutputTokens ??
    lookupModelMetadata(connection.providerType, modelId).maxOutputTokens;
  if (wireOutputLimit === undefined) return undefined;
  return anthropicMessages
    ? wireOutputLimit - fixedAnthropicThinkingBudget(providerOptions)
    : wireOutputLimit;
}

function usesNativeOpenAiResponses(
  connection: RuntimeExecutionConnection,
  runtime: ResolvedModelRuntime,
): boolean {
  return connection.providerType === 'openai' && runtime.wire === 'openai-responses';
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
  openAiResponsesThinking: boolean;
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
  output?: unknown;
  isError?: boolean;
  usage?: AiSdkUsageLike;
  finishReason?: unknown;
  /** What the provider itself called it, before the SDK bucketed it. */
  rawFinishReason?: unknown;
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
  response: PromiseLike<{
    id: string;
  }>;
}

/**
 * The finish reason to forward, preferring what the provider actually said.
 *
 * The SDK splits the reason in two: a closed unified enum, and the provider's
 * own spelling. Unified is the right thing to forward — `runtime-runner` and
 * the backend compare against `'tool-calls'`, which is a name only the SDK
 * uses. Except when unified is `other`, which is not a reason but the SDK
 * declining to name one; there it hides the only distinction that matters
 * downstream. `other` with a provider spelling is a model that stopped for a
 * reason we have no case for — an ordinary finished turn. `other` with nothing
 * behind it is a stream that died without anyone saying so.
 */
function chunkFinishReason(chunk: AiSdkStreamChunk): string | undefined {
  const unified = rawFinishReasonString(chunk.finishReason);
  if (unified !== 'other' && unified !== 'unknown') return unified;
  return rawFinishReasonString(chunk.rawFinishReason) ?? unified;
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

function openAiResponsesReasoningProviderOptionsFromChunk(
  chunk: AiSdkStreamChunk,
): NonNullable<ModelMessage['providerOptions']> | undefined {
  const meta = chunk.providerMetadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const openai = (meta as { openai?: unknown }).openai;
  if (!openai || typeof openai !== 'object' || Array.isArray(openai)) return undefined;
  const { itemId, reasoningEncryptedContent } = openai as {
    itemId?: unknown;
    reasoningEncryptedContent?: unknown;
  };
  if (typeof itemId !== 'string' || itemId.length === 0) return undefined;
  return {
    openai: {
      itemId,
      ...(typeof reasoningEncryptedContent === 'string' || reasoningEncryptedContent === null
        ? { reasoningEncryptedContent }
        : {}),
    },
  };
}

/**
 * Translate one raw AI SDK stream chunk into zero or more Maka-owned
 * `ModelStreamEvent`s. The sole site that parses SDK chunk names; the backend
 * never sees raw chunks. Pure and side-effect-free.
 */
function translateChunk(
  chunk: AiSdkStreamChunk,
  openAiChatReasoningTransportState?: OpenAiChatReasoningTransportState,
): ModelStreamEvent[] {
  switch (chunk.type) {
    case 'text-start':
      return [{ kind: 'text-start' }];
    case 'text-delta': {
      const text = chunk.text ?? chunk.textDelta ?? chunk.delta ?? '';
      return text ? [{ kind: 'text', text }] : [];
    }
    case 'text-end': {
      if (!chunk.providerMetadata || typeof chunk.providerMetadata !== 'object') return [];
      return [
        {
          kind: 'text-metadata',
          providerOptions: chunk.providerMetadata as NonNullable<ModelMessage['providerOptions']>,
        },
      ];
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
      const responsesProviderOptions = openAiResponsesReasoningProviderOptionsFromChunk(chunk);
      const events: ModelStreamEvent[] = [];
      if (signature) events.push({ kind: 'thinking-signature', signature });
      // The signed reasoning chunk arrives as a standalone delta with empty
      // text; preserve provider-authored empty reasoning, but do not surface a
      // signature-only carrier as an additional empty reasoning fragment.
      if (text !== undefined && (text.length > 0 || signature === undefined)) {
        events.push({
          kind: 'thinking',
          text: restoreOpenAiChatEmptyReasoning(text),
          ...(responsesProviderOptions
            ? { providerOptions: responsesProviderOptions }
            : openAiChatReasoningTransportState
              ? {
                  providerOptions: openAiChatReasoningFieldProviderOptions(
                    openAiChatReasoningTransportState.reasoningField,
                  ),
                  providerOptionsOrigin: 'maka_transport' as const,
                }
              : {}),
        });
      }
      return events;
    }
    case 'reasoning-end': {
      const signature = reasoningSignatureFromChunk(chunk);
      const responsesProviderOptions = openAiResponsesReasoningProviderOptionsFromChunk(chunk);
      return [
        ...(signature ? [{ kind: 'thinking-signature' as const, signature }] : []),
        ...(responsesProviderOptions
          ? [{ kind: 'thinking' as const, text: '', providerOptions: responsesProviderOptions }]
          : []),
      ];
    }
    case 'tool-input-start':
    case 'tool-input-delta':
    case 'tool-input-end':
      return chunk.providerExecuted === true ? [{ kind: 'provider-tool-input' }] : [];
    // Step boundaries (`start-step` / `finish-step`) and the terminal `finish`
    // carry no text/thinking to stream. The backend owns step accounting: it
    // counts and flushes one AssistantMessage per step and rotates the
    // messageId at each `finish-step`. `step-finish` is legacy replay fixture
    // compatibility — handled as a step boundary, not a text carrier.
    case 'finish-step':
    case 'step-finish': {
      const finishReason = chunkFinishReason(chunk);
      // The same value the turn's outcome is decided from, so the record and
      // the outcome cannot name different reasons for the same stream.
      const usage = normalizeAiSdkUsage(chunk.usage, { rawFinishReason: finishReason });
      return [
        {
          kind: 'step-finish',
          ...(usage ? { usage } : {}),
          ...(finishReason ? { finishReason } : {}),
        },
      ];
    }
    case 'finish': {
      const finishReason = chunkFinishReason(chunk);
      return [{ kind: 'finish', ...(finishReason ? { finishReason } : {}) }];
    }
    case 'reasoning-start':
    case 'start-step':
    case 'tool-result':
    case 'tool-error': {
      if (
        chunk.providerExecuted !== true ||
        typeof chunk.toolCallId !== 'string' ||
        typeof chunk.toolName !== 'string'
      ) {
        return [];
      }
      return [
        {
          kind: 'provider-tool-result',
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          output: chunk.type === 'tool-error' ? chunk.error : (chunk.output ?? chunk.result),
          ...(chunk.type === 'tool-error' || chunk.isError === true ? { isError: true } : {}),
        },
      ];
    }
    case 'tool-call': {
      if (typeof chunk.toolCallId !== 'string' || typeof chunk.toolName !== 'string') return [];
      const toolCall: ToolCallPart = {
        type: 'tool-call',
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input:
          chunk.providerExecuted === true
            ? parseProviderExecutedToolInput(chunk.input ?? chunk.args)
            : (chunk.input ?? chunk.args),
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
      return [{ kind: 'error', failure: normalizeProviderFailure(chunk.error) }];
    default:
      return [];
  }
}

function parseProviderExecutedToolInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export function lowerModelTools(tools: ModelToolSet): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => [
      name,
      definition.kind === 'provider'
        ? compileProviderTool(definition.providerTool)
        : {
            ...(definition.description !== undefined
              ? { description: definition.description }
              : {}),
            inputSchema: definition.inputSchema,
          },
    ]),
  );
}

function compileProviderTool(
  tool: NonNullable<import('./tool-runtime.js').MakaTool['providerTool']>,
): unknown {
  switch (tool.kind) {
    case 'openai-apply-patch':
      return openAiApplyPatchProviderTool;
    case 'openai-custom-apply-patch':
      return codexV4aApplyPatchProviderTool;
    case 'openai-web-search':
      return openai.tools.webSearch({
        ...(tool.searchContextSize ? { searchContextSize: tool.searchContextSize } : {}),
      });
    case 'anthropic-web-search-20250305':
      return anthropic.tools.webSearch_20250305({
        ...(tool.maxUses !== undefined ? { maxUses: tool.maxUses } : {}),
      });
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

function normalizeProviderFailure(error: unknown): ModelFailure {
  if (isModelFailure(error)) return error;
  const summary = providerFailureSummary(error);
  const failure = normalizeModelFailure(error);
  return {
    ...failure,
    ...(summary?.code !== undefined ? { code: summary.code } : {}),
    ...(failure.kind === 'unknown' && summary !== undefined ? { message: summary.message } : {}),
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
