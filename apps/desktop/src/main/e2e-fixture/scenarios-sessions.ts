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

import type { SessionHeader, StoredMessage } from '@maka/core/session';
import { scheduledTaskSessionLabel } from '@maka/core/scheduled-task';
import {
  header,
  LONG_SIDEBAR_PROJECT_ID,
  LONG_SIDEBAR_PROJECT_SESSION_COUNT,
  LONG_SIDEBAR_SESSION_COUNT,
  LONG_SIDEBAR_SESSION_PREFIX,
} from './seed-helpers.js';

export function longSidebarSessions(
  now: number,
): Array<{ header: SessionHeader; messages: StoredMessage[] }> {
  return Array.from({ length: LONG_SIDEBAR_SESSION_COUNT }, (_, index) => {
    const suffix = String(index).padStart(2, '0');
    const sessionId = LONG_SIDEBAR_SESSION_PREFIX + suffix;
    const lastMessageAt = now - index * 5 * 60_000;
    return {
      header: header({
        id: sessionId,
        name: `任务 ${suffix}`,
        connection: 'zai-live',
        model: 'glm-5.1',
        now,
        lastMessageAt,
        ...(index < LONG_SIDEBAR_PROJECT_SESSION_COUNT
          ? { projectId: LONG_SIDEBAR_PROJECT_ID }
          : {}),
      }),
      messages: [
        {
          type: 'user',
          id: `msg-long-user-${suffix}`,
          turnId: `turn-long-${suffix}`,
          ts: lastMessageAt - 30_000,
          text: `示例对话 ${suffix}`,
        },
        {
          type: 'assistant',
          id: `msg-long-assistant-${suffix}`,
          turnId: `turn-long-${suffix}`,
          ts: lastMessageAt,
          text: `已归档第 ${suffix} 条研究记录。`,
          modelId: 'glm-5.1',
        },
      ],
    };
  });
}

export function dailyReviewSessions(
  now: number,
): Array<{ header: SessionHeader; messages: StoredMessage[] }> {
  return [
    {
      header: {
        ...header({
          id: 'daily-review-current',
          name: '每日回顾 · 5月22日',
          connection: 'zai-live',
          model: 'glm-5.1',
          now,
          lastMessageAt: now - 35 * 60_000,
        }),
        labels: [scheduledTaskSessionLabel('system-daily-review')],
      },
      messages: [{
        type: 'assistant',
        id: 'daily-review-current-message',
        turnId: 'daily-review-current-turn',
        ts: now - 35 * 60_000,
        text: '已完成迁移设计与窄测试；下一步需要确认 Daily Review 页面保留历史入口。',
        modelId: 'glm-5.1',
      }],
    },
    {
      header: {
        ...header({
          id: 'daily-review-migrated',
          name: 'Daily Review · 2026-05-21 · 1d',
          connection: 'zai-live',
          model: 'glm-5.1',
          now,
          lastMessageAt: now - 24 * 60 * 60_000,
        }),
        labels: ['migrated:daily-review'],
      },
      messages: [{
        type: 'assistant',
        id: 'daily-review-migrated-message',
        turnId: 'daily-review-migrated-turn',
        ts: now - 24 * 60 * 60_000,
        text: '这份旧版回顾已迁移为普通任务，并保留原始 Markdown 报告 Artifact。',
        modelId: 'glm-5.1',
      }],
    },
  ];
}
