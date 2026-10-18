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
  eventWaitSourceKey,
  EVENT_WAIT_PAGE_LIMIT,
  normalizeEventWaitCommit,
  validateEventWaitRead,
  validateEventWaitPage,
  validateEventWaitStatusPage,
  validateEventWaitObservationList,
  validateEventWaitSource,
  validateEventWaitSourceCooldown,
  validateEventWaitSourceDispatch,
} from '../event-wait-authority.js';
import {
  type MemoryExecutionAuthority,
  type MemoryState,
  rows,
  equal,
} from './memory-execution-state.js';

interface SourceCooldown {
  until: number;
  dispatchToken: string | null;
  dispatchUntil: number;
}
const effectiveCooldown = (value: SourceCooldown): number =>
  Math.max(value.until, value.dispatchUntil);
function cleanSourceCooldowns(table: Map<string, SourceCooldown>, observedAt: number): void {
  const expired = [...table.entries()]
    .filter(([, value]) => effectiveCooldown(value) <= observedAt)
    .sort(
      ([a, av], [b, bv]) =>
        effectiveCooldown(av) - effectiveCooldown(bv) || (a < b ? -1 : a > b ? 1 : 0),
    )
    .slice(0, EVENT_WAIT_PAGE_LIMIT);
  for (const [key] of expired) table.delete(key);
}

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
    listByStatus(input) {
      check();
      validateEventWaitStatusPage(input);
      return authority.read((s) =>
        eventWaitPage(
          [...rows<EventWaitSnapshot>(s, 'eventWaits').values()]
            .filter(
              (v) =>
                v.record.status === input.status && v.record.waitId > (input.afterWaitId ?? ''),
            )
            .sort(compare)
            .slice(0, input.limit + 1),
          input.limit,
        ),
      );
    },
    listForObservation(input) {
      check();
      validateEventWaitObservationList(input);
      return authority.read((s) => {
        const dirty = new Set(input.dirtyWaitIds);
        const excludedWaits = new Set(input.excludedWaitIds);
        const excludedSources = new Set((input.excludedSources ?? []).map(eventWaitSourceKey));
        const cooldowns = rows<SourceCooldown>(s, 'eventWaitSourceCooldowns');
        return [...rows<EventWaitSnapshot>(s, 'eventWaits').values()]
          .filter(({ record }) => {
            if (
              record.status !== 'waiting' ||
              record.deadlineAt <= input.now ||
              record.waitId <= (input.scan?.afterWaitId ?? '') ||
              excludedWaits.has(record.waitId)
            )
              return false;
            const source = eventWaitSourceKey(record.resource);
            if (excludedSources.has(source)) return false;
            const cooldown = cooldowns.get(source);
            if (cooldown && effectiveCooldown(cooldown) > input.now) return false;
            const due = record.observation
              ? dirty.has(record.waitId)
                ? record.observation.nextObserveAt
                : record.observation.nextPollAt
              : record.createdAt;
            return due <= input.now;
          })
          .sort(
            input.scan
              ? compare
              : (a, b) =>
                  (a.record.observation?.lastAttemptAt ?? 0) -
                    (b.record.observation?.lastAttemptAt ?? 0) || compare(a, b),
          )
          .slice(0, input.limit);
      });
    },
    readSourceCooldown(input) {
      check();
      validateEventWaitSource(input);
      return authority.read((s) => {
        const value = rows<SourceCooldown>(s, 'eventWaitSourceCooldowns').get(
          eventWaitSourceKey(input),
        );
        return value ? effectiveCooldown(value) : null;
      });
    },
    extendSourceCooldown(input) {
      check();
      validateEventWaitSourceCooldown(input);
      return authority.write('eventWait.extendSourceCooldown', (s) => {
        const table = rows<SourceCooldown>(s, 'eventWaitSourceCooldowns');
        cleanSourceCooldowns(table, input.observedAt);
        const key = eventWaitSourceKey(input);
        const current = table.get(key) ?? { until: 0, dispatchToken: null, dispatchUntil: 0 };
        const next = { ...current, until: Math.max(current.until, input.until) };
        table.set(key, next);
        return next.until;
      });
    },
    reserveSourceDispatch(input) {
      check();
      validateEventWaitSourceDispatch(input);
      return authority.write('eventWait.reserveSourceDispatch', (s) => {
        const table = rows<SourceCooldown>(s, 'eventWaitSourceCooldowns');
        cleanSourceCooldowns(table, input.observedAt);
        const key = eventWaitSourceKey(input);
        const current = table.get(key) ?? { until: 0, dispatchToken: null, dispatchUntil: 0 };
        if (current.dispatchToken !== input.token && effectiveCooldown(current) > input.observedAt)
          return false;
        table.set(key, {
          ...current,
          dispatchToken: input.token,
          dispatchUntil: Math.max(current.dispatchUntil, input.until),
        });
        return true;
      });
    },
    completeSourceDispatch(input) {
      check();
      validateEventWaitSourceDispatch(input, true);
      return authority.write('eventWait.completeSourceDispatch', (s) => {
        const table = rows<SourceCooldown>(s, 'eventWaitSourceCooldowns');
        const key = eventWaitSourceKey(input);
        const current = table.get(key);
        if (!current) return 0;
        if (current.dispatchToken !== input.token) return effectiveCooldown(current);
        const next = {
          until: Math.max(current.until, input.until),
          dispatchToken: null,
          dispatchUntil: 0,
        };
        table.set(key, next);
        return effectiveCooldown(next);
      });
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
