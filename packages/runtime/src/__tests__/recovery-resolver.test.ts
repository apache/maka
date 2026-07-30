import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalToolArgsHash } from '@maka/core';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { resolveRuntimeRecovery } from '../recovery-resolver.js';

describe('RecoveryResolver', () => {
  it('proves a new-protocol call without dispatch was never dispatched', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        status: 'definitely_not_dispatched',
        reason: 'new_protocol_before_dispatch',
        callRuntimeEventId: 'function-call-1',
      },
    ]);
    assert.equal(resolution.hasCorruption, false);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('requires reconciliation after dispatch when no response was committed', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent(),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        operationId: 'operation-1',
        status: 'indeterminate',
        reason: 'dispatch_without_response',
        callRuntimeEventId: 'function-call-1',
        dispatchRuntimeEventId: 'dispatch-1',
      },
    ]);
    assert.equal(resolution.hasCorruption, false);
    assert.equal(resolution.requiresReconciliation, true);
  });

  it('treats a matching response without dispatch as a completed pre-T1 result', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      functionResponseEvent(true),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        status: 'completed',
        reason: 'matching_response',
        callRuntimeEventId: 'function-call-1',
        responseRuntimeEventId: 'function-response-1',
        responseIsError: true,
        settlementOrigin: 'pre_t1_synthetic',
      },
    ]);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('classifies a dispatch without its canonical function call as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      toolDispatchEvent(),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        operationId: 'operation-1',
        status: 'corruption',
        reason: 'orphan_dispatch',
        dispatchRuntimeEventId: 'dispatch-1',
      },
    ]);
    assert.equal(resolution.hasCorruption, true);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('classifies a response without its canonical function call as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionResponseEvent(),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        status: 'corruption',
        reason: 'orphan_response',
        responseRuntimeEventId: 'function-response-1',
        responseIsError: false,
      },
    ]);
    assert.equal(resolution.hasCorruption, true);
  });

  it('classifies dispatch identity drift as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent({ toolName: 'Write' }),
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        operationId: 'operation-1',
        status: 'corruption',
        reason: 'identity_conflict',
        callRuntimeEventId: 'function-call-1',
        dispatchRuntimeEventId: 'dispatch-1',
      },
    ]);
    assert.equal(resolution.hasCorruption, true);
  });

  it('classifies repeated dispatch for one operation as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent(),
      { ...toolDispatchEvent(), id: 'dispatch-2' },
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        operationId: 'operation-1',
        status: 'corruption',
        reason: 'duplicate_dispatch',
        callRuntimeEventId: 'function-call-1',
        dispatchRuntimeEventId: 'dispatch-1',
      },
    ]);
    assert.equal(resolution.hasCorruption, true);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('classifies repeated response for one operation as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent(),
      functionResponseEvent(false, 'operation-1'),
      { ...functionResponseEvent(false, 'operation-1'), id: 'function-response-2' },
    ]);

    assert.deepEqual(resolution.decisions, [
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        operationId: 'operation-1',
        status: 'corruption',
        reason: 'duplicate_response',
        callRuntimeEventId: 'function-call-1',
        dispatchRuntimeEventId: 'dispatch-1',
        responseRuntimeEventId: 'function-response-1',
        responseIsError: false,
      },
    ]);
    assert.equal(resolution.hasCorruption, true);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('rejects a protocol marker added after the first canonical event', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent(),
      event({
        id: 'late-marker',
        actions: { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } },
      }),
    ]);

    assert.deepEqual(resolution.issues, [
      {
        code: 'protocol_marker_invalid',
        eventId: 'late-marker',
      },
    ]);
    assert.equal(resolution.toolBoundaryProtocol, undefined);
    assert.equal(resolution.hasCorruption, true);
  });

  it('rejects an unknown protocol marker on the first canonical event', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('future_protocol' as 't1_after_preflight_v1'),
      functionCallEvent(),
    ]);

    assert.equal(resolution.toolBoundaryProtocol, undefined);
    assert.deepEqual(resolution.issues, [
      {
        code: 'protocol_marker_invalid',
        eventId: 'initial-1',
      },
    ]);
    assert.equal(resolution.decisions[0]?.status, 'indeterminate');
    assert.equal(resolution.decisions[0]?.reason, 'legacy_dispatch_unknown');
    assert.equal(resolution.hasCorruption, true);
    assert.equal(resolution.requiresReconciliation, false);
  });

  it('classifies a response linked to a different operation as corruption', () => {
    const resolution = resolveRuntimeRecovery([
      initialEvent('t1_after_preflight_v1'),
      functionCallEvent(),
      toolDispatchEvent(),
      functionResponseEvent(false, 'another-operation'),
    ]);

    assert.equal(resolution.decisions[0]?.status, 'corruption');
    assert.equal(resolution.decisions[0]?.reason, 'identity_conflict');
    assert.equal(resolution.decisions[0]?.responseRuntimeEventId, 'function-response-1');
    assert.equal(resolution.hasCorruption, true);
  });
});

function initialEvent(toolBoundary?: 't1_after_preflight_v1'): RuntimeEvent {
  return event({
    id: 'initial-1',
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'run it' },
    ...(toolBoundary ? { actions: { runtimeProtocol: { toolBoundary } } } : {}),
  });
}

function functionCallEvent(): RuntimeEvent {
  return event({
    id: 'function-call-1',
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: 'call-1', name: 'Bash', args: { command: 'do-it' } },
  });
}

function toolDispatchEvent(overrides: { toolName?: string } = {}): RuntimeEvent {
  return event({
    id: 'dispatch-1',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'call-1',
        toolName: overrides.toolName ?? 'Bash',
        canonicalArgsHash: canonicalToolArgsHash('Bash', { command: 'do-it' }),
        recoveryMode: 'never_auto_retry',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'call-1' },
  });
}

function functionResponseEvent(isError = false, operationId?: string): RuntimeEvent {
  return event({
    id: 'function-response-1',
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'call-1',
      name: 'Bash',
      result: isError ? 'permission denied' : 'ok',
      ...(isError ? { isError: true } : {}),
    },
    ...(operationId ? { refs: { operationId, toolCallId: 'call-1' } } : {}),
  });
}

function event(overrides: Partial<RuntimeEvent>): RuntimeEvent {
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
