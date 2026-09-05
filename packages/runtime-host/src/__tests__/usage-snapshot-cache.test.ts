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
import {
  UsageSnapshotCache,
  UsageSnapshotCapacityError,
  type UsageSnapshotContents,
} from '../server/usage-snapshot-cache.js';
import { USAGE_SNAPSHOT_ACTIVITY_MAX_ITEMS } from '../protocol/index.js';

const CONTENTS: UsageSnapshotContents = {
  summary: {
    range: { from: 0, to: 1 },
    totalRequests: 0,
    totalCostUsd: 0,
    totalTokens: {
      input: 0,
      output: 0,
      cacheMiss: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
    },
    cacheHitRequests: 0,
    cacheCreateRequests: 0,
    errorRequests: 0,
    totalDurationMs: 0,
  },
  provenance: {
    coverage: {
      attempts: 0,
      pricedAttempts: 0,
      unpricedAttempts: 0,
      usageReportedAttempts: 0,
      usagePartialAttempts: 0,
      usageMissingAttempts: 0,
    },
    legacyRecords: 0,
    unreadableRecords: 0,
    pendingRepairs: 0,
  },
  llmRows: [],
  llmTruncated: false,
  toolRows: [],
  toolTruncated: false,
  pricingEntries: [],
};

test('rejects an activity limit above the protocol maximum', () => {
  assert.throws(
    () => new UsageSnapshotCache({ activityLimit: USAGE_SNAPSHOT_ACTIVITY_MAX_ITEMS + 1 }),
    TypeError,
  );
});

test('preserves four owned leases at capacity instead of evicting an active revision', () => {
  let revision = 0;
  const cache = new UsageSnapshotCache({
    capacity: 4,
    createRevision: () => `revision-${++revision}`,
  });
  const retained = Array.from({ length: 4 }, (_, index) =>
    completeReservation(cache, `connection-${index}`),
  );

  assert.throws(
    () => completeReservation(cache, 'connection-5'),
    (error: unknown) =>
      error instanceof UsageSnapshotCapacityError &&
      error.message === 'Usage snapshot capacity is occupied',
  );
  for (const [index, snapshot] of retained.entries()) {
    assert.equal(cache.get(`connection-${index}`, snapshot.revision)?.revision, snapshot.revision);
  }
});

test('limits one connection to two leases without consuming global capacity', () => {
  let revision = 0;
  const cache = new UsageSnapshotCache({
    capacity: 4,
    createRevision: () => `revision-${++revision}`,
  });

  cache.reserve('connection-a');
  cache.reserve('connection-a');
  assert.throws(() => cache.reserve('connection-a'), UsageSnapshotCapacityError);

  assert.doesNotThrow(() => cache.reserve('connection-b'));
  assert.doesNotThrow(() => cache.reserve('connection-b'));
  assert.throws(() => cache.reserve('connection-c'), UsageSnapshotCapacityError);
});

test('enforces ownership and reclaims capacity on release and connection teardown', () => {
  let revision = 0;
  const cache = new UsageSnapshotCache({
    capacity: 2,
    createRevision: () => `revision-${++revision}`,
  });
  const first = completeReservation(cache, 'connection-a');
  completeReservation(cache, 'connection-b');

  assert.equal(cache.get('connection-b', first.revision), undefined);
  cache.release('connection-b', first.revision);
  assert.equal(cache.get('connection-a', first.revision)?.revision, first.revision);
  assert.throws(() => completeReservation(cache, 'connection-c'), UsageSnapshotCapacityError);

  cache.release('connection-a', first.revision);
  const third = completeReservation(cache, 'connection-c');
  assert.equal(cache.get('connection-c', third.revision)?.revision, third.revision);

  cache.releaseConnection('connection-b');
  const fourth = completeReservation(cache, 'connection-d');
  assert.equal(cache.get('connection-d', fourth.revision)?.revision, fourth.revision);
});

test('renews idle lifetime on owner access without extending the hard deadline', () => {
  let now = 0;
  const cache = new UsageSnapshotCache({
    now: () => now,
    ttlMs: 100,
    hardTtlMs: 250,
    createRevision: () => 'revision-1',
  });
  const retained = completeReservation(cache, 'connection-a');

  now = 90;
  assert.equal(cache.get('connection-a', retained.revision)?.revision, retained.revision);
  now = 180;
  assert.equal(cache.get('connection-a', retained.revision)?.revision, retained.revision);
  now = 249;
  assert.equal(cache.get('connection-a', retained.revision)?.revision, retained.revision);
  now = 250;
  assert.equal(cache.get('connection-a', retained.revision), undefined);
});

test('expires an idle lease before its hard deadline', () => {
  let now = 0;
  const cache = new UsageSnapshotCache({
    now: () => now,
    ttlMs: 100,
    hardTtlMs: 250,
    createRevision: () => 'revision-1',
  });
  const retained = completeReservation(cache, 'connection-a');

  now = 100;
  assert.equal(cache.get('connection-a', retained.revision), undefined);
});

test('pending reservations occupy capacity until their exact owner finalizes them', () => {
  let revision = 0;
  const cache = new UsageSnapshotCache({
    capacity: 4,
    createRevision: () => `revision-${++revision}`,
  });
  const reservations = Array.from({ length: 4 }, (_, index) =>
    cache.reserve(`connection-${index}`),
  );

  assert.throws(() => cache.reserve('connection-5'), UsageSnapshotCapacityError);
  for (const [index, reservation] of reservations.entries()) {
    assert.equal(cache.get(`connection-${index}`, reservation.revision), undefined);
  }

  const first = cache.finalize('connection-0', reservations[0]!.revision, CONTENTS);
  assert.equal(first?.revision, reservations[0]!.revision);
  assert.equal(cache.get('connection-0', reservations[0]!.revision)?.revision, first?.revision);
  assert.throws(() => cache.reserve('connection-5'), UsageSnapshotCapacityError);
});

test('abort, release, and connection teardown reclaim pending reservations', () => {
  let revision = 0;
  const cache = new UsageSnapshotCache({
    capacity: 2,
    createRevision: () => `revision-${++revision}`,
  });
  const first = cache.reserve('connection-a');
  const second = cache.reserve('connection-b');

  cache.release('connection-b', first.revision);
  assert.throws(() => cache.reserve('connection-c'), UsageSnapshotCapacityError);

  cache.abort('connection-a', first.revision);
  const third = cache.reserve('connection-c');
  cache.release('connection-b', second.revision);
  const fourth = cache.reserve('connection-d');

  cache.releaseConnection('connection-c');
  assert.equal(cache.finalize('connection-c', third.revision, CONTENTS), undefined);
  assert.equal(
    cache.finalize('connection-d', fourth.revision, CONTENTS)?.revision,
    fourth.revision,
  );
  assert.doesNotThrow(() => cache.reserve('connection-e'));
});

test('finalization never revives a wrong, released, or expired reservation', () => {
  let now = 0;
  let revision = 0;
  const cache = new UsageSnapshotCache({
    now: () => now,
    ttlMs: 100,
    hardTtlMs: 250,
    capacity: 2,
    createRevision: () => `revision-${++revision}`,
  });
  const exact = cache.reserve('connection-a');

  assert.equal(cache.finalize('connection-b', exact.revision, CONTENTS), undefined);
  assert.equal(cache.finalize('connection-a', 'missing-revision', CONTENTS), undefined);
  assert.equal(cache.get('connection-a', exact.revision), undefined);
  assert.equal(cache.finalize('connection-a', exact.revision, CONTENTS)?.revision, exact.revision);

  cache.release('connection-a', exact.revision);
  assert.equal(cache.finalize('connection-a', exact.revision, CONTENTS), undefined);

  const expiring = cache.reserve('connection-a');
  now = 100;
  assert.equal(cache.finalize('connection-a', expiring.revision, CONTENTS), undefined);
  assert.equal(cache.get('connection-a', expiring.revision), undefined);
});

function completeReservation(cache: UsageSnapshotCache, connectionId: string) {
  const reservation = cache.reserve(connectionId);
  const retained = cache.finalize(connectionId, reservation.revision, CONTENTS);
  assert.ok(retained);
  return retained;
}
