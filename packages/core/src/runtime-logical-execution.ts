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
  continuationStartEventMatchesClaim,
  createRuntimeBoundaryCursor,
  invocationMatchesClaimTarget,
  runtimePrefixSegment,
  type ImmutableRuntimePrefixProofV1,
  type ImmutableRuntimePrefixV1,
  type RuntimePrefixSegmentV1,
} from './runtime-boundary.js';
import type { RuntimeEvent } from './runtime-event.js';
import {
  readRunInvocation,
  type RuntimeContinuationAuthorityStore,
} from './runtime-event-store.js';
import type { RuntimeInvocationRecord } from './runtime-invocation.js';
import {
  assertHandoffClaimSource,
  runtimeHandoffPause,
  type RuntimeHandoffPause,
} from './runtime-handoff.js';

export interface LogicalRuntimeExecution {
  /** Original admission identity; callers continue to validate its domain owner. */
  readonly root: RuntimeInvocationRecord;
  /** Latest authenticated physical attempt, never a new logical admission. */
  readonly tip: RuntimeInvocationRecord;
  readonly events: readonly RuntimeEvent[];
  /** Authenticated physical membership, including the original admission. */
  readonly runIds: readonly string[];
  /** Durable intent exists but the successor has not opened yet. */
  readonly pendingHandoff?: RuntimeHandoffPause;
}

export type LogicalRuntimeExecutionMembership = Omit<LogicalRuntimeExecution, 'events'>;

type LogicalExecutionAuthorityReader = Pick<
  RuntimeContinuationAuthorityStore,
  'readRunInvocation' | 'listSessionInvocations' | 'readContinuationClaimStateByBoundary'
>;

export type LogicalExecutionMembershipReader = LogicalExecutionAuthorityReader & {
  readImmutableRuntimePrefixProof(input: {
    sessionId: string;
    runId: string;
    upToEventSeq?: number;
  }): Promise<ImmutableRuntimePrefixProofV1>;
};

type LogicalExecutionReader = LogicalExecutionAuthorityReader &
  Pick<
    RuntimeContinuationAuthorityStore,
    'readImmutableRuntimeEvents' | 'readImmutableRuntimePrefix'
  >;

export function readLogicalRuntimeExecution(
  store: LogicalExecutionReader,
  identity: { sessionId: string; runId: string; turnId: string },
  knownRoot?: RuntimeInvocationRecord,
): Promise<LogicalRuntimeExecution | undefined>;
export function readLogicalRuntimeExecution(
  store: LogicalExecutionMembershipReader,
  identity: { sessionId: string; runId: string; turnId: string },
  knownRoot: RuntimeInvocationRecord | undefined,
  options: { mode: 'membership' },
): Promise<LogicalRuntimeExecutionMembership | undefined>;

/** All logical snapshot and command routing paths share these edge checks. */
export async function readLogicalRuntimeExecution(
  store: LogicalExecutionReader | LogicalExecutionMembershipReader,
  identity: { sessionId: string; runId: string; turnId: string },
  knownRoot?: RuntimeInvocationRecord,
  options?: { mode: 'membership' },
): Promise<LogicalRuntimeExecution | LogicalRuntimeExecutionMembership | undefined> {
  const membership = options?.mode === 'membership';
  const root = knownRoot ?? (await readRunInvocation(store, identity.sessionId, identity.runId));
  if (!root) return undefined;
  if (
    root.sessionId !== identity.sessionId ||
    root.runId !== identity.runId ||
    root.turnId !== identity.turnId ||
    root.opening.source.kind === 'handoff'
  ) {
    throw new Error('Logical execution reference does not name its original admission');
  }
  let tip = root;
  let segments: RuntimePrefixSegmentV1[] | undefined;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(tip.runId) || seen.size >= 64)
      throw new Error('Invalid logical execution handoff lineage');
    seen.add(tip.runId);
    const events = membership
      ? undefined
      : await (store as LogicalExecutionReader).readImmutableRuntimeEvents(
          identity.sessionId,
          tip.runId,
        );
    const last = membership ? tip.terminalEvent : events?.at(-1);
    const pause = last && runtimeHandoffPause(last);
    if (!pause) return logicalExecutionResult(root, tip, [...seen], events);
    if (pause.rootRunId !== root.runId) throw new Error('Handoff seal changes the logical root');
    const prefix = membership
      ? await (store as LogicalExecutionMembershipReader).readImmutableRuntimePrefixProof({
          sessionId: identity.sessionId,
          runId: tip.runId,
        })
      : await (store as LogicalExecutionReader).readImmutableRuntimePrefix({
          sessionId: identity.sessionId,
          runId: tip.runId,
        });
    const segment = runtimePrefixSegment(prefix);
    if (prefix.position.lastEventId !== last.id)
      throw new Error('Handoff source changed after its seal');
    if (!segments) {
      // A manual continuation may itself become a handoff root. Preserve its
      // earlier replay boundary without treating those earlier Turns as this Turn.
      const source = root.opening.source;
      if (source.kind === 'continuation') {
        if (!source.boundaryDigest)
          throw new Error('Handoff requires authenticated source lineage');
        const initial = await store.readContinuationClaimStateByBoundary(source.boundaryDigest);
        if (
          !initial ||
          initial.startEventId !== prefixFirstEvent(prefix).id ||
          !invocationMatchesClaimTarget(root, initial.claim) ||
          !continuationStartEventMatchesClaim(
            prefixFirstEvent(prefix),
            initial.claim,
            initial.startKind,
          )
        ) {
          throw new Error('Handoff root continuation is not authenticated');
        }
        segments = [...initial.claim.boundary.segments];
      } else segments = [];
    }
    segments.push(segment);
    const boundary = createRuntimeBoundaryCursor(
      segments as [RuntimePrefixSegmentV1, ...RuntimePrefixSegmentV1[]],
    );
    let state = await store.readContinuationClaimStateByBoundary(boundary.manifestDigest);
    const next = await readRunInvocation(store, identity.sessionId, pause.successorRunId);
    // A start can commit between the two reads. Authority is monotonic; refresh
    // it once when the later opening read proves the earlier snapshot was old.
    if (next && !state?.startEventId) {
      state = await store.readContinuationClaimStateByBoundary(boundary.manifestDigest);
    }
    if (!state) {
      if (next) throw new Error('Handoff successor opened without its continuation claim');
      return logicalExecutionResult(root, tip, [...seen], events, pause);
    }
    assertHandoffClaimSource(state.claim, prefix);
    if (!next) {
      if (state.startEventId) throw new Error('Handoff successor opening is missing');
      return logicalExecutionResult(root, tip, [...seen], events, pause);
    }
    const first = membership
      ? prefixFirstEvent(
          await (store as LogicalExecutionMembershipReader).readImmutableRuntimePrefixProof({
            sessionId: identity.sessionId,
            runId: next.runId,
            upToEventSeq: 1,
          }),
        )
      : (
          await (store as LogicalExecutionReader).readImmutableRuntimeEvents(
            identity.sessionId,
            next.runId,
          )
        )[0];
    if (
      state.startEventId !== first?.id ||
      !invocationMatchesClaimTarget(next, state.claim) ||
      !continuationStartEventMatchesClaim(first, state.claim, state.startKind)
    ) {
      throw new Error('Handoff successor does not match its authenticated start');
    }
    tip = next;
  }
}

function prefixFirstEvent(
  prefix: ImmutableRuntimePrefixV1 | ImmutableRuntimePrefixProofV1,
): RuntimeEvent {
  const first =
    prefix.protocol === 'immutable_runtime_prefix_v1' ? prefix.events[0] : prefix.firstEvent;
  if (!first) throw new Error('immutable RuntimeEvent prefix is empty');
  return first;
}

function logicalExecutionResult(
  root: RuntimeInvocationRecord,
  tip: RuntimeInvocationRecord,
  runIds: readonly string[],
  events?: readonly RuntimeEvent[],
  pendingHandoff?: RuntimeHandoffPause,
): LogicalRuntimeExecution | LogicalRuntimeExecutionMembership {
  const result = { root, tip, runIds, ...(pendingHandoff ? { pendingHandoff } : {}) };
  return events ? { ...result, events } : result;
}

/** Resolve a durable physical proof back to its root, then authenticate membership. */
export async function readLogicalRuntimeExecutionForRun(
  store: LogicalExecutionReader,
  identity: { sessionId: string; runId: string; turnId: string },
): Promise<LogicalRuntimeExecution | undefined> {
  const run = await readRunInvocation(store, identity.sessionId, identity.runId);
  if (!run) return undefined;
  const rootRunId =
    run.opening.source.kind === 'handoff' ? run.opening.source.rootRunId : run.runId;
  const logical = await readLogicalRuntimeExecution(store, { ...identity, runId: rootRunId });
  if (!logical?.runIds.includes(identity.runId)) {
    throw new Error('Physical proof is not an authenticated member of its logical execution');
  }
  return logical;
}
