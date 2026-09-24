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
  return {
    create: async (input) =>
      ({
        id: 'task-1',
        title: input.title,
        nextFireAt: input.schedule.kind === 'once' ? input.schedule.runAt : null,
        effect: { kind: 'notify', channel: 'local' },
        ...created,
      }) as ScheduledTask,
    list: async () => [],
    pause: async () => ({ error: 'unused' }),
    resume: async () => ({ error: 'unused' }),
    remove: async () => ({ error: 'unused' }),
  };
}

const ctx = { sessionId: 'session-1' } as MakaToolContext;

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
    'Scheduled task created: Tidy Downloads (task-1)',
    `nextFireAt=${TEN_AM_SHANGHAI} (2026-09-24T10:00:00+08:00 (Asia/Shanghai))`,
    'effect=notify',
    `now=${NOW} (2026-09-24T09:42:45+08:00 (Asia/Shanghai))`,
  ]);
});
