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
import { test } from 'node:test';
import type { ShellRunUpdate } from '@maka/core/events';
import { HostRuntimeResourceCoordinator } from '../server/runtime-resource-coordinator.js';
import {
  boundedRuntimeResourceSnapshot,
  canonicalRuntimeResources,
  createRuntimeResourcePage,
  runtimeResourceRevision,
} from '../server/runtime-resource-projection.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('resource get/list clone each source once without changing projection or source ownership', async () => {
  const clone = globalThis.structuredClone;
  const clones: number[] = [];
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    const caller = new Error().stack?.split('\n')[2] ?? '';
    if (
      caller.includes('/runtime-resource-projection.js:') &&
      (caller.includes('boundedRuntimeResourceUpdate') || caller.includes('boundedState'))
    ) {
      clones.push(Buffer.byteLength(JSON.stringify(value)));
    }
    return clone(value, options);
  }) as typeof structuredClone;
  const expectedClones: number[] = [];
  const unreachable = (): never => {
    throw new Error('Query must not execute a runtime resource');
  };
  try {
    for (const source of fixtures()) {
      const original = clone(source);
      const expected: ShellRunUpdate = {
        ...clone(source),
        result: source.result.output
          ? boundedRuntimeResourceSnapshot(
              source.result as Parameters<typeof boundedRuntimeResourceSnapshot>[0],
            )
          : clone(source.result),
      };
      const revision = runtimeResourceRevision([expected]);
      const coordinator = new HostRuntimeResourceCoordinator({
        manager: {
          runForegroundBash: unreachable,
          runBackgroundBash: unreachable,
          readRuntimeResource: unreachable,
          stopBackgroundTask: unreachable,
          writeStdin: unreachable,
          inspectResource: unreachable,
          getLivePtySnapshot: unreachable,
          terminateAll: async () => {},
        },
        sessions: {
          listShellRunUpdates: async () => [source],
          getShellRunUpdate: async () => source,
        },
        sessionHeaders: { readHeader: async () => ({ cwd: '/workspace', isArchived: false }) },
        sessionAdmission: new SessionAdmissionGate(),
        acquireResidency: () => ({ release() {} }),
        requestDrain() {},
      });
      const context = {
        hostEpoch: 'host-1',
        connectionId: 'connection-1',
        principal: 'local_os_user' as const,
        acquireResidency: () => ({ release() {} }),
      };
      try {
        const get = await coordinator.handlers['runtime.resource.query'](
          { kind: 'get', sessionId: source.sessionId, ref: source.result.ref },
          context,
        );
        expectedClones.push(Buffer.byteLength(JSON.stringify(source)));
        assert.deepEqual(get, {
          ok: true,
          result: { kind: 'resource', sessionId: source.sessionId, revision, resource: expected },
        });
        const list = await coordinator.handlers['runtime.resource.query'](
          { kind: 'list_start', sessionId: source.sessionId },
          context,
        );
        expectedClones.push(Buffer.byteLength(JSON.stringify(source)));
        assert.deepEqual(list, {
          ok: true,
          result: createRuntimeResourcePage(source.sessionId, revision, [expected], 0),
        });
        assert.ok(Buffer.byteLength(JSON.stringify(expected.result)) <= 48 * 1024);
        assert.deepEqual(source, original);
        assert.ok(get.ok && get.result.kind === 'resource' && get.result.resource);
        get.result.resource.ownership.kind = 'local';
        get.result.resource.result.cmd = 'mutated query result';
        if (get.result.resource.result.output?.mode === 'pty') {
          get.result.resource.result.output.cursor.x = 999;
        }
        assert.deepEqual(source, original);
        assert.deepEqual(list, {
          ok: true,
          result: createRuntimeResourcePage(source.sessionId, revision, [expected], 0),
        });
        const projected = canonicalRuntimeResources([source])[0];
        expectedClones.push(Buffer.byteLength(JSON.stringify(source)));
        assert.deepEqual(projected, expected);
        assert.ok(projected);
        projected.result.cwd = 'mutated direct projection';
        projected.ownership.kind = 'local';
        assert.deepEqual(source, original);
      } finally {
        await coordinator.close();
      }
    }
    // Keep this last: the old implementation must pass all response/ownership checks first.
    assert.deepEqual(clones, expectedClones);
  } finally {
    globalThis.structuredClone = clone;
  }
});

function fixtures(): ShellRunUpdate[] {
  const base: ShellRunUpdate = {
    sessionId: 'session-1',
    ownership: { kind: 'local' },
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    result: {
      kind: 'shell_run',
      ref: 'maka://runtime/background-tasks/shell-1',
      mode: 'pipes',
      status: 'running',
      cwd: '/workspace',
      cmd: 'sleep 60',
      startedAt: 1,
      updatedAt: 1,
      revision: 1,
    },
  };
  const pipes = (text: string): ShellRunUpdate => ({
    ...structuredClone(base),
    result: {
      ...structuredClone(base.result),
      mode: 'pipes',
      output: {
        mode: 'pipes',
        stdout: text,
        stderr: 'stderr',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    },
  });
  const heavy = pipes('界🦊"\n'.repeat(100_000));
  heavy.result.cmd = 'cmd'.repeat(30_000);
  heavy.result.cwd = '/path/'.repeat(10_000);
  heavy.result.failureMessage = 'failure'.repeat(10_000);
  heavy.result.status = 'failed';
  heavy.result.exitCode = 1;
  heavy.result.completedAt = 1;
  const pty: ShellRunUpdate = {
    ...structuredClone(base),
    result: {
      ...structuredClone(base.result),
      mode: 'pty',
      output: {
        mode: 'pty',
        screen: '界🦊'.repeat(100_000),
        scrollback: 'history\n'.repeat(100_000),
        lastAlternateScreen: 'alternate\n'.repeat(30_000),
        cols: 80,
        rows: 24,
        cursor: { x: 2, y: 0, visible: true },
        alternateScreen: false,
        truncated: false,
        redacted: false,
      },
    },
  };
  const inherited = structuredClone(base);
  inherited.ownership = { kind: 'source_unavailable', sourceSessionId: 'source-session' };
  return [base, pipes('short'), heavy, pty, inherited];
}
