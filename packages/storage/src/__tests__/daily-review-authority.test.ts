/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { DailyReviewArchive } from '@maka/core/daily-review';
import {
  authenticateInteractiveDailyReviewAuthorityWriter,
  openInteractiveDailyReviewAuthorityForWrite,
} from '../daily-review-authority.js';
import {
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
} from '../root-authority.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

// The control directory of each resolved root lives outside that root, so a
// temporary root's removal leaves it behind; reclaim the recorded rootIds here.
after(removeTrackedControlDirectories);

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

      const stored = await first.publishArchive(archive(), 180);
      assert.deepEqual(await second.getArchive(stored.id), stored);
      assert.deepEqual(
        (await second.listArchivePage(null, 180)).archives.map((item) => item.id),
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
    await assert.rejects(() => writer.publishArchive(archive(), 180), isInvalidLease);
    writer.close();
  });
});

test('Daily Review authority publishes and prunes archives in one operation', async () => {
  await withInteractiveRoot(async ({ capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    try {
      const writer = await openInteractiveDailyReviewAuthorityForWrite(owner.lease);
      const older = archive();
      const newer = {
        ...archive(new Date(2026, 7, 4).getTime()),
        id: '2026-08-04-1d',
        generatedAt: older.generatedAt + 1,
      };
      await writer.publishArchive(older, 1);
      await writer.publishArchive(newer, 1);
      assert.deepEqual(
        (await writer.listArchivePage(null, 180)).archives.map((item) => item.id),
        [newer.id],
      );
      assert.equal(await writer.getArchive(older.id), null);
      const oldest = archive(new Date(2026, 7, 2).getTime());
      await writer.publishArchive(oldest, 1);
      assert.deepEqual(
        (await writer.listArchivePage(null, 180)).archives.map((item) => item.id),
        [oldest.id],
      );
      assert.deepEqual(await writer.getArchive(oldest.id), oldest);
      await assert.rejects(() => writer.publishArchive({ ...newer, id: '2026-08-05-1d' }, 1));
      assert.deepEqual(
        (await writer.listArchivePage(null, 180)).archives.map((item) => item.id),
        [oldest.id],
      );
      writer.close();
    } finally {
      if (!owner.closed) await owner.close();
    }
  });
});

function archive(fromMs = new Date(2026, 7, 3).getTime()): DailyReviewArchive {
  const start = new Date(fromMs);
  const toMs = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime();
  return {
    id: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(
      start.getDate(),
    ).padStart(2, '0')}-1d`,
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
    const capability = trackControlDirectory(
      await resolveStorageRoot({ path: join(base, 'interactive'), kind: 'interactive' }),
    );
    await run({ capability });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function isInvalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}
