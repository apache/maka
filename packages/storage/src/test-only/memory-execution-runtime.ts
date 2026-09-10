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

import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  isTerminalRuntimeEvent,
  type RuntimeEvent,
} from '@maka/core/runtime-event';
import {
  RunSealedError,
  RUNTIME_CONTINUATION_AUTHORITY_V1,
  type ContinuationClaimStateV1,
} from '@maka/core/runtime-event-store';
import {
  runtimeInvocationsFromSessionEvents,
  isSessionInlineInvocation,
} from '@maka/core/runtime-invocation';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import {
  buildImmutableRuntimePrefix,
  decodeContinuationClaim,
  continuationStartEventMatchesClaim,
  type ContinuationClaimV1,
  type ImmutableRuntimePrefixV1,
} from '@maka/core/runtime-boundary';
import { assertHandoffClaimSource } from '@maka/core/runtime-handoff';
import { WORKSPACE_AUTHORITY_SESSION_ID } from '@maka/core/workspace-version-authority';
import {
  validateToolLedgerTransition,
  scanToolLedger,
  ToolLedgerRejectionError,
  type ToolLedgerTransitionKind,
} from '@maka/core/tool-ledger-scanner';
import { interpretScannedToolRecovery } from '@maka/core/tool-recovery-bundle';
import type { ExecutionRuntimeEventWriter } from '../execution-stores.js';
import type {
  ToolOperationRecord,
  SessionRuntimeEventEntry,
} from '../runtime-event-store-contract.js';
import {
  assertPreparedInput,
  assertOutcomeInput,
  assertPreparedIdentity,
  assertOutcomeIdentity,
} from '../tool-commit-validation.js';
import { assertSafeId, assertNoReservedToolLedgerFact } from '../agent-run-store-contract.js';
import { assertNoReservedWorkspaceAuthorityAppend } from '../runtime-event-authority.js';
import { immutableSteeringMessageId } from '../runtime-event-invariants.js';
import {
  RuntimeTranscriptOversizedTurnError,
  type RuntimeTranscriptInvocation,
} from '../runtime-transcript-query.js';
import {
  partialRuntimeStream,
  completedPartialRuntimeStreamKey,
  mergeRuntimePartialSnapshots,
  type RuntimePartialSnapshot,
} from '../runtime-partial-values.js';
import { bounded } from './memory-execution-agent.js';
import {
  copy,
  equal,
  key,
  rows,
  type MemoryState,
  type MemoryExecutionAuthority,
} from './memory-execution-state.js';

const events = (s: MemoryState) => rows<RuntimeEvent[]>(s, 'runtimeEvents');
const partials = (s: MemoryState) => rows<RuntimePartialSnapshot>(s, 'runtimePartials');
const ordinals = (s: MemoryState) => rows<SessionRuntimeEventEntry[]>(s, 'runtimeOrdinals');
const claims = (s: MemoryState) => rows<ContinuationClaimStateV1>(s, 'continuationClaims');
const operations = (s: MemoryState) => rows<ToolOperationRecord>(s, 'toolOperations');
type ToolJournalEntry = {
  operationId: string;
  eventId: string;
  state: ToolOperationRecord['currentState'] | 'reconcile_observed';
  committedAt: number;
};

/** Reconstruct projections from canonical facts, inside the import transaction. */
function rebuildToolProjections(s: MemoryState, sessionId: string): void {
  const sessionEvents = allEvents(s)
    .filter((e) => e.sessionId === sessionId)
    .sort((a, b) => a.invocationId.localeCompare(b.invocationId));
  const scan = scanToolLedger(sessionEvents);
  if (scan.hasCorruption)
    throw new Error('Corrupt tool RuntimeEvent ledger: ' + scan.issues[0]?.code);
  const order = new Map(sessionEvents.map((e, i) => [e.id, i]));
  const journal = rows<ToolJournalEntry>(s, 'toolJournal');
  const committedAt = new Map([...journal.values()].map((j) => [j.eventId, j.committedAt]));
  const removed = new Set<string>();
  for (const [id, operation] of operations(s)) {
    if (operation.dispatchEventId && order.has(operation.callEventId)) {
      operations(s).delete(id);
      removed.add(id);
    }
  }
  for (const [id, entry] of journal) if (removed.has(entry.operationId)) journal.delete(id);
  for (const operation of scan.operations) {
    const event = operation.dispatchEvent;
    if (!event) continue;
    const dispatch = event.actions?.toolDispatch;
    const call = operation.callEvent;
    if (!dispatch || !call) throw new Error('Incomplete dispatched tool operation');
    const recovery = interpretScannedToolRecovery(operation, order);
    if (recovery.kind === 'corruption')
      throw new Error('Corrupt tool recovery bundle: ' + recovery.code);
    const response = operation.responseEvent;
    const decision = recovery.kind === 'valid' ? recovery.decision : undefined;
    const currentState = decision
      ? decision.disposition === 'completed'
        ? 'recovery_completed'
        : 'recovery_parked'
      : response
        ? 'outcome_committed'
        : 'prepared';
    const tail: Array<{ event: RuntimeEvent; state: ToolJournalEntry['state'] }> = [];
    if (recovery.kind === 'valid') {
      tail.push({ event: recovery.reconcileEvent, state: 'reconcile_observed' });
      tail.push({ event: recovery.decisionEvent, state: currentState });
    }
    if (response) tail.push({ event: response, state: 'outcome_committed' });
    tail.sort((a, b) => order.get(a.event.id)! - order.get(b.event.id)!);
    // Operation and journal identities are root-wide, not scoped to this copy.
    if (operations(s).has(dispatch.operationId))
      throw new Error('Tool operation identity conflict');
    operations(s).set(dispatch.operationId, {
      operationId: dispatch.operationId,
      invocationId: event.invocationId,
      runId: event.runId,
      turnId: event.turnId,
      providerToolCallId: dispatch.providerToolCallId,
      toolName: dispatch.toolName,
      canonicalArgsHash: dispatch.canonicalArgsHash,
      recoveryMode: dispatch.recoveryMode,
      currentState,
      callEventId: call.id,
      dispatchEventId: event.id,
      ...(response ? { resultEventId: response.id } : {}),
      version: 1 + tail.length,
    });
    for (const item of [{ event, state: 'prepared' as const }, ...tail]) {
      const id =
        item.state === 'prepared'
          ? `${dispatch.operationId}_prepared`
          : item.state === 'outcome_committed'
            ? `${dispatch.operationId}_outcome`
            : `${item.event.id}_journal`;
      if (journal.has(id)) throw new Error('Tool journal identity conflict');
      journal.set(id, {
        operationId: dispatch.operationId,
        eventId: item.event.id,
        state: item.state,
        committedAt: committedAt.get(item.event.id) ?? item.event.ts,
      });
    }
  }
}
function check(...ids: string[]) {
  for (const id of ids) assertSafeId(id, 'Invalid runtime identity');
}
function immutable(s: MemoryState, sessionId: string, runId: string) {
  check(sessionId, runId);
  return events(s).get(key(sessionId, runId)) ?? [];
}
function allEvents(s: MemoryState) {
  return [...events(s).values()].flat();
}
function transition(
  s: MemoryState,
  candidateEvents: RuntimeEvent[],
  expectedTransition: ToolLedgerTransitionKind,
) {
  const ids = new Set(candidateEvents.map((e) => e.invocationId));
  const validation = validateToolLedgerTransition({
    existingEvents: allEvents(s).filter((e) => ids.has(e.invocationId)),
    candidateEvents,
    expectedTransition,
  });
  if (!validation.ok) throw new ToolLedgerRejectionError(validation.code, validation.eventId);
}
function assertIdentity(s: MemoryState, event: RuntimeEvent) {
  check(event.id, event.sessionId, event.runId, event.invocationId, event.turnId);
  for (const existing of [...allEvents(s), ...[...partials(s).values()].map((p) => p.event)]) {
    if (
      existing.invocationId === event.invocationId &&
      (existing.sessionId !== event.sessionId ||
        existing.runId !== event.runId ||
        existing.turnId !== event.turnId)
    )
      throw new Error('RuntimeEvent invocation identity conflict');
    if (
      existing.sessionId === event.sessionId &&
      existing.runId === event.runId &&
      (existing.invocationId !== event.invocationId || existing.turnId !== event.turnId)
    )
      throw new Error('RuntimeEvent run identity conflict');
  }
}
function assertClaimAllows(
  s: MemoryState,
  event: RuntimeEvent,
  authorizedClaim?: string,
  exactRetry = false,
) {
  const own = [...claims(s).values()].find((c) =>
    equal(c.claim.target, {
      sessionId: event.sessionId,
      invocationId: event.invocationId,
      runId: event.runId,
      turnId: event.turnId,
    }),
  );
  for (const state of claims(s).values()) {
    const c = state.claim;
    if (
      c.boundary.segments.some(
        (p) => p.identity.sessionId === event.sessionId && p.identity.runId === event.runId,
      )
    ) {
      if (!exactRetry)
        throw new Error('RuntimeEvent source boundary is sealed by continuation claim');
      continue;
    }
    const t = c.target;
    const inherited =
      own?.claim.targetOpening.source.kind === 'handoff' &&
      own.claim.boundary.segments.some((p) => p.identity.runId === t.runId);
    if (
      !(
        event.invocationId === t.invocationId ||
        (event.sessionId === t.sessionId &&
          (event.runId === t.runId || (event.turnId === t.turnId && !inherited)))
      )
    )
      continue;
    if (
      !equal(t, {
        sessionId: event.sessionId,
        invocationId: event.invocationId,
        runId: event.runId,
        turnId: event.turnId,
      })
    )
      throw new Error('Continuation target identity conflict');
    if (!state.startEventId && authorizedClaim !== c.claimId)
      throw new Error('Target event one is reserved for continuation start');
  }
}
function insert(s: MemoryState, input: RuntimeEvent, authorizedClaim?: string): number {
  const event = encodeCanonicalRuntimeEvent(input).event;
  assertIdentity(s, event);
  const list = immutable(s, event.sessionId, event.runId);
  const existing = allEvents(s).find((e) => e.id === event.id);
  if (existing) {
    if (!equal(existing, event)) throw new Error('RuntimeEvent identity conflict: ' + event.id);
    assertClaimAllows(s, event, authorizedClaim, true);
    return list.findIndex((e) => e.id === event.id) + 1;
  }
  assertClaimAllows(s, event, authorizedClaim);
  if (list.some(isTerminalRuntimeEvent)) throw new RunSealedError(event.runId);
  const steering = immutableSteeringMessageId(event);
  if (
    steering &&
    allEvents(s).some(
      (e) => e.sessionId === event.sessionId && immutableSteeringMessageId(e) === steering,
    )
  )
    throw new Error('Immutable steering message identity conflict');
  list.push(event);
  events(s).set(key(event.sessionId, event.runId), list);
  const entries = ordinals(s).get(event.sessionId) ?? [];
  entries.push({ ordinal: entries.length + 1, event });
  ordinals(s).set(event.sessionId, entries);
  const completed = completedPartialRuntimeStreamKey(event);
  if (completed) partials(s).delete(completed);
  return list.length;
}
function append(s: MemoryState, input: RuntimeEvent) {
  const event = encodeCanonicalRuntimeEvent(input).event;
  assertNoReservedToolLedgerFact(event);
  assertIdentity(s, event);
  const stream = partialRuntimeStream(event),
    list = immutable(s, event.sessionId, event.runId);
  if (!stream) {
    transition(s, [event], 'generic_append');
    insert(s, event);
    return;
  }
  assertClaimAllows(s, event);
  if (list.some(isTerminalRuntimeEvent)) throw new RunSealedError(event.runId);
  const old = partials(s).get(stream.key);
  if (!old && list.some((e) => completedPartialRuntimeStreamKey(e) === stream.key)) return;
  const snapshot = old ?? { event: stream.snapshot, afterEventId: list.at(-1)?.id };
  if (snapshot.event.content?.kind === 'text' || snapshot.event.content?.kind === 'thinking')
    snapshot.event.content.text += stream.text;
  partials(s).set(stream.key, snapshot);
}
function prefix(
  s: MemoryState,
  input: { sessionId: string; runId: string; upToEventSeq?: number },
): ImmutableRuntimePrefixV1 {
  const list = immutable(s, input.sessionId, input.runId);
  const limit = input.upToEventSeq ?? list.length;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > list.length)
    throw new Error('immutable RuntimeEvent prefix high-water unavailable');
  const first = list[0]!;
  return buildImmutableRuntimePrefix(
    {
      sessionId: first.sessionId,
      invocationId: first.invocationId,
      runId: first.runId,
      turnId: first.turnId,
    },
    list.slice(0, limit).map((event, i) => ({ eventSeq: i + 1, event })),
  );
}
function assertBoundary(s: MemoryState, claim: ContinuationClaimV1) {
  let previous: ImmutableRuntimePrefixV1 | undefined;
  for (const [index, segment] of claim.boundary.segments.entries()) {
    const last = index === claim.boundary.segments.length - 1;
    const p = prefix(s, {
      sessionId: segment.identity.sessionId,
      runId: segment.identity.runId,
      ...(last ? {} : { upToEventSeq: segment.position.lastEventSeq }),
    });
    if (
      !equal(p.identity, segment.identity) ||
      !equal(p.position, segment.position) ||
      p.prefixDigest !== segment.prefixDigest
    )
      throw new Error('Continuation source boundary changed');
    const opening = p.events[0]?.content;
    if (
      previous?.identity.turnId === p.identity.turnId ||
      (opening?.kind === 'invocation_opened' && opening.source.kind === 'handoff')
    ) {
      if (!previous || opening?.kind !== 'invocation_opened' || opening.source.kind !== 'handoff')
        throw new Error('Same-turn boundary requires handoff');
      const source = opening.source;
      const state = [...claims(s).values()].find((c) => c.claim.claimId === source.claimId);
      if (
        !state ||
        state.startEventId !== p.events[0]!.id ||
        !equal(state.claim.boundary.segments, claim.boundary.segments.slice(0, index)) ||
        !continuationStartEventMatchesClaim(p.events[0], state.claim, state.startKind)
      )
        throw new Error('Unauthenticated handoff lineage');
      assertHandoffClaimSource(state.claim, previous);
    }
    if (last) {
      assertHandoffClaimSource(claim, p);
      if (
        p.events.filter(isTerminalRuntimeEvent).length !== 1 ||
        !isTerminalRuntimeEvent(p.events.at(-1)!)
      )
        throw new Error('Continuation source must end with exactly one terminal event');
    }
    previous = p;
  }
}
function transcript(
  s: MemoryState,
  sessionId: string,
  throughOrdinal = Number.MAX_SAFE_INTEGER,
): RuntimeTranscriptInvocation[] {
  check(sessionId);
  const entries = ordinals(s).get(sessionId) ?? [];
  return runtimeInvocationsFromSessionEvents(
    sessionId,
    entries.map((e) => e.event),
  )
    .filter((i) => isSessionInlineInvocation(i.opening) && i.terminalEvent)
    .map((invocation) => {
      const own = entries.filter((e) => e.event.invocationId === invocation.invocationId);
      return {
        invocation,
        firstOrdinal: own.find((e) => e.event.content?.kind === 'invocation_opened')!.ordinal,
        lastOrdinal: own.find((e) => e.event.id === invocation.terminalEvent!.id)!.ordinal,
        events: own.filter((e) => e.ordinal <= throughOrdinal),
      };
    })
    .filter((i) => i.lastOrdinal <= throughOrdinal)
    .sort((x, y) => x.firstOrdinal - y.firstOrdinal);
}
function limit(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256)
    throw new RangeError('Invocation limit must be between 1 and 256');
}
export function createMemoryRuntimeStore(a: MemoryExecutionAuthority): ExecutionRuntimeEventWriter {
  const start = (
    input: { claim: ContinuationClaimV1; event: RuntimeEvent },
    kind: 'runtime_admission' | 'claim_repair',
  ) =>
    a.write('runtime.continuationStart', (s) => {
      const claim = decodeContinuationClaim(copy(input.claim)),
        event = encodeCanonicalRuntimeEvent(input.event).event;
      assertNoReservedWorkspaceAuthorityAppend(event);
      if (!continuationStartEventMatchesClaim(event, claim, kind))
        throw new Error('Invalid continuation start event');
      const state = claims(s).get(claim.boundaryDigest);
      if (!state || !equal(state.claim, claim))
        throw new Error('Continuation start requires acquired claim');
      if (state.startEventId) {
        if (state.startEventId !== event.id || state.startKind !== kind)
          throw new Error('Continuation start identity conflict');
        return { created: false, runtimeEventSeq: insert(s, event, claim.claimId) };
      }
      const seq = insert(s, event, claim.claimId);
      if (seq !== 1) throw new Error('Continuation start must be event one');
      claims(s).set(claim.boundaryDigest, { claim, startEventId: event.id, startKind: kind });
      return { created: true, runtimeEventSeq: seq };
    });
  const store: ExecutionRuntimeEventWriter = {
    durability: 'canonical',
    toolBoundaryProtocol: TOOL_BOUNDARY_PROTOCOL_V1,
    continuationAuthorityCapability: RUNTIME_CONTINUATION_AUTHORITY_V1,
    appendRuntimeEvent: async (sessionId, runId, event) =>
      a.write('runtime.append', (s) => {
        if (event.sessionId !== sessionId || event.runId !== runId)
          throw new Error('Runtime append identity mismatch');
        append(s, event);
      }),
    appendRuntimePartialBatch: async (sessionId, runId, input) =>
      a.write('runtime.partials', (s) => {
        const streams = input.map((e) =>
          partialRuntimeStream(encodeCanonicalRuntimeEvent(e).event),
        );
        if (
          input.some(
            (e, i) =>
              e.sessionId !== sessionId ||
              e.runId !== runId ||
              !streams[i] ||
              streams[i]!.key !== streams[0]?.key,
          )
        )
          throw new Error('Partial batch must contain one presentation stream');
        for (const event of input) append(s, event);
      }),
    ensureTerminalRuntimeEventDurable: async (sessionId, runId, event) => {
      if (!isTerminalRuntimeEvent(event) || event.partial)
        throw new Error('Terminal writer requires immutable terminal event');
      await store.appendRuntimeEvent(sessionId, runId, event, { durable: true });
    },
    readRuntimeEvents: async (sessionId, runId) =>
      a.read((s) =>
        mergeRuntimePartialSnapshots(
          immutable(s, sessionId, runId),
          [...partials(s).values()].filter(
            (p) => p.event.sessionId === sessionId && p.event.runId === runId,
          ),
        ),
      ),
    readImmutableRuntimeEvents: async (sessionId, runId) =>
      a.read((s) => immutable(s, sessionId, runId)),
    readSessionRuntimeEventEntries: async (sessionId) =>
      a.read((s) => {
        check(sessionId);
        return ordinals(s).get(sessionId) ?? [];
      }),
    readSessionRuntimeEvents: async (sessionId) => {
      const all = a.read((s) =>
        [...events(s).values()]
          .flat()
          .concat([...partials(s).values()].map((p) => p.event))
          .filter((e) => e.sessionId === sessionId),
      );
      const runs = [...new Set(all.map((e) => e.runId))].sort();
      const result = (
        await Promise.all(runs.map((runId) => store.readRuntimeEvents(sessionId, runId)))
      ).flat();
      return result
        .map((event, index) => ({ event, index }))
        .sort(
          (x, y) =>
            x.event.ts - y.event.ts ||
            x.event.runId.localeCompare(y.event.runId) ||
            x.index - y.index,
        )
        .map((x) => x.event);
    },
    listSessionInvocations: async (sessionId) =>
      runtimeInvocationsFromSessionEvents(
        sessionId,
        (await store.readSessionRuntimeEventEntries(sessionId)).map((e) => e.event),
      ),
    readRunInvocation: async (sessionId, runId) =>
      (await store.listSessionInvocations(sessionId)).find((i) => i.runId === runId),
    readInvocation: async (sessionId, invocationId) => {
      const i = (await store.listSessionInvocations(sessionId)).find(
        (i) => i.invocationId === invocationId,
      );
      if (!i) throw new Error('Invocation not found');
      return i;
    },
    listSessionInvocationsBounded: async (sessionId, n) => {
      limit(n);
      const all = await store.listSessionInvocations(sessionId);
      return { invocations: all.slice(0, n), truncated: all.length > n };
    },
    listSessionInvocationsPage: async (sessionId, input) => {
      limit(input.limit);
      const all = (await store.listSessionInvocations(sessionId))
        .filter(
          (i) =>
            !input.before ||
            i.openedAt < input.before.openedAt ||
            (i.openedAt === input.before.openedAt && i.invocationId < input.before.invocationId),
        )
        .sort((x, y) => y.openedAt - x.openedAt || y.invocationId.localeCompare(x.invocationId));
      const invocations = all.slice(0, input.limit),
        last = invocations.at(-1);
      return {
        invocations,
        nextCursor:
          all.length > input.limit && last
            ? { openedAt: last.openedAt, invocationId: last.invocationId }
            : null,
      };
    },
    readRuntimeEventsBounded: async (sessionId, runId, budget) =>
      bounded(await store.readRuntimeEvents(sessionId, runId), budget),
    scanRuntimeEvents: async (sessionId, runId, budget, visit) => {
      const snapshot = await store.readRuntimeEvents(sessionId, runId);
      for (const value of Object.values(budget))
        if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid scan budget');
      const stable = bounded(
        snapshot.filter((e) => !e.partial),
        { maxRecords: budget.maxImmutableRecords, maxBytes: budget.maxImmutableBytes },
      );
      const mutable = bounded(
        snapshot.filter((e) => e.partial),
        { maxRecords: budget.maxPartialRecords, maxBytes: budget.maxPartialBytes },
      );
      if (
        stable.status === 'limit_exceeded' ||
        mutable.status === 'limit_exceeded' ||
        snapshot.some((e) => Buffer.byteLength(JSON.stringify(e)) > budget.maxRecordBytes)
      )
        return { status: 'limit_exceeded' };
      let batch: RuntimeEvent[] = [],
        bytes = 0;
      for (const e of snapshot) {
        const size = Buffer.byteLength(JSON.stringify(e));
        if (size > budget.maxBatchBytes) return { status: 'limit_exceeded' };
        if (bytes + size > budget.maxBatchBytes) {
          visit(copy(batch));
          batch = [];
          bytes = 0;
        }
        batch.push(e);
        bytes += size;
      }
      if (batch.length) visit(copy(batch));
      return { status: 'complete' };
    },
    importConversationCopyRuntimeEvents: async (sessionId, batches) =>
      a.write('runtime.import', (s) => {
        check(sessionId);
        const canonicalBatches = batches.map(({ runId, events }) => {
          check(runId);
          return { runId, events: events.map((e) => encodeCanonicalRuntimeEvent(e).event) };
        });
        const canonicalEvents = canonicalBatches.flatMap((b) => b.events);
        if (new Set(canonicalEvents.map((e) => e.id)).size !== canonicalEvents.length)
          throw new Error('Conversation copy contains duplicate RuntimeEvents');
        for (const batch of canonicalBatches)
          for (const event of batch.events) {
            if (event.sessionId !== sessionId || event.runId !== batch.runId || event.partial)
              throw new Error('Invalid copied runtime identity');
            assertNoReservedWorkspaceAuthorityAppend(event);
          }
        const scan = scanToolLedger(canonicalEvents);
        if (scan.hasCorruption)
          throw new Error(
            'Conversation copy RuntimeEvent ledger is corrupt: ' + scan.issues[0]?.code,
          );
        const byRun = new Map<string, RuntimeEvent[]>();
        for (const { runId, events } of canonicalBatches)
          byRun.set(runId, [...(byRun.get(runId) ?? []), ...events]);
        const newRuns = new Set<string>();
        for (const [runId, events] of byRun) {
          const existing = immutable(s, sessionId, runId);
          if (existing.length && !equal(existing, events))
            throw new Error('Conversation copy RuntimeEvent identity conflict for run ' + runId);
          if (!existing.length) newRuns.add(runId);
        }
        for (const { runId, events } of canonicalBatches)
          if (newRuns.has(runId)) for (const event of events) insert(s, event);
        if (
          canonicalEvents.some(
            (e) =>
              e.content?.kind === 'function_call' ||
              e.content?.kind === 'function_response' ||
              e.actions?.toolDispatch ||
              e.actions?.toolRecovery,
          )
        )
          rebuildToolProjections(s, sessionId);
      }),
    resequenceSessionEventOrdinals: async (sessionId) =>
      a.write('runtime.resequence', (s) => {
        const entries = ordinals(s).get(sessionId) ?? [];
        const opened = new Map(
          runtimeInvocationsFromSessionEvents(
            sessionId,
            entries.map((e) => e.event),
          ).map((i) => [i.invocationId, i.openedAt]),
        );
        entries.sort(
          (x, y) =>
            (opened.get(x.event.invocationId) ?? x.event.ts) -
              (opened.get(y.event.invocationId) ?? y.event.ts) ||
            x.event.invocationId.localeCompare(y.event.invocationId) ||
            x.ordinal - y.ordinal,
        );
        entries.forEach((e, i) => {
          entries[i] = { event: e.event, ordinal: i + 1 };
        });
      }),
    readImmutableSteeringMessageProof: async (sessionId, messageId) =>
      a.read((s) => {
        check(sessionId, messageId);
        const matches = allEvents(s).filter(
          (e) => e.sessionId === sessionId && immutableSteeringMessageId(e) === messageId,
        );
        if (matches.length > 1) throw new Error('Immutable steering identity conflict');
        return matches[0] ? { event: matches[0] } : undefined;
      }),
    repairImmutableSteeringMessageProofsForRecovery: async (sessionId) => {
      const events = (await store.readSessionRuntimeEventEntries(sessionId)).map((e) => e.event);
      const ids = events.map(immutableSteeringMessageId).filter(Boolean);
      if (new Set(ids).size !== ids.length) throw new Error('Immutable steering identity conflict');
    },
    readImmutableRuntimePrefix: async (input) => a.read((s) => prefix(s, input)),
    claimContinuation: async (input) =>
      a.write('runtime.claimContinuation', (s) => {
        const claim = decodeContinuationClaim(copy(input.claim));
        if (
          claim.target.sessionId === WORKSPACE_AUTHORITY_SESSION_ID ||
          claim.boundary.segments.some(
            (p) => p.identity.sessionId === WORKSPACE_AUTHORITY_SESSION_ID,
          )
        )
          throw new Error('Reserved workspace authority stream');
        assertBoundary(s, claim);
        const old = claims(s).get(claim.boundaryDigest);
        if (old) {
          if (!equal(old.claim.boundary, claim.boundary))
            throw new Error('Conflicting boundary digest');
          return { kind: 'existing', claim: old.claim };
        }
        const source = claim.boundary.segments.at(-1)!;
        const conflicting = [...claims(s).values()].find(({ claim: c }) => {
          const p = c.boundary.segments.at(-1)!;
          return (
            c.claimId === claim.claimId ||
            c.target.invocationId === claim.target.invocationId ||
            c.target.runId === claim.target.runId ||
            (claim.targetOpening.source.kind !== 'handoff' &&
              c.target.sessionId === claim.target.sessionId &&
              c.target.turnId === claim.target.turnId) ||
            (p.identity.sessionId === source.identity.sessionId &&
              p.identity.runId === source.identity.runId &&
              p.position.lastEventSeq === source.position.lastEventSeq)
          );
        });
        if (conflicting) return { kind: 'conflict', claim: conflicting.claim };
        if (
          [...allEvents(s), ...[...partials(s).values()].map((p) => p.event)].some(
            (e) =>
              e.invocationId === claim.target.invocationId ||
              (e.sessionId === claim.target.sessionId && e.runId === claim.target.runId),
          )
        )
          throw new Error('Continuation target ledger is not empty');
        claims(s).set(claim.boundaryDigest, { claim });
        return { kind: 'acquired', claim };
      }),
    readContinuationClaimByBoundary: async (id) =>
      (await store.readContinuationClaimStateByBoundary(id))?.claim,
    readContinuationClaimStateByBoundary: async (id) =>
      a.read((s) => {
        if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Invalid boundary digest');
        return claims(s).get(id);
      }),
    listContinuationClaimsForRecovery: async (sessionId) =>
      a.read((s) =>
        [...claims(s).values()]
          .filter((c) => c.claim.target.sessionId === sessionId)
          .sort(
            (x, y) =>
              x.claim.claimedAt - y.claim.claimedAt ||
              x.claim.claimId.localeCompare(y.claim.claimId),
          ),
      ),
    commitContinuationStart: async (input) => start(input, 'runtime_admission'),
    commitContinuationRepairStart: async (input) => start(input, 'claim_repair'),
    commitToolPrepared: async (value) =>
      a.write('runtime.toolPrepared', (s) => {
        const input = {
          ...copy(value),
          runtimeEvent: encodeCanonicalRuntimeEvent(value.runtimeEvent).event,
          dispatchRuntimeEvent: encodeCanonicalRuntimeEvent(value.dispatchRuntimeEvent).event,
        };
        assertNoReservedWorkspaceAuthorityAppend(input.runtimeEvent);
        assertNoReservedWorkspaceAuthorityAppend(input.dispatchRuntimeEvent);
        assertPreparedInput(input);
        transition(s, [input.runtimeEvent, input.dispatchRuntimeEvent], 't1_prepare');
        const old = operations(s).get(input.operationId);
        if (old) {
          assertPreparedIdentity(old, input);
          insert(s, input.runtimeEvent);
          return { created: false, runtimeEventSeq: insert(s, input.dispatchRuntimeEvent) };
        }
        if (input.dispatchRuntimeEvent.actions?.toolDispatch?.managedMutation)
          throw new Error('Managed mutation requires workspace authority binding');
        if (allEvents(s).some((e) => e.id === input.dispatchRuntimeEvent.id))
          throw new Error('Dispatch already exists outside tool transaction');
        insert(s, input.runtimeEvent);
        const seq = insert(s, input.dispatchRuntimeEvent);
        operations(s).set(input.operationId, {
          operationId: input.operationId,
          invocationId: input.runtimeEvent.invocationId,
          runId: input.runtimeEvent.runId,
          turnId: input.runtimeEvent.turnId,
          providerToolCallId: input.providerToolCallId,
          toolName: input.toolName,
          canonicalArgsHash: input.canonicalArgsHash,
          recoveryMode: input.recoveryMode,
          currentState: 'prepared',
          callEventId: input.runtimeEvent.id,
          dispatchEventId: input.dispatchRuntimeEvent.id,
          version: 1,
        });
        rows(s, 'toolJournal').set(input.journalEventId, {
          operationId: input.operationId,
          eventId: input.dispatchRuntimeEvent.id,
          state: 'prepared',
          committedAt: input.committedAt,
        });
        return { created: true, runtimeEventSeq: seq };
      }),
    commitToolOutcome: async (value) =>
      a.write('runtime.toolOutcome', (s) => {
        const input = {
          ...copy(value),
          runtimeEvent: encodeCanonicalRuntimeEvent(value.runtimeEvent).event,
        };
        assertNoReservedWorkspaceAuthorityAppend(input.runtimeEvent);
        assertOutcomeInput(input);
        const operation = operations(s).get(input.operationId);
        if (!operation) throw new Error('T2 requires prepared operation');
        assertOutcomeIdentity(operation, input.runtimeEvent);
        transition(s, [input.runtimeEvent], 't2_outcome');
        if (operation.resultEventId) {
          if (operation.resultEventId !== input.runtimeEvent.id)
            throw new Error('Tool outcome identity conflict');
          return { created: false, runtimeEventSeq: insert(s, input.runtimeEvent) };
        }
        const dispatch = allEvents(s).find((e) => e.id === operation.dispatchEventId)?.actions
          ?.toolDispatch;
        if (!dispatch) throw new Error('Tool dispatch missing');
        if (dispatch.managedMutation)
          throw new Error('Managed mutation outcome requires workspace authority writer');
        if (
          dispatch.resultProjectionVersion === 1 &&
          input.runtimeEvent.content?.kind === 'function_response' &&
          input.runtimeEvent.content.modelProjection === undefined
        )
          throw new Error('Model projection is required');
        const seq = insert(s, input.runtimeEvent);
        operations(s).set(input.operationId, {
          ...operation,
          currentState: 'outcome_committed',
          resultEventId: input.runtimeEvent.id,
          version: operation.version + 1,
        });
        rows(s, 'toolJournal').set(input.journalEventId, {
          operationId: input.operationId,
          eventId: input.runtimeEvent.id,
          state: 'outcome_committed',
          committedAt: input.committedAt,
        });
        return { created: true, runtimeEventSeq: seq };
      }),
    listUnsettledToolOperations: async (sessionId) =>
      a.read((s) =>
        [...operations(s).values()].filter(
          (o) =>
            o.currentState === 'prepared' &&
            allEvents(s).some((e) => e.id === o.callEventId && e.sessionId === sessionId),
        ),
      ),
    readTranscriptHighWater: async (sessionId) =>
      a.read((s) => {
        const all = transcript(s, sessionId);
        return all.length ? Math.max(...all.map((i) => i.lastOrdinal)) : null;
      }),
    readTranscriptInvocations: async (sessionId, request) =>
      a.read((s) => {
        const { direction, throughOrdinal, position, limit: n, maxEvents, maxBytes } = request;
        for (const value of [throughOrdinal, position, n, maxEvents, maxBytes])
          if (!Number.isSafeInteger(value) || value < 0)
            throw new RangeError('Invalid transcript bound');
        if (direction !== 'older' && direction !== 'newer')
          throw new Error('Invalid transcript direction');
        const all = transcript(s, sessionId, throughOrdinal);
        const selected = (
          direction === 'older'
            ? all
                .filter((i) => i.firstOrdinal <= position)
                .sort((x, y) => y.firstOrdinal - x.firstOrdinal)
            : all
                .filter((i) => i.lastOrdinal >= position)
                .sort((x, y) => x.lastOrdinal - y.lastOrdinal)
        ).slice(0, n);
        if (
          selected.some(
            (i) =>
              bounded(
                i.events.map((e) => e.event),
                { maxRecords: maxEvents, maxBytes },
              ).status === 'limit_exceeded',
          )
        )
          throw new RuntimeTranscriptOversizedTurnError('Transcript Turn exceeds budget');
        return selected.sort((x, y) => x.firstOrdinal - y.firstOrdinal);
      }),
    readTranscriptLandmarks: async (sessionId, throughOrdinal, n) =>
      a.read((s) => {
        if (!Number.isSafeInteger(throughOrdinal) || throughOrdinal < 0 || !Number.isSafeInteger(n))
          throw new RangeError('Invalid landmark bounds');
        if (n < 1) return [];
        const all = transcript(s, sessionId, throughOrdinal);
        const positions = new Set(
          Array.from({ length: Math.min(n, all.length) }, (_, i) =>
            n === 1 ? all.length - 1 : Math.floor((i * (all.length - 1)) / (n - 1)),
          ),
        );
        return [...positions]
          .map((i) => all[i]!)
          .map((i) => ({
            invocation: i.invocation,
            firstOrdinal: i.firstOrdinal,
            ...(i.events.find((e) => e.event.role === 'user' && e.event.content?.kind === 'text')
              ? {
                  prompt: i.events.find(
                    (e) => e.event.role === 'user' && e.event.content?.kind === 'text',
                  ),
                }
              : {}),
          }));
      }),
  };
  return store;
}
