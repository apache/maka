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

import type { RuntimeEvent } from './runtime-event.js';
import type { RuntimeInvocationRecord } from './runtime-invocation.js';
import type {
  ContinuationClaimV1,
  ImmutableRuntimePrefixV1,
  RuntimeBoundaryDigest,
} from './runtime-boundary.js';
import type {
  WorkspaceEpochRecordV1,
  WorkspaceHeadRecordV1,
  WorkspaceProjectionRebuildResult,
  WorkspaceVersionRecordV1,
} from './workspace-version-authority.js';
import { WORKSPACE_VERSION_AUTHORITY_CAPABILITY_V1 } from './workspace-version-authority.js';

export const TOOL_RECOVERY_BUNDLE_CAPABILITY_V1 = 'tool_recovery_bundle_v1' as const;
export const RUNTIME_CONTINUATION_AUTHORITY_V1 = 'runtime_continuation_authority_v1' as const;

export interface RuntimeRecoveryBundleCommit {
  operationId: string;
  reconcileRuntimeEvent: RuntimeEvent;
  outcomeRuntimeEvent?: RuntimeEvent;
  decisionRuntimeEvent: RuntimeEvent;
}

/**
 * An append arrived after the run's terminal fact was already written. The
 * refusal is the store doing its job: once a run has said it ended, a late
 * stream event is by definition not part of it. Typed so callers can tell
 * this expected boundary apart from store failure (#2311): pressing stop
 * seals the run ahead of the still-draining stream, and the stragglers that
 * window refuses must not read as "the store is sick".
 */
export class RunSealedError extends Error {
  readonly name = 'RunSealedError';

  constructor(readonly runId: string) {
    super(`RuntimeEvent run ${runId} is sealed by its terminal fact`);
  }
}

/** A requested stable-storage barrier failed; read-back cannot upgrade it to success. */
export class DurableStoreWriteError extends Error {
  readonly name = 'DurableStoreWriteError';

  constructor(
    message: string,
    readonly storeCause: unknown,
  ) {
    super(message);
  }
}

export interface RuntimeEventStore {
  /** Canonical stores fail the active run closed on every durable write error. */
  readonly durability?: 'best_effort' | 'canonical';
  /**
   * Enumerate a Session's invocations from the canonical events.
   *
   * This is a query, not a table. Nothing writes it and nothing repairs it, so
   * clearing any physical index and rebuilding from the events produces the
   * same inventory. Reserved control-plane invocation streams have no opening
   * fact and therefore never appear here.
   *
   * One exception, and it is a durable one: an invocation that predates the
   * opening fact could not be given one without rewriting an immutable
   * sequence, so a store that migrated such a Session keeps that opening
   * outside the events and merges it in here. Those invocations cannot be
   * rebuilt from events alone, and never will be.
   *
   * An invocation's `terminalEvent` is its first terminal event. Sealing makes
   * that the only one for anything written through this interface; a ledger
   * from before the seal can carry a straggler after it, and the ending is
   * still the terminal event.
   */
  listSessionInvocations(sessionId: string): Promise<RuntimeInvocationRecord[]>;
  /**
   * One invocation by run id, absent when no opening fact names it. A store
   * that indexes openings answers this in one read; stores without the fast
   * path are answered from the inventory by `readRunInvocation`.
   */
  readRunInvocation?(
    sessionId: string,
    runId: string,
  ): Promise<RuntimeInvocationRecord | undefined>;
  /**
   * Append one event to a run.
   *
   * Every implementation seals: once a run holds a terminal event, appending
   * any event the store does not already have must throw `RunSealedError`. An
   * exact-id replay of an event already stored stays idempotent. This is what
   * makes a run's ending single and final, so it is an obligation of this
   * interface rather than a detail of one store — a test double that skips it
   * is manufacturing a ledger no supported store can produce. Tests that need a
   * corrupt ledger should build it beneath this interface, not through it.
   */
  appendRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
    options?: { durable?: boolean },
  ): Promise<void>;
  /**
   * Coalesce one already-admitted mutable presentation stream into one store
   * transaction. Callers must preserve provider order and flush before every
   * immutable execution boundary. Stores that do not implement this optional
   * fast path continue to receive one append per partial event. The seal on
   * `appendRuntimeEvent` applies here too.
   */
  appendRuntimePartialBatch?(
    sessionId: string,
    runId: string,
    events: readonly RuntimeEvent[],
  ): Promise<void>;
  /**
   * Append the terminal event if absent, or re-establish its stable-storage
   * barrier if present. This is the one writer the seal admits: it must commit
   * the terminal event and the seal check in the same transaction, so two
   * callers racing to end one run produce one terminal event and a
   * `RunSealedError` for the loser.
   */
  ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void>;
  readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  /** Session-wide immutable append order. */
  readSessionRuntimeEventEntries(
    sessionId: string,
  ): Promise<Array<{ readonly ordinal: number; readonly event: RuntimeEvent }>>;
  /** Physical append-log rows only; excludes mutable partial snapshots. */
  readImmutableRuntimeEvents?(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  /** Versioned physical prefix with event-seq high-water and canonical digest. */
  readImmutableRuntimePrefix?(input: {
    sessionId: string;
    runId: string;
    upToEventSeq?: number;
  }): Promise<ImmutableRuntimePrefixV1>;
  readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]>;
}

/** One invocation by run id, through the store's fast path when it has one. */
export async function readRunInvocation(
  store: Pick<RuntimeEventStore, 'listSessionInvocations' | 'readRunInvocation'>,
  sessionId: string,
  runId: string,
): Promise<RuntimeInvocationRecord | undefined> {
  if (store.readRunInvocation) return store.readRunInvocation(sessionId, runId);
  return (await store.listSessionInvocations(sessionId)).find(
    (invocation) => invocation.runId === runId,
  );
}

export interface RuntimeRecoveryBundleStore extends RuntimeEventStore {
  readonly recoveryBundleCapability: typeof TOOL_RECOVERY_BUNDLE_CAPABILITY_V1;
  commitToolRecoveryBundle(input: RuntimeRecoveryBundleCommit): Promise<void>;
}

export type ContinuationClaimResult =
  | { kind: 'acquired'; claim: ContinuationClaimV1 }
  | { kind: 'existing'; claim: ContinuationClaimV1 }
  | { kind: 'conflict'; claim: ContinuationClaimV1 };

export interface ContinuationClaimStateV1 {
  claim: ContinuationClaimV1;
  startEventId?: string;
  /** Store-owned classification of the narrow command that committed event 1. */
  startKind?: 'runtime_admission' | 'claim_repair';
}

export interface RuntimeContinuationAuthorityStore extends RuntimeEventStore {
  readonly continuationAuthorityCapability: typeof RUNTIME_CONTINUATION_AUTHORITY_V1;
  readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readImmutableRuntimePrefix(input: {
    sessionId: string;
    runId: string;
    upToEventSeq?: number;
  }): Promise<ImmutableRuntimePrefixV1>;
  claimContinuation(input: { claim: ContinuationClaimV1 }): Promise<ContinuationClaimResult>;
  readContinuationClaimByBoundary(
    boundaryDigest: RuntimeBoundaryDigest,
  ): Promise<ContinuationClaimV1 | undefined>;
  readContinuationClaimStateByBoundary(
    boundaryDigest: RuntimeBoundaryDigest,
  ): Promise<ContinuationClaimStateV1 | undefined>;
  listContinuationClaimsForRecovery(sessionId: string): Promise<ContinuationClaimStateV1[]>;
  commitContinuationStart(input: {
    claim: ContinuationClaimV1;
    event: RuntimeEvent;
  }): Promise<{ created: boolean; runtimeEventSeq: number }>;
  commitContinuationRepairStart(input: {
    claim: ContinuationClaimV1;
    event: RuntimeEvent;
  }): Promise<{ created: boolean; runtimeEventSeq: number }>;
}

export interface RuntimeWorkspaceVersionAuthorityStore extends RuntimeEventStore {
  readonly workspaceVersionAuthorityCapability: typeof WORKSPACE_VERSION_AUTHORITY_CAPABILITY_V1;
  readWorkspaceEpoch(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceEpochRecordV1 | undefined>;
  readWorkspaceVersion(workspaceVersionId: string): Promise<WorkspaceVersionRecordV1 | undefined>;
  readWorkspaceHead(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceHeadRecordV1 | undefined>;
  rebuildWorkspaceVersionProjections(): Promise<WorkspaceProjectionRebuildResult>;
}
