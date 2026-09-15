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
import type { SessionBackgroundActivity } from '@maka/core/session';
import { HostChangeFeed, type HostChangeFrame } from '../server/host-change-feed.js';
import { SessionBackgroundActivityProjection } from '../server/session-background-activity.js';

test('background work updates catalog-only clients and stays running across the supervisor handoff', () => {
  const graph = new Map<string, SessionBackgroundActivity>();
  const supervisor = new Map<string, SessionBackgroundActivity>();
  const feed = new HostChangeFeed();
  const frames: HostChangeFrame[] = [];
  feed.attachConnection(
    'sidebar-with-no-open-session',
    { sessionCatalog: true },
    {
      send: async (frame) => void frames.push(frame),
    },
  );
  const projection = new SessionBackgroundActivityProjection({
    graph: (id) => graph.get(id) ?? 'idle',
    supervisor: (id) => supervisor.get(id) ?? 'idle',
    publish: (id) => feed.publishSessionCatalog(id),
  });
  assert.equal(projection.read('parent'), 'idle');
  graph.set('parent', 'running');
  projection.changed('parent');
  // Token/tool/projection invalidations must not churn the catalog.
  for (let index = 0; index < 100; index += 1) projection.changed('parent');
  supervisor.set('parent', 'running');
  projection.changed('parent');
  graph.delete('parent');
  projection.changed('parent');
  assert.equal(projection.read('parent'), 'running');
  assert.equal(projection.read('unrelated-session'), 'idle');
  assert.deepEqual(frames, [{ kind: 'session.catalog.changed', revision: 1, sessionId: 'parent' }]);
  supervisor.delete('parent');
  projection.changed('parent');
  assert.equal(projection.read('parent'), 'idle');
  assert.deepEqual(frames.at(-1), {
    kind: 'session.catalog.changed',
    revision: 2,
    sessionId: 'parent',
  });
});

test('permission needs attention while automatic failure handling remains running', () => {
  let graph: SessionBackgroundActivity = 'blocked';
  let supervisor: SessionBackgroundActivity = 'running';
  const projection = new SessionBackgroundActivityProjection({
    graph: () => graph,
    supervisor: () => supervisor,
    publish: () => undefined,
  });
  assert.equal(projection.read('parent'), 'running', 'the supervisor can resolve a child failure');
  supervisor = 'waiting_for_user';
  assert.equal(projection.read('parent'), 'waiting_for_user');
  supervisor = 'idle';
  assert.equal(projection.read('parent'), 'blocked', 'exhausted recovery must not pulse forever');
  graph = 'idle';
  assert.equal(projection.read('parent'), 'idle');
});
