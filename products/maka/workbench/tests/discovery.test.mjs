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
import { discoveryInput, discoveryTasks } from '../app/discoveryCore.ts';
import { quoteBotMessage } from '../app/botTranscriptCore.ts';

const approval = {
  target: {
    sessionId: 'bot',
    workspace: { path: '/sample' },
    permissions: { access: 'read_only', requestPermissions: false },
    boundaryRevision: 3,
    binding: null,
  },
  model: { connectionId: 'selected', modelId: 'deepseek' },
  thinkingLevel: null,
};

test('approval pins the displayed scope and model and rejects invalid intervals', () => {
  const input = discoveryInput(approval, 'Discovery', ' Check new changes ', 30, 1000, 'UTC');
  assert.deepEqual(input.task.effect, { kind: 'discovery', ...approval });
  assert.equal(input.task.intentBody, 'Check new changes');
  assert.deepEqual(input.task.schedule, { kind: 'interval', everySeconds: 1800, startAt: 1801000 });
  for (const minutes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => discoveryInput(approval, 'Discovery', 'check', minutes, 1000, 'UTC'));
  }
});

test('discovery listing carries catalogue revision through all pages and rejects a raced snapshot', async () => {
  const first = { kind: 'page', revision: 5, tasks: [{ id: 'a' }], nextCursor: 'a' };
  const seen = [];
  const tasks = await discoveryTasks(first, async (cursor, revision) => {
    seen.push([cursor, revision]);
    return { kind: 'page', revision: 5, tasks: [{ id: 'b' }], nextCursor: null };
  });
  assert.deepEqual(tasks, [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(seen, [['a', 5]]);
  await assert.rejects(
    discoveryTasks(first, async () => ({ kind: 'changed', revision: 6 })),
    /page_changed/,
  );
  await assert.rejects(
    discoveryTasks(first, async () => ({ ...first, tasks: [] })),
    /cursor_repeated/,
  );
});

test('quoting an older publication retains its exact outbox and turn identity', () => {
  const publication = {
    sequence: 7,
    turnId: 'older-turn',
    text: 'Original finding',
    discovery: { recordId: 'record', workerSessionId: 'worker', workerTurnId: 'worker-turn' },
  };
  assert.deepEqual(quoteBotMessage(publication, 'bot', 'Discovery', 'finding', 1234), {
    text: 'finding',
    label: 'Discovery',
    sourceMessageId: 'bot/7',
    sourceTurnId: 'older-turn',
    source: { sessionId: 'bot', sessionName: 'Discovery', capturedAt: 1234, truncated: false },
  });
});

test('editing an approved plan preserves cadence, fire limit and expiry unless the interval changes', () => {
  const existing = {
    task: {
      schedule: { kind: 'interval', everySeconds: 1800, startAt: 5000 },
      maxFires: 4,
      expiresAt: 9000000,
    },
    timezone: 'Asia/Shanghai',
    misfire: 'skip',
  };
  const kept = discoveryInput(
    approval,
    'Discovery',
    'Revised instructions',
    30,
    10000,
    'UTC',
    existing,
  );
  assert.deepEqual(kept.task.schedule, existing.task.schedule);
  assert.equal(kept.task.maxFires, 4);
  assert.equal(kept.task.expiresAt, 9000000);
  assert.equal(kept.timezone, 'Asia/Shanghai');
  assert.equal(kept.misfire, 'skip');
  const changed = discoveryInput(
    approval,
    'Discovery',
    'Revised instructions',
    60,
    10000,
    'UTC',
    existing,
  );
  assert.deepEqual(changed.task.schedule, {
    kind: 'interval',
    everySeconds: 3600,
    startAt: 3610000,
  });
  const once = {
    ...existing,
    task: { ...existing.task, schedule: { kind: 'once', runAt: 90000 } },
  };
  assert.deepEqual(
    discoveryInput(approval, 'Discovery', 'Revised instructions', 30, 10000, 'UTC', once).task
      .schedule,
    once.task.schedule,
  );
});

test('editing second-based plans preserves their original seconds and cadence', () => {
  for (const seconds of [1, 31, 90, 3599]) {
    const schedule = { kind: 'interval', everySeconds: seconds, startAt: 5000 };
    const existing = { task: { schedule }, timezone: 'UTC', misfire: 'latest' };
    const edited = discoveryInput(
      approval,
      'Discovery',
      'Only changed instructions',
      Number(String(seconds / 60)),
      10000,
      'UTC',
      existing,
    );
    assert.deepEqual(edited.task.schedule, schedule);
    assert.equal(edited.task.intentBody, 'Only changed instructions');
  }
});
