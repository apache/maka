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
import { HostChangeFeed } from '../server/host-change-feed.js';

test('routes each change kind only to subscribed connections', () => {
  const feed = new HostChangeFeed();
  const configuration: unknown[] = [];
  const project: unknown[] = [];
  const all: unknown[] = [];
  feed.attachConnection(
    'configuration',
    { configuration: true },
    { send: async (frame) => void configuration.push(frame) },
  );
  feed.attachConnection(
    'project',
    { projectCatalog: true },
    { send: async (frame) => void project.push(frame) },
  );
  feed.attachConnection(
    'all',
    { configuration: true, projectCatalog: true, sessionCatalog: true, scheduledTask: true },
    { send: async (frame) => void all.push(frame) },
  );

  feed.publishConfiguration();
  feed.publishProjectCatalog();
  feed.publishSessionCatalog('session-1');
  feed.publishScheduledTask(7, 'updated', 'task-1');

  assert.deepEqual(
    configuration.map((frame) => (frame as { kind: string }).kind),
    ['configuration.changed'],
  );
  assert.deepEqual(
    project.map((frame) => (frame as { kind: string }).kind),
    ['project.catalog.changed'],
  );
  assert.equal(all.length, 4);
});

test('keeps catalog revisions independent and removes failed subscriptions', async () => {
  const feed = new HostChangeFeed();
  const frames: unknown[] = [];
  feed.attachConnection(
    'working',
    { projectCatalog: true, sessionCatalog: true },
    { send: async (frame) => void frames.push(frame) },
  );
  feed.attachConnection(
    'failed',
    { projectCatalog: true },
    {
      send: async () => {
        throw new Error('closed');
      },
    },
  );

  feed.publishProjectCatalog();
  feed.publishSessionCatalog('session-1');
  await Promise.resolve();
  feed.publishProjectCatalog();

  assert.deepEqual(
    frames.map((frame) => (frame as { kind: string; revision: number }).revision),
    [1, 1, 2],
  );
});
