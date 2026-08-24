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
