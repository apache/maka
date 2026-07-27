import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeRuntimeEvent, type RuntimeEvent } from '../runtime-event.js';
import { canonicalToolArgsHash } from '../tool-args-identity.js';
import {
  scanToolLedger,
  validateGenericToolLedgerAppend,
  validateToolLedgerEventLane,
} from '../tool-ledger-scanner.js';
import {
  interpretScannedToolRecovery,
  validateToolRecoveryEventBundle,
} from '../tool-recovery-bundle.js';

const EXPECTED_ARGS_HASH =
  'sha256:6d6986f1e1432963178ce8c64f6fb4a1ba30f6176991750cc70558e417d93058';
const OBSERVATION_DIGEST =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

describe('recovery persistence authority', () => {
  it('derives one domain-separated identity from strict JSON tool arguments', () => {
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
