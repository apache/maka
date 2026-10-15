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

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantNavigation, originalHost } from '../../renderer/features/personal-assistant/testing.js';
import { sessionMatchesRail } from '../../renderer/application/contracts/session-catalog/session-rail-visibility.js';

test('native assistant coalesces opening, reuses its conversation and matches the owning Host', async () => {
  let state: null | { sessionId: string } = null;
  let created = 0;
  let binds = 0;
  const id = JSON.stringify(['host-a', 'assistant']);
  const host = { hostId: 'host-a', profileId: 'profile-a' };
  const nav = createAssistantNavigation({
    host: async () => host,
    binding: async () => ({ state }),
    create: async () => {
      created++;
      return { id };
    },
    bind: async (target, sessionId) => {
      assert.deepEqual(target, host);
      binds++;
      return (state = { sessionId });
    },
    list: async () => [{ id: JSON.stringify(['host-b', 'assistant']) }, { id }],
  });
  assert.deepEqual(await Promise.all([nav.open(), nav.open()]), [id, id]);
  assert.equal(await nav.open(), id);
  assert.equal(created, 1);
  assert.equal(binds, 1);
});

test('switching Host during creation never binds the other Host session', async () => {
  let host = { hostId: 'host-a', profileId: 'a' };
  let binds = 0;
  const nav = createAssistantNavigation({
    host: async () => host,
    binding: async () => ({ state: null }),
    create: async () => {
      host = { hostId: 'host-b', profileId: 'b' };
      return { id: JSON.stringify(['host-b', 'created']) };
    },
    bind: async () => {
      binds++;
      return { sessionId: 'wrong' };
    },
    list: async () => [],
  });
  await assert.rejects(nav.open(), /Host/);
  assert.equal(binds, 0);
});

test('missing bound conversation is reported without creating a replacement', async () => {
  let created = 0;
  const nav = createAssistantNavigation({
    host: async () => ({ hostId: 'a', profileId: 'a' }),
    binding: async () => ({ state: { sessionId: 'missing' } }),
    create: async () => {
      created++;
      return { id: 'replacement' };
    },
    bind: async () => ({ sessionId: 'replacement' }),
    list: async () => [],
  });
  await assert.rejects(nav.open(), /找不到/);
  assert.equal(created, 0);
});

test('native assistant conversation stays out of rail without any plugin registration', () => {
  assert.equal(
    sessionMatchesRail({ id: 'assistant', labels: ['personal-assistant'] } as any),
    false,
  );
  assert.equal(sessionMatchesRail({ id: 'ordinary', labels: [] } as any), true);
});


test('original references follow the displayed Host instead of the default and never fall back', () => {
  const entries = [
    { hostId: 'host-a', enabled: true, profile: { id: 'default' } },
    { hostId: 'host-b', enabled: true, profile: { id: 'remote' } },
  ];
  assert.deepEqual(originalHost(JSON.stringify(['host-b', 'same-session']), entries), {
    host: { hostId: 'host-b', profileId: 'remote' }, sessionId: 'same-session',
  });
  assert.throws(() => originalHost('same-session', entries), /Host/);
  assert.throws(() => originalHost(JSON.stringify(['missing', 'same-session']), entries), /Host/);
  assert.throws(() => originalHost(JSON.stringify(['host-b', 'same-session']),
    entries.map(e => ({ ...e, enabled: e.hostId === 'host-a' }))), /Host/);
});


test('disabled Host rejects opening before creating a dedicated assistant conversation', async () => {
  let created = 0;
  const nav = createAssistantNavigation({
    host: async () => ({ hostId: 'host-a', profileId: 'profile-a' }),
    binding: async () => { throw Error('Personal assistant is disabled; enable it in Settings'); },
    create: async () => { created++; return { id: 'unexpected' }; },
    bind: async () => { throw Error('must not bind'); },
    list: async () => [],
  });
  await assert.rejects(nav.open(), /disabled/);
  assert.equal(created, 0);
});
