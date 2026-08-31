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
import test from 'node:test';
import type { DesktopSessionSummary } from '../../preload/bridge-contract.js';
import {
  collectRuntimeHostSessionCatalogs,
  collectRuntimeHostSessionCatalogsWithCoverage,
} from '../../preload/runtime-host-session-catalog.js';

function session(id: string, activityAt: number): DesktopSessionSummary {
  return { id, activityAt } as DesktopSessionSummary;
}

test('keeps healthy Host catalogs when another Host rejects', async () => {
  const sessions = await collectRuntimeHostSessionCatalogs([
    Promise.resolve([session('older', 1)]),
    Promise.reject(new Error('remote unavailable')),
    Promise.resolve([session('newer', 2)]),
  ]);

  assert.deepEqual(sessions.map(({ id }) => id), ['newer', 'older']);
});

test('reports exactly which Host catalogs are complete', async () => {
  const catalog = await collectRuntimeHostSessionCatalogsWithCoverage([
    { hostId: 'local', access: 'owner', sessions: Promise.resolve([session('local-session', 1)]) },
    {
      hostId: 'remote',
      access: 'owner',
      sessions: Promise.reject(new Error('remote unavailable')),
    },
  ]);

  assert.deepEqual(catalog.sessions.map(({ id }) => id), ['local-session']);
  assert.deepEqual(catalog.completeHostIds, ['local']);
});

test('collapses overlapping Guest catalogs in favor of the Owner authority', async () => {
  const owner = session('shared-session', 2);
  const guest = { ...owner, shared: true as const };

  const sessions = await collectRuntimeHostSessionCatalogs([
    Promise.resolve([guest]),
    Promise.resolve([owner]),
  ]);

  assert.deepEqual(sessions, [owner]);
});

test('fails when every Host catalog rejects', async () => {
  await assert.rejects(
    collectRuntimeHostSessionCatalogs([
      Promise.reject(new Error('first unavailable')),
      Promise.reject(new Error('second unavailable')),
    ]),
    /Every Runtime Host Session Catalog request failed/,
  );
});
