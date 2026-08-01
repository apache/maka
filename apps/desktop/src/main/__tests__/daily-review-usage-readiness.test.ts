import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSqliteTelemetryRepo } from '@maka/storage';
import { createDailyReviewMainService } from '../daily-review-main.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('Daily Review waits for shared usage readiness before reading telemetry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-daily-review-usage-ready-'));
  const seeded = createSqliteTelemetryRepo(root);
  const telemetryRepo = createSqliteTelemetryRepo(root, { createIfMissing: false });
  const loadGate = deferred();

  try {
    const now = Date.now();
    await seeded.load();
    await seeded.insertLlmCall({
      id: 'usage_daily_review_ready',
      providerId: 'openai',
      modelId: 'gpt-5',
      inputTokens: 10,
      outputTokens: 20,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 30,
      costUsd: 0.001,
      latencyMs: 5,
      status: 'success',
      startedAt: now - 5,
      date: new Date(now).toISOString().slice(0, 10),
      ts: now,
    });
    await seeded.close();

    const service = createDailyReviewMainService({
      telemetryRepo,
      ensureUsageReady: async () => {
        await loadGate.promise;
        await telemetryRepo.load();
      },
      listSessions: async () => [],
      archiveStore: {},
      connectionStore: {},
      resolveConnectionSecret: async () => null,
      buildSubscriptionModelFetch: () => undefined,
    } as unknown as Parameters<typeof createDailyReviewMainService>[0]);

    const summaryPending = service.buildSummaryForRange(0, 1);
    await Promise.resolve();
    assert.throws(() => telemetryRepo.summary({ range: 'all' }));
    loadGate.resolve();
    const summary = await summaryPending;
    assert.equal(summary.totals.requestCount, 1);
  } finally {
    await Promise.allSettled([seeded.close(), telemetryRepo.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
