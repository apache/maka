import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DailyReviewArchive } from '@maka/core/daily-review';
import {
  DAILY_REVIEW_PAGE_MAX_ITEMS,
  decodeDailyReviewMutateInput,
  decodeDailyReviewQueryResult,
  decodeRequestFrame,
} from '../protocol/index.js';

test('Daily Review protocol rejects open and unbounded inputs', () => {
  assert.throws(() =>
    decodeDailyReviewMutateInput({
      kind: 'run',
      range: 1,
      offsetDays: 0,
      modelKeyOverride: '',
      replaceExisting: false,
      extra: true,
    }),
  );
  assert.throws(() =>
    decodeRequestFrame({
      requestId: 'request-1',
      operation: 'daily-review.query',
      input: {
        kind: 'archives',
        beforeArchiveId: null,
        limit: DAILY_REVIEW_PAGE_MAX_ITEMS + 1,
      },
    }),
  );
  assert.throws(() =>
    decodeDailyReviewQueryResult({
      kind: 'archives',
      archives: Array.from({ length: DAILY_REVIEW_PAGE_MAX_ITEMS + 1 }, archiveSummary),
      beforeArchiveId: null,
      nextBeforeArchiveId: null,
    }),
  );
  assert.throws(() =>
    decodeDailyReviewQueryResult({
      kind: 'archives',
      archives: [archiveSummary()],
      beforeArchiveId: null,
      nextBeforeArchiveId: '2026-08-02-1d',
    }),
  );
  assert.throws(() =>
    decodeDailyReviewQueryResult({
      kind: 'archives',
      archives: [{ ...archiveSummary(), range: 7 }],
      beforeArchiveId: null,
      nextBeforeArchiveId: null,
    }),
  );
  assert.throws(() =>
    decodeDailyReviewQueryResult({
      kind: 'archive',
      archive: {
        ...archive(),
        totals: { ...archive().totals, costUsd: -1 },
      },
    }),
  );
});

function archive(): DailyReviewArchive {
  const fromMs = new Date(2026, 7, 3).getTime();
  return {
    id: '2026-08-03-1d',
    day: { fromMs, toMs: new Date(2026, 7, 4).getTime() },
    range: 1,
    status: 'ok',
    generatedAt: fromMs + 1,
    trigger: 'manual',
    modelKey: 'openrouter::openrouter/free',
    sections: { summary: 'One review.' },
    totals: {
      sessionCount: 1,
      requestCount: 2,
      totalTokens: 3,
      costUsd: 0,
      errorCount: 0,
    },
  };
}

function archiveSummary() {
  const { sections: _sections, ...summary } = archive();
  return summary;
}
