/**
 * Maka-owned provider-boundary model protocol types (#1381 slice 1).
 *
 * This module is the single seam where the provider-boundary message/value
 * contract is *owned* by Maka. Runtime consumers (history projection,
 * compaction, context budget, request shape, tool output, the adapter
 * itself) import these names from here — never from `ai` — so AI SDK type
 * changes no longer propagate past the `ModelAdapter` boundary.
 *
 * The shapes defined here are structurally equivalent to the AI SDK 7
 * `@ai-sdk/provider-utils` message/value unions, but they are **Maka-owned**:
 * the generated declaration of this module imports nothing from `ai` or
 * `@ai-sdk/*`. Lowering Maka messages to AI SDK types, and normalizing AI SDK
 * responses back to Maka types, happens only inside `ModelAdapter`
 * (`model-adapter.ts`); that module is the lone runtime file permitted to
 * import the SDK protocol types for the lowering/normalization cast.
 *
 * Schema helpers (`jsonSchema` / `zodSchema`) and SDK value imports
 * (`generateText`, `RetryError`, ...) remain local implementation details or
 * follow-up work (RFC #1381 follow-up Q2/Q4) and are deliberately out of scope
 * for this seam.
 */

import type { CacheMissInputSource } from '@maka/core/usage-stats/types';

// ---------------------------------------------------------------------------
// JSON value contract
// ---------------------------------------------------------------------------

export type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
export type JSONObject = { [key: string]: JSONValue | undefined };
export type JSONArray = JSONValue[];

// ---------------------------------------------------------------------------
// Provider options contract
// ---------------------------------------------------------------------------

/**
 * Provider-specific option bag, keyed by provider name. Mirrors the AI SDK
 * `SharedV4ProviderOptions` shape so pass-through values stay structurally
 * compatible across the lowering cast.
 */
export type ProviderOptions = Record<string, JSONObject>;

/**
 * A mapping of provider names to provider-specific file identifiers. A
 * provider reference identifies a file across providers without re-uploading.
 * The `type?: never` constraint excludes any object that has a `type` property,
 * so a provider reference cannot be confused with a tagged `FileData` shape
 * (`{ type: 'data', data }` / `{ type: 'reference', reference }`) when both
 * appear in the same union.
 */
export type ProviderReference = Record<string, string> & { type?: never };

// ---------------------------------------------------------------------------
// File / data content contract
// ---------------------------------------------------------------------------

export type DataContent = string | Uint8Array | ArrayBuffer | Buffer;

export interface FileDataData {
  type: 'data';
  data: DataContent;
}
export interface FileDataUrl {
  type: 'url';
  url: URL;
}
export interface FileDataReference {
  type: 'reference';
  reference: ProviderReference;
}
export interface FileDataText {
  type: 'text';
  text: string;
}
export type FileData = FileDataData | FileDataUrl | FileDataReference | FileDataText;

// ---------------------------------------------------------------------------
// Content part contract
// ---------------------------------------------------------------------------

export interface TextPart {
  type: 'text';
  text: string;
  providerOptions?: ProviderOptions;
}

export interface ImagePart {
  type: 'image';
  image: DataContent | URL | ProviderReference;
  mediaType?: string;
  providerOptions?: ProviderOptions;
}

export interface FilePart {
  type: 'file';
  data: FileData | DataContent | URL | ProviderReference;
  filename?: string;
  mediaType: string;
  providerOptions?: ProviderOptions;
}

export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  providerOptions?: ProviderOptions;
}

export interface CustomPart {
  type: 'custom';
  kind: `${string}.${string}`;
  providerOptions?: ProviderOptions;
}

export interface ReasoningFilePart {
  type: 'reasoning-file';
  data: FileDataData | FileDataUrl | DataContent | URL;
  mediaType: string;
  providerOptions?: ProviderOptions;
}

export interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerOptions?: ProviderOptions;
  providerExecuted?: boolean;
}

export type ToolApprovalRequest = {
  type: 'tool-approval-request';
  approvalId: string;
  toolCallId: string;
  isAutomatic?: boolean;
  signature?: string;
};

export type ToolApprovalResponse = {
  type: 'tool-approval-response';
  approvalId: string;
  approved: boolean;
  reason?: string;
  providerExecuted?: boolean;
};

// ---------------------------------------------------------------------------
// Tool result output contract
// ---------------------------------------------------------------------------

/** One part of a `content`-shaped tool result output. */
export type ToolResultContentPart =
  | { type: 'text'; text: string; providerOptions?: ProviderOptions }
  | {
      type: 'file';
      data: FileData;
      mediaType: string;
      filename?: string;
      providerOptions?: ProviderOptions;
    }
  | { type: 'custom'; providerOptions?: ProviderOptions };

export type ToolResultOutput =
  | { type: 'text'; value: string; providerOptions?: ProviderOptions }
  | { type: 'json'; value: JSONValue; providerOptions?: ProviderOptions }
  | { type: 'execution-denied'; reason?: string; providerOptions?: ProviderOptions }
  | { type: 'error-text'; value: string; providerOptions?: ProviderOptions }
  | { type: 'error-json'; value: JSONValue; providerOptions?: ProviderOptions }
  | { type: 'content'; value: ToolResultContentPart[] };

/**
 * Maka-owned provider-facing tool contract. The schema stays opaque because
 * schema construction is a local implementation detail. Execution belongs to
 * ToolRuntime and never crosses the provider adapter boundary.
 */
export type ModelToolDefinition =
  | {
      kind?: 'function';
      description?: string;
      inputSchema: unknown;
      execute?: unknown;
    }
  | {
      kind: 'provider';
      providerTool: NonNullable<import('./tool-runtime.js').MakaTool['providerTool']>;
    };

export type ModelToolSet = Record<string, ModelToolDefinition>;

export interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
  providerOptions?: ProviderOptions;
}

// ---------------------------------------------------------------------------
// Message contract
// ---------------------------------------------------------------------------

export type AssistantContent =
  | string
  | Array<
      | TextPart
      | CustomPart
      | FilePart
      | ReasoningPart
      | ReasoningFilePart
      | ToolCallPart
      | ToolResultPart
      | ToolApprovalRequest
    >;
export type UserContent = string | Array<TextPart | ImagePart | FilePart>;
export type ToolContent = Array<ToolResultPart | ToolApprovalResponse>;

export interface SystemModelMessage {
  role: 'system';
  content: string;
  providerOptions?: ProviderOptions;
}
export interface UserModelMessage {
  role: 'user';
  content: UserContent;
  providerOptions?: ProviderOptions;
}
export interface AssistantModelMessage {
  role: 'assistant';
  content: AssistantContent;
  providerOptions?: ProviderOptions;
}
export interface ToolModelMessage {
  role: 'tool';
  content: ToolContent;
  providerOptions?: ProviderOptions;
}

/**
 * The canonical provider-boundary message shape. One arm per role, matching
 * the AI SDK `ModelMessage` union used by `streamText` / `generateText`.
 * Consumers build and read this Maka-owned union; `ModelAdapter` lowers it to
 * the AI SDK message type at the request boundary.
 */
export type ModelMessage =
  | SystemModelMessage
  | UserModelMessage
  | AssistantModelMessage
  | ToolModelMessage;

// ---------------------------------------------------------------------------
// Completion / usage / finish-reason contract
// ---------------------------------------------------------------------------

/**
 * Raw provider usage fields the AI SDK surfaces, mirrored here so the
 * normalized usage can carry a verbatim provider view without importing `ai`.
 * Owned by Maka; only the `ModelAdapter` normalization helper reads it.
 */
export interface RawUsageFields {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * Maka-owned, provider-agnostic token-usage contract. `ModelAdapter`
 * normalizes the AI SDK usage shape into this stable contract; runtime
 * consumers (compaction cost, telemetry, token-usage events) read only this
 * shape and never the SDK usage union.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens: number;
  cacheMissInputTokens: number;
  cacheMissInputSource: CacheMissInputSource;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  rawFinishReason?: string;
  raw?: RawUsageFields;
  /** Backward-compatible alias for `cacheHitInputTokens`. */
  cachedInputTokens: number;
}

export function rawFinishReasonString(reason: unknown): string | undefined {
  if (typeof reason === 'string') return reason;
  if (!reason || typeof reason !== 'object') return undefined;
  const value = reason as { raw?: unknown; unified?: unknown };
  if (typeof value.raw === 'string') return value.raw;
  return typeof value.unified === 'string' ? value.unified : undefined;
}

/**
 * Normalized provider finish reason as a Maka-owned string. The raw AI SDK
 * finish-reason value (string or `{ raw, unified }` object) is reduced at the
 * provider boundary; downstream code compares against the string literal
 * (e.g. `'tool-calls'`) or maps it via `ModelAdapter.mapFinishReason`.
 */
export type ModelFinishReason = string;

// ---------------------------------------------------------------------------
// Failure contract
// ---------------------------------------------------------------------------

/**
 * Stable failure categories consumed by Runtime policy. Provider-specific
 * error objects and AI SDK wrappers are classified inside `ModelAdapter` and
 * never cross the boundary.
 */
export type ModelFailureKind =
  | 'abort'
  | 'auth'
  | 'context_overflow'
  | 'network'
  | 'provider_billing'
  | 'provider_unavailable'
  | 'rate_limit'
  | 'timeout'
  | 'unknown';

export interface ModelFailure {
  type: 'model_failure';
  kind: ModelFailureKind;
  message: string;
  /** Adapter-owned transport fact consumed by Runtime retry policy. */
  retryable: boolean;
  /** Provider-requested delay for the next physical attempt, in milliseconds. */
  retryAfterMs?: number;
  code?: string;
}

/**
 * Provider request metadata reduced to the Maka-owned message projection.
 * Headers and provider request bodies stay with ProviderRequestTracker, their
 * existing capture owner, instead of being retained again by the stream result.
 */
export interface ModelRequestMetadata {
  messages?: readonly ModelMessage[];
}

// ---------------------------------------------------------------------------
// Stream-event / stream-result contract
// ---------------------------------------------------------------------------

/**
 * Maka-owned discriminated stream event. `ModelAdapter` translates each raw
 * AI SDK stream chunk into zero or more of these events; runtime consumers
 * iterate `ModelStreamResult.events` and never see raw SDK chunk names.
 *
 * - `text` / `thinking`: incremental assistant content deltas for the current
 *   step. The backend accumulates them per step and flushes one
 *   `AssistantMessage` (+ terminal text/thinking `SessionEvent`s) at the
 *   next `step-finish`.
 * - `thinking-signature`: a provider-signed reasoning signature (Anthropic)
 *   delivered out-of-band from the thinking text.
 * - `step-finish`: a provider step boundary. Carries the step's normalized
 *   usage (already reduced to `NormalizedUsage`) and normalized finish
 *   reason. The backend owns step counting, the per-step `AssistantMessage`
 *   flush, and the messageId rotation.
 * - `finish`: the terminal stream boundary, carrying the normalized finish
 *   reason.
 * - `error`: a request-level provider failure, already classified and scrubbed
 *   by the adapter. The backend uses its stable kind for overflow/transport
 *   recovery and terminal error emission.
 */
export type ModelStreamEvent =
  | { kind: 'text-start' }
  | { kind: 'text'; text: string }
  | { kind: 'text-metadata'; providerOptions: ProviderOptions }
  | {
      kind: 'thinking';
      text: string;
      providerOptions?: ProviderOptions;
      /** Maka-authored replay hint; absent provider metadata stays fail-closed. */
      providerOptionsOrigin?: 'maka_transport';
    }
  | { kind: 'thinking-signature'; signature: string }
  /** Provider-side tool execution has begun, but no replayable call exists yet. */
  | { kind: 'provider-tool-input' }
  | { kind: 'tool-call'; toolCall: ToolCallPart }
  | {
      kind: 'provider-tool-result';
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError?: boolean;
    }
  | { kind: 'step-finish'; usage?: NormalizedUsage; finishReason?: ModelFinishReason }
  | { kind: 'finish'; finishReason?: ModelFinishReason }
  | { kind: 'error'; failure: ModelFailure };

export type ModelStepOutcome =
  | {
      kind: 'completed';
      finishReason: ModelFinishReason;
      usage?: NormalizedUsage;
      request: ModelRequestMetadata;
      continuation: 'none' | 'pending';
    }
  | {
      kind: 'truncated' | 'retryable-failure' | 'terminal-failure' | 'aborted';
      failure: ModelFailure;
      usage?: NormalizedUsage;
      request: ModelRequestMetadata;
      continuation: 'none';
    };

/** One physical provider request: live output plus one authoritative settlement. */
export interface ModelStreamResult {
  events: AsyncIterable<ModelStreamEvent>;
  outcome: Promise<ModelStepOutcome>;
}
