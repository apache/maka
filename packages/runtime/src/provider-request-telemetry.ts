/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import {
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
  type ModelCallKind,
  type ModelCallUsageBasis,
} from '@maka/core/model-call-attempt';
import type { PricingConfig } from '@maka/core/usage-stats/types';
import {
  capturePreparedProviderRequest,
  type PreparedProviderRequestCapture,
  type PreparedRequestSegment,
} from './request-shape.js';
import { rawFinishReasonString } from './model-protocol.js';
import {
  providerFailureDiagnostic,
  type ProviderFailureDiagnostic,
} from './provider-error-classification.js';
import { latestContextProjectionInput } from './latest-context-snapshot.js';
import type { ContextDiagnosticsCompaction } from './context-diagnostics.js';
import type { ModelCallCommit } from '@maka/core/agent-run';

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
    | {
        total?: number;
        noCache?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
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
  /**
   * Present only when a capture sink is wired. The request shape below is
   * computed locally and always present; these two are the join keys to the
   * persisted artifact, so they are absent when there is nothing to join to.
   */
  captureId?: string;
  captureArtifactId?: string;
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
  failure?: ProviderFailureDiagnostic;
  latencyMs: number;
  timeToFirstTokenMs?: number;
}

/**
 * Cost resolved at the moment a call settles, plus the basis it was resolved
 * against. Recording the basis alongside the amount is what makes a stored
 * figure auditable later, when rates may have changed.
 */
export interface ResolvedModelCallCost {
  costUsd?: number;
  pricingRevision?: number;
  pricingRates?: PricingConfig;
}

export interface ProviderRequestTrackerInput {
  traceId: string;
  turnId: string;
  contextWindow?: number;
  now: () => number;
  newId: () => string;
  /**
   * Request-body capture sink. Optional because capture is a diagnostic, and
   * metering must not depend on one: a deployment with capture switched off
   * still settles canonical records, it just has no artifact to join them to.
   */
  persistCapture?: (
    capture: ProviderRequestCaptureRecord,
  ) => Promise<Pick<ProviderRequestCaptureRef, 'artifactId'>>;
  recordAttempt: (attempt: ProviderRequestAttemptRecord) => void | Promise<void>;
  /**
   * Durable run metadata that must exist before any physical provider call.
   * Kept outside accounting because a dispatch gate is an execution contract,
   * not a metering concern.
   */
  beforeDispatch?: () => void | Promise<void>;

  /**
   * Canonical metering. Present as a unit or not at all: a `ModelCallAttempt`
   * without session, run, and kind is unattributable, so identity and sink are
   * wired together rather than as independently optional fields. Absent leaves
   * the tracker purely diagnostic, which is what the capture-only tests use.
   */
  accounting?: ModelCallAccountingInput;
}

export interface ModelCallAccountingInput {
  sessionId: string;
  /** Resolved per send: one tracker does not outlive a single run. */
  resolveRunId: () => string | undefined;
  /**
   * The connection the request was dispatched over. Without it a record is
   * attributable to a provider and model but not to the configured connection,
   * which is what the Usage surface filters and groups by.
   */
  connectionSlug?: string;
  /**
   * The connection's provider type, which is the vocabulary the Usage surface
   * groups by. The diagnostic record carries the SDK's own provider id instead
   * (`moonshot.chat` where this says `moonshot`); metering must not split one
   * provider across two bucket keys, so accounting uses this when given.
   */
  providerId?: string;
  callKind: ModelCallKind;
  historyCompactRoute?: ModelCallAttempt['historyCompactRoute'];
  /**
   * Commits the attempt, and with it the derived latest-context row when this
   * request is one that answers "what is the context made of" (#2323). One
   * call, so the two cannot fail or arrive independently.
   */
  record: (commit: ModelCallCommit<ModelCallAttempt>) => void | Promise<void>;
  /** Resolves cost at settlement time; absent means the price is unknown. */
  resolveCost?: (usage: ProviderRequestUsage) => ResolvedModelCallCost | undefined;
  /**
   * Pre-dispatch accounting gate. Throws when the canonical record could not be
   * written for this dispatch. Checked before the provider is called and never
   * from settlement — a rejection inside `finalize` would surface through the
   * stream's `pull` handler and error an otherwise-complete model response.
   */
  assertReady?: () => void;
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
  /**
   * The compaction boundary THIS request's prompt was built from (#2323).
   *
   * Per request rather than per tracker: one tracker spans every physical
   * request of a send, and mid-turn compaction or overflow recovery can
   * prepare the next request against a different boundary. Read at settlement
   * it would be whatever the session holds by then — a boundary this prompt
   * may never have seen.
   */
  historyCompactBoundary?: ContextDiagnosticsCompaction;
}

export interface TrackProviderGenerateInput {
  providerId: string;
  modelId: string;
  /** As `TrackProviderStreamInput.historyCompactBoundary`. */
  historyCompactBoundary?: ContextDiagnosticsCompaction;
  params: Record<string, unknown>;
  abortSignal?: AbortSignal;
  doGenerate: () => PromiseLike<ProviderGenerateResult>;
}

interface ProviderMiddlewareGenerateInput {
  doGenerate: () => PromiseLike<ProviderGenerateResult>;
  params: Record<string, unknown> & { abortSignal?: AbortSignal };
  model: { provider: string; modelId: string };
}

interface ProviderMiddlewareStreamInput {
  doStream: () => PromiseLike<ProviderStreamResult>;
  params: Record<string, unknown> & { abortSignal?: AbortSignal };
  model: { provider: string; modelId: string };
}

/**
 * Wraps a language model so its single `generate` call is tracked.
 *
 * The AI SDK's `wrapLanguageModel` is passed in rather than imported: both
 * callers load the `ai` package dynamically, and there is no reason for this
 * module to load it a third time. Non-streaming counterpart of what
 * `ModelAdapter.startStream` does with `wrapStream`, and the only place either
 * auxiliary caller attaches a tracker to a model.
 */
export function withProviderGenerateTracking(input: {
  model: unknown;
  wrapLanguageModel: (input: Record<string, unknown>) => unknown;
  tracker: ProviderRequestTracker;
  abortSignal?: AbortSignal;
}): unknown {
  return input.wrapLanguageModel({
    model: input.model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params, model }: ProviderMiddlewareGenerateInput) =>
        await input.tracker.trackGenerate({
          providerId: model.provider,
          modelId: model.modelId,
          params,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          doGenerate,
        }),
    },
  });
}

/** Wraps a language model so its single streaming call is tracked. */
export function withProviderStreamTracking(input: {
  model: unknown;
  wrapLanguageModel: (input: Record<string, unknown>) => unknown;
  tracker: ProviderRequestTracker;
  abortSignal?: AbortSignal;
}): unknown {
  return input.wrapLanguageModel({
    model: input.model,
    middleware: {
      wrapStream: async ({ doStream, params, model }: ProviderMiddlewareStreamInput) =>
        await input.tracker.trackStream({
          providerId: model.provider,
          modelId: model.modelId,
          params,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          doStream,
        }),
    },
  });
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
  /** Absent when no capture sink is wired: there is no artifact to point at. */
  ref?: ProviderRequestCaptureRef;
}

const CANONICAL_USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheMissInputTokens',
  'cacheWriteInputTokens',
  'reasoningTokens',
] as const;

/**
 * Distinguishes "the provider never reported usage" from "it reported some of
 * it". Both differ from an unresolvable price, which `costBasis` carries.
 */
function resolveUsageBasis(usage: ProviderRequestUsage | undefined): ModelCallUsageBasis {
  if (!usage) return 'missing';
  const present = CANONICAL_USAGE_FIELDS.filter((field) => usage[field] !== undefined);
  if (present.length === 0) return 'missing';
  return usage.inputTokens !== undefined && usage.outputTokens !== undefined
    ? 'reported'
    : 'partial';
}

function modelCallUsageFields(
  usage: ProviderRequestUsage | undefined,
): Partial<Record<(typeof CANONICAL_USAGE_FIELDS)[number], number>> {
  if (!usage) return {};
  const fields: Partial<Record<(typeof CANONICAL_USAGE_FIELDS)[number], number>> = {};
  for (const field of CANONICAL_USAGE_FIELDS) {
    const value = usage[field];
    if (value !== undefined) fields[field] = value;
  }
  return fields;
}

export class ProviderRequestTracker {
  private step = 0;
  private readonly attemptsByStep = new Map<number, number>();
  private readonly captures = new Map<string, Promise<StoredCapture>>();
  /**
   * One logical call per step. Retries of the same step are further attempts of
   * that call, not new calls, so they share this id.
   */
  private readonly logicalCallIdByStep = new Map<number, string>();

  constructor(private readonly input: ProviderRequestTrackerInput) {}

  get traceId(): string {
    return this.input.traceId;
  }

  setStep(step: number): void {
    this.step = step;
  }

  async trackStream(input: TrackProviderStreamInput): Promise<ProviderStreamResult> {
    throwIfAbortedBeforeDispatch(input.abortSignal);
    await this.input.beforeDispatch?.();
    throwIfAbortedBeforeDispatch(input.abortSignal);
    this.input.accounting?.assertReady?.();
    const step = this.step;
    const capture = await this.capture(step, input);
    throwIfAbortedBeforeDispatch(input.abortSignal);
    let sawOutput = false;
    const attempt = this.beginAttempt(step, capture, input);

    let result: ProviderStreamResult;
    try {
      result = await input.doStream();
    } catch (error) {
      await attempt.finalize(abortStatus(input.abortSignal, error), { error });
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
              { error: part.error },
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
            { error },
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
    await this.input.beforeDispatch?.();
    throwIfAbortedBeforeDispatch(input.abortSignal);
    this.input.accounting?.assertReady?.();
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
      await attempt.finalize(abortStatus(input.abortSignal, error), { error });
      throw error;
    }
  }

  private beginAttempt(
    step: number,
    capture: StoredCapture,
    input: Pick<
      TrackProviderStreamInput | TrackProviderGenerateInput,
      'providerId' | 'modelId' | 'abortSignal' | 'historyCompactBoundary'
    >,
  ): {
    observeOutput(): void;
    finalize(
      status: ProviderRequestAttemptStatus,
      finish?: { reason?: string; usage?: ProviderRequestUsageLike; error?: unknown },
    ): Promise<void>;
  } {
    const attempt = (this.attemptsByStep.get(step) ?? 0) + 1;
    this.attemptsByStep.set(step, attempt);
    let logicalCallId = this.logicalCallIdByStep.get(step);
    if (logicalCallId === undefined) {
      logicalCallId = this.input.newId();
      this.logicalCallIdByStep.set(step, logicalCallId);
    }
    const attemptId = this.input.newId();
    const startedAt = this.input.now();
    let timeToFirstTokenMs: number | undefined;
    // Cancellation and provider settlement are different events. An abort that
    // carries no usage records provisionally but does not close the attempt, so
    // a `finish` arriving afterwards can still settle it. Both writes share one
    // `attemptId`, and the canonical record dedupes on that key keeping the last
    // — otherwise a cancelled call that really did consume tokens would be
    // frozen as a permanently token-less, cost-less record.
    let settled = false;
    let provisionallyRecorded = false;
    let accountingSettlement = Promise.resolve();
    let abortListener: (() => void) | undefined;
    const finalize = async (
      status: ProviderRequestAttemptStatus,
      finish?: { reason?: string; usage?: ProviderRequestUsageLike; error?: unknown },
    ): Promise<void> => {
      if (settled) return;
      const provisional = status === 'aborted' && finish?.usage === undefined;
      if (provisional && provisionallyRecorded) return;
      if (provisional) provisionallyRecorded = true;
      else settled = true;
      if (abortListener && !provisional) {
        input.abortSignal?.removeEventListener('abort', abortListener);
      }
      const completedAt = this.input.now();
      const usage = strictProviderRequestUsage(finish?.usage);
      const contextWindow = positiveInteger(this.input.contextWindow);
      const failure =
        finish?.error !== undefined ? providerFailureDiagnostic(finish.error) : undefined;
      const record: ProviderRequestAttemptRecord = {
        traceId: this.input.traceId,
        attemptId,
        turnId: this.input.turnId,
        step,
        attempt,
        ...(capture.ref
          ? {
              captureId: capture.ref.captureId,
              captureArtifactId: capture.ref.artifactId,
            }
          : {}),
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
        ...(failure !== undefined ? { failure } : {}),
        latencyMs: Math.max(0, completedAt - startedAt),
        ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
        ...(usage ?? {}),
      };
      accountingSettlement = accountingSettlement.then(async () => {
        try {
          await this.input.recordAttempt(record);
        } catch {
          // Attempt telemetry is diagnostic. The provider outcome remains authoritative.
        }
        await this.emitModelCallAttempt(record, {
          logicalCallId,
          usage,
          contextWindow,
          // Frozen when THIS request was prepared, so a checkpoint published
          // mid-flight by another turn cannot be sealed into a prompt built
          // before it existed.
          historyCompactBoundary: input.historyCompactBoundary,
        });
      });
      await accountingSettlement;
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
      else
        input.abortSignal.addEventListener('abort', abortListener, {
          once: true,
        });
    }
    return { observeOutput, finalize };
  }

  /**
   * Projects a settled attempt into the canonical accounting record.
   *
   * Never throws. This runs from the stream's `pull` handler, where a rejection
   * would reach `controller.error` and fail an otherwise-complete model
   * response. The dispatch-time gate is `assertAccountingReady`; a failure here
   * means the call happened and was billed but went unrecorded, which is
   * reported, not raised.
   */
  private async emitModelCallAttempt(
    record: ProviderRequestAttemptRecord,
    context: {
      logicalCallId: string;
      usage: ProviderRequestUsage | undefined;
      contextWindow: number | undefined;
      historyCompactBoundary: ContextDiagnosticsCompaction | undefined;
    },
  ): Promise<void> {
    const accounting = this.input.accounting;
    if (!accounting) return;
    const runId = accounting.resolveRunId();
    if (runId === undefined) return;

    const usage = context.usage;
    const usageBasis = resolveUsageBasis(usage);
    const cost = usage ? accounting.resolveCost?.(usage) : undefined;
    const priced = cost?.costUsd !== undefined;

    const attempt: ModelCallAttempt = {
      schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
      logicalCallId: context.logicalCallId,
      attemptId: record.attemptId,
      traceId: record.traceId,
      sessionId: accounting.sessionId,
      runId,
      turnId: record.turnId,
      ...(accounting.connectionSlug !== undefined
        ? { connectionSlug: accounting.connectionSlug }
        : {}),
      // The physical ordinals are one-based on the diagnostic record; the
      // canonical record counts retries from zero.
      step: Math.max(0, record.step),
      attempt: Math.max(0, record.attempt - 1),
      callKind: accounting.callKind,
      ...(accounting.historyCompactRoute !== undefined
        ? { historyCompactRoute: accounting.historyCompactRoute }
        : {}),
      providerId: accounting.providerId ?? record.providerId,
      modelId: record.modelId,
      ...(context.contextWindow !== undefined ? { contextWindow: context.contextWindow } : {}),
      ...(record.captureArtifactId !== undefined
        ? { captureArtifactId: record.captureArtifactId }
        : {}),
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      latencyMs: record.latencyMs,
      ...(record.timeToFirstTokenMs !== undefined
        ? { timeToFirstTokenMs: record.timeToFirstTokenMs }
        : {}),
      status: record.status,
      ...(record.finishReason !== undefined ? { finishReason: record.finishReason } : {}),
      ...(record.failure ?? {}),
      usageBasis,
      ...(usageBasis === 'missing' ? {} : modelCallUsageFields(usage)),
      costBasis: priced ? 'priced' : 'unpriced',
      ...(priced
        ? {
            costUsd: cost?.costUsd,
            ...(cost?.pricingRevision !== undefined
              ? { pricingRevision: cost.pricingRevision }
              : {}),
            ...(cost?.pricingRates !== undefined ? { pricingRates: cost.pricingRates } : {}),
          }
        : {}),
    };

    // Only a completed MAIN call describes the conversation's own context, so
    // only that one carries the derived row. A failed, aborted or compaction
    // call commits its metering alone and leaves the last answer standing.
    const latestContext =
      attempt.callKind === 'main' && attempt.status === 'completed'
        ? latestContextProjectionInput(attempt, record.segments, context.historyCompactBoundary)
        : undefined;

    try {
      await accounting.record({ attempt, ...(latestContext ? { latestContext } : {}) });
    } catch {
      // Reported through the run's accounting-incomplete signal by the sink
      // itself. Settlement must not fail the turn the call already completed.
    }
  }

  private async capture(
    step: number,
    input: TrackProviderStreamInput | TrackProviderGenerateInput,
  ): Promise<StoredCapture> {
    const prepared = preparedCapture(input.providerId, input.modelId, input.params);
    const key = `${step}:${prepared.requestHash}`;
    const existing = this.captures.get(key);
    if (existing) return await existing;

    const persistCapture = this.input.persistCapture;
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
      // The request shape on `capture` is computed here and needs no sink. Only
      // the artifact join keys depend on one, so without it the attempt still
      // carries hash, bytes, and segments — it just points at nothing.
      if (!persistCapture) return { capture };
      const persisted = await persistCapture(capture);
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
  const safeParams = secretFreeParams(params);
  const prompt = Array.isArray(safeParams.prompt) ? safeParams.prompt : [];
  const instructions: unknown[] = [];
  const messages: unknown[] = [];
  for (const item of prompt) {
    const record = asRecord(item);
    if (record?.role === 'system') instructions.push(record.content);
    else messages.push(item);
  }
  const tools = Array.isArray(safeParams.tools) ? safeParams.tools : [];
  const providerOptions = asRecord(safeParams.providerOptions);
  return capturePreparedProviderRequest({
    providerId,
    modelId,
    instructions,
    messages,
    tools,
    ...(providerOptions ? { providerOptions } : {}),
    requestPayload: safeParams,
  });
}

function secretFreeParams(params: Record<string, unknown>): Record<string, unknown> {
  const { abortSignal: _abortSignal, headers: _headers, ...safe } = params;
  if (!Array.isArray(safe.prompt)) return safe;
  return { ...safe, prompt: safe.prompt.map(redactPromptCompactionState) };
}

function redactPromptCompactionState(value: unknown): unknown {
  if (!isPlainRecord(value) || !Array.isArray(value.content)) return value;
  return { ...value, content: value.content.map(redactCompactionContentPart) };
}

function redactCompactionContentPart(value: unknown): unknown {
  if (!isPlainRecord(value) || value.type !== 'custom' || value.kind !== 'openai.compaction') {
    return value;
  }
  const providerOptions = isPlainRecord(value.providerOptions) ? value.providerOptions : undefined;
  const openai = isPlainRecord(providerOptions?.openai) ? providerOptions.openai : undefined;
  const { itemId: _itemId, encryptedContent: _encryptedContent, ...safeOpenai } = openai ?? {};
  return {
    ...value,
    providerOptions: {
      ...(providerOptions ?? {}),
      openai: { ...safeOpenai, redacted: true },
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
