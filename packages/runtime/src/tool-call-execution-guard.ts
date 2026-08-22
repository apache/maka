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
 * tool-call-execution-guard.ts — positive-completion proof for a provider
 * step's tool calls before `ai-sdk-backend.ts` settles them through
 * `ToolRuntime` (real side effects: filesystem writes, shell commands,
 * apply_patch, SQL execution, dependency installs, and so on).
 *
 * Why this exists: `settleModelStepOutcome` (model-adapter.ts) classifies a
 * step as `{ kind: 'completed' }` for `finishReason: "length"` — the same
 * branch `"stop"` and `"tool-calls"` take. `ai-sdk-backend.ts`'s historical
 * gate before settling `returnedToolCalls` only asked for that broader
 * completed outcome, so a step that streamed a structurally complete tool
 * call and was then cut off by a token limit while producing more content
 * could still execute that call. The `length -> completed` classification is
 * correct for that function's continuation/retry bookkeeping purpose and is
 * deliberately not reused as an irreversible tool-execution gate here.
 *
 * `translateChunk` (model-adapter.ts) also does not establish execution
 * authority for a final `'tool-call'` chunk's `input`: that value is the AI
 * SDK's parsed/post-processed projection and may have passed through
 * `repairToolCall` or another coercion path. Where the provider exposes raw
 * `tool-input-delta` chunks, those bytes are stronger evidence of what the
 * provider actually streamed. This tracker observes the raw SDK chunks
 * verbatim before translation, keeps the argument bytes per physical request,
 * requires matching start/end evidence plus a positively safe terminal event,
 * and parses only the captured raw JSON. The resulting raw-stream tool name
 * and parsed value are the execution authority for that call.
 *
 * Some provider-facing chunk sequences may contain `tool-input-start`
 * immediately followed by `tool-input-end` with zero `tool-input-delta`
 * chunks, with the actual arguments present only in the trailing `tool-call`
 * projection. The focused guard and production-path regression suites exercise
 * that zero-delta/atomic shape directly (`tool-call-execution-guard.test.ts`,
 * `length-cutoff-tool-execution-repro.test.ts`, and `ai-sdk-backend.test.ts`).
 * For this tracker, zero raw deltas therefore means there is no raw-byte
 * completeness proof for that id, not that a partial byte stream was observed.
 * `resolveToolCallSafety` therefore omits an id that received no real
 * non-empty delta from `decisions` entirely.
 *
 * A caller (see `ai-sdk-backend.ts`) may only interpret that absence as
 * "genuinely atomic; use the step-level fallback" when
 * `hadRawArgumentEvidence` is false for the WHOLE physical request. The
 * moment any sibling call streamed real bytes, another call's missing
 * decision is indistinguishable from an id mismatch between this tracker's
 * raw-chunk view and the SDK's resolved `tool-call`; that case must fail
 * closed. A call that did stream real delta bytes gets the strict raw-byte
 * verdict, including the raw-stream name/value as execution authority — never
 * the SDK's post-hoc projection of the same call.
 *
 * Concurrency note: nothing here is shared across requests or stored beyond
 * one `ModelAdapter.startStream` result. `createToolCallSafetyTracker()` owns
 * fresh maps and terminal state every time, so two concurrent provider
 * requests that both use a provider-issued id like `"call_1"` can never
 * observe or resolve each other's evidence.
 *
 * `isSafeToolExecutionStepOutcome` below is the fallback used for a call with
 * no raw-byte evidence either way. It is deliberately narrower than
 * `settleModelStepOutcome`'s own `kind === 'completed'` — that classification
 * also covers `"length"`, which is correct for that function's bookkeeping
 * purpose but is not an execution-safe outcome. This helper exists only for
 * the tool-execution gate; it does not change `settleModelStepOutcome` itself
 * or anything else that reads `ModelStepOutcome`.
 */
import type {
  ModelStepOutcome,
  ToolCallExecutionSafety,
  ToolCallSafetyDecision,
} from './model-protocol.js';

interface RawToolCallState {
  name?: string;
  raw: string;
  started: boolean;
  ended: boolean;
  invalid: boolean;
}

type TerminalState = 'pending' | 'safe' | 'unsafe';

export interface ToolCallSafetyTracker {
  /** Per-id raw argument state for this physical provider request only. */
  readonly calls: Map<string, RawToolCallState>;
  /** ids that received at least one non-empty tool-input-delta chunk. */
  readonly idsWithRawDelta: Set<string>;
  terminal: TerminalState;
  resolved?: ToolCallExecutionSafety;
}

function toolPartId(part: { id?: unknown; toolCallId?: unknown }): string | undefined {
  if (typeof part.id === 'string') return part.id;
  if (typeof part.toolCallId === 'string') return part.toolCallId;
  return undefined;
}

function callState(tracker: ToolCallSafetyTracker, id: string): RawToolCallState {
  let state = tracker.calls.get(id);
  if (state === undefined) {
    state = { raw: '', started: false, ended: false, invalid: false };
    tracker.calls.set(id, state);
  }
  return state;
}

function normalizedFinishReason(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { unified?: unknown }).unified === 'string'
  ) {
    return (value as { unified: string }).unified;
  }
  return undefined;
}

function markTerminal(tracker: ToolCallSafetyTracker, safe: boolean): void {
  if (!safe || tracker.terminal === 'unsafe') {
    tracker.terminal = 'unsafe';
    return;
  }
  tracker.terminal = 'safe';
}

/** Starts tracking one physical provider request's raw stream. */
export function createToolCallSafetyTracker(): ToolCallSafetyTracker {
  return { calls: new Map(), idsWithRawDelta: new Set(), terminal: 'pending' };
}

/** Feed one raw AI SDK stream chunk through, unchanged, as observed. */
export function observeRawChunk(tracker: ToolCallSafetyTracker, chunk: unknown): void {
  if (chunk === null || typeof chunk !== 'object') return;
  const part = chunk as {
    type?: unknown;
    id?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    delta?: unknown;
    finishReason?: unknown;
  };

  const isToolEvidence =
    part.type === 'tool-input-start' ||
    part.type === 'tool-input-delta' ||
    part.type === 'tool-input-end' ||
    part.type === 'tool-error';
  if (tracker.terminal !== 'pending' && isToolEvidence) tracker.terminal = 'unsafe';

  switch (part.type) {
    case 'tool-input-start': {
      const id = toolPartId(part);
      if (id === undefined) return;
      const state = callState(tracker, id);
      if (state.started || state.ended || state.raw.length > 0) state.invalid = true;
      state.started = true;
      if (typeof part.toolName === 'string' && part.toolName.length > 0) {
        if (state.name !== undefined && state.name !== part.toolName) state.invalid = true;
        state.name = part.toolName;
      }
      return;
    }
    case 'tool-input-delta': {
      const id = toolPartId(part);
      if (id === undefined || typeof part.delta !== 'string' || part.delta.length === 0) return;
      const state = callState(tracker, id);
      if (!state.started || state.ended) state.invalid = true;
      state.raw += part.delta;
      tracker.idsWithRawDelta.add(id);
      return;
    }
    case 'tool-input-end': {
      const id = toolPartId(part);
      if (id === undefined) return;
      const state = callState(tracker, id);
      if (!state.started || state.ended) state.invalid = true;
      state.ended = true;
      return;
    }
    case 'tool-error': {
      const id = toolPartId(part);
      if (id !== undefined) callState(tracker, id).invalid = true;
      return;
    }
    case 'finish': {
      const reason = normalizedFinishReason(part.finishReason);
      markTerminal(tracker, reason === 'stop' || reason === 'tool-calls');
      return;
    }
    case 'error':
    case 'abort':
      markTerminal(tracker, false);
      return;
    default:
      return;
  }
}

function rejectedDecision(): ToolCallSafetyDecision {
  return { action: 'reject' };
}

/**
 * Resolves every call that actually streamed raw bytes. Positive execution
 * requires start + non-empty raw bytes + end + a raw-stream tool name + valid
 * JSON decoded from exactly those bytes + an observed `stop`/`tool-calls`
 * terminal event. Missing, contradictory, or out-of-order evidence fails
 * closed. `meta` is accepted for the ModelAdapter call shape but cannot
 * promote a stream with no terminal event to safe.
 */
export function resolveToolCallSafety(
  tracker: ToolCallSafetyTracker,
  _meta?: { providerReason?: string },
): ToolCallExecutionSafety {
  if (tracker.resolved !== undefined) return tracker.resolved;

  const decisions = new Map<string, ToolCallSafetyDecision>();
  for (const id of tracker.idsWithRawDelta) {
    const state = tracker.calls.get(id);
    if (
      tracker.terminal !== 'safe' ||
      state === undefined ||
      !state.started ||
      !state.ended ||
      state.invalid ||
      state.name === undefined
    ) {
      decisions.set(id, rejectedDecision());
      continue;
    }

    try {
      const value: unknown = JSON.parse(state.raw);
      decisions.set(id, { action: 'execute', name: state.name, value });
    } catch {
      decisions.set(id, rejectedDecision());
    }
  }

  tracker.resolved = {
    hadRawArgumentEvidence: tracker.idsWithRawDelta.size > 0,
    decisions,
  };
  return tracker.resolved;
}

/**
 * Whether an all-atomic provider step's own termination is execution-safe.
 * Only an unambiguous normal completion qualifies. `length` is intentionally
 * excluded even though `settleModelStepOutcome` classifies it as completed.
 */
export function isSafeToolExecutionStepOutcome(outcome: ModelStepOutcome): boolean {
  return (
    outcome.kind === 'completed' &&
    (outcome.finishReason === 'stop' || outcome.finishReason === 'tool-calls')
  );
}
