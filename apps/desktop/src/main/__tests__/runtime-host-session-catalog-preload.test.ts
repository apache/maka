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
  collectRuntimeHostSessionCatalogsWithCoverage,
  createRuntimeHostSessionCatalogRefresher,
  recordObservedRuntimeHostSessionAuthority,
  reconcileRuntimeHostSessionCatalog,
  resolveRuntimeHostSessionCatalog,
} from '../../preload/runtime-host-session-catalog.js';

function session(id: string, activityAt: number): DesktopSessionSummary {
  return { id, activityAt } as DesktopSessionSummary;
}

function ownerSession(
  id: string,
  activityAt: number,
  hostId = 'owner-host',
  profileId = 'owner-profile',
): DesktopSessionSummary {
  return {
    ...session(id, activityAt),
    runtimeHostId: hostId,
    profileId,
  };
}

function guestSession(
  id: string,
  activityAt: number,
  profileId = 'guest-profile',
): DesktopSessionSummary {
  return {
    ...session(id, activityAt),
    runtimeHostId: 'guest-host',
    profileId,
    shared: true,
  };
}

test('starts a fresh catalog read after the previous refresh settles', async () => {
  let resolveFirst!: (sessions: DesktopSessionSummary[]) => void;
  const firstRead = new Promise<DesktopSessionSummary[]>((resolve) => {
    resolveFirst = resolve;
  });
  const stale = session('stale', 1);
  const fresh = session('fresh', 2);
  let reads = 0;
  let current: DesktopSessionSummary[] = [];
  const refresher = createRuntimeHostSessionCatalogRefresher({
    listCatalog: async () => ({
      sessions: await (++reads === 1 ? firstRead : Promise.resolve([fresh])),
      completeHostIds: [],
    }),
    currentCatalog: () => ({ sessions: current, completeHostIds: [] }),
    commitCatalog: (catalog) => {
      current = catalog.sessions;
    },
  });

  const first = refresher.refresh();
  resolveFirst([stale]);
  assert.deepEqual((await first).sessions, [stale]);
  const second = refresher.refresh();
  assert.deepEqual((await second).sessions, [fresh]);
  assert.equal(reads, 2);
});

test('does not commit a catalog read superseded while it is in flight', async () => {
  let resolveFirst!: (sessions: DesktopSessionSummary[]) => void;
  const firstRead = new Promise<DesktopSessionSummary[]>((resolve) => {
    resolveFirst = resolve;
  });
  const stale = session('stale', 1);
  const fresh = session('fresh', 2);
  const commits: DesktopSessionSummary[][] = [];
  let reads = 0;
  let current: DesktopSessionSummary[] = [];
  const refresher = createRuntimeHostSessionCatalogRefresher({
    listCatalog: async () => ({
      sessions: await (++reads === 1 ? firstRead : Promise.resolve([fresh])),
      completeHostIds: [],
    }),
    currentCatalog: () => ({ sessions: current, completeHostIds: [] }),
    commitCatalog: (catalog) => {
      current = catalog.sessions;
      commits.push(catalog.sessions);
    },
  });

  const first = refresher.refresh();
  const second = refresher.refresh();
  resolveFirst([stale]);

  assert.deepEqual((await first).sessions, [fresh]);
  assert.deepEqual((await second).sessions, [fresh]);
  assert.deepEqual(commits, [[fresh]]);
  assert.equal(reads, 2);
});

test('continues to an admitted trailing read after a superseded read fails', async () => {
  let rejectFirst!: (error: Error) => void;
  const firstRead = new Promise<DesktopSessionSummary[]>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const fresh = session('fresh', 2);
  let reads = 0;
  let current: DesktopSessionSummary[] = [];
  const refresher = createRuntimeHostSessionCatalogRefresher({
    listCatalog: async () => ({
      sessions: await (++reads === 1 ? firstRead : Promise.resolve([fresh])),
      completeHostIds: [],
    }),
    currentCatalog: () => ({ sessions: current, completeHostIds: [] }),
    commitCatalog: (catalog) => {
      current = catalog.sessions;
    },
  });

  const first = refresher.refresh();
  const second = refresher.refresh();
  rejectFirst(new Error('superseded'));

  assert.deepEqual((await first).sessions, [fresh]);
  assert.deepEqual((await second).sessions, [fresh]);
  assert.equal(reads, 2);
});

test('keeps a newly created Session when the superseding catalog read fails', async () => {
  let resolveStale!: (catalog: {
    sessions: DesktopSessionSummary[];
    completeHostIds: string[];
  }) => void;
  const staleRead = new Promise<{
    sessions: DesktopSessionSummary[];
    completeHostIds: string[];
  }>((resolve) => {
    resolveStale = resolve;
  });
  const created = ownerSession('created', 2);
  let reads = 0;
  let current = {
    sessions: [ownerSession('existing', 1)],
    completeHostIds: ['owner-host'],
  };
  const refresher = createRuntimeHostSessionCatalogRefresher({
    listCatalog: () => {
      reads += 1;
      return reads === 1
        ? staleRead
        : Promise.reject(new Error('Owner catalog temporarily unavailable'));
    },
    currentCatalog: () => current,
    commitCatalog: (catalog) => {
      current = catalog;
    },
  });

  const refresh = refresher.refresh();
  refresher.admit(created);
  resolveStale({ sessions: [], completeHostIds: ['owner-host'] });

  await assert.rejects(refresh, /temporarily unavailable/);
  assert.deepEqual(current.sessions.map(({ id }) => id), ['created', 'existing']);
  assert.equal(reads, 2);
});

test('rejects a delayed bootstrap seed after a Session is created', async () => {
  const created = ownerSession('created', 2);
  let current = {
    sessions: [ownerSession('existing', 1)],
    completeHostIds: ['owner-host'],
  };
  const refresher = createRuntimeHostSessionCatalogRefresher({
    listCatalog: () => Promise.reject(new Error('Owner catalog temporarily unavailable')),
    currentCatalog: () => current,
    commitCatalog: (catalog) => {
      current = catalog;
    },
  });

  const delayedBootstrap = refresher.beginSeed();
  refresher.admit(created);

  assert.equal(
    delayedBootstrap.commit({ sessions: [], completeHostIds: ['owner-host'] }),
    false,
  );
  await assert.rejects(refresher.refresh(), /temporarily unavailable/);
  assert.deepEqual(current.sessions.map(({ id }) => id), ['created', 'existing']);
});

test('collects every healthy Owner catalog and reports only complete Hosts', async () => {
  const catalog = await collectRuntimeHostSessionCatalogsWithCoverage([
    { hostId: 'older', sessions: Promise.resolve([session('older', 1)]) },
    {
      hostId: 'unavailable',
      sessions: Promise.reject(new Error('remote unavailable')),
    },
    { hostId: 'newer', sessions: Promise.resolve([session('newer', 2)]) },
  ]);

  assert.deepEqual(catalog.sessions.map(({ id }) => id), ['newer', 'older']);
  assert.deepEqual(catalog.completeHostIds, ['older', 'newer']);
});

test('keeps incomplete coverage when every Owner catalog rejects', async () => {
  assert.deepEqual(
    await collectRuntimeHostSessionCatalogsWithCoverage([
      { hostId: 'first', sessions: Promise.reject(new Error('first unavailable')) },
      { hostId: 'second', sessions: Promise.reject(new Error('second unavailable')) },
    ]),
    { sessions: [], completeHostIds: [] },
  );
});

test('reconciles Owner catalogs per Host and retires removed Owner profiles', () => {
  const first = ownerSession('first', 1, 'first-host', 'first-owner');
  const second = ownerSession('second', 2, 'second-host', 'second-owner');

  assert.deepEqual(
    reconcileRuntimeHostSessionCatalog([first, second], {
      sessions: [],
      completeHostIds: ['first-host'],
      knownOwnerProfileIds: ['first-owner', 'second-owner'],
      guestSessions: [],
    }),
    [second],
  );
  assert.deepEqual(
    reconcileRuntimeHostSessionCatalog([first, second], {
      sessions: [],
      completeHostIds: [],
      knownOwnerProfileIds: ['first-owner'],
      guestSessions: [],
    }),
    [first],
  );
});

test('uses the mount service as the complete Guest catalog authority', () => {
  const stale = guestSession('shared', 1);
  const fresh = { ...stale, activityAt: 2, name: 'fresh' };
  const owner = ownerSession('shared', 3, 'guest-host');

  assert.deepEqual(
    reconcileRuntimeHostSessionCatalog([stale], {
      sessions: [],
      completeHostIds: [],
      knownOwnerProfileIds: [],
      guestSessions: [fresh],
    }),
    [fresh],
  );
  assert.deepEqual(
    reconcileRuntimeHostSessionCatalog([stale], {
      sessions: [],
      completeHostIds: [],
      knownOwnerProfileIds: [],
      guestSessions: [],
    }),
    [],
  );
  assert.deepEqual(
    reconcileRuntimeHostSessionCatalog([], {
      sessions: [owner],
      completeHostIds: ['guest-host'],
      knownOwnerProfileIds: ['owner-profile'],
      guestSessions: [fresh],
    }),
    [owner],
  );
});

test('prefers a live Guest projection over an unavailable Owner fallback', () => {
  const retainedOwner = ownerSession('shared', 1);
  const liveGuest = {
    ...guestSession('shared', 2),
    runtimeHostId: retainedOwner.runtimeHostId,
  };

  assert.deepEqual(
    reconcileRuntimeHostSessionCatalog([retainedOwner], {
      sessions: [],
      completeHostIds: [],
      knownOwnerProfileIds: [retainedOwner.profileId],
      guestSessions: [liveGuest],
    }),
    [liveGuest],
  );
});

test('retains the last Guest projection only when mount inventory is unavailable', async () => {
  const guest = guestSession('shared', 2);
  assert.deepEqual(
    await resolveRuntimeHostSessionCatalog(
      [guest],
      Promise.resolve({ sessions: [], completeHostIds: [] }),
      () => [],
      Promise.reject(new Error('mount inventory unavailable')),
    ),
    { sessions: [guest], completeHostIds: [] },
  );
});

test('preserves an authenticated onboarding Owner seed across a failed catalog refresh', async () => {
  const owner = ownerSession('owner', 3);
  const guest = guestSession('shared', 2);
  const seeded = reconcileRuntimeHostSessionCatalog([], {
    sessions: [owner],
    completeHostIds: ['owner-host'],
    knownOwnerProfileIds: ['owner-profile'],
  });

  assert.deepEqual(
    await resolveRuntimeHostSessionCatalog(
      seeded,
      collectRuntimeHostSessionCatalogsWithCoverage([
        {
          hostId: 'owner-host',
          sessions: Promise.reject(new Error('catalog temporarily unavailable')),
        },
      ]),
      () => ['owner-profile'],
      Promise.resolve([guest]),
    ),
    { sessions: [owner, guest], completeHostIds: [] },
  );
});

test('an observed Guest event cannot replace an accepted Owner authority', () => {
  const authorities = new Map([['shared-session', 'owner-profile']]);

  assert.equal(
    recordObservedRuntimeHostSessionAuthority(authorities, 'shared-session', 'guest-profile'),
    false,
  );
  assert.equal(authorities.get('shared-session'), 'owner-profile');
  assert.equal(
    recordObservedRuntimeHostSessionAuthority(authorities, 'new-session', 'guest-profile'),
    true,
  );
  assert.equal(authorities.get('new-session'), 'guest-profile');
});
