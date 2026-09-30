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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import { seedE2eFixture } from '../e2e-fixture.js';
import { usageStatsRecords } from '../e2e-fixture/scenarios-usage.js';
import { E2E_FIXTURE_NOW } from '../e2e-fixture/seed-helpers.js';

test('settings-usage fixture folds the canonical usage projection until no run is pending', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'e2e-usage-fold-'));
  try {
    await seedE2eFixture({
      workspaceRoot,
      fixture: {
        scenario: 'settings-usage',
        workspaceName: 'e2e-fixture-settings-usage',
        reducedMotion: false,
        theme: null,
        locale: null,
        timezone: null,
        platform: null,
      },
      now: E2E_FIXTURE_NOW,
    });

    const storageRoot = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(storageRoot);
    assert.ok(owner, 'the fixture must release the storage root so readers can acquire it');
    const usage = await openInteractiveUsageStoresForWrite(owner.lease);
    try {
      // The page's first read must already see every seeded model call; the
      // fixture folds the appended attempts into the read model before closing.
      const expectedRequests = usageStatsRecords(E2E_FIXTURE_NOW).modelCalls.length;
      const summary = await usage.modelCalls.modelCallSummary({ range: 'all' }, E2E_FIXTURE_NOW);
      assert.equal(
        summary.projection.totalRequests,
        expectedRequests,
        'the first read must see every seeded model call',
      );
      // One catch-up pass bounds how many lagging runs it folds, so a complete
      // fold leaves nothing pending for later reads to repair.
      const projection = await usage.modelCalls.catchUpModelCallProjection();
      assert.equal(projection.pendingRuns, 0, 'no lagging run may outlive the fixture seed');
    } finally {
      await usage.close();
      await owner.close();
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
