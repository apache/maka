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
 * Some provider-facing chunk sequences (the installed Google adapter's among
 * them) may contain `tool-input-start` immediately followed by
 * `tool-input-end` with zero `tool-input-delta` chunks, for a tool that
 * genuinely takes no arguments — with the (empty) arguments present only in
 * the trailing `tool-call` projection. That shape is legitimate on its own
 * and, per call, indistinguishable from a truncated/mismatched stream only
 * in the absence of its own start/end lifecycle — which this tracker does
 * observe. The focused guard and production-path regression suites exercise
 * it directly (`tool-call-execution-guard.test.ts`,
 * `length-cutoff-tool-execution-repro.test.ts`, and `ai-sdk-backend.test.ts`),
 * including the case where an argument-bearing sibling call shares the same
 * physical request.
 *
 * `resolveToolCallSafety` represents only positive proof, in two disjoint
 * maps:
 *
 * - `proofs` holds an entry for an id if and only if every condition below
 *   held — matching start, non-empty raw bytes, matching end, unpoisoned
 *   ordering, a raw-stream tool name, JSON that parses from exactly those
 *   bytes, and an execution-safe terminal classification. Its `value` is the
 *   guard's own parsed argument value.
 * - `atomicProofs` holds an entry for an id whose OWN lifecycle positively
 *   proved an atomic, genuinely zero-argument delivery: matching start,
 *   matching end, unpoisoned ordering, a raw-stream tool name, zero raw
 *   `tool-input-delta` chunks for that id specifically, and an
 *   execution-safe terminal classification. It carries no `value` — there
 *   were no raw bytes to parse — only the name the tracker itself observed,
 *   for the caller's identity check.
 *
 * An id can appear in at most one of the two maps (an id that received any
 * raw delta bytes is only ever eligible for `proofs`, never `atomicProofs`,
 * even if those bytes failed to produce a proof). An id in neither map had
 * no positive per-id evidence at all — a mismatched, out-of-order, or wholly
 * unobserved lifecycle — and a caller must treat that the same as a call
 * that never streamed anything: there is no separate rejected/retry state to
 * distinguish "evidence existed but failed a condition" from "no evidence at
 * all", because a caller can never act on that difference anyway.
 *
 * `atomicProofs` is deliberately silent on VALUE, and that is the caller's
 * responsibility to get right, not this tracker's: this tracker only ever
 * observes `tool-input-start`/`tool-input-delta`/`tool-input-end`, never the
 * resolved `tool-call` chunk itself, so it has no way to know — and does not
 * claim to know — what the SDK's own projected `toolCall.input` for that id
 * turned out to be. A complete, unpoisoned, zero-delta id/name lifecycle
 * proves the provider streamed no argument bytes; it does not, by itself,
 * prove what the SDK-resolved input contains. The caller (see
 * `ai-sdk-backend.ts`) closes that gap by additionally requiring
 * `hadRawArgumentEvidence` to be true before it will consult `atomicProofs`
 * at all, and by treating the canonical empty object — never
 * `toolCall.input` — as the executed value once it does: see that file for
 * why (the installed Google adapter's own source confirms a real zero-delta
 * id and a real non-empty id are never the same wire shape, so the SDK's
 * projection is not needed and is not trusted for this branch).
 *
 * A caller resolves a call with neither a `proofs` nor an (its own
 * `hadRawArgumentEvidence`-gated) `atomicProofs` entry by falling back to
 * "genuinely atomic; use the step-level fallback, trusting `toolCall.input`
 * verbatim" ONLY when `hadRawArgumentEvidence` is false for the WHOLE
 * physical request — i.e. this tracker observed no `tool-input-delta` bytes
 * anywhere in the request, meaning either every call in it is legitimately
 * atomic (a provider that hands off complete, possibly non-empty calls in
 * one shot, with no incremental streaming at all) or the provider's protocol
 * never emits granular per-call lifecycle chunks in the first place. That is
 * a separate, pre-existing policy this tracker does not change. The moment
 * any call anywhere in the request streamed real bytes, a call with no
 * `proofs` entry AND no `atomicProofs` entry is indistinguishable from an id
 * mismatch between this tracker's raw-chunk view and the SDK's resolved
 * `tool-call`; that case must still fail closed. A call with a `proofs`
 * entry of its own, or an `atomicProofs` entry the caller is willing to
 * trust, never needs this fallback — which is exactly what fixed the case a
 * purely request-global rule got wrong: an argument-bearing call and a
 * legitimate zero-argument sibling in the same request, each proved from its
 * own lifecycle, neither one's fate decided by the other's.
 *
 * A call with a present `proofs` entry gets the raw-stream name/value as
 * execution authority. Neither case ever defers to the SDK's post-hoc
 * projection for a DIFFERENT id, and neither lets one call's raw evidence
 * stand in for another's.
 *
 * Concurrency note: nothing here is shared across requests or stored beyond
 * one `ModelAdapter.startStream` result. `createToolCallSafetyTracker()` owns
 * fresh maps and terminal state every time, so two concurrent provider
 * requests that both use a provider-issued id like `"call_1"` can never
 * observe or resolve each other's evidence.
 *
 * `isSafeToolExecutionStepOutcome` below is the fallback used for a call with
 * no per-id evidence at all (see the whole-request fallback above). It is
 * deliberately narrower than `settleModelStepOutcome`'s own
 * `kind === 'completed'` — that classification also covers `"length"`,
 * which is correct for that function's bookkeeping purpose but is not an
 * execution-safe outcome. This helper exists only for the tool-execution
 * gate; it does not change `settleModelStepOutcome` itself or anything else
 * that reads `ModelStepOutcome`.
 */
import type {
  ModelStepOutcome,
  ToolCallAtomicProof,
  ToolCallExecutionSafety,
  ToolCallSafetyProof,
} from './model-protocol.js';

interface RawToolCallState {
  name?: string;
  raw: string;
  started: boolean;
  ended: boolean;
  invalid: boolean;
}

/**
 * `pending`: no terminal stream event observed yet.
 * `finish`: an actual `finish` chunk was observed; `reason` is this
 * tracker's own local read of it (`.unified` only — see
 * `normalizedFinishReason`), which may be ambiguous (`"other"`/`"unknown"`/
 * `undefined`) even when the provider's own spelling, available elsewhere,
 * is not. See `isTerminalSafe`.
 * `blocked`: an explicit `error`/`abort` part, or tool-call evidence
 * arriving after any terminal event already happened (a poisoned request).
 * Sticky: nothing can move a tracker out of `blocked`.
 */
type TerminalState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'finish'; readonly reason: string | undefined }
  | { readonly kind: 'blocked' };

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

function blockTerminal(tracker: ToolCallSafetyTracker): void {
  tracker.terminal = { kind: 'blocked' };
}

/** Starts tracking one physical provider request's raw stream. */
export function createToolCallSafetyTracker(): ToolCallSafetyTracker {
  return { calls: new Map(), idsWithRawDelta: new Set(), terminal: { kind: 'pending' } };
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
  if (tracker.terminal.kind !== 'pending' && isToolEvidence) blockTerminal(tracker);

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
      // A second finish-shaped event is exactly as suspicious as tool
      // evidence after a terminal event — treat it the same way (blocked),
      // rather than letting a later finish silently replace an earlier one.
      if (tracker.terminal.kind !== 'pending') {
        blockTerminal(tracker);
        return;
      }
      tracker.terminal = { kind: 'finish', reason: normalizedFinishReason(part.finishReason) };
      return;
    }
    case 'error':
    case 'abort':
      blockTerminal(tracker);
      return;
    default:
      return;
  }
}

/**
 * Whether this request's terminal state is execution-safe, given the
 * stronger provider reason `resolveToolCallSafety`'s caller already resolved
 * (see below). Mirrors `chunkFinishReason`'s (model-adapter.ts) own rule —
 * fall back to the provider's own spelling only when the SDK's unified
 * reason is ambiguous (`"other"`/`"unknown"`) — without importing it
 * directly: `tool-call-execution-guard.ts` is imported by `model-adapter.ts`,
 * so the reverse import would cycle.
 *
 * `providerReason` may only resolve an AMBIGUOUS classification belonging to
 * a real terminal event this tracker itself witnessed. It can never promote
 * `pending` (no terminal event observed at all — see the module doc comment
 * for why `sdk.finishReason`'s own fallback means a caller can have a
 * non-empty `providerReason` even then) or `blocked` (explicit error/abort,
 * or tool evidence poisoning the request) to safe, and it can never override
 * a terminal event this tracker directly classified as unsafe on its own
 * (`length`, `content-filter`, `stop`-with-no-safe-match, etc.) — only an
 * ambiguous one.
 */
function isTerminalSafe(terminal: TerminalState, providerReason: string | undefined): boolean {
  if (terminal.kind !== 'finish') return false;
  if (terminal.reason === 'stop' || terminal.reason === 'tool-calls') return true;
  const ambiguous =
    terminal.reason === undefined || terminal.reason === 'other' || terminal.reason === 'unknown';
  if (!ambiguous) return false;
  return providerReason === 'stop' || providerReason === 'tool-calls';
}

/**
 * Resolves every call this tracker has per-id evidence for into a positive
 * proof (raw-byte or atomic) or no entry at all — see the module doc comment
 * for the full `proofs`/`atomicProofs` contract. `meta.providerReason` is the
 * same finish reason `ModelAdapter.startStream` resolves for step settlement
 * (`chunkFinishReason`, model-adapter.ts) — passing it lets an ambiguous
 * local classification agree with the stronger, already-computed answer
 * instead of the two diverging for the same physical request.
 */
export function resolveToolCallSafety(
  tracker: ToolCallSafetyTracker,
  meta?: { providerReason?: string },
): ToolCallExecutionSafety {
  if (tracker.resolved !== undefined) return tracker.resolved;

  const terminalSafe = isTerminalSafe(tracker.terminal, meta?.providerReason);
  const proofs = new Map<string, ToolCallSafetyProof>();
  for (const id of tracker.idsWithRawDelta) {
    const state = tracker.calls.get(id);
    if (
      !terminalSafe ||
      state === undefined ||
      !state.started ||
      !state.ended ||
      state.invalid ||
      state.name === undefined
    ) {
      continue;
    }

    try {
      const value: unknown = JSON.parse(state.raw);
      proofs.set(id, { name: state.name, value });
    } catch {
      // No proof: the captured bytes did not parse as JSON.
    }
  }

  // A call with its own matching start + end, zero raw delta bytes, and no
  // contradictory evidence has a complete, unambiguous lifecycle even though
  // it never carries argument bytes to parse — this is the shape the
  // installed Google adapter legitimately produces for a zero-argument tool
  // call. `idsWithRawDelta` and this loop are disjoint by construction: an id
  // that received any delta bytes is only ever eligible for `proofs` above,
  // even when those bytes failed to produce one.
  const atomicProofs = new Map<string, ToolCallAtomicProof>();
  for (const [id, state] of tracker.calls) {
    if (tracker.idsWithRawDelta.has(id)) continue;
    if (
      !terminalSafe ||
      !state.started ||
      !state.ended ||
      state.invalid ||
      state.name === undefined
    ) {
      continue;
    }
    atomicProofs.set(id, { name: state.name });
  }

  tracker.resolved = {
    hadRawArgumentEvidence: tracker.idsWithRawDelta.size > 0,
    proofs,
    atomicProofs,
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
