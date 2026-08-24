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
 * AgentFlow — the runtime v2 model/tool loop seam.
 *
 * Architecture: docs/architecture/runtime-core-architecture-draft.md
 *
 * Layering (from the architecture doc):
 *
 *   RuntimeRunner
 *     -> InvocationContext  ← canonical spine from ./invocation-context.ts
 *     -> AgentFlow          ← this module defines the flow interface
 *         -> AiSdkFlow      ← default long-term implementation (./ai-sdk-flow.ts)
 *             -> AI SDK streamText
 *             -> ToolRuntime
 *     -> RuntimeEvent ledger
 *     -> projections
 *
 * A Flow owns the model/tool loop for one invocation. It consumes the
 * canonical InvocationContext + a FlowInput (the user turn) and emits the
 * canonical `RuntimeEvent` stream. The current stepping engine lives inside
 * `AiSdkBackend.send()`; `AiSdkFlow` wraps that backend and normalizes its
 * renderer-facing `SessionEvent` stream into canonical `RuntimeEvent`s
 * without rewriting the stepping logic. That keeps the AI SDK as Maka's
 * first-class long-term flow engine (Phase 4 design intent).
 *
 * Phase 4 scope (this node): interface + adapter/wrapper + mapping helpers
 * + tests. It does NOT migrate SessionManager onto the runner, does NOT
 * rewrite `AiSdkBackend.send()`, and does NOT change current renderer
 * behavior. The seam exists so future work can move from
 * `SessionManager -> AgentRun -> AiSdkBackend` to
 * `RuntimeRunner -> AiSdkFlow` without a flag day.
 */

import type { AttachmentRef, QuoteRef } from '@maka/core/events';
import type { SteeringLease } from '@maka/core/backend-types';
import type { StoredMessage } from '@maka/core/session';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeContinuationMetadata } from '@maka/core/backend-types';
import type { EffectiveOrchestration } from '@maka/core/orchestration';
import type { ToolMode } from '@maka/core/tool-mode';
import type { InvocationContext } from './invocation-context.js';

export type { InvocationContext } from './invocation-context.js';

// ============================================================================
// FlowInput — the user turn handed to a Flow
// ============================================================================

/**
 * The user turn input a Flow runs on. This is the flow-level analogue of
 * `BackendSendInput`, expressed without binding to a specific backend.
 *
 * `context` is the prior conversation history (`StoredMessage[]`) the flow
 * projects into model history. Today the AI SDK path forwards this straight
 * to `AiSdkBackend.send()`; in the target architecture it flows through a
 * `ModelHistoryProjector` (Phase 7), but that projection is owned upstream
 * of the flow, not inside it.
 */
export interface FlowInput {
  /** Parent AgentRun id when this flow is running a child agent turn. */
  parentRunId?: string;
  /** Trusted effective orchestration snapshot for this invocation. */
  orchestration?: EffectiveOrchestration;
  /** Trusted effective tool protocol snapshot for this invocation. */
  toolMode?: ToolMode;
  /** Trusted per-turn cap on provider tool-call steps. */
  maxSteps?: number;
  /** User turn text. */
  text: string;
  /** Optional attachments bound to the user message. */
  attachments?: AttachmentRef[];
  /** Optional inline quoted excerpts bound to the user message. */
  quotes?: QuoteRef[];
  /**
   * Prior conversation history for model-history projection. The flow does
   * not own the inclusion policy; it receives whatever the runner/gate
   * resolved.
   */
  context: StoredMessage[];
  /**
   * Optional prior RuntimeEvent ledger for model-history projection. Flows
   * forward this to backends that can prefer it over the StoredMessage-shaped
   * compatibility projection.
   */
  runtimeContext?: RuntimeEvent[];
  /** Continue the committed history directly instead of appending a new user message. */
  continuation?: RuntimeContinuationMetadata;
  /**
   * Steering lease/ack/nack forwarded to a steppable backend. Leases queued
   * mid-turn user messages at each step boundary; see
   * `BackendSendInput.pullSteering`.
   */
  pullSteering?: () => readonly SteeringLease[];
  ackSteering?: (leaseIds: readonly string[]) => void;
  nackSteering?: (leaseIds: readonly string[]) => void;
  /** Abort signal propagated to the underlying engine. */
  abortSignal?: AbortSignal;
}

// ============================================================================
// AgentFlow — the model/tool loop seam
// ============================================================================

/**
 * Owns the model/tool loop for one invocation.
 *
 * `run()` returns an async iterable of canonical `RuntimeEvent`s. The flow
 * is responsible for:
 *   - building provider messages from the input/history,
 *   - driving the model/tool stepping engine,
 *   - delegating tool execution to `ToolRuntime`,
 *   - mapping every model/tool/permission/usage/error/finish fact to a
 *     `RuntimeEvent`.
 *
 * A flow MUST emit exactly one terminal event (`isTerminalRuntimeEvent`)
 * per invocation, whether the turn completed, errored, aborted, or was
 * cancelled. Non-terminal partial chunks carry `partial: true`.
 *
 * Control surface (`stop` / `respondToSandboxBoundary` / `dispose`) is optional
 * on the interface because not every flow implementation owns a steppable
 * engine. `AiSdkFlow` exposes these and delegates them to the wrapped
 * backend so the current control semantics are preserved.
 */
export interface AgentFlow {
  /** Stable label for telemetry/diagnostics, e.g. `'ai-sdk'`. */
  readonly kind: string;
  /** Session this flow is bound to. */
  readonly sessionId: string;
  /** Run the model/tool loop, emitting canonical runtime facts. */
  run(ctx: InvocationContext, input: FlowInput): AsyncIterable<RuntimeEvent>;
}

/**
 * Narrow runnable flow surface for orchestration code that should not depend
 * on flow metadata such as `kind` or `sessionId`.
 */
export type RunnableAgentFlow = Pick<AgentFlow, 'run'>;

// ============================================================================
// AgentFlowControl — optional lifecycle/steering surface
// ============================================================================

/**
 * Optional steering surface for flows that wrap a steppable engine. Mirrors
 * the existing `AgentBackend` control methods so callers (SessionManager
 * today, RuntimeRunner tomorrow) can stop a turn, answer a permission
 * prompt, or tear the flow down without depending on a concrete class.
 *
 * `AiSdkFlow` implements this; pure/projection-only flows may omit it.
 */
export interface AgentFlowControl {
  stop(reason: 'user_stop' | 'redirect'): Promise<void>;
  respondToSandboxBoundary(
    response: import('@maka/core/sandbox-boundary').SandboxBoundaryResponse,
  ): Promise<void>;
  respondToUserQuestion(
    response: import('@maka/core/user-question').UserQuestionResponse,
  ): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Type guard for the optional control surface. Callers that have an
 * `AgentFlow` and need steering can narrow with this helper.
 */
export function flowSupportsControl(flow: AgentFlow): flow is AgentFlow & AgentFlowControl {
  return (
    typeof (flow as AgentFlow & Partial<AgentFlowControl>).stop === 'function' &&
    typeof (flow as AgentFlow & Partial<AgentFlowControl>).respondToSandboxBoundary ===
      'function' &&
    typeof (flow as AgentFlow & Partial<AgentFlowControl>).respondToUserQuestion === 'function' &&
    typeof (flow as AgentFlow & Partial<AgentFlowControl>).dispose === 'function'
  );
}
