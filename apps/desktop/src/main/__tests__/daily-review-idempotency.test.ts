import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDailyReviewMainService,
  parseDailyReviewSections,
} from '../daily-review-main.js';

const emptyUsageSummary = {
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

function createService(archiveStore: Record<string, unknown>) {
  return createDailyReviewMainService({
    archiveStore: {
      getConfig: async () => ({ enabled: true, executeTime: '08:00', modelKey: '' }),
      prune: async () => undefined,
      ...archiveStore,
    },
    telemetryRepo: {
      summary: () => emptyUsageSummary,
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
}

test('Daily Review rejects model output without a usable section', () => {
  for (const output of ['', '{}', '[]', 'null', '{"summary":42}', '{"summary":"  "}']) {
    assert.throws(() => parseDailyReviewSections(output));
  }
  assert.deepEqual(parseDailyReviewSections('plain text fallback'), {
    summary: 'plain text fallback',
  });
});

test('Daily Review run reuses an existing archive', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 7, 3, 9, 0, 0).getTime() });
  let writes = 0;
  const service = createService({
    getArchive: async () => ({
      status: 'ok',
      range: 1,
      day: {
        fromMs: new Date(2026, 7, 3, 0, 0, 0, 0).getTime(),
        toMs: new Date(2026, 7, 4, 0, 0, 0, 0).getTime(),
      },
    }),
    putArchive: async () => {
      writes += 1;
    },
  });

  try {
    const result = await service.run({ range: 1, trigger: 'manual' });

    assert.equal(result.archiveId, '2026-08-03-1d');
    assert.equal(writes, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test('Daily Review run retries every non-success archive status', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 7, 3, 9, 0, 0).getTime() });
  try {
    for (const status of ['no_data', 'no_model', 'failed', 'skipped']) {
      let writes = 0;
      const service = createService({
        getArchive: async () => ({ status }),
        putArchive: async () => {
          writes += 1;
        },
      });

      await service.run({ range: 1, trigger: 'manual' });
      assert.equal(writes, 1, `${status} should remain retryable`);
    }
  } finally {
    t.mock.timers.reset();
  }
});

test('Daily Review run replaces an ok archive for a different resolved day', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 7, 3, 9, 0, 0).getTime() });
  let writes = 0;
  const service = createService({
    getArchive: async () => ({
      status: 'ok',
      range: 1,
      day: { fromMs: 1, toMs: 2 },
    }),
    putArchive: async () => {
      writes += 1;
    },
  });

  try {
    await service.run({ range: 1, trigger: 'manual' });
    assert.equal(writes, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('Daily Review run coalesces concurrent generation for the same archive', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 7, 3, 9, 0, 0).getTime() });
  let writes = 0;
  let releaseWrite!: () => void;
  let notifyWriteStarted!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    notifyWriteStarted = resolve;
  });
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const service = createService({
    getArchive: async () => null,
    putArchive: async () => {
      writes += 1;
      notifyWriteStarted();
      await writeReleased;
    },
  });

  try {
    const first = service.run({ range: 7, trigger: 'manual' });
    await writeStarted;
    const second = service.run({ range: 7, trigger: 'manual' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseWrite();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(writes, 1);
  } finally {
    releaseWrite();
    t.mock.timers.reset();
  }
});
