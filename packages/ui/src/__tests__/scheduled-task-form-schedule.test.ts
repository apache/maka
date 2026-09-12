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
import {
  scheduledTaskEditSeed,
  scheduledTaskScheduleFromForm,
  toScheduledTaskLocalDateTimeValue,
} from '../scheduled-task-helpers.js';

const recurrenceAnchor = new Date(2026, 8, 13, 9, 0).getTime();
const snoozedNextFire = new Date(2026, 8, 13, 9, 10).getTime();

const snoozedDailyTask: ScheduledTask = {
  id: 'daily-reminder',
  title: 'Daily reminder',
  intent: { kind: 'text', body: '' },
  schedule: { kind: 'calendar', recurrence: 'daily', anchorAt: recurrenceAnchor },
  effect: { kind: 'notify', channel: 'local' },
  status: 'active',
  nextFireAt: snoozedNextFire,
  lastFireAt: null,
  fireCount: 0,
  maxFires: null,
  expiresAt: null,
  createdBy: { kind: 'user' },
  createdAt: recurrenceAnchor - 1_000,
  updatedAt: recurrenceAnchor - 1_000,
  runs: [],
  lastError: null,
};

const snoozedIntervalTask: ScheduledTask = {
  ...snoozedDailyTask,
  id: 'interval-reminder',
  schedule: { kind: 'interval', everySeconds: 3_600, startAt: recurrenceAnchor },
};

test('preserves a snoozed daily anchor when schedule fields are unchanged', () => {
  const seed = scheduledTaskEditSeed(snoozedDailyTask);

  assert.equal(seed.runAtLocal, toScheduledTaskLocalDateTimeValue(snoozedNextFire));
  assert.equal(scheduledTaskScheduleFromForm(seed, {
    runAtLocal: seed.runAtLocal,
    parsedRunAt: Date.parse(seed.runAtLocal),
    recurrence: seed.recurrence,
    cronExpression: seed.cronExpression,
  }), undefined);
});

test('omits an unchanged interval schedule after snoozing', () => {
  const seed = scheduledTaskEditSeed(snoozedIntervalTask);

  assert.equal(seed.recurrence, 'interval');
  assert.equal(scheduledTaskScheduleFromForm(seed, {
    runAtLocal: seed.runAtLocal,
    parsedRunAt: Date.parse(seed.runAtLocal),
    recurrence: seed.recurrence,
    cronExpression: seed.cronExpression,
  }), undefined);
});

test('uses an explicitly edited time as the new daily anchor', () => {
  const seed = scheduledTaskEditSeed(snoozedDailyTask);
  const editedAnchor = new Date(2026, 8, 13, 9, 30).getTime();

  assert.deepEqual(scheduledTaskScheduleFromForm(seed, {
    runAtLocal: toScheduledTaskLocalDateTimeValue(editedAnchor),
    parsedRunAt: editedAnchor,
    recurrence: seed.recurrence,
    cronExpression: seed.cronExpression,
  }), { kind: 'calendar', recurrence: 'daily', anchorAt: editedAnchor });
});

test('uses an explicitly edited recurrence with the displayed next-run time', () => {
  const seed = scheduledTaskEditSeed(snoozedDailyTask);

  assert.deepEqual(scheduledTaskScheduleFromForm(seed, {
    runAtLocal: seed.runAtLocal,
    parsedRunAt: snoozedNextFire,
    recurrence: 'weekly',
    cronExpression: seed.cronExpression,
  }), { kind: 'calendar', recurrence: 'weekly', anchorAt: snoozedNextFire });
});
