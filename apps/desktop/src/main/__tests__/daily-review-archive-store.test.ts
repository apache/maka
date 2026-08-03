import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { DailyReviewArchive } from '@maka/core';
import { createDailyReviewArchiveStore } from '../daily-review-archive-store.js';

const roots: string[] = [];
const DAY = {
  fromMs: new Date(2026, 7, 3, 0, 0, 0, 0).getTime(),
  toMs: new Date(2026, 7, 4, 0, 0, 0, 0).getTime(),
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Daily Review SQLite archive store', () => {
  it('persists canonical config across store instances', async () => {
    const root = await workspace();
    const next = await createDailyReviewArchiveStore(root).setConfig({
      enabled: true,
      executeTime: '07:45',
      modelKey: 'openai::gpt-5',
    });

    assert.deepEqual(next, {
      enabled: true,
      executeTime: '07:45',
      modelKey: 'openai::gpt-5',
    });
    assert.deepEqual(await createDailyReviewArchiveStore(root).getConfig(), next);
  });

  it('stores, replaces, and deletes one canonical archive', async () => {
    const root = await workspace();
    const store = createDailyReviewArchiveStore(root);
    await store.putArchive(archive('2026-08-03-1d', 3));
    await store.putArchive({
      ...archive('2026-08-03-1d', 4),
      sections: { summary: 'updated' },
    });

    assert.equal((await store.getArchive('2026-08-03-1d'))?.sections.summary, 'updated');
    assert.deepEqual((await store.listArchives()).map(({ id }) => id), ['2026-08-03-1d']);

    await store.deleteArchive('2026-08-03-1d');
    assert.equal(await store.getArchive('2026-08-03-1d'), null);
  });

  it('orders newest first and prunes older archives in SQLite', async () => {
    const root = await workspace();
    const store = createDailyReviewArchiveStore(root);
    await store.putArchive(archive('2026-08-01-1d', 1));
    await store.putArchive(archive('2026-08-02-1d', 2));
    await store.putArchive(archive('2026-08-03-1d', 3));

    await store.prune(2);

    assert.deepEqual(
      (await store.listArchives()).map(({ id }) => id),
      ['2026-08-03-1d', '2026-08-02-1d'],
    );
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-daily-review-store-'));
  roots.push(root);
  return root;
}

function archive(id: string, generatedAt: number): DailyReviewArchive {
  return {
    id,
    day: DAY,
    range: 1,
    status: 'ok',
    generatedAt,
    trigger: 'manual',
    modelKey: '',
    sections: { summary: 'healthy' },
    totals: {
      sessionCount: 1,
      requestCount: 2,
      totalTokens: 3,
      costUsd: 4,
      errorCount: 0,
    },
  };
}
