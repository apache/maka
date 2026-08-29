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

import {
  scheduledTaskPresetSessionLabel,
} from '@maka/core/scheduled-task';
import type { SessionStatus, SessionSummary } from '@maka/core/session';

export type DailyReviewRange = 1 | 7 | 30;

export interface DailyReviewUsageSummary {
  readonly totalRequests: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
}

export interface DailyReviewReportSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly generatedAt: number;
  readonly preview?: string;
  readonly migrated: boolean;
}

export interface DailyReviewSessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly activityAt: number;
  readonly preview?: string;
  readonly status: SessionStatus;
}

export interface DailyReviewViewState {
  readonly totals: DailyReviewUsageSummary & { readonly sessionCount: number };
  readonly sessions: readonly DailyReviewSessionSummary[];
  readonly reports: readonly DailyReviewReportSummary[];
  readonly hasMigratedReports: boolean;
}

export function dailyReviewRangeBounds(
  range: DailyReviewRange,
  now: number,
  offsetDays = 0,
): {
  readonly from: number;
  readonly to: number;
} {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offsetDays - (range - 1));
  if (offsetDays === 0) return { from: start.getTime(), to: now };
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + offsetDays + 1);
  return { from: start.getTime(), to: end.getTime() };
}

export function dailyReviewManualIntent(
  range: DailyReviewRange,
  now = Date.now(),
  offsetDays = 0,
): string {
  const bounds = dailyReviewRangeBounds(range, now, offsetDays);
  return [
    `Review Maka work across exactly ${range} local calendar day${range === 1 ? '' : 's'} using ordinary Session history whose activity timestamp is in [${bounds.from}, ${bounds.to}).`,
    'Identify completed work, unfinished or missed follow-ups, and useful patterns.',
    'Write a concise report and save it as a normal Markdown Artifact in the Session.',
  ].join(' ');
}

export function projectDailyReviewView(input: {
  readonly sessions: readonly SessionSummary[];
  readonly from: number;
  readonly to: number;
  readonly usage: DailyReviewUsageSummary;
}): DailyReviewViewState {
  const sessionsInRange = input.sessions.filter((session) => {
    const activityAt = session.lastMessageAt;
    return activityAt !== undefined && activityAt >= input.from && activityAt < input.to;
  });
  const sessions = sessionsInRange
    .map((session): DailyReviewSessionSummary => ({
      sessionId: session.id,
      title: session.name,
      activityAt: session.lastMessageAt!,
      ...(session.lastMessagePreview ? { preview: session.lastMessagePreview } : {}),
      status: session.status,
    }))
    .sort((left, right) => right.activityAt - left.activityAt);
  const presetLabel = scheduledTaskPresetSessionLabel('daily-review');
  const reports = input.sessions
    .filter(
      (session) =>
        session.lastMessageAt !== undefined &&
        session.status === 'active' &&
        (session.labels.includes('migrated:daily-review') ||
          session.labels.includes(presetLabel)),
    )
    .map((session): DailyReviewReportSummary => ({
      sessionId: session.id,
      title: session.name,
      generatedAt: session.lastMessageAt!,
      ...(session.lastMessagePreview ? { preview: session.lastMessagePreview } : {}),
      migrated: session.labels.includes('migrated:daily-review'),
    }))
    .sort((left, right) => right.generatedAt - left.generatedAt);
  return {
    totals: { ...input.usage, sessionCount: sessionsInRange.length },
    sessions,
    reports,
    hasMigratedReports: reports.some((report) => report.migrated),
  };
}
