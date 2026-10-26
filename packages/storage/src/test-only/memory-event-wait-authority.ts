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

import { createMemoryRuntimeStore } from './memory-execution-runtime.js';
import type { GoalAuthoritySnapshot } from '../goal-authority.js';
import type { RootTurnAdmission } from '../agent-run-store-contract.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { assertMemoryBridgeSession } from './memory-event-wait-bridge.js';
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
  key,
} from './memory-execution-state.js';

import {
  decodeConsumerEventWaitRecord,
  assertAnyEventWaitTransition,
  eventWaitConsumerKind,
  type ConsumerEventWaitRecord,
} from '@maka/core/event-wait';
import { readLogicalRuntimeExecution } from '@maka/core/runtime-logical-execution';
import type { ToolOperationRecord } from '../runtime-event-store-contract.js';
import {
  assertConsumerWaitRegistration,
  acknowledgeInvocationWait,
  retireInvocationWait,
  acknowledgeGoalWaitingAdmission,
  type EventWaitConsumerFacts,
} from '../event-wait-consumer.js';
import {
  anyEventWaitPage,
  normalizeAnyEventWaitCommit,
  validateAnyEventWaitPage,
  type AnyEventWaitSnapshot,
} from '../event-wait-authority.js';

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
  const runtime = createMemoryRuntimeStore(authority);
  let closed = false;
  const check = () => {
    if (closed) throw new Error('Memory event wait authority is closed');
  };
  const facts = (
    s: MemoryState,
    r: ConsumerEventWaitRecord,
    admissionTurnId?: string,
  ): EventWaitConsumerFacts => {
    const admission = rows<RootTurnAdmission>(s, 'rootAdmissions').get(
      key(r.sessionId, admissionTurnId ?? r.sourceTurnId),
    );
    if (admissionTurnId !== undefined) return { events: [], runTerminated: false, admission };
    const c = r.consumer;
    const operation =
      c.kind === 'tool_invocation'
        ? rows<ToolOperationRecord>(s, 'toolOperations').get(c.operationId)
        : undefined;
    const eventIds = new Set(
      c.kind === 'tool_invocation'
        ? [operation?.callEventId, operation?.dispatchEventId, operation?.resultEventId]
        : [c.completionEventId],
    );
    const runId = c.kind === 'tool_invocation' ? c.runId : c.sourceRunId;
    const selected: RuntimeEvent[] = [];
    let runTerminated = false;
    for (const event of rows<RuntimeEvent[]>(s, 'runtimeEvents').get(key(r.sessionId, runId)) ??
      []) {
      if (event.sessionId !== r.sessionId || event.runId !== runId) continue;
      if (eventIds.has(event.id)) selected.push(event);
      if (
        c.kind === 'tool_invocation' &&
        (event.actions?.endInvocation === true ||
          (event.status !== undefined &&
            ['completed', 'failed', 'cancelled', 'aborted'].includes(event.status)))
      )
        runTerminated = true;
    }
    return {
      events: selected,
      runTerminated,
      ...(operation ? { operation } : {}),
      admission,
      goal: rows<GoalAuthoritySnapshot>(s, 'goals').get(r.sessionId),
    };
  };
  const register = (
    record: ConsumerEventWaitRecord,
    prior?: RootTurnAdmission,
  ): AnyEventWaitSnapshot => {
    check();
    return authority.write('eventWait.registerConsumer', (s) => {
      assertMemoryBridgeSession(s, record.sessionId);
      const table = rows<AnyEventWaitSnapshot>(s, 'eventWaits'),
        old = table.get(record.waitId);
      if (old) {
        const fields = [
          'schemaVersion',
          'waitId',
          'sessionId',
          'sourceTurnId',
          'consumer',
          'resource',
          'condition',
          'deliveryKey',
          'createdAt',
          'deadlineAt',
        ] as const;
        if (
          old.record.schemaVersion !== 2 ||
          fields.some((k) => !equal((old.record as ConsumerEventWaitRecord)[k], record[k]))
        )
          throw new Error('Conflicting consumer wait registration');
        return old;
      }
      const current = facts(s, record);
      if (prior && !equal(prior, current.admission)) throw new Error('Root admission changed');
      assertConsumerWaitRegistration(record, current);
      for (const item of table.values()) {
        if (item.record.schemaVersion !== 2 || item.record.sessionId !== record.sessionId) continue;
        const a = item.record.consumer,
          b = record.consumer;
        if (
          (a.kind === 'tool_invocation' && b.kind === a.kind && a.operationId === b.operationId) ||
          (a.kind === 'goal_waiting' &&
            b.kind === a.kind &&
            equal(a.goalControlLease, b.goalControlLease) &&
            a.goalRevision === b.goalRevision)
        )
          throw new Error('Consumer already has a registered wait');
      }
      const snapshot = { authorityRevision: 0, record };
      table.set(record.waitId, snapshot);
      return snapshot;
    });
  };
  const update = (
    input: { sessionId: string; waitId: string },
    apply: (snapshot: AnyEventWaitSnapshot, facts: EventWaitConsumerFacts) => AnyEventWaitSnapshot,
    admissionTurnId?: string,
  ): AnyEventWaitSnapshot | null => {
    check();
    validateEventWaitRead({ sessionId: input.sessionId, waitId: input.waitId });
    return authority.write('eventWait.consume', (s) => {
      const table = rows<AnyEventWaitSnapshot>(s, 'eventWaits'),
        old = table.get(input.waitId);
      if (!old || old.record.sessionId !== input.sessionId) return null;
      if (old.record.schemaVersion !== 2) throw new Error('Expected consumer wait');
      const next = apply(old, facts(s, old.record, admissionTurnId));
      if (!Number.isSafeInteger(next.authorityRevision))
        throw new Error('Event wait revision exhausted');
      table.set(input.waitId, next);
      return next;
    });
  };
  return {
    readAny(input) {
      check();
      validateEventWaitRead(input);
      return authority.read((s) => {
        const snapshot = rows<AnyEventWaitSnapshot>(s, 'eventWaits').get(input.waitId);
        return snapshot?.record.sessionId === input.sessionId ? snapshot : null;
      });
    },
    listAny(input) {
      check();
      validateAnyEventWaitPage(input);
      return authority.read((s) =>
        anyEventWaitPage(
          [...rows<AnyEventWaitSnapshot>(s, 'eventWaits').values()]
            .filter(
              ({ record: r }) =>
                r.waitId > (input.afterWaitId ?? '') &&
                (input.sessionId === undefined || input.sessionId === r.sessionId) &&
                (input.status === undefined || input.status === r.status) &&
                (input.consumerKind === undefined ||
                  input.consumerKind === eventWaitConsumerKind(r)) &&
                (!input.deliveryOutstanding || !r.delivery),
            )
            .sort(compare)
            .slice(0, input.limit + 1),
          input.limit,
        ),
      );
    },
    commitAny(raw) {
      check();
      const input = normalizeAnyEventWaitCommit(raw);
      if (input.record.schemaVersion === 1) return this.commit({ ...input, record: input.record });
      return authority.write('eventWait.commitConsumer', (s) => {
        const header = rows<SessionHeaderSnapshot>(s, 'headers').get(input.sessionId);
        if (!header || header.header.isArchived || rows(s, 'tombstones').has(input.sessionId))
          return { kind: 'session_unavailable' };
        const table = rows<AnyEventWaitSnapshot>(s, 'eventWaits'),
          old = table.get(input.waitId);
        if (old && old.record.sessionId !== input.sessionId)
          throw new Error('Event wait ownership mismatch');
        if ((old?.authorityRevision ?? null) !== input.expectedAuthorityRevision)
          return {
            kind: 'revision_conflict',
            actualAuthorityRevision: old?.authorityRevision ?? null,
          };
        if (!old) throw new Error('Consumer waits require authenticated registration');
        if (!equal(old.record.delivery, input.record.delivery))
          throw new Error('Consumer delivery requires authenticated acknowledgement');
        assertAnyEventWaitTransition(old.record, input.record);
        if (equal(old.record, input.record)) return { kind: 'committed', snapshot: old };
        const snapshot = { authorityRevision: old.authorityRevision + 1, record: input.record };
        if (!Number.isSafeInteger(snapshot.authorityRevision))
          throw new Error('Event wait revision exhausted');
        table.set(input.waitId, snapshot);
        return { kind: 'committed', snapshot };
      });
    },
    async registerInvocationWait(input) {
      check();
      const record = decodeConsumerEventWaitRecord(input.record);
      if (record.consumer.kind !== 'tool_invocation')
        throw new Error('Expected invocation consumer');
      const prior = authority.read((s) =>
        rows<RootTurnAdmission>(s, 'rootAdmissions').get(
          key(record.sessionId, record.sourceTurnId),
        ),
      );
      if (!prior) throw new Error('Event wait has no Root admission');
      if (prior.runId !== record.consumer.runId) {
        const logical = await readLogicalRuntimeExecution(runtime, {
          sessionId: prior.sessionId,
          turnId: prior.turnId,
          runId: prior.runId,
        });
        if (!logical || logical.pendingHandoff || logical.tip.runId !== record.consumer.runId)
          throw new Error('Event wait is not the current logical execution');
      }
      return register(record, prior);
    },
    registerGoalWaitingWait(input) {
      check();
      const record = decodeConsumerEventWaitRecord(input.record);
      if (record.consumer.kind !== 'goal_waiting')
        throw new Error('Expected Goal waiting consumer');
      return register(record);
    },
    acknowledgeInvocationWaitResult(input) {
      return update(input, (snapshot, facts) => acknowledgeInvocationWait(snapshot, input, facts));
    },
    retireInvocationWait(input) {
      return update(input, (snapshot, facts) => retireInvocationWait(snapshot, input, facts));
    },
    acknowledgeGoalWaitingAdmission(input) {
      return update(
        input,
        (snapshot, facts) => acknowledgeGoalWaitingAdmission(snapshot, input, facts),
        input.turnId,
      );
    },
    read(input) {
      check();
      validateEventWaitRead(input);
      return authority.read((s) => {
        const snapshot = rows<EventWaitSnapshot>(s, 'eventWaits').get(input.waitId);
        return snapshot?.record.schemaVersion === 1 && snapshot.record.sessionId === input.sessionId
          ? snapshot
          : null;
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
                v.record.schemaVersion === 1 &&
                v.record.sessionId === input.sessionId &&
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
                v.record.schemaVersion === 1 &&
                v.record.status === input.status &&
                v.record.waitId > (input.afterWaitId ?? ''),
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
              record.schemaVersion !== 1 ||
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
    listAnyForObservation(input) {
      check();
      validateEventWaitObservationList(input);
      return authority.read((s) => {
        const dirty = new Set(input.dirtyWaitIds);
        const excludedWaits = new Set(input.excludedWaitIds);
        const excludedSources = new Set((input.excludedSources ?? []).map(eventWaitSourceKey));
        const cooldowns = rows<SourceCooldown>(s, 'eventWaitSourceCooldowns');
        return [...rows<AnyEventWaitSnapshot>(s, 'eventWaits').values()]
          .filter(({ record }) => {
            if (
              record.status !== 'waiting' ||
              (record.deadlineAt !== null && record.deadlineAt <= input.now) ||
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
function compare(a: AnyEventWaitSnapshot, b: AnyEventWaitSnapshot): number {
  return a.record.waitId < b.record.waitId ? -1 : a.record.waitId > b.record.waitId ? 1 : 0;
}
