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
import test from 'node:test';
import { openInteractiveDailyReviewAuthorityForWrite } from '@maka/storage/daily-review-authority';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { writeDailyReviewArchives } from '../e2e-fixture/scenarios-settings.js';

async function withWorkspace<T>(name: string, run: (workspaceRoot: string) => Promise<T>) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `${name}-`));
  try {
    return await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function readArchiveIds(workspaceRoot: string): Promise<string[]> {
  const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, 'fixture operation must release the root owner');
  try {
    const writer = await openInteractiveDailyReviewAuthorityForWrite(owner.lease);
    try {
      return (await writer.listArchivePage(null, 180)).archives.map(({ id }) => id);
    } finally {
      writer.close();
    }
  } finally {
    await owner.close();
  }
}

test('Daily Review fixture derives deterministic one-day and seven-day archive identities', async () => {
  await withWorkspace('maka-daily-review-fixture', async (workspaceRoot) => {
    const noon = Date.UTC(2026, 4, 21, 12);
    await writeDailyReviewArchives(workspaceRoot, noon);
    assert.deepEqual(await readArchiveIds(workspaceRoot), ['2026-05-21-1d', '2026-05-15-7d']);
  });
});

test('Daily Review fixture is idempotent for the same logical day', async () => {
  await withWorkspace('maka-daily-review-idempotent', async (workspaceRoot) => {
    await writeDailyReviewArchives(workspaceRoot, Date.UTC(2026, 4, 21, 1));
    await writeDailyReviewArchives(workspaceRoot, Date.UTC(2026, 4, 21, 23));
    assert.deepEqual(await readArchiveIds(workspaceRoot), ['2026-05-21-1d', '2026-05-15-7d']);
  });
});

test('Daily Review fixture rolls back ownership and storage after invalid input', async () => {
  await withWorkspace('maka-daily-review-invalid', async (workspaceRoot) => {
    await assert.rejects(writeDailyReviewArchives(workspaceRoot, Number.NaN), /generatedAt/);
    assert.deepEqual(await readArchiveIds(workspaceRoot), []);
  });
});
