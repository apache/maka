import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DailyReviewArchive } from '@maka/core/daily-review';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('two Clients share Daily Review config, generation, and restart recovery', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-daily-review-uds-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({
    path: root,
    kind: 'interactive',
  });
  let owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let host: Awaited<ReturnType<typeof RuntimeHostKernel.start>> | undefined;
  let desktop: RuntimeHostConnection | undefined;
  let tui: RuntimeHostConnection | undefined;
  let setupUsage: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>> | undefined;
  try {
    const usage = await openInteractiveUsageStoresForWrite(owner.lease);
    setupUsage = usage;
    const now = Date.now();
    await usage.telemetry.recordLlmCall({
      id: 'usage-daily-review-test',
      callKind: 'main',
      callId: 'daily-review-source-call',
      connectionSlug: 'missing-provider',
      providerId: 'missing-provider',
      modelId: 'missing-model',
      inputTokens: 2,
      outputTokens: 3,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 2,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 5,
      costUsd: 0,
      latencyMs: 1,
      status: 'success',
      startedAt: now - 1,
      date: new Date(now).toISOString().slice(0, 10),
      ts: now,
    });
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 30_000,
      composition: defineInteractiveRuntimeHostComposition(createExecutionRuntimeHostComposition),
    });
    owner = undefined;
    [desktop, tui] = await Promise.all([connect(root, 'desktop'), connect(root, 'tui')]);

    const initial = await desktop.queryDailyReview({ kind: 'config' });
    assert.deepEqual(initial, {
      kind: 'config',
      revision: 0,
      config: { enabled: false, executeTime: '08:00', modelKey: '' },
    });
    const mutations = await Promise.all([
      desktop.mutateDailyReview({
        kind: 'update_config',
        expectedRevision: 0,
        config: { enabled: false, executeTime: '09:00', modelKey: '' },
      }),
      tui.mutateDailyReview({
        kind: 'update_config',
        expectedRevision: 0,
        config: { enabled: false, executeTime: '10:00', modelKey: '' },
      }),
    ]);
    assert.equal(mutations.filter((result) => result.kind === 'config_committed').length, 1);
    assert.equal(mutations.filter((result) => result.kind === 'revision_conflict').length, 1);
    assert.deepEqual(
      await desktop.queryDailyReview({ kind: 'config' }),
      await tui.queryDailyReview({ kind: 'config' }),
    );

    const run = {
      kind: 'run' as const,
      range: 1 as const,
      offsetDays: -2,
      modelKeyOverride: '',
      replaceExisting: false,
    };
    const [desktopRun, tuiRun] = await Promise.all([
      desktop.mutateDailyReview(run),
      tui.mutateDailyReview(run),
    ]);
    assert.deepEqual(tuiRun, desktopRun);
    assert.equal(desktopRun.kind, 'archive');
    if (desktopRun.kind !== 'archive') return;
    assert.equal(desktopRun.archive.status, 'no_data');

    const noModel = await desktop.mutateDailyReview({
      ...run,
      offsetDays: 0,
      modelKeyOverride: 'missing-provider::missing-model',
    });
    assert.equal(noModel.kind, 'archive');
    if (noModel.kind !== 'archive') return;
    assert.equal(noModel.archive.status, 'no_model');
    assert.equal(noModel.archive.totals.requestCount, 1);

    const enabled = await desktop.mutateDailyReview({
      kind: 'update_config',
      expectedRevision: 1,
      config: {
        enabled: true,
        executeTime: '00:00',
        modelKey: 'missing-provider::missing-model',
      },
    });
    assert.equal(enabled.kind, 'config_committed');
    const scheduled = await waitForScheduledArchive(desktop);

    await Promise.all([desktop.close(), tui.close()]);
    desktop = undefined;
    tui = undefined;
    await host.close();
    host = undefined;

    owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 30_000,
      composition: defineInteractiveRuntimeHostComposition(createExecutionRuntimeHostComposition),
    });
    owner = undefined;
    tui = await connect(root, 'tui');
    assert.deepEqual(
      await tui.queryDailyReview({
        kind: 'archive',
        archiveId: desktopRun.archive.id,
      }),
      { kind: 'archive', archive: desktopRun.archive },
    );
    assert.deepEqual(
      await tui.queryDailyReview({
        kind: 'archive',
        archiveId: scheduled.id,
      }),
      { kind: 'archive', archive: scheduled },
    );
  } finally {
    await Promise.allSettled([desktop?.close(), tui?.close()]);
    await host?.close().catch(() => undefined);
    await setupUsage?.close().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

async function connect(
  rootPath: string,
  surface: 'desktop' | 'tui',
): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({
    rootPath,
    surface,
    protocol: PROTOCOL,
  });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Unable to connect to Runtime Host');
  return result.connection;
}

async function waitForScheduledArchive(
  connection: RuntimeHostConnection,
): Promise<DailyReviewArchive> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const page = await connection.queryDailyReview({
      kind: 'archives',
      beforeArchiveId: null,
      limit: 10,
    });
    if (page.kind === 'archives') {
      const scheduled = page.archives.find((archive) => archive.trigger === 'cron');
      if (scheduled) {
        const result = await connection.queryDailyReview({
          kind: 'archive',
          archiveId: scheduled.id,
        });
        if (result.kind === 'archive' && result.archive) return result.archive;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Scheduled Daily Review archive was not published');
}
