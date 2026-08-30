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
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import { DailyReviewPanel } from '../daily-review-panel.js';
import { LocaleProvider } from '../locale-context.js';
import type { DailyReviewViewState } from '../daily-review-view-state.js';

const originalGlobals = {
  document: globalThis.document,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;
const originalDateNow = Date.now;
const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  Date.now = originalDateNow;
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function computedStyle(): CSSStyleDeclaration {
  return {
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  } as unknown as CSSStyleDeclaration;
}

const EMPTY_VIEW: DailyReviewViewState = {
  totals: {
    sessionCount: 0,
    totalRequests: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  },
  sessions: [],
  reports: [],
  hasMigratedReports: false,
};

async function renderDailyReview(
  view: DailyReviewViewState,
  task?: ScheduledTask,
): Promise<Document> {
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => computedStyle();
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Date.now = () => new Date(2026, 7, 30, 15, 45).getTime();

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <LocaleProvider locale="zh">
        <DailyReviewPanel
          bridge={{
            load: async () => view,
          }}
          canSetUp
          task={task}
          onSetUp={() => undefined}
          onManageSchedule={() => undefined}
        />
      </LocaleProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return document;
}

test('a completed Daily Review task shows its terminal state without Run Now', async () => {
  const now = Date.now();
  const document = await renderDailyReview(EMPTY_VIEW, {
    id: 'completed-review',
    presetId: 'daily-review',
    title: 'Daily Review',
    intent: { kind: 'text', body: 'Review my work.' },
    schedule: { kind: 'once', runAt: now - 1_000 },
    effect: { kind: 'notify', channel: 'local' },
    status: 'completed',
    nextFireAt: null,
    lastFireAt: now - 1_000,
    fireCount: 1,
    maxFires: 1,
    expiresAt: null,
    createdBy: { kind: 'user' },
    createdAt: now - 2_000,
    updatedAt: now,
    runs: [],
    lastError: null,
  });
  const text = document.documentElement.textContent ?? '';
  assert.match(text, /每日回顾已完成/u);
  assert.doesNotMatch(text, /立即生成回顾/u);
  assert.match(text, /管理日程/u);
});

test('an empty Daily Review keeps one date-scoped content section', async () => {
  const document = await renderDailyReview(EMPTY_VIEW);
  const sections = document.querySelectorAll('.maka-daily-review-content section');
  assert.equal(sections.length, 1);
  assert.match(sections[0]?.getAttribute('aria-label') ?? '', /8月30日/u);
  const controls = document.querySelector('.maka-daily-review-period-controls');
  assert.equal(controls?.getAttribute('aria-controls'), sections[0]?.id);
  assert.match(controls?.textContent ?? '', /8月30日/u);
  assert.doesNotMatch(document.documentElement.textContent ?? '', /还没有回顾报告/u);
});

test('a review report appears once while migrated history stays visible', async () => {
  const report = {
    sessionId: 'daily-review-report',
    title: 'Daily Review · 8月30日',
    preview: '完成了三个任务。',
  } as const;
  const document = await renderDailyReview({
    ...EMPTY_VIEW,
    totals: { ...EMPTY_VIEW.totals, sessionCount: 1 },
    sessions: [{ ...report, activityAt: Date.now(), status: 'active' }],
    reports: [{ ...report, generatedAt: Date.now(), migrated: true }],
    hasMigratedReports: true,
  });
  const text = document.documentElement.textContent ?? '';
  assert.equal(text.split(report.title).length - 1, 1, text);
  assert.match(text, /旧报告已迁移/u);
  assert.match(text, /回顾报告/u);
});
