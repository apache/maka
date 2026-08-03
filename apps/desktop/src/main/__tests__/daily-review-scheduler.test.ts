import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDailyReviewMainService } from '../daily-review-main.js';

test('Daily Review scheduler targets the previous complete local day without overwriting it', async (t) => {
  const scheduledAt = new Date(2026, 7, 3, 8, 0, 0, 0);
  const previousDay = {
    fromMs: new Date(2026, 7, 2, 0, 0, 0, 0).getTime(),
    toMs: new Date(2026, 7, 3, 0, 0, 0, 0).getTime(),
  };
  t.mock.timers.enable({ apis: ['Date'], now: scheduledAt.getTime() });
  let resolveChecked!: () => void;
  const checked = new Promise<void>((resolve) => {
    resolveChecked = resolve;
  });
  let checkedArchiveId = '';
  let writes = 0;

  const emptySummary = {
    range: { from: 0, to: 0 },
    totalRequests: 0,
    totalCostUsd: 0,
    totalTokens: {
      input: 0,
      output: 0,
      cacheMiss: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
    },
    cacheHitRequests: 0,
    cacheCreateRequests: 0,
    errorRequests: 0,
  };

  const service = createDailyReviewMainService({
    archiveStore: {
      getConfig: async () => ({ enabled: true, executeTime: '08:00', modelKey: '' }),
      getArchive: async (archiveId: string) => {
        checkedArchiveId = archiveId;
        resolveChecked();
        return {
          id: archiveId,
          day: previousDay,
          range: 1,
          status: 'ok',
          generatedAt: scheduledAt.getTime(),
          trigger: 'cron',
          modelKey: '',
          sections: { summary: 'existing' },
          totals: {
            sessionCount: 0,
            requestCount: 0,
            totalTokens: 0,
            costUsd: 0,
            errorCount: 0,
          },
        };
      },
      putArchive: async () => {
        writes += 1;
      },
      prune: async () => undefined,
    },
    telemetryRepo: {
      summary: () => emptySummary,
      buckets: () => [],
    },
    modelCallLedger: {
      read: () => ({ attempts: [], unreadableRecords: 0 }),
      pendingReprojections: () => [],
    },
    ensureUsageReady: async () => undefined,
    listSessions: async () => [],
    connectionStore: {},
    resolveConnectionSecret: async () => null,
    buildSubscriptionModelFetch: () => undefined,
  } as unknown as Parameters<typeof createDailyReviewMainService>[0]);

  try {
    service.startScheduler();
    await checked;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(checkedArchiveId, '2026-08-02-1d');
    assert.equal(writes, 0);
  } finally {
    service.stopScheduler();
    t.mock.timers.reset();
  }
});
