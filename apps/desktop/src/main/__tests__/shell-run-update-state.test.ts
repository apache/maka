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
import type { ShellRunSnapshotResult, ShellRunUpdate } from '@maka/core/events';
import {
  mergeShellRunNotification,
  mergeShellRunUpdates,
  ShellRunHydration,
} from '../../renderer/shell-run-update-state.js';

test('ShellRun update state rejects a stale hydration result after a newer notification', () => {
  const current = mergeShellRunUpdates({}, [update(3)]);
  const afterStaleHydration = mergeShellRunUpdates(current, [update(2)]);
  assert.equal(afterStaleHydration, current);
  assert.equal(afterStaleHydration.session?.bash?.result.revision, 3);

  const afterNewerNotification = mergeShellRunUpdates(current, [update(4)]);
  assert.notEqual(afterNewerNotification, current);
  assert.equal(afterNewerNotification.session?.bash?.result.revision, 4);
});

test('ShellRun update state fans owner completion into an inherited session view', () => {
  const inherited: ShellRunUpdate = {
    sessionId: 'branch',
    ownership: {
      kind: 'source_owned',
      sourceSessionId: 'parent',
      ownerSessionId: 'owner',
    },
    sourceTurnId: 'turn',
    sourceToolCallId: 'bash',
    result: shellRun(3),
  };
  const current = mergeShellRunUpdates({}, [inherited]);
  const ownerCompletion: ShellRunUpdate = {
    sessionId: 'owner',
    ownership: { kind: 'local' },
    sourceTurnId: 'owner-turn',
    sourceToolCallId: 'owner-bash',
    result: {
      ...shellRun(4),
      status: 'completed',
      completedAt: 4,
      exitCode: 0,
    },
  };

  const next = mergeShellRunNotification(current, 'branch', ownerCompletion);

  assert.equal(next.branch?.bash?.sessionId, 'branch');
  assert.deepEqual(next.branch?.bash?.ownership, inherited.ownership);
  assert.equal(next.branch?.bash?.result.status, 'completed');
  assert.equal(next.branch?.bash?.result.revision, 4);
});

test('ShellRun update state applies ownership changes at the same revision', () => {
  const owned: ShellRunUpdate = {
    sessionId: 'branch',
    ownership: {
      kind: 'source_owned',
      sourceSessionId: 'parent',
      ownerSessionId: 'owner',
    },
    sourceTurnId: 'turn',
    sourceToolCallId: 'bash',
    result: shellRun(3),
  };
  const current = mergeShellRunUpdates({}, [owned]);
  const next = mergeShellRunUpdates(current, [{
    ...owned,
    ownership: { kind: 'source_unavailable', sourceSessionId: 'parent' },
  }]);

  assert.notEqual(next, current);
  assert.deepEqual(next.branch?.bash?.ownership, {
    kind: 'source_unavailable',
    sourceSessionId: 'parent',
  });
  assert.equal(next.branch?.bash?.result.revision, 3);
});

test('ShellRun hydration ignores an old read and replays updates after the resync boundary', () => {
  const hydration = new ShellRunHydration();
  const oldEpoch = hydration.begin();
  hydration.accept(update(2));

  const currentEpoch = hydration.begin();
  hydration.accept(update(4));
  const current = hydration.commit(currentEpoch);
  assert.deepEqual(current?.updates.map((entry) => entry.result.revision), [4]);
  assert.equal(hydration.commit(oldEpoch), undefined);

  assert.equal(hydration.accept(update(5))?.result.revision, 5);
});

function update(revision: number): ShellRunUpdate {
  return {
    sessionId: 'session',
    ownership: { kind: 'local' },
    sourceTurnId: 'turn',
    sourceToolCallId: 'bash',
    result: shellRun(revision),
  };
}

function shellRun(revision: number): ShellRunSnapshotResult {
  return {
    kind: 'shell_run',
    ref: 'maka://runtime/background-tasks/pty',
    mode: 'pty',
    status: 'running',
    cwd: '/repo',
    cmd: 'job',
    startedAt: 1,
    updatedAt: revision,
    revision,
    output: {
      mode: 'pty',
      screen: 'ready',
      scrollback: '',
      cols: 80,
      rows: 24,
      cursor: { x: 5, y: 0, visible: true },
      alternateScreen: false,
      truncated: false,
      redacted: false,
    },
  };
}
