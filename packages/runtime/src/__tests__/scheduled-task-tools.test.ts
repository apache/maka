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
import type { ScheduledTask } from '@maka/core/scheduled-task';
import {
  buildScheduledTaskTool,
  formatScheduledTaskLocalTime,
  type ScheduledTaskToolAuthority,
} from '../scheduled-task-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

// 2026-09-24T09:42:45+08:00
const NOW = Date.UTC(2026, 8, 24, 1, 42, 45);
const TEN_AM_SHANGHAI = Date.UTC(2026, 8, 24, 2, 0, 0);

function authority(created: Partial<ScheduledTask> = {}): ScheduledTaskToolAuthority {
  let latest: ScheduledTask | undefined;
  return {
    create: async (input) => {
      latest = {
        id: 'task-1',
        title: input.title,
        nextFireAt: input.schedule.kind === 'once' ? input.schedule.runAt : null,
        effect: { kind: 'notify', channel: 'local' },
        ...created,
      } as ScheduledTask;
      return latest;
    },
    list: async () => (latest ? [latest] : []),
    pause: async () => ({ error: 'unused' }),
    resume: async () => ({ error: 'unused' }),
    remove: async () => ({ error: 'unused' }),
  };
}

const ctx = { cwd: '/project', sessionId: 'session-1' } as MakaToolContext;

test('formats Host time with an explicit offset and zone', () => {
  assert.equal(
    formatScheduledTaskLocalTime(NOW, 'Asia/Shanghai'),
    '2026-09-24T09:42:45+08:00 (Asia/Shanghai)',
  );
  assert.equal(formatScheduledTaskLocalTime(NOW, 'UTC'), '2026-09-24T01:42:45+00:00 (UTC)');
});

test('list reports the current Host time so runAt needs no shell', async () => {
  const tool = buildScheduledTaskTool({
    authority: authority(),
    now: () => NOW,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(
    await tool.impl({ mode: 'list' }, ctx),
    `No scheduled tasks.\nnow=${NOW} (2026-09-24T09:42:45+08:00 (Asia/Shanghai))`,
  );
});

test('create echoes the local fire time next to the epoch', async () => {
  const tool = buildScheduledTaskTool({
    authority: authority(),
    now: () => NOW,
    timeZone: 'Asia/Shanghai',
  });
  const result = String(
    await tool.impl(
      {
        mode: 'create',
        title: 'Tidy Downloads',
        intentBody: 'Archive screenshots, installers, and temporary documents.',
        schedule: { kind: 'once', runAt: TEN_AM_SHANGHAI },
        effect: 'agent_run',
      },
      ctx,
    ),
  );
  assert.deepEqual(result.split('\n'), [
    'Scheduled task created and verified in Maka catalog: Tidy Downloads (task-1)',
    `nextFireAt=${TEN_AM_SHANGHAI} (2026-09-24T10:00:00+08:00 (Asia/Shanghai))`,
    'effect=notify',
    'cwd=/project',
    `now=${NOW} (2026-09-24T09:42:45+08:00 (Asia/Shanghai))`,
  ]);
});

const verificationTask: ScheduledTask = {
  id: 'weekly-report',
  title: 'Weekly work report',
  intent: { kind: 'text', body: 'Generate a weekly report' },
  schedule: { kind: 'cron', expression: '0 17 * * 5', startAt: 1 },
  effect: {
    kind: 'agent_run',
    execution: {
      cwd: '/project',
      llmConnectionId: 'connection',
      llmConnectionSlug: 'model',
      model: 'test',
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
    },
  },
  status: 'active',
  nextFireAt: 1790931600000,
  lastFireAt: null,
  fireCount: 0,
  maxFires: null,
  expiresAt: null,
  createdBy: { kind: 'agent', sessionId: 'session' },
  createdAt: 1,
  updatedAt: 1,
  runs: [],
  lastError: null,
};
const verificationInput = {
  mode: 'create',
  title: verificationTask.title,
  intentBody: verificationTask.intent.body,
  schedule: { kind: 'cron', expression: '0 17 * * 5' },
  effect: 'agent_run',
};

function verificationFixture(overrides: Partial<ScheduledTaskToolAuthority> = {}) {
  let creates = 0;
  const authority: ScheduledTaskToolAuthority = {
    create: async () => {
      creates++;
      return verificationTask;
    },
    list: async () => [verificationTask],
    pause: async () => verificationTask,
    resume: async () => verificationTask,
    remove: async () => ({ ok: true }),
    ...overrides,
  };
  const context: MakaToolContext = {
    cwd: '/project',
    sessionId: 'session',
    turnId: 'turn',
    toolCallId: 'call',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
  return { tool: buildScheduledTaskTool({ authority }), context, creates: () => creates };
}

test('create checks the catalog and reports the persisted execution directory', async () => {
  let reads = 0;
  const fixture = verificationFixture({
    list: async () => {
      reads++;
      return [verificationTask];
    },
  });
  const result = await fixture.tool.impl(verificationInput, {
    ...fixture.context,
    cwd: '/other-context',
  });
  assert.match(String(result), /created and verified in Maka catalog/);
  assert.match(String(result), /cwd=\/project/);
  assert.equal(reads, 1);
  assert.equal(fixture.creates(), 1);
});

for (const kind of ['missing', 'unavailable'] as const) {
  test(`create warns of possible persistence when catalog is ${kind}`, async () => {
    const fixture = verificationFixture({
      list: async () => {
        if (kind === 'unavailable') throw new Error('offline');
        return [];
      },
    });
    const result = String(await fixture.tool.impl(verificationInput, fixture.context));
    assert.match(result, /catalog verification (could not find|was unavailable)/);
    assert.match(result, /weekly-report/);
    assert.match(result, /before retrying to avoid duplicates/);
    assert.doesNotMatch(result, /created and verified/);
    assert.equal(fixture.creates(), 1);
  });
}

for (const cwd of ['', '  ']) {
  test(`rejects unresolved project cwd ${JSON.stringify(cwd)} before mutation`, async () => {
    const fixture = verificationFixture();
    assert.match(
      String(await fixture.tool.impl(verificationInput, { ...fixture.context, cwd })),
      /requires a project working directory/,
    );
    assert.equal(fixture.creates(), 0);
  });
}

test('allows a filesystem-root workspace when the Host provides it', async () => {
  const fixture = verificationFixture();
  const result = String(
    await fixture.tool.impl(verificationInput, { ...fixture.context, cwd: '/' }),
  );
  assert.match(result, /created and verified in Maka catalog/);
  assert.equal(fixture.creates(), 1);
});

test('notifications do not require a project directory', async () => {
  const fixture = verificationFixture();
  await fixture.tool.impl(
    { ...verificationInput, effect: 'notify_local' },
    { ...fixture.context, cwd: '' },
  );
  assert.equal(fixture.creates(), 1);
});

test('list is explicitly a query and never creates tasks', async () => {
  const fixture = verificationFixture();
  assert.match(
    String(await fixture.tool.impl({ mode: 'list' }, fixture.context)),
    /Scheduled task catalog \(1\)/,
  );
  assert.equal(fixture.creates(), 0);
});

test('creation error is preserved without querying the catalog', async () => {
  const fixture = verificationFixture({
    create: async () => ({ error: 'Session was not found' }),
    list: async () => {
      assert.fail('must not query on failure');
    },
  });
  assert.match(
    String(await fixture.tool.impl(verificationInput, fixture.context)),
    /Session was not found/,
  );
});
