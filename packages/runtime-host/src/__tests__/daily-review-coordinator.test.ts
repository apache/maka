import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localDayBoundsAt, type DailyReviewArchive } from '@maka/core/daily-review';
import { openInteractiveDailyReviewAuthorityForWrite } from '@maka/storage/daily-review-authority';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostDailyReviewCoordinator } from '../server/daily-review-coordinator.js';

const CONTEXT: ConnectionContext = {
  hostEpoch: 'host-epoch',
  connectionId: 'connection-id',
  surface: 'tui',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('Daily Review refuses to archive an incomplete canonical Usage projection', async () => {
  await withCoordinator(async ({ coordinator, store, usage, readRunEventsCount, drainCount }) => {
    await usage.modelCalls.markRunPendingReprojection('session-missing', 'run-missing');
    const outcome = await coordinator.handlers['daily-review.mutate'](
      {
        kind: 'run',
        range: 1,
        offsetDays: 0,
        modelKeyOverride: '',
        replaceExisting: false,
      },
      CONTEXT,
    );

    assert.deepEqual(outcome, {
      ok: false,
      error: {
        code: 'projection_incomplete',
        message: 'Daily Review is waiting for canonical Usage repair',
      },
    });
    assert.equal(readRunEventsCount(), 1);
    assert.equal(drainCount(), 0);
    assert.deepEqual(await store.listArchivePage(null, 1), {
      archives: [],
      nextBeforeArchiveId: null,
    });
  });
});

test('Daily Review conflicts rather than coalescing different generation options', async () => {
  let releaseModel: (() => void) | undefined;
  let notifyModelStarted: (() => void) | undefined;
  const modelStarted = new Promise<void>((resolve) => {
    notifyModelStarted = resolve;
  });
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  let modelCalls = 0;

  await withCoordinator(
    async ({ coordinator, usage }) => {
      const now = Date.now();
      await usage.telemetry.recordLlmCall({
        id: 'daily-review-conflict-source',
        callKind: 'main',
        callId: 'daily-review-conflict-source',
        connectionSlug: 'test',
        providerId: 'test',
        modelId: 'test',
        inputTokens: 1,
        outputTokens: 1,
        cacheHitInputTokens: 0,
        cacheMissInputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
        costUsd: 0,
        latencyMs: 1,
        status: 'success',
        startedAt: now,
        date: new Date(now).toISOString().slice(0, 10),
        ts: now,
      });
      const first = coordinator.handlers['daily-review.mutate'](
        {
          kind: 'run',
          range: 1,
          offsetDays: 0,
          modelKeyOverride: 'provider::model-a',
          replaceExisting: true,
        },
        CONTEXT,
      );
      await modelStarted;
      const coalesced = coordinator.handlers['daily-review.mutate'](
        {
          kind: 'run',
          range: 1,
          offsetDays: 0,
          modelKeyOverride: 'provider::model-a',
          replaceExisting: false,
        },
        CONTEXT,
      );
      const conflicting = await coordinator.handlers['daily-review.mutate'](
        {
          kind: 'run',
          range: 1,
          offsetDays: 0,
          modelKeyOverride: 'provider::model-b',
          replaceExisting: true,
        },
        CONTEXT,
      );
      assert.equal(conflicting.ok, false);
      if (!conflicting.ok) assert.equal(conflicting.error.code, 'operation_conflict');
      assert.equal(modelCalls, 1);
      assert.ok(releaseModel);
      releaseModel();
      const [firstResult, coalescedResult] = await Promise.all([first, coalesced]);
      assert.equal(firstResult.ok, true);
      assert.deepEqual(coalescedResult, firstResult);
    },
    {
      generate: async () => {
        modelCalls += 1;
        notifyModelStarted?.();
        await modelGate;
        return { ok: false, errorClass: 'configuration' };
      },
    },
  );
});

test('Daily Review does not coalesce cron and manual archive provenance', async () => {
  let releaseModel: (() => void) | undefined;
  let notifyModelStarted: (() => void) | undefined;
  const modelStarted = new Promise<void>((resolve) => {
    notifyModelStarted = resolve;
  });
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  let modelCalls = 0;

  await withCoordinator(
    async ({ coordinator, store, usage }) => {
      const snapshot = await store.readConfig();
      const update = await store.updateConfig(snapshot.revision, {
        enabled: true,
        executeTime: '00:00',
        modelKey: 'provider::model-a',
      });
      assert.equal(update.kind, 'committed');
      const now = localDayBoundsAt(Date.now(), -1).fromMs + 1;
      await usage.telemetry.recordLlmCall({
        id: 'daily-review-cron-source',
        callKind: 'main',
        callId: 'daily-review-cron-source',
        connectionSlug: 'test',
        providerId: 'test',
        modelId: 'test',
        inputTokens: 1,
        outputTokens: 1,
        cacheHitInputTokens: 0,
        cacheMissInputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
        costUsd: 0,
        latencyMs: 1,
        status: 'success',
        startedAt: now,
        date: new Date(now).toISOString().slice(0, 10),
        ts: now,
      });

      const recovery = coordinator.recover();
      await modelStarted;
      const manual = await coordinator.handlers['daily-review.mutate'](
        {
          kind: 'run',
          range: 1,
          offsetDays: -1,
          modelKeyOverride: '',
          replaceExisting: false,
        },
        CONTEXT,
      );
      assert.equal(manual.ok, false);
      if (!manual.ok) assert.equal(manual.error.code, 'operation_conflict');
      assert.equal(modelCalls, 1);
      assert.ok(releaseModel);
      releaseModel();
      await recovery;
    },
    {
      generate: async () => {
        modelCalls += 1;
        notifyModelStarted?.();
        await modelGate;
        return { ok: false, errorClass: 'configuration' };
      },
    },
    false,
  );
});

test('Daily Review archive cursors stay stable across concurrent inserts', async () => {
  await withCoordinator(async ({ coordinator, store }) => {
    await store.publishArchive(archive('2026-08-01-1d'), 180);
    await store.publishArchive(archive('2026-08-03-1d'), 180);
    const first = await coordinator.handlers['daily-review.query'](
      { kind: 'archives', beforeArchiveId: null, limit: 1 },
      CONTEXT,
    );
    assert.equal(first.ok, true);
    if (!first.ok || first.result.kind !== 'archives') return;
    assert.deepEqual(
      first.result.archives.map((item) => item.id),
      ['2026-08-03-1d'],
    );
    assert.equal(first.result.nextBeforeArchiveId, '2026-08-03-1d');

    await store.publishArchive(archive('2026-08-04-1d'), 180);
    const second = await coordinator.handlers['daily-review.query'](
      {
        kind: 'archives',
        beforeArchiveId: first.result.nextBeforeArchiveId,
        limit: 1,
      },
      CONTEXT,
    );
    assert.equal(second.ok, true);
    if (!second.ok || second.result.kind !== 'archives') return;
    assert.deepEqual(
      second.result.archives.map((item) => item.id),
      ['2026-08-01-1d'],
    );
    assert.equal(second.result.nextBeforeArchiveId, null);
  });
});

async function withCoordinator(
  run: (input: {
    coordinator: HostDailyReviewCoordinator;
    store: Awaited<ReturnType<typeof openInteractiveDailyReviewAuthorityForWrite>>;
    usage: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>;
    readRunEventsCount: () => number;
    drainCount: () => number;
  }) => Promise<void>,
  model: ConstructorParameters<typeof HostDailyReviewCoordinator>[0]['model'] = {
    generate: async () => ({ ok: false, errorClass: 'configuration' }),
  },
  recoverBeforeRun = true,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-daily-review-coordinator-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'interactive'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const store = await openInteractiveDailyReviewAuthorityForWrite(owner.lease);
  const usage = await openInteractiveUsageStoresForWrite(owner.lease);
  let runEventReads = 0;
  let drains = 0;
  const coordinator = new HostDailyReviewCoordinator({
    store,
    usage,
    sessions: { list: async () => [] },
    readRunEvents: async () => {
      runEventReads += 1;
      throw new Error('Run authority is temporarily unavailable');
    },
    model,
    acquireResidency: () => ({ release: () => undefined }),
    requestDrain: () => {
      drains += 1;
    },
  });
  try {
    if (recoverBeforeRun) await coordinator.recover();
    await run({
      coordinator,
      store,
      usage,
      readRunEventsCount: () => runEventReads,
      drainCount: () => drains,
    });
  } finally {
    await coordinator.close();
    await usage.close();
    if (!owner.closed) await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

function archive(id: string): DailyReviewArchive {
  const [year, month, day] = id.slice(0, 10).split('-').map(Number);
  const fromMs = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).getTime();
  return {
    id,
    day: { fromMs, toMs: new Date(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1).getTime() },
    range: 1,
    status: 'ok',
    generatedAt: fromMs,
    trigger: 'manual',
    modelKey: 'test::model',
    sections: { summary: 'Stable archive.' },
    totals: {
      sessionCount: 1,
      requestCount: 1,
      totalTokens: 2,
      costUsd: 0,
      errorCount: 0,
    },
  };
}
