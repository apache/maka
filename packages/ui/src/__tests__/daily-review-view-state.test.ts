import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { DailyReviewSummary } from '@maka/core';

import {
  createDailyReviewActivityState,
  dailyReviewActivityReducer,
  shiftDailyReviewScope,
} from '../daily-review-view-state.js';

const today: DailyReviewSummary = {
  day: { fromMs: 0, toMs: 1 },
  totals: { sessionCount: 1, requestCount: 2, totalTokens: 3, costUsd: 0, errorCount: 0 },
  sessions: [],
  topModels: [],
  topTools: [],
};

describe('Daily Review resolved view continuity', () => {
  it('keeps the resolved content while a different scope is loading', () => {
    const resolved = dailyReviewActivityReducer(
      createDailyReviewActivityState({ range: 1, offsetDays: 0 }),
      { type: 'resolved', scope: { range: 1, offsetDays: 0 }, summary: today },
    );

    const pending = dailyReviewActivityReducer(resolved, {
      type: 'selected',
      scope: { range: 7, offsetDays: 0 },
    });

    assert.deepEqual(pending.selection, { range: 7, offsetDays: 0 });
    assert.equal(pending.pendingScopeKey, '0:7');
    assert.equal(pending.resolvedView?.summary, today);
    assert.equal(pending.resolvedView?.scopeKey, '0:1');
  });

  it('replaces the visible content atomically when the selected scope resolves', () => {
    const week = { ...today, day: { fromMs: 10, toMs: 20 } };
    const pending = dailyReviewActivityReducer(
      createDailyReviewActivityState({ range: 1, offsetDays: 0 }),
      { type: 'selected', scope: { range: 7, offsetDays: 0 } },
    );

    const resolved = dailyReviewActivityReducer(pending, {
      type: 'resolved',
      scope: { range: 7, offsetDays: 0 },
      summary: week,
    });

    assert.equal(resolved.pendingScopeKey, null);
    assert.equal(resolved.resolvedView?.summary, week);
    assert.equal(resolved.resolvedView?.scopeKey, '0:7');
  });

  it('retains the last resolved content when a refresh fails', () => {
    const resolved = dailyReviewActivityReducer(
      createDailyReviewActivityState({ range: 1, offsetDays: 0 }),
      { type: 'resolved', scope: { range: 1, offsetDays: 0 }, summary: today },
    );
    const pending = dailyReviewActivityReducer(resolved, {
      type: 'selected',
      scope: { range: 30, offsetDays: 0 },
    });

    const failed = dailyReviewActivityReducer(pending, {
      type: 'rejected',
      scope: { range: 30, offsetDays: 0 },
      error: '读取失败',
    });

    assert.equal(failed.pendingScopeKey, null);
    assert.equal(failed.resolvedView, resolved.resolvedView);
    assert.equal(failed.error, '读取失败');
  });

  it('ignores a result for a scope that is no longer selected', () => {
    const pendingWeek = dailyReviewActivityReducer(
      createDailyReviewActivityState({ range: 1, offsetDays: 0 }),
      { type: 'selected', scope: { range: 7, offsetDays: 0 } },
    );
    const pendingMonth = dailyReviewActivityReducer(pendingWeek, {
      type: 'selected',
      scope: { range: 30, offsetDays: 0 },
    });

    const staleResult = dailyReviewActivityReducer(pendingMonth, {
      type: 'resolved',
      scope: { range: 7, offsetDays: 0 },
      summary: today,
    });

    assert.equal(staleResult, pendingMonth);
  });
});

describe('Daily Review range navigation', () => {
  it('moves rolling ranges one day at a time', () => {
    assert.deepEqual(shiftDailyReviewScope({ range: 7, offsetDays: 0 }, -1), {
      range: 7,
      offsetDays: -1,
    });
    assert.deepEqual(shiftDailyReviewScope({ range: 30, offsetDays: -2 }, 1), {
      range: 30,
      offsetDays: -1,
    });
  });
});
