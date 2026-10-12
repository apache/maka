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

import { assertEventWaitTransition } from '@maka/core/event-wait';
import type { SessionHeaderSnapshot } from '../session-store-contract.js';
import {
  type EventWaitAuthorityRepository,
  type EventWaitSnapshot,
  eventWaitPage,
  normalizeEventWaitCommit,
  validateEventWaitRead,
  validateEventWaitPage,
} from '../event-wait-authority.js';
import {
  type MemoryExecutionAuthority,
  type MemoryState,
  rows,
  equal,
} from './memory-execution-state.js';

export function deleteMemoryEventWaits(state: MemoryState, sessionId: string): void {
  const table = rows<EventWaitSnapshot>(state, 'eventWaits');
  for (const [key, snapshot] of table)
    if (snapshot.record.sessionId === sessionId) table.delete(key);
}
/** Independent copy-on-write reference; facts survive only this provider object's process lifetime. */
export function createMemoryEventWaitAuthority(
  authority: MemoryExecutionAuthority,
): EventWaitAuthorityRepository {
  let closed = false;
  const check = () => {
    if (closed) throw new Error('Memory event wait authority is closed');
  };
  return {
    read(input) {
      check();
      validateEventWaitRead(input);
      return authority.read((s) => {
        const snapshot = rows<EventWaitSnapshot>(s, 'eventWaits').get(input.waitId);
        return snapshot?.record.sessionId === input.sessionId ? snapshot : null;
      });
    },
    listSession(input) {
      check();
      validateEventWaitPage(input, true);
      return authority.read((s) =>
        eventWaitPage(
          [...rows<EventWaitSnapshot>(s, 'eventWaits').values()]
            .filter(
              (v) =>
                v.record.sessionId === input.sessionId &&
                v.record.waitId > (input.afterWaitId ?? ''),
            )
            .sort(compare)
            .slice(0, input.limit + 1),
          input.limit,
        ),
      );
    },
    listPending(input) {
      check();
      validateEventWaitPage(input);
      return authority.read((s) =>
        eventWaitPage(
          [...rows<EventWaitSnapshot>(s, 'eventWaits').values()]
            .filter(
              (v) =>
                (v.record.status === 'waiting' || v.record.status === 'resolved') &&
                v.record.waitId > (input.afterWaitId ?? ''),
            )
            .sort(compare)
            .slice(0, input.limit + 1),
          input.limit,
        ),
      );
    },
    commit(raw) {
      check();
      const input = normalizeEventWaitCommit(raw);
      return authority.write('eventWait.commit', (s) => {
        const session = rows<SessionHeaderSnapshot>(s, 'headers').get(input.sessionId);
        if (!session || session.header.isArchived || rows(s, 'tombstones').has(input.sessionId))
          return { kind: 'session_unavailable' };
        const table = rows<EventWaitSnapshot>(s, 'eventWaits');
        const current = table.get(input.waitId);
        if (current && current.record.sessionId !== input.sessionId)
          throw new TypeError('Event wait ownership mismatch');
        if ((current?.authorityRevision ?? null) !== input.expectedAuthorityRevision)
          return {
            kind: 'revision_conflict',
            actualAuthorityRevision: current?.authorityRevision ?? null,
          };
        if (current) {
          assertEventWaitTransition(current.record, input.record);
          if (equal(current.record, input.record)) return { kind: 'committed', snapshot: current };
        } else if (input.record.status !== 'waiting')
          throw new TypeError('Event waits must be created waiting');
        if (input.record.status === 'waiting' || input.record.status === 'resolved') {
          for (const other of table.values()) {
            if (
              other.record.sessionId === input.sessionId &&
              other.record.waitId !== input.waitId &&
              (other.record.status === 'waiting' || other.record.status === 'resolved')
            )
              return { kind: 'active_wait_conflict', waitId: other.record.waitId };
          }
        }
        const authorityRevision = (current?.authorityRevision ?? -1) + 1;
        if (!Number.isSafeInteger(authorityRevision))
          throw new TypeError('Event wait revision exhausted');
        const snapshot = { authorityRevision, record: input.record };
        table.set(input.waitId, snapshot);
        return { kind: 'committed', snapshot };
      });
    },
    close() {
      closed = true;
    },
  };
}
// JS relational comparison matches SQLite BINARY for the bounded ASCII wait IDs.
function compare(a: EventWaitSnapshot, b: EventWaitSnapshot): number {
  return a.record.waitId < b.record.waitId ? -1 : a.record.waitId > b.record.waitId ? 1 : 0;
}
