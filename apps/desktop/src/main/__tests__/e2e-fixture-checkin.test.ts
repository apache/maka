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
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from '@maka/storage/operational-state-store';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { openInteractiveSessionTodoStoreForWrite } from '@maka/storage/session-todo-authority';
import { createSqliteSessionMetadataStore } from '@maka/storage/sqlite-session-metadata-store';
import { getE2eFixtureState, seedE2eFixture, type E2eFixture } from '../e2e-fixture.js';
import {
  CHECKIN_FIXTURE_CONNECTION,
  CHECKIN_FIXTURE_MODEL,
  checkinSessions,
} from '../e2e-fixture/scenarios-checkin.js';

const NOW = Date.UTC(2026, 9, 24, 3, 0, 0);
const WEEK = 7 * 24 * 60 * 60 * 1000;

const fixture: E2eFixture = {
  scenario: 'checkin',
  workspaceName: 'e2e-fixture-checkin',
  reducedMotion: false,
  theme: null,
  locale: null,
  timezone: null,
  platform: null,
};

test('the check-in corpus covers every case inside the look-back window', () => {
  const sessions = checkinSessions(NOW);
  assert.equal(new Set(sessions.map((seed) => seed.header.id)).size, sessions.length);
  assert.deepEqual(
    [...new Set(sessions.map((seed) => seed.expect))].sort(),
    ['answer', 'continue', 'no card', 'resume'],
  );
  for (const seed of sessions) {
    assert.ok((seed.header.lastMessageAt ?? 0) > NOW - WEEK, seed.header.id);
    assert.equal(seed.header.llmConnectionSlug, CHECKIN_FIXTURE_CONNECTION);
  }
  // The real clock, not the fixed one: check-in compares against the Host's time.
  assert.equal(getE2eFixtureState(fixture)?.now, undefined);
});

test('the check-in fixture seeds its Sessions, Todo items and default model', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'e2e-checkin-'));
  try {
    await seedE2eFixture({ workspaceRoot, fixture, now: NOW });

    const databaseLease = acquireOperationalStateDatabase(workspaceRoot);
    const metadata = createSqliteSessionMetadataStore(
      join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME),
      { databaseLease },
    );
    let boundTo: Set<string | undefined>;
    try {
      const records = await metadata.list(undefined, 'ordinary');
      const seeded = new Set(records.map((record) => record.header.id));
      for (const seed of checkinSessions(NOW)) assert.ok(seeded.has(seed.header.id), seed.header.id);
      boundTo = new Set(
        records
          .filter((record) => record.header.llmConnectionSlug === CHECKIN_FIXTURE_CONNECTION)
          .map((record) => record.header.llmConnectionId),
      );
    } finally {
      metadata.close();
    }

    const storageRoot = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(storageRoot);
    assert.ok(owner, 'the fixture must release the storage root');
    try {
      const todos = await openInteractiveSessionTodoStoreForWrite(owner.lease);
      assert.deepEqual(
        (await todos.readOrBootstrap('checkin-open-todo')).items.map((item) => item.status),
        ['completed', 'completed', 'pending', 'pending'],
      );
      const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
      const catalog = await policy.connectionCatalog.getSnapshot();
      const fallback = catalog.connections.find(
        (connection) => connection.connectionId === catalog.defaultTarget?.connectionId,
      );
      assert.equal(fallback?.slug, CHECKIN_FIXTURE_CONNECTION);
      // Bound by identity, not by slug alone, so the Host will run them.
      assert.deepEqual([...boundTo], [fallback?.connectionId]);
      assert.equal(catalog.defaultTarget?.modelId, CHECKIN_FIXTURE_MODEL);
    } finally {
      await owner.close();
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
