import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveDailyReviewAuthorityForWrite } from '@maka/storage/daily-review-authority';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { writeDailyReviewArchives } from '../e2e-fixture/scenarios-settings.js';

test('Daily Review fixture seeds archives through the storage authority', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-daily-review-fixture-'));
  try {
    await writeDailyReviewArchives(workspaceRoot, Date.UTC(2026, 4, 21, 12, 0, 0));

    const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    try {
      const writer = await openInteractiveDailyReviewAuthorityForWrite(owner.lease);
      try {
        const page = await writer.listArchivePage(null, 180);
        assert.deepEqual(
          page.archives.map((archive) => archive.id),
          ['2026-05-21-1d', '2026-05-15-7d'],
        );
        assert.ok(await writer.getArchive('2026-05-21-1d'));
        assert.ok(await writer.getArchive('2026-05-15-7d'));
      } finally {
        writer.close();
      }
    } finally {
      await owner.close();
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
