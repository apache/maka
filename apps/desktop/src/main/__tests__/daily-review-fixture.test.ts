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

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import { tmpdir as temporaryDirectory } from 'node:os';
import { join as joinPath } from 'node:path';
import { test as verify } from 'node:test';
import * as dailyReviewAuthority from '@maka/storage/daily-review-authority';
import * as rootAuthority from '@maka/storage/root-authority';
import { writeDailyReviewArchives as materializeDailyReviewArchives } from '../e2e-fixture/scenarios-settings.js';
async function withWorkspace<T>(name: string, run: (workspaceRoot: string) => Promise<T>) {
  const workspaceRoot = await fs.mkdtemp(joinPath(temporaryDirectory(), `${name}-`));
  return run(workspaceRoot).finally(() =>
    fs.rm(workspaceRoot, { recursive: true, force: true }),
  );
}

async function readArchiveIds(workspaceRoot: string): Promise<readonly string[]> {
  const capability = await rootAuthority.resolveStorageRoot({
    path: workspaceRoot,
    kind: 'interactive',
  });
  const owner = await rootAuthority.tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, 'fixture operation must release the root owner');
  const writer = await dailyReviewAuthority.openInteractiveDailyReviewAuthorityForWrite(owner.lease);
  try {
    const page = await writer.listArchivePage(null, 180);
    return page.archives.map(({ id }) => id);
  } finally {
    writer.close();
    await owner.close();
  }
}

const expectedArchiveIds = ['2026-05-21-1d', '2026-05-15-7d'] as const;

for (const scenario of [
  { name: 'deterministic identities', hours: [12] },
  { name: 'same-day idempotence', hours: [1, 23] },
] as const) {
  verify(`Daily Review fixture preserves ${scenario.name}`, async () => {
    await withWorkspace(`maka-daily-review-${scenario.hours.length}`, async (workspaceRoot) => {
      for (const hour of scenario.hours) {
        await materializeDailyReviewArchives(workspaceRoot, Date.UTC(2026, 4, 21, hour));
      }
      assert.deepEqual(await readArchiveIds(workspaceRoot), expectedArchiveIds);
    });
  });
}

verify('Daily Review fixture rolls back ownership and storage after invalid input', async () => {
  await withWorkspace('maka-daily-review-invalid', async (workspaceRoot) => {
    await assert.rejects(materializeDailyReviewArchives(workspaceRoot, Number.NaN), /generatedAt/);
    assert.deepEqual(await readArchiveIds(workspaceRoot), []);
  });
});
