import { createHash } from 'node:crypto';
import { generalizedErrorMessage, redactSecrets } from '@maka/core/redaction';
import type {
  CacheMissInputSource,
  ContextBudgetDiagnostic,
  PrefixChangeReason,
  PromptSegmentEstimate,
  ToolSchemaChangeReason,
  ToolAvailabilityDiagnostic,
} from '@maka/core/usage-stats/types';
import type { SandboxRunTraceProjection } from './sandbox/diagnostics.js';

export type RunTracePhase =
  | 'turn'
  | 'model'
  | 'tool'
  | 'permission'
  | 'sandbox'
  | 'skill'
  | 'plan'
  | 'abort'
  | 'usage';

export type RunTraceEventType =
  | 'turn_started'
  | 'sandbox_context_resolved'
  | 'plan_context_resolved'
  | 'plan_submitted'
  | 'plan_execution_started'
  | 'plan_progress_updated'
  | 'plan_execution_completed'
  | 'plan_execution_cancelled'
  | 'plan_execution_interrupted'
  | 'plan_execution_resumed'
  | 'plan_transition_failed'
  | 'model_resolved'
  | 'model_resolve_failed'
  | 'model_stream_started'
  | 'model_stream_completed'
  | 'model_stream_failed'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'skill_catalog_built'
  | 'skill_searched'
  | 'skill_loaded'
  | 'skill_load_failed'
  | 'permission_requested'
  | 'permission_decided'
  | 'permission_failed'
  | 'approval_routed'
  | 'auto_review_started'
  | 'auto_review_decided'
  | 'auto_review_failed'
  | 'sandbox_escalation_requested'
  | 'sandbox_escalation_granted'
  | 'sandbox_escalation_denied'
  | 'sandbox_escalation_applied'
  | 'sandbox_escalation_failed'
  | 'sandbox_denial_detected'
  | 'abort_requested'
  | 'usage_recorded';

export interface RunTraceEvent {
  id: string;
  sessionId: string;
  turnId: string;
  ts: number;
  phase: RunTracePhase;
  type: RunTraceEventType;
  message: string;
  data?: Record<string, unknown>;
}

export type RunTraceRecorder = (event: RunTraceEvent) => unknown;

const REDACTED_ERROR_MESSAGE_MAX_CHARS = 2_048;

export interface RunTraceInput {
  sessionId: string;
  turnId: string;
  connectionSlug: string;
  providerId: string;
  modelId: string;
  newId: () => string;
  now: () => number;
  record?: RunTraceRecorder;
}

export class RunTrace {
  constructor(private readonly input: RunTraceInput) {}

  emit(
    phase: RunTracePhase,
    type: RunTraceEventType,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const event: RunTraceEvent = {
      id: this.input.newId(),
      sessionId: this.input.sessionId,
      turnId: this.input.turnId,
      ts: this.input.now(),
      phase,
      type,
      message,
      ...(data ? { data: sanitizeTraceData(data) } : {}),
    };
    try {
      const recorded = this.input.record?.(event);
      if (isPromiseLike(recorded)) void Promise.resolve(recorded).catch(() => {});
    } catch {
      // Tracing is diagnostic-only and must not perturb model/tool execution.
    }
  }

  turnStarted(extra: Record<string, unknown> = {}): void {
    this.emit('turn', 'turn_started', 'Turn started', {
      connectionSlug: this.input.connectionSlug,
      providerId: this.input.providerId,
      modelId: this.input.modelId,
      ...extra,
    });
  }

  sandboxContextResolved(snapshot: SandboxRunTraceProjection): void {
    this.emit('sandbox', 'sandbox_context_resolved', 'Sandbox context resolved', { snapshot });
  }

  modelResolved(): void {
    this.emit('model', 'model_resolved', 'Model resolved', {
      connectionSlug: this.input.connectionSlug,
      providerId: this.input.providerId,
      modelId: this.input.modelId,
    });
  }

  modelResolveFailed(error: unknown): void {
    this.emit('model', 'model_resolve_failed', 'Model resolution failed', {
      error: explainError(error),
    });
  }

  modelStreamStarted(
    activeTools: readonly string[],
    prefix?: {
      systemPromptHash?: string;
      prefixHash: string;
      prefixChangeReason: PrefixChangeReason;
      requestShapeHash?: string;
      requestShapeChangeReason?: PrefixChangeReason;
      toolSchemaChangeReason?: ToolSchemaChangeReason;
      toolAvailability?: ToolAvailabilityDiagnostic;
      promptSegments?: PromptSegmentEstimate[];
      contextBudget?: ContextBudgetDiagnostic;
    },
  ): void {
    this.emit('model', 'model_stream_started', 'Model stream started', {
      activeTools: [...activeTools],
      ...(prefix !== undefined ? prefix : {}),
    });
  }

  modelStreamCompleted(stopReason: string): void {
    this.emit('model', 'model_stream_completed', 'Model stream completed', {
      stopReason,
    });
  }

  modelStreamFailed(
    errorClass: string | undefined,
    error: unknown,
    replay?: { gate: string; diagnosticCodes: readonly string[] },
  ): void {
    this.emit('model', 'model_stream_failed', 'Model stream failed', {
      ...(errorClass ? { errorClass } : {}),
      ...(replay
        ? {
            priorReplayGate: replay.gate,
            priorReplayDiagnosticCodes: [...replay.diagnosticCodes],
          }
        : {}),
      error: explainError(error),
      ...diagnoseError(error),
    });
  }

  usageRecorded(usage: {
    inputTokens: number;
    outputTokens: number;
    cacheHitInputTokens: number;
    cacheMissInputTokens: number;
    cacheMissInputSource?: CacheMissInputSource;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    rawFinishReason?: string;
    costUsd?: number;
    systemPromptHash?: string;
    prefixHash?: string;
    prefixChangeReason?: PrefixChangeReason;
    requestShapeHash?: string;
    requestShapeChangeReason?: PrefixChangeReason;
    toolSchemaChangeReason?: ToolSchemaChangeReason;
    toolAvailability?: ToolAvailabilityDiagnostic;
  }): void {
    this.emit('usage', 'usage_recorded', 'Token usage recorded', {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheHitInputTokens: usage.cacheHitInputTokens,
      cacheMissInputTokens: usage.cacheMissInputTokens,
      ...(usage.cacheMissInputSource !== undefined
        ? { cacheMissInputSource: usage.cacheMissInputSource }
        : {}),
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      ...(usage.rawFinishReason !== undefined ? { rawFinishReason: usage.rawFinishReason } : {}),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
      ...(usage.systemPromptHash !== undefined ? { systemPromptHash: usage.systemPromptHash } : {}),
      ...(usage.prefixHash !== undefined ? { prefixHash: usage.prefixHash } : {}),
      ...(usage.prefixChangeReason !== undefined
        ? { prefixChangeReason: usage.prefixChangeReason }
        : {}),
      ...(usage.requestShapeHash !== undefined ? { requestShapeHash: usage.requestShapeHash } : {}),
      ...(usage.requestShapeChangeReason !== undefined
        ? { requestShapeChangeReason: usage.requestShapeChangeReason }
        : {}),
      ...(usage.toolSchemaChangeReason !== undefined
        ? { toolSchemaChangeReason: usage.toolSchemaChangeReason }
        : {}),
      ...(usage.toolAvailability !== undefined ? { toolAvailability: usage.toolAvailability } : {}),
    });
  }

  abortRequested(reason: string): void {
    this.emit('abort', 'abort_requested', 'Abort requested', { reason });
  }
}

export interface RunTraceLike {
  emit(
    phase: RunTracePhase,
    type: RunTraceEventType,
    message: string,
    data?: Record<string, unknown>,
  ): void;
}

export function explainError(error: unknown): string {
  return generalizedErrorMessage(error);
}

function diagnoseError(error: unknown): Record<string, unknown> {
  const rawMessage = rawErrorMessage(error);
  const redactedMessage = redactSecrets(rawMessage);
  const stack =
    error instanceof Error && typeof error.stack === 'string'
      ? redactSecrets(error.stack)
      : undefined;
  const message = truncate(redactedMessage, REDACTED_ERROR_MESSAGE_MAX_CHARS);

  return {
    rawErrorName: rawErrorName(error),
    rawErrorType: typeof error,
    redactedErrorMessage: message.text,
    redactedErrorMessageSha256: sha256(redactedMessage),
    ...(message.truncated ? { redactedErrorMessageTruncated: true } : {}),
    ...(stack ? { redactedErrorStackSha256: sha256(stack) } : {}),
  };
}

function rawErrorName(error: unknown): string {
  if (error instanceof Error && typeof error.name === 'string' && error.name.length > 0) {
    return error.name;
  }
  if (error === null) return 'null';
  return typeof error;
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const serialized = JSON.stringify(error);
    if (typeof serialized === 'string') return serialized;
  } catch {
    // Fall back to string coercion for cyclic or otherwise unserializable values.
  }
  try {
    return String(error);
  } catch {
    return '[unprintable error]';
  }
}

function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sanitizeTraceData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
      (typeof value === 'object' || typeof value === 'function') &&
      'then' in value &&
      typeof value.then === 'function',
  );
}
