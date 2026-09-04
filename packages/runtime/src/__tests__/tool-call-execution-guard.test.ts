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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  createToolCallSafetyTracker,
  isSafeToolExecutionStepOutcome,
  observeRawChunk,
  resolveToolCallSafety,
} from '../tool-call-execution-guard.js';
import type { ModelFailure, ModelStepOutcome } from '../model-protocol.js';

function completeToolCallParts(id: string, input: unknown, toolName = 'Write') {
  return [
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: JSON.stringify(input) },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  ];
}

function pushCompleteCall(
  tracker: ReturnType<typeof createToolCallSafetyTracker>,
  id = 'call-1',
  input: unknown = { path: 'a.md' },
): void {
  for (const part of completeToolCallParts(id, input)) observeRawChunk(tracker, part);
}

function hasProof(
  tracker: ReturnType<typeof createToolCallSafetyTracker>,
  id = 'call-1',
  meta?: { providerReason?: string },
): boolean {
  return resolveToolCallSafety(tracker, meta).proofs.has(id);
}

describe('tool-call-execution-guard', () => {
  test('stop positively proves the raw-stream name and value', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker, 'call-1', { path: 'a.md', content: 'hello' });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });

    const safety = resolveToolCallSafety(tracker);
    assert.equal(safety.hadRawArgumentEvidence, true);
    assert.deepEqual(safety.proofs.get('call-1'), {
      name: 'Write',
      value: { path: 'a.md', content: 'hello' },
    });
  });

  test('tool-calls is also an explicitly safe terminal reason', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'finish', finishReason: 'tool-calls' });
    assert.equal(hasProof(tracker), true);
  });

  for (const finishReason of ['length', 'content-filter', 'error', 'other', 'unknown']) {
    test(`${finishReason} never authorizes a fully streamed call`, () => {
      const tracker = createToolCallSafetyTracker();
      pushCompleteCall(tracker);
      observeRawChunk(tracker, { type: 'finish', finishReason });
      assert.equal(hasProof(tracker), false);
    });
  }

  test('provider error part fails closed', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'error', error: new Error('upstream 500') });
    assert.equal(hasProof(tracker), false);
  });

  test('abort part fails closed', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'abort' });
    assert.equal(hasProof(tracker), false);
  });

  test('missing terminal event fails closed even when fallback metadata says stop', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    assert.equal(hasProof(tracker, 'call-1', { providerReason: 'stop' }), false);
  });

  // Finish-reason authority: model-adapter.ts already resolves a stronger
  // finish reason (chunkFinishReason) that falls back to the provider's own
  // spelling when the SDK's unified reason is "other"/"unknown", and passes
  // it as providerReason. Before this, the tracker's own local (unified-only)
  // read of the same finish chunk could disagree with that stronger answer
  // for the exact same physical request.
  test('a real finish event with an ambiguous unified reason is rescued by a real providerReason', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'finish', finishReason: { unified: 'other', raw: 'stop' } });
    assert.equal(hasProof(tracker, 'call-1', { providerReason: 'stop' }), true);
  });

  test('unknown is also rescuable when providerReason resolves to tool-calls', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, {
      type: 'finish',
      finishReason: { unified: 'unknown', raw: 'tool-calls' },
    });
    assert.equal(hasProof(tracker, 'call-1', { providerReason: 'tool-calls' }), true);
  });

  test('an ambiguous reason with no rescuing providerReason still fails closed', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'finish', finishReason: { unified: 'other', raw: 'other' } });
    assert.equal(hasProof(tracker, 'call-1', { providerReason: 'other' }), false);
  });

  test('an abort terminal event is never rescued by providerReason', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'abort' });
    assert.equal(hasProof(tracker, 'call-1', { providerReason: 'stop' }), false);
  });

  test('a provider error terminal event is never rescued by providerReason', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'error', error: new Error('upstream 500') });
    assert.equal(hasProof(tracker, 'call-1', { providerReason: 'stop' }), false);
  });

  test('a directly observed length finish reason is never rescued by providerReason', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'finish', finishReason: 'length' });
    assert.equal(hasProof(tracker, 'call-1', { providerReason: 'stop' }), false);
  });

  test('a directly observed content-filter finish reason is never rescued by providerReason', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'finish', finishReason: 'content-filter' });
    assert.equal(hasProof(tracker, 'call-1', { providerReason: 'stop' }), false);
  });

  test('a second finish-shaped event is treated as poisoning, not a softer verdict', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'finish', finishReason: { unified: 'other', raw: 'stop' } });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });
    assert.equal(hasProof(tracker, 'call-1', { providerReason: 'stop' }), false);
  });

  test('missing tool-input-end fails closed', () => {
    const tracker = createToolCallSafetyTracker();
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-1', toolName: 'Write' });
    observeRawChunk(tracker, {
      type: 'tool-input-delta',
      id: 'call-1',
      delta: '{"path":"a.md"}',
    });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });
    assert.equal(hasProof(tracker), false);
  });

  test('malformed JSON fails closed despite start/end and a safe finish', () => {
    const tracker = createToolCallSafetyTracker();
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-1', toolName: 'Write' });
    observeRawChunk(tracker, { type: 'tool-input-delta', id: 'call-1', delta: '{"path":' });
    observeRawChunk(tracker, { type: 'tool-input-end', id: 'call-1' });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });
    assert.equal(hasProof(tracker), false);
  });

  test('delta before start is contradictory evidence and fails closed', () => {
    const tracker = createToolCallSafetyTracker();
    observeRawChunk(tracker, { type: 'tool-input-delta', id: 'call-1', delta: '{"path":"a.md"}' });
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-1', toolName: 'Write' });
    observeRawChunk(tracker, { type: 'tool-input-end', id: 'call-1' });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });
    assert.equal(hasProof(tracker), false);
  });

  test('duplicate start fails closed', () => {
    const tracker = createToolCallSafetyTracker();
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-1', toolName: 'Write' });
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-1', toolName: 'Write' });
    observeRawChunk(tracker, { type: 'tool-input-delta', id: 'call-1', delta: '{"path":"a.md"}' });
    observeRawChunk(tracker, { type: 'tool-input-end', id: 'call-1' });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });
    assert.equal(hasProof(tracker), false);
  });

  test('tool evidence after a terminal event poisons the request', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });
    observeRawChunk(tracker, { type: 'tool-input-delta', id: 'call-1', delta: ' ' });
    assert.equal(hasProof(tracker), false);
  });

  test('pure atomic delivery has no proof and keeps request-level evidence false', () => {
    const tracker = createToolCallSafetyTracker();
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-1', toolName: 'Write' });
    observeRawChunk(tracker, { type: 'tool-input-end', id: 'call-1' });
    observeRawChunk(tracker, {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'Write',
      input: JSON.stringify({ path: 'a.md' }),
    });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });

    const safety = resolveToolCallSafety(tracker);
    assert.equal(safety.hadRawArgumentEvidence, false);
    assert.equal(safety.proofs.has('call-1'), false);
  });

  test('a mixed request records raw evidence globally while leaving the atomic sibling unproved', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker, 'call-incremental', { path: 'a.md' });
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-atomic', toolName: 'Write' });
    observeRawChunk(tracker, { type: 'tool-input-end', id: 'call-atomic' });
    observeRawChunk(tracker, {
      type: 'tool-call',
      toolCallId: 'call-atomic',
      toolName: 'Write',
      input: JSON.stringify({ path: 'b.md' }),
    });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });

    const safety = resolveToolCallSafety(tracker);
    assert.equal(safety.hadRawArgumentEvidence, true);
    assert.equal(safety.proofs.has('call-incremental'), true);
    assert.equal(safety.proofs.has('call-atomic'), false);
  });

  test('concurrent request trackers can reuse call_1 without cross-resolution', () => {
    const safe = createToolCallSafetyTracker();
    const unsafe = createToolCallSafetyTracker();
    pushCompleteCall(safe, 'call_1', { path: 'safe.md' });
    pushCompleteCall(unsafe, 'call_1', { path: 'unsafe.md' });
    observeRawChunk(unsafe, { type: 'finish', finishReason: 'length' });
    observeRawChunk(safe, { type: 'finish', finishReason: 'stop' });

    assert.equal(hasProof(safe, 'call_1'), true);
    assert.equal(hasProof(unsafe, 'call_1'), false);
    assert.deepEqual(resolveToolCallSafety(safe).proofs.get('call_1')?.value, {
      path: 'safe.md',
    });
  });

  test('resolution is stable when read more than once', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker);
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });
    const first = resolveToolCallSafety(tracker);
    const second = resolveToolCallSafety(tracker);
    assert.equal(second, first);
  });
});

// The installed Google adapter can legitimately deliver a zero-argument tool
// call as start -> end -> final-call with ZERO tool-input-delta chunks. These
// cases prove that shape gets its own per-id positive proof, and that the
// proof requires the same completeness/identity discipline `proofs` does —
// never "no deltas" alone, and never contamination from a sibling's evidence.
describe('atomicProofs (per-call zero-argument evidence)', () => {
  function pushAtomicCall(
    tracker: ReturnType<typeof createToolCallSafetyTracker>,
    id = 'call-1',
    toolName = 'ListTodos',
  ): void {
    observeRawChunk(tracker, { type: 'tool-input-start', id, toolName });
    observeRawChunk(tracker, { type: 'tool-input-end', id });
  }

  test('a genuinely atomic zero-argument call gets its own positive proof', () => {
    const tracker = createToolCallSafetyTracker();
    pushAtomicCall(tracker);
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });

    const safety = resolveToolCallSafety(tracker);
    assert.deepEqual(safety.atomicProofs.get('call-1'), { name: 'ListTodos' });
    assert.equal(safety.proofs.has('call-1'), false);
  });

  test('an argument-bearing sibling no longer poisons a legitimate zero-argument call', () => {
    const tracker = createToolCallSafetyTracker();
    pushCompleteCall(tracker, 'call-args', { path: 'a.md' });
    pushAtomicCall(tracker, 'call-zero', 'ListTodos');
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });

    const safety = resolveToolCallSafety(tracker);
    // Sibling state is exactly as before: request-global evidence is true,
    // and the zero-arg call still has no entry in `proofs` (it never
    // streamed argument bytes) — but it now has its own atomic proof, which
    // is what a caller must consult before falling back to
    // `hadRawArgumentEvidence`.
    assert.equal(safety.hadRawArgumentEvidence, true);
    assert.deepEqual(safety.proofs.get('call-args'), {
      name: 'Write',
      value: { path: 'a.md' },
    });
    assert.equal(safety.proofs.has('call-zero'), false);
    assert.deepEqual(safety.atomicProofs.get('call-zero'), { name: 'ListTodos' });
  });

  test('an id with any raw delta is never atomic-eligible, even if the bytes never proved', () => {
    const tracker = createToolCallSafetyTracker();
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-1', toolName: 'Write' });
    observeRawChunk(tracker, { type: 'tool-input-delta', id: 'call-1', delta: '{"path":' });
    observeRawChunk(tracker, { type: 'tool-input-end', id: 'call-1' });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });

    const safety = resolveToolCallSafety(tracker);
    assert.equal(safety.proofs.has('call-1'), false); // malformed JSON: no raw-byte proof either.
    assert.equal(safety.atomicProofs.has('call-1'), false);
  });

  test('zero deltas but missing start fails closed', () => {
    const tracker = createToolCallSafetyTracker();
    observeRawChunk(tracker, { type: 'tool-input-end', id: 'call-1' });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });
    assert.equal(resolveToolCallSafety(tracker).atomicProofs.has('call-1'), false);
  });

  test('zero deltas but missing end fails closed', () => {
    const tracker = createToolCallSafetyTracker();
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-1', toolName: 'ListTodos' });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });
    assert.equal(resolveToolCallSafety(tracker).atomicProofs.has('call-1'), false);
  });

  test('duplicate start with zero deltas fails closed', () => {
    const tracker = createToolCallSafetyTracker();
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-1', toolName: 'ListTodos' });
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-1', toolName: 'ListTodos' });
    observeRawChunk(tracker, { type: 'tool-input-end', id: 'call-1' });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });
    assert.equal(resolveToolCallSafety(tracker).atomicProofs.has('call-1'), false);
  });

  test('end observed for a different id than start leaves neither id atomic-proved', () => {
    const tracker = createToolCallSafetyTracker();
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-a', toolName: 'ListTodos' });
    observeRawChunk(tracker, { type: 'tool-input-end', id: 'call-b' });
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });

    const safety = resolveToolCallSafety(tracker);
    assert.equal(safety.atomicProofs.has('call-a'), false); // started, never ended.
    assert.equal(safety.atomicProofs.has('call-b'), false); // ended without starting: invalid.
  });

  test('tool evidence after a terminal event poisons an otherwise-atomic call too', () => {
    const tracker = createToolCallSafetyTracker();
    pushAtomicCall(tracker);
    observeRawChunk(tracker, { type: 'finish', finishReason: 'stop' });
    observeRawChunk(tracker, { type: 'tool-input-start', id: 'call-2', toolName: 'ListTodos' });
    observeRawChunk(tracker, { type: 'tool-input-end', id: 'call-2' });

    const safety = resolveToolCallSafety(tracker);
    assert.equal(safety.atomicProofs.has('call-1'), false);
    assert.equal(safety.atomicProofs.has('call-2'), false);
  });

  for (const finishReason of ['length', 'content-filter', 'error', 'other', 'unknown']) {
    test(`${finishReason} never authorizes an atomic call either`, () => {
      const tracker = createToolCallSafetyTracker();
      pushAtomicCall(tracker);
      observeRawChunk(tracker, { type: 'finish', finishReason });
      assert.equal(resolveToolCallSafety(tracker).atomicProofs.has('call-1'), false);
    });
  }

  test('an ambiguous finish reason is rescued by providerReason for an atomic call too', () => {
    const tracker = createToolCallSafetyTracker();
    pushAtomicCall(tracker);
    observeRawChunk(tracker, { type: 'finish', finishReason: { unified: 'other', raw: 'stop' } });
    assert.deepEqual(
      resolveToolCallSafety(tracker, { providerReason: 'stop' }).atomicProofs.get('call-1'),
      {
        name: 'ListTodos',
      },
    );
  });
});

describe('isSafeToolExecutionStepOutcome', () => {
  const request = {};
  const failure: ModelFailure = {
    type: 'model_failure',
    kind: 'provider_unavailable',
    message: 'boom',
    retryable: false,
  };

  for (const finishReason of ['stop', 'tool-calls'] as const) {
    test(`allows ${finishReason}`, () => {
      const outcome: ModelStepOutcome = {
        kind: 'completed',
        finishReason,
        request,
        continuation: 'none',
      };
      assert.equal(isSafeToolExecutionStepOutcome(outcome), true);
    });
  }

  for (const finishReason of ['length', 'content-filter', 'other', 'unknown'] as const) {
    test(`rejects completed/${finishReason}`, () => {
      const outcome: ModelStepOutcome = {
        kind: 'completed',
        finishReason,
        request,
        continuation: 'none',
      };
      assert.equal(isSafeToolExecutionStepOutcome(outcome), false);
    });
  }

  for (const outcome of [
    { kind: 'truncated', failure, request, continuation: 'none' },
    { kind: 'terminal-failure', failure, request, continuation: 'none' },
    {
      kind: 'retryable-failure',
      failure: { ...failure, retryable: true },
      request,
      continuation: 'none',
    },
    {
      kind: 'aborted',
      failure: { ...failure, kind: 'abort' as const },
      request,
      continuation: 'none',
    },
  ] satisfies ModelStepOutcome[]) {
    test(`rejects ${outcome.kind}`, () => {
      assert.equal(isSafeToolExecutionStepOutcome(outcome), false);
    });
  }
});
