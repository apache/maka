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
import { ASSISTANT_BACKGROUND_SESSION_LABEL } from '@maka/core/session';
import { markAssistantBackgroundSessions } from '../assistant/background-sessions.js';

test('startup backfill preserves labels, skips deleted identities and is idempotent', async () => {
  const headers = new Map([
    ['worker', { labels: ['custom'], revision: 3 }],
    ['already', { labels: [ASSISTANT_BACKGROUND_SESSION_LABEL], revision: 4 }],
    ['ordinary', { labels: [], revision: 1 }],
  ]);
  let writes = 0;
  const store = {
    listHeaders: async () => [...headers.keys()].map((id) => ({ id })),
    readHeaderRecordSnapshot: async (id: string) => ({
      header: headers.get(id)!,
      revision: headers.get(id)!.revision,
    }),
    updateHeaderVersioned: async (id: string, patch: { labels: string[] }, revision: number) => {
      const old = headers.get(id)!;
      assert.equal(old.revision, revision);
      writes++;
      headers.set(id, { ...patch, revision: revision + 1 });
    },
  };
  for (let run = 0; run < 2; run++)
    await markAssistantBackgroundSessions(store, ['worker', 'worker', 'already', 'deleted']);
  assert.equal(writes, 1);
  assert.deepEqual(headers.get('worker')?.labels, ['custom', ASSISTANT_BACKGROUND_SESSION_LABEL]);
  assert.deepEqual(headers.get('ordinary')?.labels, []);
});
