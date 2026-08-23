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
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  buildInterruptedCodeModeOutcomeCommits,
  resolveRuntimeRecovery,
} from '../recovery-resolver.js';

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

  it('builds an interrupted outcome only for the outer exec operation', () => {
    const outerCall = event({
      id: 'outer-call',
      role: 'model',
      author: 'agent',
      origin: 'provider',
      modelVisibility: 'visible',
      content: { kind: 'function_call', id: 'exec-1', name: 'exec', args: { code: 'work()' } },
      refs: { operationId: 'outer-op', toolCallId: 'exec-1' },
    });
    const outerDispatch = dispatchFor({
      id: 'outer-dispatch',
      operationId: 'outer-op',
      toolCallId: 'exec-1',
      toolName: 'exec',
      args: { code: 'work()' },
    });
    const nestedCall = event({
      id: 'nested-call',
      role: 'model',
      author: 'agent',
      origin: 'code_mode',
      modelVisibility: 'hidden',
      content: { kind: 'function_call', id: 'nested-1', name: 'Read', args: {} },
      refs: {
        operationId: 'nested-op',
        toolCallId: 'nested-1',
        parentOperationId: 'outer-op',
        parentToolCallId: 'exec-1',
      },
    });
    const nestedDispatch = dispatchFor({
      id: 'nested-dispatch',
      operationId: 'nested-op',
      toolCallId: 'nested-1',
      toolName: 'Read',
      args: {},
      origin: 'code_mode',
      modelVisibility: 'hidden',
      parentOperationId: 'outer-op',
      parentToolCallId: 'exec-1',
    });

    const commits = buildInterruptedCodeModeOutcomeCommits(
      [initialEvent('t1_after_preflight_v1'), outerCall, outerDispatch, nestedCall, nestedDispatch],
      50,
      'code_mode',
    );

    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.operationId, 'outer-op');
    assert.equal(commits[0]?.runtimeEvent.content?.kind, 'function_response');
    assert.equal(
      commits[0]?.runtimeEvent.content?.kind === 'function_response'
        ? commits[0].runtimeEvent.content.isError
        : false,
      true,
    );
    assert.deepEqual(
      commits[0]?.runtimeEvent.content?.kind === 'function_response'
        ? commits[0].runtimeEvent.content.result
        : undefined,
      {
        kind: 'json',
        value: {
          kind: 'code_mode',
          status: 'interrupted',
          message: 'Code Mode execution was interrupted by runtime recovery.',
        },
      },
    );
  });

  it('does not infer Code Mode recovery from a custom direct exec name', () => {
    const commits = buildInterruptedCodeModeOutcomeCommits(
      [
        initialEvent('t1_after_preflight_v1'),
        event({
          id: 'direct-exec-call',
          role: 'model',
          author: 'agent',
          origin: 'provider',
          modelVisibility: 'visible',
          content: { kind: 'function_call', id: 'exec-1', name: 'exec', args: {} },
          refs: { operationId: 'direct-exec-op', toolCallId: 'exec-1' },
        }),
        dispatchFor({
          id: 'direct-exec-dispatch',
          operationId: 'direct-exec-op',
          toolCallId: 'exec-1',
          toolName: 'exec',
          args: {},
        }),
      ],
      50,
      'direct',
    );

    assert.deepEqual(commits, []);
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

function dispatchFor(input: {
  id: string;
  operationId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  origin?: 'provider' | 'code_mode';
  modelVisibility?: 'visible' | 'hidden';
  parentOperationId?: string;
  parentToolCallId?: string;
}): RuntimeEvent {
  return event({
    id: input.id,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.modelVisibility ? { modelVisibility: input.modelVisibility } : {}),
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: input.operationId,
        providerToolCallId: input.toolCallId,
        toolName: input.toolName,
        canonicalArgsHash: canonicalToolArgsHash(input.toolName, input.args),
        recoveryMode: 'never_auto_retry',
      },
    },
    refs: {
      operationId: input.operationId,
      toolCallId: input.toolCallId,
      ...(input.parentOperationId ? { parentOperationId: input.parentOperationId } : {}),
      ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
    },
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
