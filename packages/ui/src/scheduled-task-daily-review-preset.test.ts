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
import test from 'node:test';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import { getScheduledTaskCopy } from './scheduled-task-copy.js';
import {
  scheduledTaskEditableRunAt,
  scheduledTaskTemplateSeed,
} from './scheduled-task-helpers.js';

test('Daily Review preset freezes an ordinary Agent run execution', () => {
  const template = getScheduledTaskCopy('en').templates.find(
    (candidate) => candidate.id === 'daily-review',
  );
  assert.ok(template);
  const effect = {
    kind: 'agent_run' as const,
    execution: {
      cwd: '/workspace',
      llmConnectionId: 'connection-id',
      llmConnectionSlug: 'connection-slug',
      model: 'model-id',
      permissionMode: 'ask' as const,
      collaborationMode: 'agent' as const,
      orchestrationMode: 'default' as const,
    },
  };
  const seed = scheduledTaskTemplateSeed(
    template,
    new Date(2026, 7, 29, 10).getTime(),
    effect,
  );
  assert.equal(seed.title, 'Daily Review');
  assert.equal((seed as { presetId?: string }).presetId, 'daily-review');
  assert.equal(seed.recurrence, 'cron');
  assert.equal(seed.cronExpression, '0 18 * * *');
  assert.equal(seed.deliveryMethod, 'agent_run');
  assert.deepEqual(seed.lockedEffect, effect);
  assert.match(seed.note, /ordinary Session history/u);
});

test('paused calendar editing preserves its local execution time', () => {
  const now = new Date(2026, 7, 29, 12, 0).getTime();
  const anchorAt = new Date(2026, 7, 28, 8, 30).getTime();
  const task: ScheduledTask = {
    id: 'system-daily-review',
    presetId: 'daily-review',
    title: 'Daily Review',
    intent: { kind: 'text', body: 'Review ordinary Sessions.' },
    schedule: { kind: 'calendar', recurrence: 'daily', anchorAt, catchUp: 'once' },
    effect: { kind: 'notify', channel: 'local' },
    status: 'paused',
    nextFireAt: null,
    lastFireAt: null,
    fireCount: 0,
    maxFires: null,
    expiresAt: null,
    createdBy: { kind: 'system' },
    createdAt: anchorAt,
    updatedAt: now,
    runs: [],
    lastError: null,
  };

  const editable = new Date(scheduledTaskEditableRunAt(task, now));
  assert.equal(editable.getDate(), 30);
  assert.equal(editable.getHours(), 8);
  assert.equal(editable.getMinutes(), 30);
});
