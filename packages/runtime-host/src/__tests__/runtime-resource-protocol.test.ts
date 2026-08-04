import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES,
  type ShellRunSnapshotResult,
  type ShellRunUpdate,
} from '@maka/core';
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import {
  decodeSubscriptionFrame,
  SESSION_RUNTIME_RESOURCE_CHANGES_MAX,
} from '../protocol/session-continuity.js';
import {
  decodeRuntimeResourceControllerAcquireInput,
  decodeRuntimeResourceControllerAcquireResult,
  decodeRuntimeResourceControllerControlInput,
  decodeRuntimeResourceControllerControlResult,
  decodeRuntimeResourceControllerReleaseInput,
  decodeRuntimeResourceControllerReleaseResult,
  decodeRuntimeResourceQueryInput,
  decodeRuntimeResourceQueryResult,
  decodeRuntimeResourceStopInput,
  decodeRuntimeResourceStopResult,
  RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES,
  RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE,
  RUNTIME_RESOURCE_CURSOR_MAX_BYTES,
  RUNTIME_RESOURCE_OPERATION_SPECS,
  RUNTIME_RESOURCE_PAGE_MAX_ITEMS,
  RUNTIME_RESOURCE_RESULT_MAX_BYTES,
} from '../protocol/runtime-resource.js';

const revision = `sha256:${'a'.repeat(64)}` as const;
const nextRevision = `sha256:${'b'.repeat(64)}` as const;
const runtimeRef = 'maka://runtime/background-tasks/shell-1';
type PipeShellSnapshot = Extract<ShellRunSnapshotResult, { mode: 'pipes' }>;

describe('Runtime Resource protocol', () => {
  test('declares the complete ready operation surface', () => {
    assert.deepEqual(Object.keys(RUNTIME_RESOURCE_OPERATION_SPECS), [
      'runtime.resource.query',
      'runtime.resource.controller.acquire',
      'runtime.resource.controller.control',
      'runtime.resource.controller.release',
      'runtime.resource.stop',
    ]);
    assert.equal(RUNTIME_RESOURCE_OPERATION_SPECS['runtime.resource.query'].mode, 'query');
    for (const [key, spec] of Object.entries(RUNTIME_RESOURCE_OPERATION_SPECS)) {
      assert.equal(spec.availability, 'ready', key);
      if (key !== 'runtime.resource.query') assert.equal(spec.mode, 'control', key);
    }
  });

  test('round-trips every query, controller, and stop branch', () => {
    const update = resourceUpdate();
    const unavailable = resourceUpdate({
      ownership: { kind: 'source_unavailable', sourceSessionId: 'source-session' },
      result: compactState(),
    });
    for (const input of [
      { kind: 'list_start', sessionId: 'session-1' },
      { kind: 'list_continue', sessionId: 'session-1', revision, cursor: '2' },
      { kind: 'get', sessionId: 'session-1', ref: runtimeRef },
    ] as const) {
      assert.deepEqual(decodeRuntimeResourceQueryInput(input), input);
    }
    for (const result of [
      {
        kind: 'page',
        sessionId: 'session-1',
        revision,
        resources: [update, unavailable],
        nextCursor: '1',
      },
      { kind: 'revision_changed', expected: revision, actual: nextRevision },
      { kind: 'resource', sessionId: 'session-1', revision, resource: update },
      { kind: 'resource', sessionId: 'session-1', revision, resource: null },
    ] as const) {
      assert.deepEqual(decodeRuntimeResourceQueryResult(result), result);
    }

    const identity = { sessionId: 'session-1', ref: runtimeRef, controllerId: 'client-1' };
    assert.deepEqual(decodeRuntimeResourceControllerAcquireInput(identity), identity);
    assert.deepEqual(decodeRuntimeResourceControllerReleaseInput(identity), identity);
    assert.deepEqual(
      decodeRuntimeResourceControllerAcquireResult({
        controllerId: 'client-1',
        nextSequence: 1,
        resource: snapshot(),
      }),
      { controllerId: 'client-1', nextSequence: 1, resource: snapshot() },
    );

    for (const control of [
      { kind: 'input', input: 'hello' },
      { kind: 'resize', cols: 80, rows: 24 },
      { kind: 'input_and_resize', input: 'hello', cols: 80, rows: 24 },
    ] as const) {
      const input = { ...identity, sequence: 1, control };
      assert.deepEqual(decodeRuntimeResourceControllerControlInput(input), input);
    }
    const controlled = { controllerId: 'client-1', sequence: 1, resource: snapshot() };
    assert.deepEqual(decodeRuntimeResourceControllerControlResult(controlled), controlled);
    assert.deepEqual(
      decodeRuntimeResourceControllerReleaseResult({ controllerId: 'client-1', released: true }),
      { controllerId: 'client-1', released: true },
    );
    assert.deepEqual(decodeRuntimeResourceStopInput({ sessionId: 'session-1', ref: runtimeRef }), {
      sessionId: 'session-1',
      ref: runtimeRef,
    });
    assert.deepEqual(decodeRuntimeResourceStopResult({ resource: snapshot() }), {
      resource: snapshot(),
    });
  });

  test('rejects unknown fields and non-canonical snapshots', () => {
    assertInvalid(() =>
      decodeRuntimeResourceQueryInput({
        kind: 'get',
        sessionId: 'session-1',
        ref: runtimeRef,
        rawPath: '/private/shell-run.json',
      }),
    );
    assertInvalid(() =>
      decodeRuntimeResourceControllerControlInput({
        sessionId: 'session-1',
        ref: runtimeRef,
        controllerId: 'client-1',
        sequence: 1,
        control: { kind: 'resize', cols: 80, rows: 24, force: true },
      }),
    );
    for (const invalid of [
      { ...snapshot(), output: undefined },
      { ...snapshot(), operation: { kind: 'stop', applied: true } },
      { ...snapshot(), privatePid: 42 },
    ]) {
      assertInvalid(() => decodeRuntimeResourceStopResult({ resource: invalid }));
    }
  });

  test('enforces cursor, sequence, PTY control, item, and encoded result bounds', () => {
    const maximumToolCallId = '😀'.repeat(SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES / 4);
    assert.equal(
      Buffer.byteLength(maximumToolCallId, 'utf8'),
      SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES,
    );
    const maximumIdentity = {
      kind: 'resource' as const,
      sessionId: 'session-1',
      revision,
      resource: resourceUpdate({ sourceToolCallId: maximumToolCallId }),
    };
    const decodedMaximumIdentity = decodeRuntimeResourceQueryResult(maximumIdentity);
    assert.equal(
      decodedMaximumIdentity.kind === 'resource'
        ? decodedMaximumIdentity.resource?.sourceToolCallId
        : undefined,
      maximumToolCallId,
    );
    assertInvalid(() =>
      decodeRuntimeResourceQueryResult({
        ...maximumIdentity,
        resource: resourceUpdate({ sourceToolCallId: `${maximumToolCallId}x` }),
      }),
    );

    for (const cursor of ['', '界'.repeat(Math.floor(RUNTIME_RESOURCE_CURSOR_MAX_BYTES / 3) + 1)]) {
      assertInvalid(() =>
        decodeRuntimeResourceQueryInput({
          kind: 'list_continue',
          sessionId: 'session-1',
          revision,
          cursor,
        }),
      );
    }
    for (const sequence of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      assertInvalid(() =>
        decodeRuntimeResourceControllerControlInput({
          sessionId: 'session-1',
          ref: runtimeRef,
          controllerId: 'client-1',
          sequence,
          control: { kind: 'input', input: 'x' },
        }),
      );
    }
    assertInvalid(() =>
      decodeRuntimeResourceControllerControlInput({
        sessionId: 'session-1',
        ref: runtimeRef,
        controllerId: 'client-1',
        sequence: RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE + 1,
        control: { kind: 'input', input: 'x' },
      }),
    );
    for (const control of [
      { kind: 'input', input: '' },
      {
        kind: 'input',
        input: '界'.repeat(Math.floor(RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES / 3) + 1),
      },
      { kind: 'resize', cols: 1, rows: 24 },
      { kind: 'resize', cols: 80, rows: 101 },
    ]) {
      assertInvalid(() =>
        decodeRuntimeResourceControllerControlInput({
          sessionId: 'session-1',
          ref: runtimeRef,
          controllerId: 'client-1',
          sequence: 1,
          control,
        }),
      );
    }

    const tooMany = Array.from({ length: RUNTIME_RESOURCE_PAGE_MAX_ITEMS + 1 }, resourceUpdate);
    assertInvalid(() =>
      decodeRuntimeResourceQueryResult({
        kind: 'page',
        sessionId: 'session-1',
        revision,
        resources: tooMany,
        nextCursor: null,
      }),
    );
    const oversized = {
      resource: snapshot({
        output: pipeOutput('x'.repeat(RUNTIME_RESOURCE_RESULT_MAX_BYTES)),
      }),
    };
    assert.ok(
      Buffer.byteLength(JSON.stringify(oversized), 'utf8') > RUNTIME_RESOURCE_RESULT_MAX_BYTES,
    );
    assertInvalid(() => decodeRuntimeResourceStopResult(oversized));
  });
});

test('Runtime Resource invalidations batch lightweight unique identities', () => {
  const resources = Array.from({ length: SESSION_RUNTIME_RESOURCE_CHANGES_MAX }, (_, index) => ({
    sourceSessionId: 'source-session',
    ref: `maka://runtime/background-tasks/shell-${index}`,
  }));
  assert.deepEqual(
    decodeSubscriptionFrame({
      kind: 'subscription.session_domain_changed',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      sessionId: 'child-session',
      domain: 'runtime_resource',
      resources,
    }),
    {
      kind: 'subscription.session_domain_changed',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      sessionId: 'child-session',
      domain: 'runtime_resource',
      resources,
    },
  );
  assertInvalid(() =>
    decodeSubscriptionFrame({
      kind: 'subscription.session_domain_changed',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      sessionId: 'child-session',
      domain: 'runtime_resource',
      resources: [resources[0], resources[0]],
    }),
  );
});

function resourceUpdate(overrides: Partial<ShellRunUpdate> = {}): ShellRunUpdate {
  return {
    sessionId: 'session-1',
    ownership: { kind: 'local' },
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'call.1/part',
    result: snapshot(),
    ...overrides,
  };
}

function compactState(): ShellRunUpdate['result'] {
  const { output: _output, ...compact } = snapshot();
  return compact;
}

function snapshot(overrides: Partial<PipeShellSnapshot> = {}): PipeShellSnapshot {
  return {
    kind: 'shell_run',
    ref: runtimeRef,
    mode: 'pipes',
    status: 'running',
    cwd: '/workspace',
    cmd: 'printf done',
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: pipeOutput(''),
    ...overrides,
  };
}

function pipeOutput(stdout: string): PipeShellSnapshot['output'] {
  return {
    mode: 'pipes',
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: false,
  };
}

function assertInvalid(action: () => unknown): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame',
  );
}
