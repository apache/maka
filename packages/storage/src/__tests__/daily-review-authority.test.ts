import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DailyReviewArchive } from '@maka/core';
import {
  authenticateInteractiveDailyReviewAuthorityWriter,
  openInteractiveDailyReviewAuthorityForWrite,
} from '../daily-review-authority.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';

test('Daily Review authority serializes config revisions and preserves archives', async () => {
  await withInteractiveRoot(async ({ capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    try {
      const [first, second] = await Promise.all([
        openInteractiveDailyReviewAuthorityForWrite(owner.lease),
        openInteractiveDailyReviewAuthorityForWrite(owner.lease),
      ]);
      assert.equal(first, second);
      assert.equal(authenticateInteractiveDailyReviewAuthorityWriter(first), first);
      assert.deepEqual(await first.readConfig(), {
        revision: 0,
        config: { enabled: false, executeTime: '08:00', modelKey: '' },
      });

      assert.deepEqual(
        await first.updateConfig(0, {
          enabled: true,
          executeTime: '09:30',
          modelKey: 'openrouter::openrouter/free',
        }),
        {
          kind: 'committed',
          snapshot: {
            revision: 1,
            config: {
              enabled: true,
              executeTime: '09:30',
              modelKey: 'openrouter::openrouter/free',
            },
          },
        },
      );
      assert.deepEqual(
        await second.updateConfig(0, {
          enabled: false,
          executeTime: '10:00',
          modelKey: '',
        }),
        { kind: 'revision_conflict', expectedRevision: 0, actualRevision: 1 },
      );

      const stored = await first.putArchive(archive());
      assert.deepEqual(await second.getArchive(stored.id), stored);
      assert.deepEqual(
        (await second.listArchives()).map((item) => item.id),
        [stored.id],
      );

      first.close();
      assert.throws(() => authenticateInteractiveDailyReviewAuthorityWriter(first), isInvalidLease);
      const reopened = await openInteractiveDailyReviewAuthorityForWrite(owner.lease);
      assert.equal((await reopened.readConfig()).revision, 1);
      assert.deepEqual(await reopened.getArchive(stored.id), stored);
      reopened.close();
    } finally {
      if (!owner.closed) await owner.close();
    }
  });
});

test('Daily Review authority rejects operations after its root lease closes', async () => {
  await withInteractiveRoot(async ({ capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    const writer = await openInteractiveDailyReviewAuthorityForWrite(owner.lease);
    await owner.close();
    await assert.rejects(() => writer.readConfig(), isInvalidLease);
    await assert.rejects(() => writer.putArchive(archive()), isInvalidLease);
    writer.close();
  });
});

function archive(): DailyReviewArchive {
  const fromMs = new Date(2026, 7, 3).getTime();
  const toMs = new Date(2026, 7, 4).getTime();
  return {
    id: '2026-08-03-1d',
    day: { fromMs, toMs },
    range: 1,
    status: 'ok',
    generatedAt: toMs + 1,
    trigger: 'manual',
    modelKey: 'openrouter::openrouter/free',
    sections: { summary: 'One durable review.' },
    totals: {
      sessionCount: 1,
      requestCount: 2,
      totalTokens: 3,
      costUsd: 0,
      errorCount: 0,
    },
  };
}

async function withInteractiveRoot(
  run: (input: {
    capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-daily-review-authority-'));
  try {
    const capability = await resolveStorageRoot({
      path: join(base, 'interactive'),
      kind: 'interactive',
    });
    await run({ capability });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function isInvalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}
