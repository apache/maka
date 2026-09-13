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
import { describe, it } from 'node:test';
import { decodeRuntimeEvent, type RuntimeEvent } from '../runtime-event.js';
import { canonicalToolArgsHash, stableJsonStringify } from '../tool-args-identity.js';
import {
  scanToolLedger,
  validateGenericToolLedgerAppend,
  validateToolLedgerTransition,
  validateToolLedgerEventLane,
} from '../tool-ledger-scanner.js';
import {
  interpretScannedToolRecovery,
  validateToolRecoveryEventBundle,
} from '../tool-recovery-bundle.js';

const EXPECTED_ARGS_HASH =
  'sha256:763712445cbfb7feebe3bd4ba14e29425f05e40b8cd14aef0896853dca24b4d9';
const MAINLINE_V1_HASH_VECTORS = [
  [
    { path: 'prepared.txt' },
    'sha256:b10a9dfa507aac2940a27bdd3670fd7582d52705de906eb13c1ab37b553031e1',
  ],
  [
    { required: ['b', 'a'] },
    'sha256:0002fcd132216e3442d4ab7579d9659019019c6b7000456fbef198b7ae53ee43',
  ],
  [
    { nested: { enum: ['z', 'a'] } },
    'sha256:a1545a7c4bb9197d99d49327067d31da23188091e1bf6641e2a1698d9a906eca',
  ],
  [
    JSON.parse('{"__proto__":{"admin":true}}') as unknown,
    'sha256:ad5ecbd9c66b763ad3505d4ac9ddc7a86cffcecd8fd7f2c0ffb342c34da285e9',
  ],
  [
    { ordinaryArray: ['b', 'a'] },
    'sha256:4b6be45e18e1a7c6566dd72a0fa0c01b0f059bb3128ecd7a3265d5221f7b8351',
  ],
] as const;
const OBSERVATION_DIGEST =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

describe('recovery persistence authority', () => {
  it('preserves the mainline T1 identity bytes for strict JSON tool arguments', () => {
    assert.equal(
      canonicalToolArgsHash('Write', { content: 'after', path: 'notes.txt' }),
      EXPECTED_ARGS_HASH,
    );
    assert.equal(
      canonicalToolArgsHash('Write', { path: 'notes.txt', content: 'after' }),
      EXPECTED_ARGS_HASH,
    );
    assert.throws(() => canonicalToolArgsHash('Write', { value: undefined }), /strict JSON/);
    assert.throws(() => canonicalToolArgsHash('Write', { value: Number.NaN }), /strict JSON/);
    assert.throws(() => canonicalToolArgsHash('Write', { value: 1n }), /strict JSON/);
    assert.throws(
      () => canonicalToolArgsHash('Write', { [Symbol('hidden')]: 'value' }),
      /strict JSON/,
    );
  });

  it('matches frozen mainline v1 hashes for special and ordinary array fields', () => {
    for (const [args, expected] of MAINLINE_V1_HASH_VECTORS) {
      assert.equal(canonicalToolArgsHash('X', args), expected);
    }
  });

  it('keeps strict event JSON lossless while freezing the mainline v1 __proto__ hash', () => {
    const empty = canonicalToolArgsHash('Write', {});
    const withPrototypeNamedProperty = JSON.parse('{"__proto__":{"admin":true}}') as unknown;
    const nestedPrototypeNamedProperty = JSON.parse(
      '{"nested":{"__proto__":{"admin":true}}}',
    ) as unknown;

    assert.notEqual(stableJsonStringify(withPrototypeNamedProperty), stableJsonStringify({}));
    assert.equal(canonicalToolArgsHash('Write', withPrototypeNamedProperty), empty);
    assert.equal(
      canonicalToolArgsHash('Write', nestedPrototypeNamedProperty),
      canonicalToolArgsHash('Write', { nested: {} }),
    );
  });

  it('rejects arrays that cannot be represented as exact strict JSON arrays', () => {
    const sparse = new Array(1);
    const withExtraProperty = [1] as number[] & { extra?: number };
    withExtraProperty.extra = 2;
    const withAccessor = [1];
    Object.defineProperty(withAccessor, '0', {
      enumerable: true,
      configurable: true,
      get: () => 1,
    });
    const withCustomPrototype = [1];
    Object.setPrototypeOf(withCustomPrototype, Object.create(Array.prototype));

    for (const value of [sparse, withExtraProperty, withAccessor, withCustomPrototype]) {
      assert.throws(() => canonicalToolArgsHash('Write', value), /strict JSON/);
    }
  });

  it('accepts null-prototype records as exact JSON objects', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.path = 'notes.txt';
    value.content = 'after';

    assert.equal(canonicalToolArgsHash('Write', value), EXPECTED_ARGS_HASH);
  });

  it('rejects RuntimeEvents that claim more than one tool-ledger semantic lane', () => {
    const callWithDispatch = callEvent();
    callWithDispatch.actions = dispatchEvent().actions;
    assert.deepEqual(validateToolLedgerEventLane(callWithDispatch), {
      ok: false,
      code: 'semantic_lane_conflict',
      eventId: 'call-event-1',
    });

    const terminalDispatch = dispatchEvent();
    terminalDispatch.status = 'completed';
    assert.deepEqual(validateToolLedgerEventLane(terminalDispatch), {
      ok: false,
      code: 'semantic_lane_conflict',
      eventId: 'dispatch-event-1',
    });

    const recoveryWithContent = reconcileEvent();
    recoveryWithContent.content = {
      kind: 'text',
      text: 'not a canonical recovery fact',
    };
    assert.deepEqual(validateToolLedgerEventLane(recoveryWithContent), {
      ok: false,
      code: 'semantic_lane_conflict',
      eventId: 'reconcile-event-1',
    });

    const outcomeWithAuthority = outcomeEvent();
    outcomeWithAuthority.actions = { endInvocation: true };
    assert.deepEqual(validateToolLedgerEventLane(outcomeWithAuthority), {
      ok: false,
      code: 'semantic_lane_conflict',
      eventId: 'outcome-event-1',
    });

    const outcomeWithContinuation = outcomeEvent();
    outcomeWithContinuation.actions = { stateDelta: { continuationStart: true } };
    assert.deepEqual(validateToolLedgerEventLane(outcomeWithContinuation), {
      ok: false,
      code: 'semantic_lane_conflict',
      eventId: 'outcome-event-1',
    });

    const callWithArtifact = callEvent();
    callWithArtifact.actions = { artifactDelta: { bytes: 10 } };
    assert.deepEqual(validateToolLedgerEventLane(callWithArtifact), {
      ok: false,
      code: 'semantic_lane_conflict',
      eventId: 'call-event-1',
    });
  });

  it('reserves durable boundary and recovery facts from generic writers', () => {
    assert.deepEqual(validateGenericToolLedgerAppend(dispatchEvent()), {
      ok: false,
      code: 'reserved_tool_boundary_fact',
      eventId: 'dispatch-event-1',
    });
    assert.deepEqual(validateGenericToolLedgerAppend(outcomeEvent()), {
      ok: false,
      code: 'reserved_tool_boundary_fact',
      eventId: 'outcome-event-1',
    });
    assert.deepEqual(validateGenericToolLedgerAppend(reconcileEvent()), {
      ok: false,
      code: 'reserved_recovery_fact',
      eventId: 'reconcile-event-1',
    });
    assert.deepEqual(validateGenericToolLedgerAppend(callEvent()), { ok: true });
  });

  it('decodes only the exact recovery fact version and payload shape', () => {
    assert.deepEqual(decodeRuntimeEvent(reconcileEvent()), reconcileEvent());
    const unknownVersion = structuredClone(reconcileEvent()) as unknown as {
      actions: { toolRecovery: { version: number } };
    };
    unknownVersion.actions.toolRecovery.version = 999;
    assert.throws(() => decodeRuntimeEvent(unknownVersion), /RuntimeEvent schema/);
  });

  it('reports duplicate call identity, duplicate operation identity, and physical order', () => {
    const duplicateCall = { ...callEvent(), id: 'call-event-2' };
    const otherCall = callEvent({
      id: 'call-event-other',
      content: {
        kind: 'function_call',
        id: 'provider-call-2',
        name: 'Write',
        args: { path: 'other.txt', content: 'after' },
      },
    });
    const duplicateOperation = dispatchEvent({
      id: 'dispatch-event-other',
      actions: {
        toolDispatch: {
          ...dispatchEvent().actions!.toolDispatch!,
          providerToolCallId: 'provider-call-2',
        },
      },
      refs: { operationId: 'operation-1', toolCallId: 'provider-call-2' },
    });

    const scan = scanToolLedger([
      dispatchEvent(),
      callEvent(),
      duplicateCall,
      otherCall,
      duplicateOperation,
    ]);

    assert.deepEqual(
      scan.issues.map(({ code }) => code),
      ['event_order_conflict', 'duplicate_call', 'duplicate_operation'],
    );
    assert.equal(scan.hasCorruption, true);
  });

  it('revalidates an earlier response when a later dispatch binds the operation', () => {
    const unboundResponse = outcomeEvent();
    unboundResponse.refs = { toolCallId: 'provider-call-1' };

    const scan = scanToolLedger([callEvent(), unboundResponse, dispatchEvent()]);

    assert.equal(scan.hasCorruption, true);
    assert.ok(scan.issues.some(({ code }) => code === 'event_order_conflict'));
    assert.ok(scan.issues.some(({ code }) => code === 'identity_conflict'));
  });

  it('authenticates every dispatch hash against the canonical call arguments', () => {
    const dispatch = dispatchEvent();
    dispatch.actions!.toolDispatch!.canonicalArgsHash = 'sha256:wrong';

    const scan = scanToolLedger([callEvent(), dispatch]);

    assert.equal(scan.hasCorruption, true);
    assert.ok(scan.issues.some(({ code }) => code === 'canonical_args_hash_conflict'));
  });

  it('rejects partial events that carry an authoritative tool fact', () => {
    const partialDispatch = dispatchEvent();
    partialDispatch.partial = true;

    const scan = scanToolLedger([partialDispatch]);

    assert.deepEqual(scan.issues, [
      {
        code: 'semantic_lane_conflict',
        eventId: 'dispatch-event-1',
      },
    ]);
  });

  it('rejects branch-qualified tool authority until branch is part of durable identity', () => {
    const branchedCall = callEvent();
    branchedCall.branch = 'child-1';

    assert.deepEqual(validateToolLedgerEventLane(branchedCall), {
      ok: false,
      code: 'semantic_lane_conflict',
      eventId: 'call-event-1',
    });
  });

  it('uses unambiguous tuple identity for provider call keys', () => {
    const first = callEvent({
      id: 'call-a',
      invocationId: 'a\0b',
      content: {
        kind: 'function_call',
        id: 'c',
        name: 'Read',
        args: {},
      },
    });
    const second = callEvent({
      id: 'call-b',
      invocationId: 'a',
      content: {
        kind: 'function_call',
        id: 'b\0c',
        name: 'Read',
        args: {},
      },
    });

    const scan = scanToolLedger([first, second]);
    assert.equal(scan.hasCorruption, false);
    assert.equal(scan.operations.length, 2);
  });

  it('rejects one invocation identity spanning multiple execution spines', () => {
    const otherRun = callEvent({
      id: 'call-event-2',
      runId: 'run-2',
      turnId: 'turn-2',
      content: {
        kind: 'function_call',
        id: 'provider-call-2',
        name: 'Read',
        args: {},
      },
    });

    const scan = scanToolLedger([callEvent(), otherRun]);

    assert.equal(scan.hasCorruption, true);
    assert.ok(scan.issues.some(({ code }) => code === 'invocation_identity_conflict'));
  });

  it('rejects prospective generic transitions that would corrupt a clean ledger', () => {
    const duplicateCall = callEvent({ id: 'call-event-duplicate' });
    assert.deepEqual(
      validateToolLedgerTransition({
        existingEvents: [callEvent()],
        candidateEvents: [duplicateCall],
        expectedTransition: 'generic_append',
      }),
      {
        ok: false,
        code: 'duplicate_call',
        eventId: 'call-event-duplicate',
        toolCallId: 'provider-call-1',
      },
    );

    const unboundResponse = outcomeEvent();
    unboundResponse.refs = { toolCallId: 'provider-call-1' };
    assert.deepEqual(
      validateToolLedgerTransition({
        existingEvents: [callEvent(), dispatchEvent()],
        candidateEvents: [unboundResponse],
        expectedTransition: 'generic_append',
      }),
      {
        ok: false,
        code: 'identity_conflict',
        eventId: 'outcome-event-1',
        operationId: 'operation-1',
        toolCallId: 'provider-call-1',
      },
    );
  });

  it('rejects a recovery bundle whose T1 hash authenticates itself instead of the call args', () => {
    const dispatch = dispatchEvent();
    dispatch.actions!.toolDispatch!.canonicalArgsHash = 'sha256:wrong';

    assert.deepEqual(
      validateToolRecoveryEventBundle({
        operation: {
          ...operationIdentity(),
          canonicalArgsHash: 'sha256:wrong',
        },
        callEvent: callEvent(),
        dispatchEvent: dispatch,
        reconcileEvent: reconcileEvent(),
        outcomeEvent: outcomeEvent(),
        decisionEvent: decisionEvent(),
      }),
      {
        ok: false,
        code: 'canonical_args_hash_conflict',
        message: 'Recovery bundle argument hash does not match its canonical function call',
      },
    );
  });

  it('accepts completed only with one matching outcome and canonical evidence order', () => {
    assert.deepEqual(
      validateToolRecoveryEventBundle({
        operation: operationIdentity(),
        callEvent: callEvent(),
        dispatchEvent: dispatchEvent(),
        reconcileEvent: reconcileEvent(),
        outcomeEvent: outcomeEvent(),
        decisionEvent: decisionEvent(),
      }),
      {
        ok: true,
        reconcile: reconcileEvent().actions!.toolRecovery!.payload,
        decision: decisionEvent().actions!.toolRecovery!.payload,
      },
    );
  });

  it('gives Resolver and rebuild one recovery-bundle interpretation', () => {
    const events = [
      callEvent(),
      dispatchEvent(),
      reconcileEvent(),
      outcomeEvent(),
      decisionEvent(),
    ];
    const operation = scanToolLedger(events).operations[0]!;

    assert.equal(
      interpretScannedToolRecovery(
        operation,
        new Map(events.map((event, index) => [event.id, index])),
      ).kind,
      'valid',
    );

    const wrongOrder = [
      callEvent(),
      dispatchEvent(),
      outcomeEvent(),
      reconcileEvent(),
      decisionEvent(),
    ];
    assert.deepEqual(
      interpretScannedToolRecovery(
        scanToolLedger(wrongOrder).operations[0]!,
        new Map(wrongOrder.map((event, index) => [event.id, index])),
      ),
      {
        kind: 'corruption',
        code: 'event_order_conflict',
        message: 'Recovery facts violate canonical RuntimeEvent causal order',
      },
    );
  });
});

function operationIdentity() {
  return {
    operationId: 'operation-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    turnId: 'turn-1',
    providerToolCallId: 'provider-call-1',
    toolName: 'Write',
    canonicalArgsHash: EXPECTED_ARGS_HASH,
    recoveryMode: 'reconcile' as const,
    callEventId: 'call-event-1',
    dispatchEventId: 'dispatch-event-1',
  };
}

function baseEvent(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

function callEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return baseEvent({
    id: 'call-event-1',
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: 'provider-call-1',
      name: 'Write',
      args: { path: 'notes.txt', content: 'after' },
    },
    ...overrides,
  });
}

function dispatchEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return baseEvent({
    id: 'dispatch-event-1',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Write',
        canonicalArgsHash: EXPECTED_ARGS_HASH,
        recoveryMode: 'reconcile',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
    ...overrides,
  });
}

function reconcileEvent(): RuntimeEvent {
  return baseEvent({
    id: 'reconcile-event-1',
    ts: 2,
    actions: {
      toolRecovery: {
        kind: 'maka.tool.reconcile_result',
        version: 1,
        payload: {
          protocol: 'tool_reconcile_v1',
          operationId: 'operation-1',
          observation: 'matches_expected_state',
          observationSchema: 'state_identity_v1',
          observationDigest: OBSERVATION_DIGEST,
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function outcomeEvent(): RuntimeEvent {
  return baseEvent({
    id: 'outcome-event-1',
    ts: 3,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'provider-call-1',
      name: 'Write',
      result: 'ok',
      isError: false,
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}

function decisionEvent(): RuntimeEvent {
  return baseEvent({
    id: 'decision-event-1',
    ts: 4,
    actions: {
      toolRecovery: {
        kind: 'maka.tool.recovery_decision',
        version: 1,
        payload: {
          protocol: 'tool_recovery_v1',
          operationId: 'operation-1',
          disposition: 'completed',
          reasonCode: 'reconcile_matches_expected_state',
          outcomeEventId: 'outcome-event-1',
          evidenceEventIds: [
            'call-event-1',
            'dispatch-event-1',
            'reconcile-event-1',
            'outcome-event-1',
          ],
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  });
}
