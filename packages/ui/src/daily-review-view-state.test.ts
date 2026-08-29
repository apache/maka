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
import { scheduledTaskSessionLabel, type ScheduledTask } from '@maka/core/scheduled-task';
import type { SessionSummary } from '@maka/core/session';
import {
  dailyReviewRangeBounds,
  projectDailyReviewView,
} from './daily-review-view-state.js';

const task = {
  id: 'system-daily-review',
  title: 'Daily Review',
  intent: { kind: 'text', body: 'Review ordinary Session history.' },
  schedule: { kind: 'calendar', recurrence: 'daily', anchorAt: 1_000 },
  effect: { kind: 'notify', channel: 'local' },
  status: 'active',
  nextFireAt: 2_000,
  lastFireAt: null,
  fireCount: 0,
  maxFires: null,
  expiresAt: null,
  createdBy: { kind: 'system' },
  createdAt: 100,
  updatedAt: 100,
  runs: [],
  lastError: null,
} satisfies ScheduledTask;

function session(input: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'name'>): SessionSummary {
  return {
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'fixture',
    connectionLocked: true,
    model: 'fixture-model',
    permissionMode: 'ask',
    ...input,
  };
}

test('projects task-linked and migrated ordinary Sessions as Daily Review history', () => {
  const sessions = [
    session({
      id: 'scheduled-report',
      name: 'Daily Review · August 29',
      labels: [scheduledTaskSessionLabel(task.id)],
      lastMessageAt: 9_000,
      lastMessagePreview: 'Completed work and follow-ups.',
    }),
    session({
      id: 'migrated-report',
      name: 'Daily Review · 2026-08-28 · 1d',
      labels: ['migrated:daily-review'],
      lastMessageAt: 8_000,
    }),
    session({
      id: 'older-migrated-report',
      name: 'Daily Review · 2026-07-01 · 1d',
      labels: ['migrated:daily-review'],
      lastMessageAt: 1_000,
    }),
    session({
      id: 'ordinary-work',
      name: 'Unrelated task',
      lastMessageAt: 7_000,
    }),
    session({
      id: 'other-scheduled-task',
      name: 'Other scheduled report',
      labels: [scheduledTaskSessionLabel('another-task')],
      lastMessageAt: 6_000,
    }),
    session({
      id: 'pending-scheduled-report',
      name: 'Daily Review · pending',
      labels: [scheduledTaskSessionLabel(task.id)],
    }),
  ];

  const view = projectDailyReviewView({
    task,
    sessions,
    from: 5_000,
    to: 10_000,
    usage: {
      totalRequests: 12,
      totalTokens: 34_000,
      totalCostUsd: 0.42,
    },
  });

  assert.equal(view.totals.sessionCount, 4);
  assert.deepEqual(view.reports, [
    {
      sessionId: 'scheduled-report',
      title: 'Daily Review · August 29',
      generatedAt: 9_000,
      preview: 'Completed work and follow-ups.',
      migrated: false,
    },
    {
      sessionId: 'migrated-report',
      title: 'Daily Review · 2026-08-28 · 1d',
      generatedAt: 8_000,
      migrated: true,
    },
    {
      sessionId: 'older-migrated-report',
      title: 'Daily Review · 2026-07-01 · 1d',
      generatedAt: 1_000,
      migrated: true,
    },
  ]);
  assert.equal(view.hasMigratedReports, true);
});

test('uses local calendar-day boundaries for 1, 7, and 30 day activity views', () => {
  const now = new Date(2026, 7, 29, 15, 45, 12, 345).getTime();
  for (const range of [1, 7, 30] as const) {
    const bounds = dailyReviewRangeBounds(range, now);
    const from = new Date(bounds.from);
    assert.equal(bounds.to, now);
    assert.equal(from.getHours(), 0);
    assert.equal(from.getMinutes(), 0);
    assert.equal(from.getSeconds(), 0);
    assert.equal(from.getMilliseconds(), 0);
    const expected = new Date(now);
    expected.setHours(0, 0, 0, 0);
    expected.setDate(expected.getDate() - (range - 1));
    assert.equal(bounds.from, expected.getTime());
  }

  const yesterday = dailyReviewRangeBounds(1, now, -1);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  assert.deepEqual(yesterday, {
    from: startOfYesterday.getTime(),
    to: startOfToday.getTime(),
  });

  const earlierWeek = dailyReviewRangeBounds(7, now, -2);
  const expectedWeekStart = new Date(startOfToday);
  expectedWeekStart.setDate(expectedWeekStart.getDate() - 8);
  const expectedWeekEnd = new Date(startOfToday);
  expectedWeekEnd.setDate(expectedWeekEnd.getDate() - 1);
  assert.deepEqual(earlierWeek, {
    from: expectedWeekStart.getTime(),
    to: expectedWeekEnd.getTime(),
  });
});
