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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './host-fixture.js';
import * as Main from '../.artifacts/main-api.mjs';

for (const bundle of [false, true])
  test(`bundle=${bundle}: real Host package install and cross-Session tools: stale Todo → originals → other index → new evidence → removal`, async (t) => {
    const f = await fixture(bundle);
    t.after(() => f.close());
    const { sessions, invoke } = f;
    const first = await invoke('MemoryIndexCreate', {
      name: 'Candidate Todo',
      instructions: 'Unresolved potential follow-ups',
    });
    assert.equal(
      first.items.length,
      2,
      'imports other independent Sessions, not only the agent Session',
    );
    const ref = first.items.find((x: any) => x.session === 'chat-a').ref;
    await invoke('MemoryIndexCommit', {
      batchId: first.batchId,
      changes: [{ id: 'vendor', body: 'Contact vendor?', refs: [ref] }],
    });
    const timeline = await invoke('MemoryIndexCreate', {
      name: 'Timeline',
      instructions: 'Chronological events',
    });
    await invoke('MemoryIndexCommit', {
      batchId: timeline.batchId,
      changes: [{ id: 'discussion', body: 'Vendor discussed', refs: [ref] }],
    });
    assert.equal((await invoke('MemoryOriginal', { ref })).backlinks.length, 2);
    sessions.get('chat-b')!.push({
      id: 'c',
      type: 'user',
      text: 'Vendor contacted yesterday. No further contact needed.',
    });
    const current = await invoke('MemoryIndexRead', { indexId: first.index.id });
    assert.equal(current.items.length, 1);
    assert.match(current.items[0].text, /contacted yesterday/);
    assert.equal(
      current.entries.items[0].id,
      'vendor',
      'stale lead remains a lead until the agent judges the new evidence',
    );
    await invoke('MemoryIndexCommit', { batchId: current.batchId, remove: ['vendor'] });
    assert.equal((await invoke('MemoryIndexEntries', { indexId: first.index.id })).items.length, 0);
    assert.equal((await invoke('MemoryOriginal', { ref })).backlinks.length, 1);
    const unorganized = await invoke('MemoryIndexRead', { indexId: timeline.index.id });
    assert.equal(unorganized.items.length, 1);
    f.setIncognito(true);
    await assert.rejects(invoke('MemoryOriginal', { ref }), /Incognito/);
    await assert.rejects(invoke('MemoryIndexList', {}), /Incognito/);
  });

test('generic Recall history corpus is privacy guarded and excludes simulated/archived history', async () => {
  const deps = {
    getPrivacyContext: async () => ({ incognitoActive: true }),
    listSessions: async () => {
      throw Error('must not read history');
    },
  };
  await assert.rejects(Main.listRecallHistorySessions(deps, 'a'), /privacy|incognito/);
  await assert.rejects(
    Main.listRecallHistorySessions({ ...deps, getPrivacyContext: async () => ({}) }, 'a'),
    /privacy/,
  );
  const result = await Main.listRecallHistorySessions(
    {
      getPrivacyContext: async () => ({ incognitoActive: false }),
      listSessions: async () => [
        { id: 'real', backend: 'ai-sdk' },
        { id: 'simulated', backend: 'fake' },
        { id: 'archived', backend: 'ai-sdk', isArchived: true },
      ],
    },
    'real',
  );
  assert.deepEqual(
    result.map((s: any) => s.id),
    ['real'],
  );
});
