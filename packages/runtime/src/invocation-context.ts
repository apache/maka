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

/**
 * InvocationContext — Runtime v2 invocation/run spine.
 *
 * Architecture: docs/architecture/runtime-core-architecture-draft.md
 *
 * Phase 2 scope: types + injectable providers. RuntimeRunner consumes these
 * to build a testable invocation shell and can also be handed production ids
 * from an already-created AgentRun while migration wiring is in progress.
 *
 * Identity hierarchy carried on every context: sessionId ⊃ invocationId ⊃
 * runId ⊃ turnId. These mirror the canonical RuntimeEvent fields so events
 * minted inside a flow stay 1:1 with the invocation that produced them.
 */

import type { AttachmentRef, InlineReference, QuoteRef } from '@maka/core/events';
import type { SteeringLease } from '@maka/core/backend-types';
import type { RuntimeEvent, RuntimeEventStatus } from '@maka/core/runtime-event';
import type { StoredMessage } from '@maka/core/session';
import type { RuntimeContinuationMetadata } from '@maka/core/backend-types';
import type { EffectiveOrchestration } from '@maka/core/orchestration';
import type { ToolMode } from '@maka/core/tool-mode';

// ============================================================================
// InvocationSource
// ============================================================================

/**
 * Where the invocation entered the runtime. Desktop, bot, and gateway share
 * the same runner; `test` covers in-process fake-service invocations like the
 * ones in this package's test suite.
 */
export const INVOCATION_SOURCES = ['desktop', 'bot', 'gateway', 'test'] as const;
export type InvocationSource = (typeof INVOCATION_SOURCES)[number];

export function isInvocationSource(value: unknown): value is InvocationSource {
  return typeof value === 'string' && (INVOCATION_SOURCES as readonly string[]).includes(value);
}

// ============================================================================
// InvocationLineage — retry / regenerate / branch pointers
// ============================================================================

/**
 * Optional lineage carried from the entrypoint. Mirrors the relevant
 * UserMessageInput fields so a future StoredMessage turn_state projection
 * can map 1:1 without re-deriving shape.
 */
export interface InvocationLineage {
  parentRunId?: string;
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
}

/**
 * Runtime-owned continuation metadata carried through Runner revalidation.
 * `sourceRuntimeContext` is deliberately not part of the provider contract:
 * it identifies the immediate source segment inside assembled replay history.
 */
export interface InvocationContinuationMetadata extends RuntimeContinuationMetadata {
  sourceRuntimeContext?: RuntimeEvent[];
}

// ============================================================================
// InvocationRequest — input to RuntimeRunner.run()
// ============================================================================

/**
 * Request to run one agent invocation. The runner owns preflight, context
 * creation, the initial user RuntimeEvent, and flow dispatch. Callers may
 * provide existing production spine ids (for example from AgentRun); when
 * omitted, the runner generates them through the injected providers.
 */
export interface InvocationRequest {
  sessionId: string;
  invocationId?: string;
  runId?: string;
  turnId: string;
  /** Trusted effective orchestration snapshot for this invocation. */
  orchestration?: EffectiveOrchestration;
  /** Trusted effective tool protocol snapshot for this invocation. */
  toolMode?: ToolMode;
  /** Trusted per-turn cap on provider tool-call steps. */
  maxSteps?: number;
  text: string;
  /** Optional attachments bound to this user turn. */
  attachments?: AttachmentRef[];
  /** Optional inline quoted excerpts bound to this user turn. */
  quotes?: QuoteRef[];
  /** Display-only sent token metadata; excluded from FlowInput/provider context. */
  inlineReferences?: InlineReference[];
  /**
   * Prior conversation history resolved by the caller/gate. RuntimeRunner
   * passes this to AgentFlow as `context`, defaulting to [] so flows never
   * receive an undefined model-history input.
   */
  context?: StoredMessage[];
  /**
   * Optional prior RuntimeEvent ledger resolved by the caller. RuntimeRunner
   * passes this through without adding the current turn's RuntimeEvents.
   */
  runtimeContext?: RuntimeEvent[];
  /** Safe-boundary continuation metadata. No synthetic user RuntimeEvent is emitted when present. */
  continuation?: InvocationContinuationMetadata;
  /** Optional initial user RuntimeEvent already minted by an outer run owner. */
  initialRuntimeEvent?: RuntimeEvent;
  source: InvocationSource;
  /** Optional branch/agent lane; forwarded onto every emitted event. */
  branch?: string;
  /** Lineage for retry/regenerate/branch projections. */
  lineage?: InvocationLineage;
  /**
   * Steering lease/ack/nack forwarded to a steppable flow/backend. Leases
   * queued mid-turn user messages at each step boundary; see
   * `BackendSendInput.pullSteering`.
   */
  pullSteering?: () => readonly SteeringLease[];
  ackSteering?: (leaseIds: readonly string[]) => void;
  nackSteering?: (leaseIds: readonly string[]) => void;
  /** Caller-owned abort signal; flows and tools SHOULD observe it. */
  abortSignal?: AbortSignal;
}

// ============================================================================
// InvocationContext — created by RuntimeRunner through injected providers
// ============================================================================

/**
 * The invocation/run spine handed to AgentFlow.run(ctx, request). Carries
 * the durable identity hierarchy plus the injectable id/time providers a
 * flow uses to mint canonical RuntimeEvents that line up with the spine.
 */
export interface InvocationContext {
  sessionId: string;
  /** Durable invocation spine id; groups every run/turn of one request. */
  invocationId: string;
  /** Specific run/attempt within the invocation. */
  runId: string;
  turnId: string;
  /** Optional branch/agent lane (forwarded from the request). */
  branch?: string;
  source: InvocationSource;
  /** Unix ms timestamp captured when the runner created the context. */
  startedAt: number;
  /** Caller-owned abort signal; flows and tools SHOULD observe it. */
  abortSignal?: AbortSignal;
  /** The original request, for flows that need source/lineage/text. */
  request: InvocationRequest;
  /** Injectable id provider (same instance the runner uses). */
  newId: () => string;
  /** Injectable clock (same instance the runner uses). */
  now: () => number;
}

// ============================================================================
// InvocationProviders — injectable id/time so tests can be deterministic
// ============================================================================

export interface InvocationProviders {
  newId: () => string;
  now: () => number;
}

/**
 * Best-effort default providers. Real entrypoints already inject stronger
 * id/time sources (see SessionManagerDeps.newId / now); tests SHOULD inject
 * their own deterministic providers rather than rely on this default.
 */
export function createDefaultInvocationProviders(): InvocationProviders {
  return {
    newId: () =>
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    now: () => Date.now(),
  };
}

// ============================================================================
// InvocationResult — structured outcome returned by RuntimeRunner.run()
// ============================================================================

/**
 * Result envelope collapses non-completed outcomes to 'failed'. The precise
 * terminal RuntimeEventStatus that produced a failure is retained inside
 * `failure.terminalStatus` so callers do not lose aborted/cancelled detail.
 */
export type InvocationResultStatus = 'completed' | 'failed';

export interface InvocationFailure {
  /**
   * Stable machine-readable class. Today one of: 'preflight', 'aborted',
   * the terminal RuntimeEventStatus ('failed' | 'aborted' | 'cancelled'),
   * or the thrown error's name.
   */
  class: string;
  message?: string;
  /** Precise terminal RuntimeEventStatus when the failure came from a terminal event. */
  terminalStatus?: RuntimeEventStatus;
}

export interface InvocationResult {
  invocationId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  status: InvocationResultStatus;
  /** Last non-partial model text from a successfully completed invocation. */
  finalOutput?: string;
  /** Every newly collected RuntimeEvent in emission order (normal invocations start with user). */
  events: RuntimeEvent[];
  /** Present when status === 'failed'. */
  failure?: InvocationFailure;
  startedAt: number;
  finishedAt: number;
}
