import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createDailyReviewArchiveStore } from '../daily-review-archive-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function aRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-daily-review-store-'));
  roots.push(root);
  return root;
}

describe('Daily Review archive migration', () => {
  it('reads a legacy deep archive through the range contract', async () => {
    const root = await aRoot();
    const archiveRoot = join(root, 'daily-reviews', 'archive');
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(
      join(archiveRoot, '2026-08-03-deep.json'),
      JSON.stringify({
        id: '2026-08-03-deep',
        day: { fromMs: 1, toMs: 2 },
        mode: 'deep',
        status: 'ok',
        generatedAt: 3,
        trigger: 'manual',
        modelKey: '',
        sections: { summary: 'legacy' },
        totals: { sessionCount: 1, requestCount: 2, totalTokens: 3, costUsd: 4, errorCount: 0 },
      }),
    );

    const store = createDailyReviewArchiveStore(root);
    const archive = await store.getArchive('2026-08-03-deep');
    assert.equal(archive?.range, 7);
    assert.equal(archive?.sections.summary, 'legacy');
    assert.deepEqual((await store.listArchives()).map((item) => item.range), [7]);
  });

  it('persists only the three canonical settings', async () => {
    const root = await aRoot();
    const store = createDailyReviewArchiveStore(root);
    const next = await store.setConfig({
      enabled: true,
      executeTime: '07:45',
      modelKey: 'openai::gpt-5',
    });

    assert.deepEqual(next, {
      enabled: true,
      executeTime: '07:45',
      modelKey: 'openai::gpt-5',
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'daily-reviews', 'config.json'), 'utf8')),
      next,
    );
  });
});
