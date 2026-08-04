import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { PricingStorePublicationError } from '../pricing-store.js';
import { createSqlitePricingStore, createSqliteTelemetryRepo } from '../sqlite-usage-store.js';

describe('SQLite usage and pricing stores', () => {
  test('resumes a cutover crash after copied rows without exposing partial state', async () => {
    await withRoot(async (root) => {
      await writeFile(
        join(root, 'telemetry.json'),
        JSON.stringify({ usageRecords: [llmRecord()], toolInvocations: [] }),
      );
      const interrupted = createSqliteTelemetryRepo(root, {
        managePricing: false,
        failpoint: (point) => {
          if (point === 'after_cutover_rows_copied') throw new Error('simulated crash');
        },
      });
      await assert.rejects(() => interrupted.load(), /simulated crash/);
      await interrupted.close();

      const resumed = createSqliteTelemetryRepo(root, { managePricing: false });
      await resumed.load();
      assert.equal(resumed.logs({ range: 'all' }).total, 1);
      await resumed.close();
    });
  });

  test('fails closed when a legacy source changes after completed cutover', async () => {
    await withRoot(async (root) => {
      const path = join(root, 'telemetry.json');
      await writeFile(path, JSON.stringify({ usageRecords: [llmRecord()], toolInvocations: [] }));
      const first = createSqliteTelemetryRepo(root, { managePricing: false });
      await first.load();
      await first.close();

      await writeFile(
        path,
        JSON.stringify({
          usageRecords: [llmRecord(), llmRecord({ id: 'usage_2' })],
          toolInvocations: [],
        }),
      );
      const reopened = createSqliteTelemetryRepo(root, { managePricing: false });
      await assert.rejects(
        () => reopened.load(),
        /Legacy usage_pricing source changed after cutover completed/,
      );
      await reopened.close();
    });
  });

  test('writes only runtime.sqlite after cutover and preserves pricing revisions', async () => {
    await withRoot(async (root) => {
      const telemetry = createSqliteTelemetryRepo(root, { managePricing: false });
      const pricing = createSqlitePricingStore(root);
      await telemetry.load();
      await pricing.load();
      await telemetry.insertLlmCall(llmRecord());
      const changed = await pricing.upsert(0, {
        modelKey: 'openai:gpt-5',
        inputUsdPer1M: 1.25,
        outputUsdPer1M: 10,
      });
      assert.equal(changed.snapshot.revision, 1);
      await telemetry.close();
      await pricing.close();

      await assert.rejects(
        () => readFile(join(root, 'telemetry.json'), 'utf8'),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
      await assert.rejects(
        () => readFile(join(root, 'pricing.json'), 'utf8'),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
      assert.ok((await readFile(join(root, 'runtime.sqlite'))).byteLength > 0);

      const reopenedTelemetry = createSqliteTelemetryRepo(root, { managePricing: false });
      const reopenedPricing = createSqlitePricingStore(root);
      await reopenedTelemetry.load();
      await reopenedPricing.load();
      assert.equal(reopenedTelemetry.logs({ range: 'all' }).total, 1);
      assert.deepEqual(reopenedPricing.snapshot(), changed.snapshot);
      await reopenedTelemetry.close();
      await reopenedPricing.close();
    });
  });

  test('rolls back the whole pricing revision when an override row cannot commit', async () => {
    await withRoot(async (root) => {
      const pricing = createSqlitePricingStore(root);
      await pricing.load();
      await pricing.upsert(0, {
        modelKey: 'provider:stable',
        inputUsdPer1M: 1,
        outputUsdPer1M: 2,
      });
      const before = pricing.snapshot();
      const inspection = acquireOperationalStateDatabase(root);
      inspection.database.exec(`
        CREATE TRIGGER reject_test_pricing_override
        BEFORE INSERT ON usage_pricing_overrides
        WHEN NEW.model_key = 'provider:reject'
        BEGIN
          SELECT RAISE(ABORT, 'injected pricing row failure');
        END;
      `);
      await assert.rejects(
        () =>
          pricing.upsert(before.revision, {
            modelKey: 'provider:reject',
            inputUsdPer1M: 3,
            outputUsdPer1M: 4,
          }),
        PricingStorePublicationError,
      );
      assert.deepEqual(pricing.snapshot(), before);
      inspection.database.exec('DROP TRIGGER reject_test_pricing_override');
      inspection.close();
      await pricing.close();
    });
  });
});

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-usage-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function llmRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usage_1',
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
    latencyMs: 100,
    status: 'success',
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1) - 100,
    ...overrides,
  } as Parameters<ReturnType<typeof createSqliteTelemetryRepo>['insertLlmCall']>[0];
}
