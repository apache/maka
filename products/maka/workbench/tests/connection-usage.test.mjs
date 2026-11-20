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
import { invalidateUsageLimits, watchUsageLimits } from '../app/usageLimitsReading.ts';

const appRoot = new URL('../app/', import.meta.url);
const HOST_IDENTITY = Symbol.for('maka.hostIdentity');
const flush = () => new Promise((resolve) => setImmediate(resolve));

const ready = (usedPercent = 25) => ({
  kind: 'ready',
  limits: [{ kind: 'window', period: { kind: 'duration', seconds: 18000 }, usedPercent }],
});
const detail = (connectionId, revision, name, enabled = true) => ({
  kind: 'ready',
  enabled,
  name,
  target: { connectionId, revision },
});

test('shares in-flight reads, cached snapshots across bundles, and single refresh timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const conversationsMod = await import(new URL('usageLimitsReading.ts?b=conversations', appRoot));
  const settingsMod = await import(new URL('usageLimitsReading.ts?b=settings', appRoot));

  const application = {};
  const reads = [];
  const makeHost = () => ({
    [HOST_IDENTITY]: application,
    query: () => new Promise((resolve) => reads.push(resolve)),
  });
  const conversationsHost = makeHost();
  const settingsHost = makeHost();

  const composerObs = [];
  const settingsObs = [];
  const stopComposer = conversationsMod.watchUsageLimits(
    conversationsHost,
    { kind: 'external', runtime: 'antigravity' },
    (obs) => composerObs.push(obs),
  );
  // Concurrent mount from another plugin bundle coalesces onto the in-flight query.
  const stopSettings = settingsMod.watchUsageLimits(
    settingsHost,
    { kind: 'external', runtime: 'antigravity' },
    (obs) => settingsObs.push(obs),
  );
  assert.equal(reads.length, 1);

  reads.shift()(ready(34));
  await flush();
  assert.equal(composerObs.length, 1);
  assert.equal(settingsObs.length, 1);
  assert.equal(composerObs[0]?.sourceName, 'Antigravity');
  assert.deepEqual(settingsObs[0], composerObs[0]);

  // Re-subscribing within TTL (e.g. opening a new session) reuses the cached snapshot without querying.
  stopComposer();
  t.mock.timers.tick(15_000);
  const newSessionObs = [];
  const stopNewSession = conversationsMod.watchUsageLimits(
    conversationsHost,
    { kind: 'external', runtime: 'antigravity' },
    (obs) => newSessionObs.push(obs),
  );
  assert.equal(reads.length, 0);
  assert.deepEqual(newSessionObs, [composerObs[0]]);

  // Only one timer fires at the original 60s deadline, and slow reads do not overlap.
  t.mock.timers.tick(45_000);
  assert.equal(reads.length, 1);
  t.mock.timers.tick(120_000);
  assert.equal(reads.length, 1, 'a slow read must not overlap the next refresh');

  reads.shift()(ready(40));
  await flush();
  assert.equal(newSessionObs.at(-1)?.reading.result.limits[0].usedPercent, 40);

  // Unsubscribing all observers stops polling, keeps fresh cache, and refetches after TTL expiry.
  stopSettings();
  stopNewSession();
  t.mock.timers.tick(30_000);
  assert.equal(reads.length, 0);
  const warmObs = [];
  const stopWarm = conversationsMod.watchUsageLimits(
    conversationsHost,
    { kind: 'external', runtime: 'antigravity' },
    (obs) => warmObs.push(obs),
  );
  assert.equal(reads.length, 0);
  assert.equal(warmObs.at(-1)?.reading.result.limits[0].usedPercent, 40);
  stopWarm();

  t.mock.timers.tick(31_000);
  assert.equal(reads.length, 0);
  const expiredObs = [];
  const stopExpired = conversationsMod.watchUsageLimits(
    conversationsHost,
    { kind: 'external', runtime: 'antigravity' },
    (obs) => expiredObs.push(obs),
  );
  t.after(stopExpired);
  assert.equal(reads.length, 1);
  assert.equal(expiredObs.at(-1)?.reading.result.limits[0].usedPercent, 40);
  reads.shift()(ready(50));
  await flush();
  assert.equal(expiredObs.at(-1)?.reading.result.limits[0].usedPercent, 50);
});

test('invalidates stale connection revisions and ignores late responses from superseded generations', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = [];
  const host = { query: () => new Promise((resolve) => pending.push(resolve)) };
  const obs = [];

  const stopOld = watchUsageLimits(
    host,
    {
      kind: 'connection',
      connectionId: 'A',
      basis: { connectionId: 'A', revision: 1 },
      sourceName: 'Old',
    },
    (next) => obs.push(next),
  );
  const oldReply = pending.shift();

  // Higher revision invalidates the in-flight revision 1 request and broadcasts reset before refetching.
  const stopNew = watchUsageLimits(
    host,
    {
      kind: 'connection',
      connectionId: 'A',
      basis: { connectionId: 'A', revision: 2 },
      sourceName: 'Current',
    },
    (next) => obs.push(next),
  );
  t.after(() => {
    stopOld();
    stopNew();
  });
  assert.equal(pending.length, 1);
  assert.equal(obs.at(-1), null);

  pending.shift()(ready(25));
  await flush();
  oldReply(ready(90));
  await flush();
  assert.equal(obs.at(-1)?.sourceName, 'Current');
  assert.equal(obs.at(-1)?.reading.result.limits[0].usedPercent, 25);
});

test('retains last ready reading on refresh failure, recovers from superseded/disabled, and stops on unsupported', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  const replies = [
    detail('B', 1, 'Old'),
    ready(40),
    { kind: 'unavailable' },
    { kind: 'superseded' },
    detail('B', 2, 'New'),
    { kind: 'unavailable' },
    ready(15),
  ];
  const supObs = [];
  t.after(
    watchUsageLimits(
      { query: () => Promise.resolve(replies.shift()) },
      { kind: 'connection', connectionId: 'B' },
      (o) => supObs.push(o),
    ),
  );
  await flush();
  assert.equal(supObs.at(-1)?.sourceName, 'Old');

  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(supObs.at(-1)?.reading.refreshFailed, true);
  assert.equal(supObs.at(-1)?.reading.result.kind, 'ready');
  assert.equal(supObs.at(-1)?.sourceName, 'Old');

  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(supObs.at(-1)?.reading.result.kind, 'superseded');

  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(supObs.at(-1)?.reading.result.kind, 'ready');
  assert.equal(supObs.at(-1)?.sourceName, 'New');

  // Disabled connection recovers after re-enabling.
  let enabled = false;
  const disObs = [];
  t.after(
    watchUsageLimits(
      {
        query: (_e, m) =>
          Promise.resolve(m === 'connection' ? detail('C', 1, 'Acct C', enabled) : ready(30)),
      },
      { kind: 'connection', connectionId: 'C' },
      (o) => disObs.push(o),
    ),
  );
  await flush();
  assert.equal(disObs.at(-1)?.reading.result.kind, 'superseded');
  enabled = true;
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(disObs.at(-1)?.reading.result.kind, 'ready');

  // Unsupported target does not schedule further polling.
  let unsupportedQueries = 0;
  t.after(
    watchUsageLimits(
      {
        query: () => {
          unsupportedQueries++;
          return Promise.resolve({ kind: 'unsupported' });
        },
      },
      { kind: 'external', runtime: 'codex' },
      () => {},
    ),
  );
  await flush();
  t.mock.timers.tick(180_000);
  await flush();
  assert.equal(unsupportedQueries, 1);
});

test('invalidateUsageLimits recovers unsupported/credential updates and prunes expired idle entries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const identity = {};
  let extEnabled = false;
  let extCalls = 0;
  const makeHost = (query) => ({ [HOST_IDENTITY]: identity, query });

  // Re-enabling an external runtime invalidates cached unsupported and refetches active subscribers.
  const extHost = makeHost(() => {
    extCalls++;
    return Promise.resolve(extEnabled ? ready(20) : { kind: 'unsupported' });
  });
  const extObs = [];
  const stopExt = watchUsageLimits(extHost, { kind: 'external', runtime: 'antigravity' }, (o) =>
    extObs.push(o),
  );
  t.after(stopExt);
  await flush();
  assert.equal(extObs.at(-1)?.reading.result.kind, 'unsupported');

  extEnabled = true;
  invalidateUsageLimits(
    makeHost(() => Promise.reject(new Error('unused'))),
    {
      kind: 'external',
      runtime: 'antigravity',
    },
  );
  await flush();
  assert.equal(extCalls, 2);
  assert.equal(extObs.at(-1)?.reading.result.kind, 'ready');

  // Same-revision credential updates clear cached usage_credential_required immediately.
  let credReady = false;
  const connHost = makeHost(() =>
    Promise.resolve(credReady ? ready(15) : { kind: 'usage_credential_required' }),
  );
  const connTarget = {
    kind: 'connection',
    connectionId: 'cred-1',
    basis: { connectionId: 'cred-1', revision: 1 },
    sourceName: 'Cred',
  };
  watchUsageLimits(connHost, connTarget, () => {})();
  await flush();
  credReady = true;
  invalidateUsageLimits(connHost, { kind: 'connection', connectionId: 'cred-1' });
  const credObs = [];
  const stopCred = watchUsageLimits(connHost, connTarget, (o) => credObs.push(o));
  await flush();
  assert.equal(credObs.at(-1)?.reading.result.kind, 'ready');
  stopCred();

  // Expired idle entries are pruned on subsequent cache access.
  t.mock.timers.tick(61_000);
  const stopProbe = watchUsageLimits(connHost, { kind: 'external', runtime: 'codex' }, () => {});
  t.after(stopProbe);
  await flush();
  const entries = globalThis[Symbol.for('maka.usageLimitsStore')].get(identity);
  assert.equal(entries.has('connection:cred-1'), false);
});
