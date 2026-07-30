import { readFile } from 'node:fs/promises';
import { decodeAgentRunEvent } from '@maka/core';
import {
  findFirstChangedCacheableSegment,
  type PreparedRequestSegment,
  type PreparedRequestSegmentRef,
  type ProviderRequestAttemptRecord,
} from '@maka/runtime';

export interface ProviderRequestTraceIdentity {
  runId: string;
  sessionId: string;
  turnId: string;
}

export interface ProviderRequestTraceCaptureAnalysis {
  schemaVersion: 1 | 2;
  traceId: string;
  captureId: string;
  artifactId: string;
  turnId: string;
  step: number;
  providerId: string;
  modelId: string;
  requestHash: string;
  requestPayloadWithoutProviderOptionsHash?: string;
  requestBytes: number;
  segments: PreparedRequestSegment[];
  firstChangedCacheableSegment?: PreparedRequestSegmentRef;
}

export type ProviderRequestTraceAttemptAnalysis = ProviderRequestAttemptRecord;

export type ProviderRequestTraceDiagnosticCode =
  | 'invalid_json'
  | 'invalid_agent_run_event'
  | 'invalid_capture'
  | 'invalid_attempt'
  | 'trace_write_failed'
  | 'event_corrupt'
  | 'mixed_identity';

export interface ProviderRequestTraceDiagnostic {
  code: ProviderRequestTraceDiagnosticCode;
  line: number;
  message: string;
}

export interface ProviderRequestTraceAnalysis {
  identity?: ProviderRequestTraceIdentity;
  /** Every exported top-level execution represented by this task trace. */
  identities?: ProviderRequestTraceIdentity[];
  traceId?: string;
  captures: ProviderRequestTraceCaptureAnalysis[];
  attempts: ProviderRequestTraceAttemptAnalysis[];
  diagnostics: ProviderRequestTraceDiagnostic[];
}

export interface AssertProviderRequestTraceCompleteOptions {
  expectedIdentity?: ProviderRequestTraceIdentity;
  expectedIdentities?: readonly ProviderRequestTraceIdentity[];
  label?: string;
}

/** Read Harbor's existing AgentRun events.jsonl; no provider-proxy sidecar is required. */
export async function readProviderRequestTrace(
  traceEventsPath: string,
): Promise<ProviderRequestTraceAnalysis> {
  const text = await readFile(traceEventsPath, 'utf8');
  const captures: ProviderRequestTraceCaptureAnalysis[] = [];
  const attempts: ProviderRequestTraceAttemptAnalysis[] = [];
  const diagnostics: ProviderRequestTraceDiagnostic[] = [];
  let identity: ProviderRequestTraceIdentity | undefined;
  const identities: ProviderRequestTraceIdentity[] = [];
  const identityByRunId = new Map<string, ProviderRequestTraceIdentity>();
  const identityByTurnId = new Map<string, ProviderRequestTraceIdentity>();
  let traceId: string | undefined;
  const lastCaptureByTraceId = new Map<string, ProviderRequestTraceCaptureAnalysis>();

  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    const lineNumber = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      diagnostics.push({
        code: 'invalid_json',
        line: lineNumber,
        message: 'provider request trace row is not valid JSON',
      });
      continue;
    }

    let event: ReturnType<typeof decodeAgentRunEvent>;
    try {
      event = decodeAgentRunEvent(value);
    } catch {
      diagnostics.push({
        code: 'invalid_agent_run_event',
        line: lineNumber,
        message: 'provider request trace row is not a valid AgentRun event',
      });
      continue;
    }
    if (
      event.type !== 'provider_request_captured' &&
      event.type !== 'provider_request_attempt_recorded' &&
      event.type !== 'trace_write_failed' &&
      event.type !== 'event_corrupt'
    ) {
      continue;
    }

    const eventIdentity = identityFromEvent(event);
    if (!identity) {
      identity = eventIdentity;
    }
    const conflictingIdentity =
      identityByRunId.get(eventIdentity.runId) ?? identityByTurnId.get(eventIdentity.turnId);
    if (conflictingIdentity && !sameIdentity(conflictingIdentity, eventIdentity)) {
      diagnostics.push({
        code: 'mixed_identity',
        line: lineNumber,
        message: `provider request trace row identity ${formatIdentity(eventIdentity)} differs from ${formatIdentity(conflictingIdentity)}`,
      });
    } else if (!identities.some((candidate) => sameIdentity(candidate, eventIdentity))) {
      identities.push(eventIdentity);
      identityByRunId.set(eventIdentity.runId, eventIdentity);
      identityByTurnId.set(eventIdentity.turnId, eventIdentity);
    }

    if (event.type === 'trace_write_failed' || event.type === 'event_corrupt') {
      diagnostics.push({
        code: event.type,
        line: lineNumber,
        message: `provider request trace contains ${event.type.replaceAll('_', ' ')} evidence`,
      });
      continue;
    }

    if (event.type === 'provider_request_captured') {
      const parsed = captureFromEvent(event.turnId, event.data);
      if ('error' in parsed) {
        diagnostics.push({ code: 'invalid_capture', line: lineNumber, message: parsed.error });
        continue;
      }
      traceId ??= parsed.value.traceId;
      const prior = lastCaptureByTraceId.get(parsed.value.traceId);
      captures.push({
        ...parsed.value,
        ...(prior
          ? {
              firstChangedCacheableSegment: findFirstChangedCacheableSegment(parsed.value, prior),
            }
          : {}),
      });
      lastCaptureByTraceId.set(parsed.value.traceId, parsed.value);
      continue;
    }

    const parsed = attemptFromEvent(event.turnId, event.data);
    if ('error' in parsed) {
      diagnostics.push({ code: 'invalid_attempt', line: lineNumber, message: parsed.error });
      continue;
    }
    traceId ??= parsed.value.traceId;
    attempts.push(parsed.value);
  }

  return {
    ...(identity ? { identity } : {}),
    ...(identities.length > 0 ? { identities } : {}),
    ...(traceId ? { traceId } : {}),
    captures,
    attempts,
    diagnostics,
  };
}

/**
 * Validate tracked requests for exported top-level Harbor invocations.
 * Semantic-compaction and child-agent provider dispatches are outside this
 * artifact contract. A pre-dispatch cancellation is intentionally incomplete
 * because it is indistinguishable from a missing attempt row.
 */
export function assertProviderRequestTraceComplete(
  trace: ProviderRequestTraceAnalysis,
  options: AssertProviderRequestTraceCompleteOptions = {},
): void {
  const label = options.label ?? 'Provider request trace';
  const fail = (message: string): never => {
    throw new Error(`${label}: ${message}`);
  };
  const diagnostic = trace.diagnostics[0];
  if (diagnostic) fail(`line ${diagnostic.line}: ${diagnostic.message}`);
  const identities =
    trace.identities && trace.identities.length > 0
      ? trace.identities
      : trace.identity
        ? [trace.identity]
        : fail('has no execution identity');
  const identity = trace.identity ?? identities[0]!;
  if (options.expectedIdentity && options.expectedIdentities) {
    fail('cannot validate both expectedIdentity and expectedIdentities');
  }
  if (options.expectedIdentities) {
    const missing = options.expectedIdentities.find(
      (expected) => !identities.some((candidate) => sameIdentity(candidate, expected)),
    );
    const unexpected = identities.find(
      (candidate) =>
        !options.expectedIdentities!.some((expected) => sameIdentity(candidate, expected)),
    );
    if (missing || unexpected || identities.length !== options.expectedIdentities.length) {
      fail(
        `execution identity set differs from expected; observed ${identities
          .map(formatIdentity)
          .join(', ')}`,
      );
    }
  } else if (options.expectedIdentity) {
    if (identities.length === 1) {
      for (const key of ['runId', 'sessionId', 'turnId'] as const) {
        if (identity[key] !== options.expectedIdentity[key]) {
          fail(`${key} expected ${options.expectedIdentity[key]}, observed ${identity[key]}`);
        }
      }
    } else {
      const foreignSession = identities.find(
        (candidate) => candidate.sessionId !== options.expectedIdentity!.sessionId,
      );
      if (foreignSession) {
        fail(
          `sessionId expected ${options.expectedIdentity.sessionId}, observed ${foreignSession.sessionId}`,
        );
      }
      if (!identities.some((candidate) => sameIdentity(candidate, options.expectedIdentity!))) {
        fail(
          `does not contain expected execution identity ${formatIdentity(options.expectedIdentity)}`,
        );
      }
    }
  }
  trace.traceId ?? fail('has no provider trace id');
  if (trace.captures.length === 0 || trace.attempts.length === 0) {
    fail('has incomplete provider request telemetry');
  }

  const captures = new Map<string, ProviderRequestTraceCaptureAnalysis>();
  const turnIdByTraceId = new Map<string, string>();
  for (const capture of trace.captures) {
    if (captures.has(capture.captureId)) fail(`has duplicate capture id ${capture.captureId}`);
    if (!identities.some((candidate) => candidate.turnId === capture.turnId)) {
      fail(`capture ${capture.captureId} has another turn id`);
    }
    const traceTurnId = turnIdByTraceId.get(capture.traceId);
    if (traceTurnId !== undefined && traceTurnId !== capture.turnId) {
      fail(`capture ${capture.captureId} has another turn id for trace ${capture.traceId}`);
    }
    turnIdByTraceId.set(capture.traceId, capture.turnId);
    captures.set(capture.captureId, capture);
  }

  const attemptIds = new Set<string>();
  const referencedCaptureIds = new Set<string>();
  const attemptNumbersByStep = new Map<string, number[]>();
  for (const attempt of trace.attempts) {
    if (attemptIds.has(attempt.attemptId)) fail(`has duplicate attempt id ${attempt.attemptId}`);
    attemptIds.add(attempt.attemptId);
    if (!identities.some((candidate) => candidate.turnId === attempt.turnId)) {
      fail(`attempt ${attempt.attemptId} has another turn id`);
    }
    const capture =
      captures.get(attempt.captureId) ??
      fail(`attempt ${attempt.attemptId} does not match its request capture`);
    if (!attemptMatchesCapture(attempt, capture)) {
      fail(`attempt ${attempt.attemptId} does not match its request capture`);
    }
    referencedCaptureIds.add(capture.captureId);
    const stepKey = `${attempt.traceId}\u0000${attempt.step}`;
    const numbers = attemptNumbersByStep.get(stepKey) ?? [];
    numbers.push(attempt.attempt);
    attemptNumbersByStep.set(stepKey, numbers);
  }

  for (const captureId of captures.keys()) {
    if (!referencedCaptureIds.has(captureId)) fail(`capture ${captureId} has no request attempt`);
  }
  for (const [stepKey, numbers] of attemptNumbersByStep) {
    numbers.sort((left, right) => left - right);
    for (let index = 0; index < numbers.length; index += 1) {
      if (numbers[index] !== index + 1) {
        const step = stepKey.slice(stepKey.lastIndexOf('\u0000') + 1);
        fail(`step ${step} request attempt sequence is incomplete`);
      }
    }
  }
}

type ParseResult<T> = { value: T } | { error: string };

function captureFromEvent(
  turnId: string,
  data: Record<string, unknown> | undefined,
): ParseResult<ProviderRequestTraceCaptureAnalysis> {
  if (!data) return { error: 'provider request capture has no data' };
  if (data.schemaVersion !== 1 && data.schemaVersion !== 2) {
    return { error: 'provider request capture has an unsupported schema version' };
  }
  if (data.turnId !== undefined && data.turnId !== turnId) {
    return { error: 'provider request capture turn id differs from its event envelope' };
  }
  if (!Array.isArray(data.segments)) {
    return { error: 'provider request capture segments are missing' };
  }
  const segments = data.segments.map(segmentFromValue);
  if (segments.some((segment) => segment === undefined)) {
    return { error: 'provider request capture contains an invalid segment' };
  }
  if (
    typeof data.traceId !== 'string' ||
    typeof data.captureId !== 'string' ||
    typeof data.artifactId !== 'string' ||
    !isNonNegativeInteger(data.step) ||
    typeof data.providerId !== 'string' ||
    typeof data.modelId !== 'string' ||
    typeof data.requestHash !== 'string' ||
    !isNonNegativeInteger(data.requestBytes) ||
    (data.requestPayloadWithoutProviderOptionsHash !== undefined &&
      typeof data.requestPayloadWithoutProviderOptionsHash !== 'string') ||
    (data.schemaVersion === 2 && typeof data.requestPayloadWithoutProviderOptionsHash !== 'string')
  ) {
    return { error: 'provider request capture data is invalid' };
  }
  return {
    value: {
      schemaVersion: data.schemaVersion,
      traceId: data.traceId,
      captureId: data.captureId,
      artifactId: data.artifactId,
      turnId,
      step: data.step,
      providerId: data.providerId,
      modelId: data.modelId,
      requestHash: data.requestHash,
      ...(data.requestPayloadWithoutProviderOptionsHash !== undefined
        ? {
            requestPayloadWithoutProviderOptionsHash: data.requestPayloadWithoutProviderOptionsHash,
          }
        : {}),
      requestBytes: data.requestBytes,
      segments: segments as PreparedRequestSegment[],
    },
  };
}

function attemptFromEvent(
  turnId: string,
  data: Record<string, unknown> | undefined,
): ParseResult<ProviderRequestTraceAttemptAnalysis> {
  if (!data) return { error: 'provider request attempt has no data' };
  if (data.turnId !== turnId) {
    return { error: 'provider request attempt turn id differs from its event envelope' };
  }
  if (!Array.isArray(data.segments)) {
    return { error: 'provider request attempt segments are missing' };
  }
  const segments = data.segments.map(segmentFromValue);
  if (segments.some((segment) => segment === undefined)) {
    return { error: 'provider request attempt contains an invalid segment' };
  }
  const requiredStrings = [
    'traceId',
    'attemptId',
    'captureId',
    'captureArtifactId',
    'providerId',
    'modelId',
    'requestHash',
  ] as const;
  if (
    requiredStrings.some((key) => typeof data[key] !== 'string') ||
    !isNonNegativeInteger(data.step) ||
    !isPositiveInteger(data.attempt) ||
    !isNonNegativeInteger(data.requestBytes) ||
    (data.contextWindow !== undefined && !isPositiveInteger(data.contextWindow)) ||
    !isNonNegativeFiniteNumber(data.startedAt) ||
    !isNonNegativeFiniteNumber(data.completedAt) ||
    !isAttemptStatus(data.status) ||
    !isNonNegativeFiniteNumber(data.latencyMs) ||
    (data.finishReason !== undefined && typeof data.finishReason !== 'string') ||
    (data.timeToFirstTokenMs !== undefined && !isNonNegativeFiniteNumber(data.timeToFirstTokenMs))
  ) {
    return { error: 'provider request attempt data is invalid' };
  }
  const optionalTokens = [
    'inputTokens',
    'cacheReadInputTokens',
    'cacheMissInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
    'reasoningTokens',
  ] as const;
  if (
    optionalTokens.some((key) => data[key] !== undefined && !isNonNegativeInteger(data[key])) ||
    !validSource(data.cacheReadInputSource) ||
    !validSource(data.cacheMissInputSource) ||
    !validSource(data.cacheWriteInputSource)
  ) {
    return { error: 'provider request attempt usage is invalid' };
  }
  const inputTokens = data.inputTokens as number | undefined;
  const cacheReadInputTokens = data.cacheReadInputTokens as number | undefined;
  const cacheMissInputTokens = data.cacheMissInputTokens as number | undefined;
  const cacheWriteInputTokens = data.cacheWriteInputTokens as number | undefined;
  const outputTokens = data.outputTokens as number | undefined;
  const reasoningTokens = data.reasoningTokens as number | undefined;
  const contextWindow = data.contextWindow as number | undefined;
  const cacheReadInputSource = data.cacheReadInputSource as
    | ProviderRequestAttemptRecord['cacheReadInputSource']
    | undefined;
  const cacheMissInputSource = data.cacheMissInputSource as
    | ProviderRequestAttemptRecord['cacheMissInputSource']
    | undefined;
  const cacheWriteInputSource = data.cacheWriteInputSource as
    | ProviderRequestAttemptRecord['cacheWriteInputSource']
    | undefined;
  return {
    value: {
      traceId: data.traceId as string,
      attemptId: data.attemptId as string,
      turnId,
      step: data.step,
      attempt: data.attempt,
      captureId: data.captureId as string,
      captureArtifactId: data.captureArtifactId as string,
      providerId: data.providerId as string,
      modelId: data.modelId as string,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      requestHash: data.requestHash as string,
      requestBytes: data.requestBytes,
      segments: segments as PreparedRequestSegment[],
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      status: data.status,
      ...(data.finishReason !== undefined ? { finishReason: data.finishReason } : {}),
      latencyMs: data.latencyMs,
      ...(data.timeToFirstTokenMs !== undefined
        ? { timeToFirstTokenMs: data.timeToFirstTokenMs }
        : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
      ...(cacheReadInputSource !== undefined ? { cacheReadInputSource } : {}),
      ...(cacheMissInputTokens !== undefined ? { cacheMissInputTokens } : {}),
      ...(cacheMissInputSource !== undefined ? { cacheMissInputSource } : {}),
      ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
      ...(cacheWriteInputSource !== undefined ? { cacheWriteInputSource } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    },
  };
}

function attemptMatchesCapture(
  attempt: ProviderRequestTraceAttemptAnalysis,
  capture: ProviderRequestTraceCaptureAnalysis,
): boolean {
  return (
    attempt.traceId === capture.traceId &&
    attempt.captureArtifactId === capture.artifactId &&
    attempt.turnId === capture.turnId &&
    attempt.step === capture.step &&
    attempt.providerId === capture.providerId &&
    attempt.modelId === capture.modelId &&
    attempt.requestHash === capture.requestHash &&
    attempt.requestBytes === capture.requestBytes &&
    segmentsEqual(attempt.segments, capture.segments)
  );
}

function segmentsEqual(
  left: readonly PreparedRequestSegment[],
  right: readonly PreparedRequestSegment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        segment.kind === other.kind &&
        segment.index === other.index &&
        segment.cacheable === other.cacheable &&
        segment.hash === other.hash &&
        segment.bytes === other.bytes &&
        segment.role === other.role
      );
    })
  );
}

function segmentFromValue(value: unknown): PreparedRequestSegment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const segment = value as Record<string, unknown>;
  if (
    !['tool_schema', 'system_prompt', 'message', 'provider_options'].includes(
      String(segment.kind),
    ) ||
    !isNonNegativeInteger(segment.index) ||
    typeof segment.cacheable !== 'boolean' ||
    typeof segment.hash !== 'string' ||
    !isNonNegativeInteger(segment.bytes) ||
    (segment.role !== undefined && typeof segment.role !== 'string')
  ) {
    return undefined;
  }
  return segment as unknown as PreparedRequestSegment;
}

function identityFromEvent(
  event: ReturnType<typeof decodeAgentRunEvent>,
): ProviderRequestTraceIdentity {
  return { runId: event.runId, sessionId: event.sessionId, turnId: event.turnId };
}

function sameIdentity(
  left: ProviderRequestTraceIdentity,
  right: ProviderRequestTraceIdentity,
): boolean {
  return (
    left.runId === right.runId && left.sessionId === right.sessionId && left.turnId === right.turnId
  );
}

function formatIdentity(identity: ProviderRequestTraceIdentity): string {
  return `${identity.runId}/${identity.sessionId}/${identity.turnId}`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isAttemptStatus(value: unknown): value is ProviderRequestAttemptRecord['status'] {
  return (
    value === 'completed' || value === 'failed' || value === 'interrupted' || value === 'aborted'
  );
}

function validSource(
  value: unknown,
): value is ProviderRequestAttemptRecord['cacheReadInputSource'] {
  return value === undefined || value === 'provider' || value === 'derived';
}
