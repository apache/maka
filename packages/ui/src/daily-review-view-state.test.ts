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
import {
  scheduledTaskPresetSessionLabel,
} from '@maka/core/scheduled-task';
import type { SessionSummary } from '@maka/core/session';
import {
  dailyReviewManualIntent,
  dailyReviewRangeBounds,
  projectDailyReviewView,
} from './daily-review-view-state.js';

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

test('projects stable preset and migrated completed Sessions as Daily Review history', () => {
  const sessions = [
    session({
      id: 'scheduled-report',
      name: 'Daily Review · August 29',
      labels: [scheduledTaskPresetSessionLabel('daily-review')],
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
      labels: [scheduledTaskPresetSessionLabel('another-preset')],
      lastMessageAt: 6_000,
    }),
    session({
      id: 'running-scheduled-report',
      name: 'Daily Review · running',
      labels: [scheduledTaskPresetSessionLabel('daily-review')],
      lastMessageAt: 9_500,
      status: 'running',
    }),
    session({
      id: 'failed-scheduled-report',
      name: 'Daily Review · failed',
      labels: [scheduledTaskPresetSessionLabel('daily-review')],
      lastMessageAt: 9_400,
      status: 'blocked',
    }),
  ];

  const view = projectDailyReviewView({
    sessions,
    from: 5_000,
    to: 10_000,
    usage: {
      totalRequests: 12,
      totalTokens: 34_000,
      totalCostUsd: 0.42,
    },
  });

  assert.equal(view.totals.sessionCount, 6);
  assert.deepEqual(
    view.sessions.map((candidate) => candidate.sessionId),
    [
      'running-scheduled-report',
      'failed-scheduled-report',
      'scheduled-report',
      'migrated-report',
      'ordinary-work',
      'other-scheduled-task',
    ],
  );
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

test('builds a one-shot manual intent for the exact selected local range', () => {
  const now = new Date(2026, 7, 29, 15, 45).getTime();
  const intent = dailyReviewManualIntent(7, now, -2);
  const bounds = dailyReviewRangeBounds(7, now, -2);
  assert.match(intent, new RegExp(`\\[${bounds.from}, ${bounds.to}\\)`, 'u'));
  assert.match(intent, /7 local calendar days/u);
  assert.match(intent, /ordinary Session history/u);
  assert.match(intent, /Markdown Artifact/u);
});
