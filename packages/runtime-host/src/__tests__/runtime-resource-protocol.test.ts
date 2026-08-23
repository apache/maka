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
import { SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES } from '@maka/core/shell-run';
import { type ShellRunSnapshotResult, type ShellRunUpdate } from '@maka/core/events';
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import {
  decodeSubscriptionFrame,
  SESSION_RUNTIME_RESOURCE_CHANGES_MAX,
} from '../protocol/session-continuity.js';
import {
  decodeRuntimeResourceControllerControlInput,
  decodeRuntimeResourceQueryInput,
  decodeRuntimeResourceQueryResult,
  decodeRuntimeResourceStopResult,
  RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES,
  RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE,
  RUNTIME_RESOURCE_CURSOR_MAX_BYTES,
  RUNTIME_RESOURCE_PAGE_MAX_ITEMS,
  RUNTIME_RESOURCE_RESULT_MAX_BYTES,
} from '../protocol/runtime-resource.js';

const revision = `sha256:${'a'.repeat(64)}` as const;
const runtimeRef = 'maka://runtime/background-tasks/shell-1';
type PipeShellSnapshot = Extract<ShellRunSnapshotResult, { mode: 'pipes' }>;

describe('Runtime Resource protocol', () => {
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

test('Runtime Resource PTY data remains an ordered Session subscription frame', () => {
  const frame = {
    kind: 'subscription.runtime_resource_pty_data' as const,
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 4,
    sessionId: 'session-1',
    ref: runtimeRef,
    ptySequence: 9,
    data: '\u001b[2Jready',
  };
  assert.deepEqual(decodeSubscriptionFrame(frame), frame);
  assertInvalid(() => decodeSubscriptionFrame({ ...frame, ptySequence: 0 }));
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
