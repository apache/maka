import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PricingConfig } from '@maka/core/usage-stats/types';
import { createSqliteTelemetryRepo } from '@maka/storage';
import { registerUsageIpc, type UsageIpcDeps } from '../usage-ipc-main.js';

type Handler = (...args: any[]) => any;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('usage IPC leaves settings usage session-derived while detailed usage waits for SQLite readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-usage-ipc-ready-'));
  const seeded = createSqliteTelemetryRepo(root);
  const telemetryRepo = createSqliteTelemetryRepo(root, { createIfMissing: false });
  const ready = deferred();
  const handlers = new Map<string, Handler>();
  const calls: string[] = [];

  try {
    await seeded.load();
    await seeded.insertLlmCall(llmRecord('usage_ipc_ready'));
    await seeded.close();
    registerUsageIpc({
      ipcMain: {
        handle(channel: string, handler: Handler) {
          handlers.set(channel, handler as Handler);
        },
      },
      settingsStore: {
        usageStats: async () => {
          calls.push('settings');
          return { source: 'sessions' };
        },
      },
      telemetryRepo,
      ensureUsageReady: async () => {
        calls.push('ready:start');
        await ready.promise;
        await telemetryRepo.load();
        calls.push('ready:end');
      },
      refreshPricingLookup: () => {},
      sendToRenderer: () => {},
    } as unknown as UsageIpcDeps);

    const settings = await handlers.get('settings:usageStats')?.({});
    assert.deepEqual(settings, { source: 'sessions' });
    assert.deepEqual(calls, ['settings']);

    const summaryPending = handlers.get('usage:summary')?.({}, { range: 'all' });
    await Promise.resolve();
    assert.deepEqual(calls, ['settings', 'ready:start']);
    ready.resolve();
    const summary = await summaryPending;
    assert.equal(summary.ok, true);
    assert.equal(summary.data.totalRequests, 1);
    assert.deepEqual(calls, ['settings', 'ready:start', 'ready:end']);
  } finally {
    await Promise.allSettled([seeded.close(), telemetryRepo.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('pricing IPC mutations serialize through the canonical SQLite repo after legacy import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-usage-ipc-pricing-'));
  const legacy = pricing('openai:legacy');
  await writeFile(
    join(root, 'telemetry.json'),
    JSON.stringify({
      usageRecords: [],
      toolInvocations: [],
      pricingOverrides: [legacy],
    }),
    'utf8',
  );
  const telemetryRepo = createSqliteTelemetryRepo(root);
  const handlers = new Map<string, Handler>();
  const firstWrite = deferred();
  const firstWriteStarted = deferred();
  const events: string[] = [];
  const originalUpsert = telemetryRepo.upsertPricing.bind(telemetryRepo);
  telemetryRepo.upsertPricing = async (value) => {
    events.push(`upsert:${value.modelKey}`);
    if (value.modelKey === 'openai:first') {
      firstWriteStarted.resolve();
      await firstWrite.promise;
    }
    await originalUpsert(value);
  };
  const originalDelete = telemetryRepo.deletePricing.bind(telemetryRepo);
  telemetryRepo.deletePricing = async (modelKey) => {
    events.push(`delete:${modelKey}`);
    await originalDelete(modelKey);
  };

  try {
    let readiness: Promise<void> | undefined;
    const ensureUsageReady = () => {
      readiness ??= telemetryRepo.load();
      return readiness;
    };
    registerUsageIpc({
      ipcMain: {
        handle(channel: string, handler: Handler) {
          handlers.set(channel, handler as Handler);
        },
      },
      settingsStore: {},
      telemetryRepo,
      ensureUsageReady,
      refreshPricingLookup: () => {
        events.push(`refresh:${telemetryRepo.listPricingOverrides().length}`);
      },
      sendToRenderer: (channel: string) => {
        events.push(`notify:${channel}`);
      },
    } as unknown as UsageIpcDeps);

    const list = handlers.get('usage:pricing:list');
    const put = handlers.get('usage:pricing:put');
    const reset = handlers.get('usage:pricing:reset');
    assert.ok(list);
    assert.ok(put);
    assert.ok(reset);
    assert.deepEqual(await list({}), { ok: true, data: [legacy] });

    const first = put({}, pricing('openai:first'));
    const second = put({}, pricing('openai:second'));
    const third = reset({}, 'openai:legacy');
    await firstWriteStarted.promise;
    assert.deepEqual(events, ['upsert:openai:first']);

    firstWrite.resolve();
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.equal((await third).ok, true);
    assert.deepEqual(
      telemetryRepo.listPricingOverrides().map((item) => item.modelKey),
      ['openai:first', 'openai:second'],
    );
    assert.deepEqual(events, [
      'upsert:openai:first',
      'refresh:2',
      'notify:usage:pricing:changed',
      'upsert:openai:second',
      'refresh:3',
      'notify:usage:pricing:changed',
      'delete:openai:legacy',
      'refresh:2',
      'notify:usage:pricing:changed',
    ]);
  } finally {
    await telemetryRepo.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function pricing(modelKey: string): PricingConfig {
  return {
    modelKey,
    inputUsdPer1M: 1,
    outputUsdPer1M: 2,
  };
}

function llmRecord(id: string) {
  const now = Date.now();
  return {
    id,
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
    status: 'success' as const,
    startedAt: now - 5,
    date: new Date(now).toISOString().slice(0, 10),
    ts: now,
  };
}
