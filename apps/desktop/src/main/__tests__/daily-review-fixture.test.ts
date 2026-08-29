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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  scheduledTaskPresetSessionLabel,
  scheduledTaskSessionLabel,
} from '@maka/core/scheduled-task';
import { openInteractiveScheduledTaskStoreForWrite } from '@maka/storage/scheduled-task-store';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { dailyReviewSessions } from '../e2e-fixture/scenarios-sessions.js';
import {
  writeConnections,
  writeScheduledTasks,
} from '../e2e-fixture/scenarios-settings.js';

test('Daily Review fixture uses the ScheduledTask and ordinary Session shapes', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-daily-review-fixture-'));
  const now = Date.UTC(2026, 4, 22, 11, 0, 0);
  try {
    await writeConnections(workspaceRoot, now, 'module-daily-review');
    await writeScheduledTasks(workspaceRoot, now, 'module-daily-review');

    const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    const store = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
    try {
      const task = await store.get('system-daily-review');
      assert.equal(task?.presetId, 'daily-review');
      assert.equal(task?.createdBy.kind, 'system');
      assert.equal(task?.schedule.kind, 'calendar');
      assert.equal(task?.effect.kind, 'agent_run');
      assert.ok(task?.effect.kind === 'agent_run' && task.effect.execution.llmConnectionId);
    } finally {
      store.close();
      await owner.close();
    }

    const sessions = dailyReviewSessions(now);
    assert.deepEqual(sessions.map(({ header }) => header.labels), [
      [
        'scheduled-task',
        scheduledTaskSessionLabel('system-daily-review'),
        scheduledTaskPresetSessionLabel('daily-review'),
      ],
      ['migrated:daily-review'],
    ]);
    assert.deepEqual(sessions.map(({ messages }) => messages[0]?.type), [
      'assistant',
      'assistant',
    ]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
