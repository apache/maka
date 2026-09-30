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

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  SESSION_REMOVE_PREVIEW_MAX_ITEMS,
  type SessionRemovePreviewResult,
} from '@maka/runtime-host/protocol';
import { createSessionRemovalPreviewReader } from '../../preload/session-removal-preview.js';

/** Desktop ids read `<host>:<id>`; each page answers one of everything per task. */
function reader(options: { failHost?: string; unreachable?: string } = {}) {
  const queries: Array<{ host: string; ids: readonly string[] }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const preview = createSessionRemovalPreviewReader<string>({
    resolve: async (sessionId) => {
      const [host = '', id = ''] = sessionId.split(':');
      if (host === options.unreachable) {
        throw new Error('The Runtime Host for this task is unavailable');
      }
      return { scope: host, scopeKey: host, sessionId: id };
    },
    query: async (host, ids): Promise<SessionRemovePreviewResult> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      queries.push({ host, ids: [...ids] });
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      if (host === options.failHost) throw new Error('persistence_failed');
      return {
        archivableSubtaskCount: ids.length,
        removedSubtaskCount: 2 * ids.length,
        worktreeCount: 3 * ids.length,
        bytes: 100 * ids.length,
      };
    },
  });
  return { preview, queries, maxInFlight: () => maxInFlight };
}

test('pages a large selection per Host into bounded requests and sums them', async () => {
  const { preview, queries, maxInFlight } = reader();
  const onA = Array.from(
    { length: SESSION_REMOVE_PREVIEW_MAX_ITEMS * 2 + 3 },
    (_, index) => `a:session-${index}`,
  );
  const onB = ['b:one', 'b:two'];
  const total = onA.length + onB.length;

  assert.deepEqual(await preview([...onA, ...onB, onA[0]!]), {
    archivableSubtaskCount: total,
    removedSubtaskCount: 2 * total,
    worktreeCount: 3 * total,
    bytes: 100 * total,
  });
  assert.deepEqual(
    queries.map((query) => [query.host, query.ids.length]),
    [
      ['a', SESSION_REMOVE_PREVIEW_MAX_ITEMS],
      ['a', SESSION_REMOVE_PREVIEW_MAX_ITEMS],
      ['a', 3],
      ['b', 2],
    ],
  );
  // Host-local ids, each asked about once, one request at a time.
  assert.deepEqual(queries[3]?.ids, ['one', 'two']);
  assert.equal(new Set(queries.flatMap((query) => query.ids)).size, total);
  assert.equal(maxInFlight(), 1);
});

test('rejects rather than report a partial preview', async () => {
  await assert.rejects(reader({ failHost: 'b' }).preview(['a:one', 'b:two']), /persistence_failed/);
  await assert.rejects(
    reader({ unreachable: 'b' }).preview(['a:one', 'b:two']),
    /Runtime Host for this task is unavailable/,
  );
});
