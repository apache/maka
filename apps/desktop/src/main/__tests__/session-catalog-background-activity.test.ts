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
import { test } from 'node:test';
import { createSessionCatalogController } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import { normalizeSessionSummaryForDisplay } from '../../renderer/application/contracts/session-status-presentation.js';
import { projectDesktopSharedSessionSummary } from '../../shared/shared-session-catalog-projection.js';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';

const row: DesktopSessionSummary = {
  id: 'root', revision: 5, activityAt: 100, name: 'Swarm', isFlagged: false, isArchived: false,
  labels: [], hasUnread: false, status: 'active', backend: 'ai-sdk', llmConnectionSlug: 'default',
  connectionLocked: false, model: 'model', permissionMode: 'ask', runtimeHostId: 'host',
  profileId: 'profile', profileName: 'Local', profileKind: 'local', runningTurnIds: [],
  runEpoch: 2, runHostGeneration: 'host-1', backgroundActivity: 'running',
  backgroundActivityVersion: { hostGeneration: 'host-1', revision: 1 },
};

for (const arrival of ['list', 'patch'] as const) {
  test(`a late ${arrival} cannot overwrite a newer activity at the same Session and run revisions`, () => {
    const catalog = createSessionCatalogController();
    catalog.commitSessions([row]);
    const observedAtRevision = catalog.getState().revision;
    catalog.commitPatch(row.id, { ...row, backgroundActivity: 'idle',
      backgroundActivityVersion: { hostGeneration: 'host-1', revision: 2 } });
    const current = catalog.getState().sessions[0];
    if (arrival === 'list') catalog.commitSessions([row], { observedAtRevision });
    else catalog.commitPatch(row.id, row);
    assert.equal(catalog.getState().sessions[0], current, 'stale activity must not republish');
    assert.equal(catalog.getState().sessions[0]?.backgroundActivity, 'idle');
  });
}

test('activity ordering preserves newer durable metadata and live Turn state independently', () => {
  const catalog = createSessionCatalogController();
  catalog.commitSessions([{ ...row, backgroundActivity: 'idle',
    backgroundActivityVersion: { hostGeneration: 'host-1', revision: 3 } }]);
  catalog.commitPatch(row.id, { ...row, revision: 6, name: 'Renamed', runEpoch: 3, runningTurnIds: ['turn'] });
  assert.equal(catalog.getState().sessions[0]?.name, 'Renamed');
  assert.deepEqual(catalog.getState().sessions[0]?.runningTurnIds, ['turn']);
  assert.equal(catalog.getState().sessions[0]?.backgroundActivity, 'idle');
  catalog.commitSessions([{ ...row, backgroundActivity: 'waiting_for_user',
    backgroundActivityVersion: { hostGeneration: 'host-1', revision: 4 } }]);
  assert.equal(catalog.getState().sessions[0]?.name, 'Renamed');
  assert.equal(catalog.getState().sessions[0]?.runEpoch, 3);
  assert.equal(catalog.getState().sessions[0]?.backgroundActivity, 'waiting_for_user');
});

test('a restarted Host can replace an earlier generation with a lower activity revision', () => {
  const catalog = createSessionCatalogController();
  catalog.commitSessions([row]);
  catalog.commitPatch(row.id, { ...row, backgroundActivity: 'idle', runEpoch: 0, runHostGeneration: 'host-2',
    backgroundActivityVersion: { hostGeneration: 'host-2', revision: 0 } });
  assert.equal(catalog.getState().sessions[0]?.backgroundActivity, 'idle');
  assert.deepEqual(catalog.getState().sessions[0]?.backgroundActivityVersion, { hostGeneration: 'host-2', revision: 0 });
});

test('cached projections strip both activity and its ordering authority', () => {
  const cached = normalizeSessionSummaryForDisplay({ ...row, localState: 'cached' });
  assert.equal(cached.backgroundActivity, undefined);
  assert.equal(cached.backgroundActivityVersion, undefined);
  const catalog = createSessionCatalogController();
  catalog.commitSessions([row]);
  catalog.commitSessions([cached]);
  assert.equal(catalog.getState().sessions[0]?.backgroundActivityVersion, undefined);
  catalog.commitPatch(row.id, { ...row, backgroundActivity: 'idle',
    backgroundActivityVersion: { hostGeneration: 'host-1', revision: 0 } });
  assert.equal(catalog.getState().sessions[0]?.backgroundActivity, 'idle');
  const shared = { kind: 'shared_session' as const, id: 'shared', revision: 1, createdAt: 1,
    activityAt: 1, name: 'Shared', status: 'active' as const,
    backgroundActivity: row.backgroundActivity, backgroundActivityVersion: row.backgroundActivityVersion };
  assert.deepEqual(projectDesktopSharedSessionSummary(shared).backgroundActivityVersion, row.backgroundActivityVersion);
  assert.equal(projectDesktopSharedSessionSummary(shared, { cached: true }).backgroundActivityVersion, undefined);
});
