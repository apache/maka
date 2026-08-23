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

import { createHash } from 'node:crypto';
import type {
  CommitMemoryExtractionRequest,
  MemoryExtractionCursor,
  MemoryExtractionFailureClass,
  MemoryExtractionReceipt,
  MemoryItemWrite,
  PendingMemoryExtractionFailure,
  SettleMemoryExtractionFailureRequest,
  SettleMemoryExtractionFailureResult,
} from '@maka/core/long-term-memory';
import { redactSecrets } from '@maka/core/redaction';
import type { SessionHeader } from '@maka/core/session';
import { z } from 'zod';
import {
  fitMemoryExtractionEvidence,
  bindProviderVisibleEvidence,
  isMemoryToolName,
  planMemoryCoverage,
  projectMemoryExtractionEvidence,
  renderMemoryLocalizationContext,
  searchSameSessionMemoryHistory,
  type MemoryExtractionEventEntry,
  type MemoryCoveragePlan,
} from './memory-extraction-evidence.js';
import {
  admitMemoryProposalItemDetailed,
  buildFirstMemoryProposalPrompt,
  buildLocalizedMemoryProposalPrompt,
  buildMemoryCanonicalizationPrompt,
  deterministicMemoryPolicyRejection,
  minuteTimestamp,
  parseMemoryCanonicalization,
  parseLocalizedMemoryProposal,
  parseMemoryProposal,
  type AdmittedProposalFields,
  type MemoryProposalItem,
} from './memory-extraction-proposal.js';
import { isHistoryCompactContentEvent } from './history-compact.js';
import {
  isTextHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  renderHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import type { ModelMessage, ModelToolSet } from './model-protocol.js';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';

export const MEMORY_REMEMBER_TOOL_NAME = 'memory_remember';
export const MEMORY_EXTRACT_TOOL_NAME = 'memory_extract';
export type MemoryExtractionTrigger = 'remember' | 'extract' | 'compaction';
export type MemoryExtractionGate =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'disabled' | 'incognito' | 'ineligible' | 'unavailable';
    };

/** Frozen extraction request. Compaction may defer durable-prefix materialization to its lane. */
export interface MemoryExtractionSourceSnapshot {
  readonly trigger: MemoryExtractionTrigger;
  readonly sourceHeader: Pick<SessionHeader, 'llmConnectionSlug' | 'model' | 'thinkingLevel'>;
  readonly sourceSystemPrompt?: string;
  readonly sourceMessages: readonly ModelMessage[];
  /** Compaction-only recipe: rebuild messages from its durable checkpoint boundary. */
  readonly rebuildSourceContextFromCompactionCheckpoint?: true;
  /** RuntimeEvent-to-message positions in the frozen provider prefix. */
  readonly sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>;
  readonly sourceTools: ModelToolSet;
  readonly sourceActiveTools: readonly string[];
  readonly sourceProviderOptions?: Record<string, unknown>;
  readonly sourceMaxOutputTokens?: number;
  /** Frozen model input capacity used for deterministic auxiliary-request preflight. */
  readonly sourceContextWindowTokens?: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly workspaceKey: string;
  /** Present only for memory_remember; identifies the call excluded from evidence. */
  readonly toolCallId?: string;
  /** Present only for post-terminal memory_extract. */
  readonly terminalEventId?: string;
  /** Present only for automatic Compaction extraction. */
  readonly compactionCheckpointId?: string;
  /** Exact durable RuntimeEvent boundary captured by the Compaction checkpoint. */
  readonly compactionBoundaryEventId?: string;
}

export interface MemoryCompactionSourceContext {
  readonly messages: readonly ModelMessage[];
  readonly eventMessagePositions?: Readonly<Record<string, readonly number[]>>;
}

interface RememberedMemoryItem {
  readonly itemId: string;
  readonly content: string;
}

export type MemoryRememberResult =
  | { readonly status: 'remembered'; readonly requestedItems: readonly RememberedMemoryItem[] }
  | {
      readonly status: 'not_applicable';
      readonly requestedItems: readonly [];
      readonly reason?: 'sensitive_information';
    }
  | {
      readonly status: 'unavailable';
      readonly requestedItems: readonly [];
      readonly reason?: 'provider_unsupported';
    };

export interface MemoryExtractionSourceCapabilities {
  readonly gate: () => Promise<MemoryExtractionGate>;
  /** Synchronous policy snapshot frozen with the backend; never performs I/O. */
  readonly automaticGate?: () => MemoryExtractionGate;
  readonly remember: (snapshot: MemoryExtractionSourceSnapshot) => Promise<MemoryRememberResult>;
  readonly extract: (snapshot: MemoryExtractionSourceSnapshot) => void;
}

export interface MemoryExtractionEnginePorts {
  readonly readGate: (sessionId: string) => Promise<MemoryExtractionGate>;
  readonly readSessionEvents: (sessionId: string) => Promise<readonly MemoryExtractionEventEntry[]>;
  readonly readCursor: (sessionId: string) => Promise<MemoryExtractionCursor | undefined>;
  readonly initializeCursor: (
    sessionId: string,
    processedOrdinal: number,
  ) => Promise<MemoryExtractionCursor>;
  readonly readPendingFailure: (
    sessionId: string,
  ) => Promise<PendingMemoryExtractionFailure | undefined>;
  readonly recordCompactionPolicyDenial: (input: {
    readonly sessionId: string;
    readonly compactionCheckpointId: string;
    readonly deniedAt: number;
  }) => Promise<unknown>;
  readonly readCompactionPolicyDenials: (
    sessionId: string,
  ) => Promise<readonly { readonly compactionCheckpointId: string }[]>;
  readonly readLatestCompactionCheckpoint: (
    sessionId: string,
  ) => Promise<HistoryCompactCheckpoint | undefined>;
  readonly readCompactionCheckpoints: (
    sessionId: string,
  ) => Promise<readonly HistoryCompactCheckpoint[]>;
  readonly readReceipt: (operationId: string) => Promise<MemoryExtractionReceipt | undefined>;
  readonly generate: (input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly prompt: string;
    readonly stage: 'proposal' | 'localized' | 'canonicalize';
    readonly abortSignal: AbortSignal;
  }) => Promise<
    | { readonly ok: true; readonly text: string }
    | {
        readonly ok: false;
        readonly errorClass:
          | 'aborted'
          | 'timeout'
          | 'configuration'
          | 'provider'
          | 'persistence'
          | 'unknown';
      }
  >;
  readonly commit: (request: CommitMemoryExtractionRequest) => Promise<{
    readonly receipt: MemoryExtractionReceipt;
  }>;
  readonly settleFailure: (
    request: SettleMemoryExtractionFailureRequest,
  ) => Promise<SettleMemoryExtractionFailureResult>;
  readonly now?: () => number;
}

/** Keep most of a small context window available for the bounded source slice. */
export function memoryExtractionMaxOutputTokens(
  snapshot: Pick<
    MemoryExtractionSourceSnapshot,
    'sourceMaxOutputTokens' | 'sourceContextWindowTokens'
  >,
): number {
  const configured = Math.max(1, snapshot.sourceMaxOutputTokens ?? 2_048);
  return snapshot.sourceContextWindowTokens === undefined
    ? configured
    : Math.min(configured, Math.max(1, Math.floor(snapshot.sourceContextWindowTokens / 6)));
}

/**
 * Build the attachment-free normalized history used by automatic extraction and crash recovery.
 * RuntimeEvents remain the evidence authority; this projection is context only.
 */
export function buildMemoryCompactionSourceContext(
  events: readonly MemoryExtractionEventEntry['event'][],
  boundaryEventId: string,
  options: {
    readonly afterEventId?: string;
    readonly previousCheckpoint?: HistoryCompactCheckpoint;
  } = {},
): MemoryCompactionSourceContext | undefined {
  const boundaryIndex = events.findIndex((event) => event.id === boundaryEventId);
  if (boundaryIndex < 0) return undefined;
  const afterIndex = options.afterEventId
    ? events.findIndex((event) => event.id === options.afterEventId)
    : -1;
  if (options.afterEventId && afterIndex < 0) return undefined;
  if (afterIndex >= boundaryIndex) return undefined;
  const messages: ModelMessage[] = [];
  const positions: Record<string, number[]> = {};
  const push = (eventId: string | undefined, message: ModelMessage): void => {
    const index = messages.length;
    messages.push(message);
    if (eventId) (positions[eventId] ??= []).push(index);
  };
  // Provider checkpoints are opaque transport state, not Memory evidence.
  // Their covered RuntimeEvents remain the durable interpretation source.
  if (options.previousCheckpoint && isTextHistoryCompactCheckpoint(options.previousCheckpoint)) {
    push(undefined, {
      role: 'user',
      content: [{ type: 'text', text: renderHistoryCompactCheckpoint(options.previousCheckpoint) }],
    });
  }
  for (const event of events.slice(afterIndex + 1, boundaryIndex + 1)) {
    if (event.partial || event.content?.kind !== 'text') continue;
    if (event.role === 'user' && event.author === 'user') {
      push(event.id, { role: 'user', content: [{ type: 'text', text: event.content.text }] });
      continue;
    }
    if (event.role === 'model' && event.author === 'agent') {
      push(event.id, { role: 'assistant', content: [{ type: 'text', text: event.content.text }] });
    }
  }
  // Tool calls/results, Thinking, attachment metadata/bytes, quotes, and provider-native
  // metadata are intentionally outside the portable Memory interpretation context.
  return {
    messages: structuredClone(messages),
    ...(Object.keys(positions).length > 0 ? { eventMessagePositions: positions } : {}),
  };
}

const MAX_MEMORY_EXTRACTION_MODEL_CALLS = 3;

type CoverageProcessingResult =
  | {
      readonly kind: 'committed';
      readonly receipt: MemoryExtractionReceipt;
      readonly nextCursorOrdinal: number;
    }
  | {
      readonly kind: 'counted_failure';
      readonly failureClass: MemoryExtractionFailureClass;
      readonly failedTrigger?: MemoryExtractionTrigger;
      readonly failedOperationId?: string;
      readonly failedExpectedCursorOrdinal?: number;
      readonly failedThroughOrdinal?: number;
      readonly coverageHash?: string;
    }
  | { readonly kind: 'blocked' };

interface MemoryModelCallBudget {
  remaining: number;
}

export function buildMemoryExtractionTriggerTools(input: {
  readonly capabilities: MemoryExtractionSourceCapabilities;
  readonly snapshot: (
    trigger: MemoryExtractionTrigger,
    context: MakaToolContext,
  ) => MemoryExtractionSourceSnapshot | undefined;
  readonly markExtractRequested: (context: MakaToolContext) => void;
  readonly unsupportedReason?: 'provider_unsupported';
}): readonly MakaTool[] {
  const noArguments = z.object({}).strict();
  return [
    {
      name: MEMORY_REMEMBER_TOOL_NAME,
      description:
        'Use only when the user explicitly asks you to remember long-term information. It stores the requested memory and returns exactly what was saved.',
      parameters: noArguments,
      executionSemantics: 'exclusive_step',
      recoveryMode: 'idempotent',
      impl: async (_args: Record<string, never>, context: MakaToolContext) => {
        const gate = await input.capabilities.gate();
        if (!gate.allowed) return { status: 'unavailable', requestedItems: [] };
        if (input.unsupportedReason) {
          return {
            status: 'unavailable',
            reason: input.unsupportedReason,
            requestedItems: [],
          };
        }
        const snapshot = input.snapshot('remember', context);
        if (!snapshot) return { status: 'unavailable', requestedItems: [] };
        return input.capabilities.remember(snapshot);
      },
    },
    {
      name: MEMORY_EXTRACT_TOOL_NAME,
      description:
        'Use when the conversation contains durable long-term information worth preserving and the user did not explicitly ask to remember it. The extraction runs after this turn.',
      parameters: noArguments,
      recoveryMode: 'idempotent',
      impl: async (_args: Record<string, never>, context: MakaToolContext) => {
        const gate = await input.capabilities.gate();
        if (!gate.allowed) return { status: 'unavailable' };
        if (input.unsupportedReason) {
          return { status: 'unavailable', reason: input.unsupportedReason };
        }
        input.markExtractRequested(context);
        return { status: 'accepted' };
      },
    },
  ];
}

/** Runtime-owned bounded state machine. Host supplies authority and lifecycle ports only. */
export class MemoryExtractionEngine {
  constructor(private readonly ports: MemoryExtractionEnginePorts) {}

  async execute(snapshot: MemoryExtractionSourceSnapshot): Promise<MemoryRememberResult> {
    if (!validSourceContextContract(snapshot)) return unavailableMemoryResult();
    const operationId = memoryExtractionOperationId(snapshot);
    if (!operationId) return unavailableMemoryResult();
    if (!(await this.allowedOrSettleCompaction(snapshot, operationId))) {
      return unavailableMemoryResult();
    }

    const existing = await this.ports.readReceipt(operationId);
    if (existing) return rememberResultFromReceipt(snapshot.trigger, existing);

    if (!(await this.allowedOrSettleCompaction(snapshot, operationId))) {
      return unavailableMemoryResult();
    }
    const entries = await this.ports.readSessionEvents(snapshot.sessionId);
    const compactionCheckpoints = await this.ports.readCompactionCheckpoints(snapshot.sessionId);
    const policyDeniedCheckpointIds = new Set(
      (await this.ports.readCompactionPolicyDenials(snapshot.sessionId)).map(
        ({ compactionCheckpointId }) => compactionCheckpointId,
      ),
    );
    const currentCompactionCheckpoint =
      snapshot.trigger === 'compaction'
        ? compactionCheckpoints.find(
            (checkpoint) => checkpoint.checkpointId === snapshot.compactionCheckpointId,
          )
        : undefined;
    if (
      snapshot.trigger === 'compaction' &&
      (!currentCompactionCheckpoint ||
        !compactionCheckpointMatchesSnapshot([currentCompactionCheckpoint], snapshot))
    ) {
      return unavailableMemoryResult();
    }
    const boundary = currentCompactionCheckpoint
      ? compactionBoundaryEntry(entries, currentCompactionCheckpoint)
      : findExtractionBoundary(entries, snapshot);
    if (!boundary) return unavailableMemoryResult();
    if (
      currentCompactionCheckpoint &&
      isPolicyDeniedCheckpoint(currentCompactionCheckpoint, policyDeniedCheckpointIds)
    ) {
      await this.settlePolicyDeniedCheckpoint(snapshot, currentCompactionCheckpoint, entries);
      return unavailableMemoryResult();
    }
    const currentSnapshot = currentCompactionCheckpoint
      ? rebuildCompactionSnapshot(snapshot, currentCompactionCheckpoint)
      : snapshot;
    if (!currentSnapshot) return unavailableMemoryResult();
    if (!(await this.allowedOrSettleCompaction(snapshot, operationId))) {
      return unavailableMemoryResult();
    }

    let cursor = await this.ports.readCursor(snapshot.sessionId);
    if (!(await this.allowedOrSettleCompaction(snapshot, operationId))) {
      return unavailableMemoryResult();
    }
    const pendingFailure = await this.ports.readPendingFailure(snapshot.sessionId);
    if (!cursor && !pendingFailure) {
      if (!(await this.allowedOrSettleCompaction(snapshot, operationId))) {
        return unavailableMemoryResult();
      }
      const checkpoint = await this.ports.readLatestCompactionCheckpoint(snapshot.sessionId);
      const hasRecoverableCompaction = compactionCheckpoints.some((candidate) => {
        const candidateBoundary = compactionBoundaryEntry(entries, candidate);
        return candidateBoundary !== undefined && candidateBoundary.ordinal <= boundary.ordinal;
      });
      const bootstrapOrdinal =
        checkpoint && !hasRecoverableCompaction
          ? validCompactionBootstrapOrdinal(entries, checkpoint)
          : undefined;
      if (bootstrapOrdinal && bootstrapOrdinal <= boundary.ordinal) {
        cursor = await this.ports.initializeCursor(snapshot.sessionId, bootstrapOrdinal);
      }
    }

    let expectedCursorOrdinal = cursor?.processedOrdinal ?? 0;
    if (pendingFailure?.firstOperationId === operationId) return unavailableMemoryResult();
    if (
      pendingFailure &&
      (pendingFailure.fromOrdinal !== expectedCursorOrdinal + 1 ||
        pendingFailure.throughOrdinal > boundary.ordinal)
    ) {
      return unavailableMemoryResult();
    }
    if (pendingFailure) {
      const pendingCheckpoint = pendingFailure.compactionCheckpointId
        ? compactionCheckpoints.find(
            (checkpoint) => checkpoint.checkpointId === pendingFailure.compactionCheckpointId,
          )
        : undefined;
      const pendingBoundary = pendingCheckpoint
        ? compactionBoundaryEntry(entries, pendingCheckpoint)
        : entries.find(({ ordinal }) => ordinal === pendingFailure.throughOrdinal);
      if (pendingCheckpoint && pendingBoundary?.ordinal !== pendingFailure.throughOrdinal) {
        return unavailableMemoryResult();
      }
      const retrySnapshot = pendingCheckpoint
        ? rebuildCompactionSnapshot(currentSnapshot, pendingCheckpoint)
        : pendingFailure.compactionCheckpointId
          ? undefined
          : rebuildExplicitPendingSnapshot(
              currentSnapshot,
              pendingFailure,
              pendingBoundary,
              entries,
            );
      if (!retrySnapshot) return unavailableMemoryResult();
      const retryOperationId = pendingRetryOperationId(operationId, pendingFailure);
      const retry = await this.processRange({
        snapshot: retrySnapshot,
        trigger: pendingFailure.firstTrigger,
        operationId: retryOperationId,
        expectedCursorOrdinal,
        targetBoundaryOrdinal: pendingFailure.throughOrdinal,
        expectedCoverageHash: pendingFailure.coverageHash,
        entries,
        compactionCheckpoints,
        policyDeniedCheckpointIds,
        prioritizeCurrentTurn: pendingFailure.firstTrigger === 'remember',
      });
      if (retry.kind === 'blocked') {
        await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
        return unavailableMemoryResult();
      }
      if (retry.kind === 'committed') {
        expectedCursorOrdinal = retry.nextCursorOrdinal;
      } else {
        const settled = await this.settleCountedFailure({
          snapshot: retrySnapshot,
          trigger: retry.failedTrigger ?? pendingFailure.firstTrigger,
          operationId: retry.failedOperationId ?? retryOperationId,
          expectedCursorOrdinal: retry.failedExpectedCursorOrdinal ?? expectedCursorOrdinal,
          throughOrdinal: retry.failedThroughOrdinal ?? pendingFailure.throughOrdinal,
          coverageHash: retry.coverageHash ?? pendingFailure.coverageHash,
          failureClass: retry.failureClass,
        });
        if (!settled) {
          await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
          return unavailableMemoryResult();
        }
        if (settled.status !== 'discarded') return unavailableMemoryResult();
        expectedCursorOrdinal = settled.cursor.processedOrdinal;
      }
    }
    for (;;) {
      const recoveredCheckpoint = earliestUnprocessedCompactionCheckpoint(
        compactionCheckpoints,
        entries,
        expectedCursorOrdinal,
        boundary.ordinal,
        snapshot.compactionCheckpointId,
      );
      if (!recoveredCheckpoint) break;
      if (isPolicyDeniedCheckpoint(recoveredCheckpoint, policyDeniedCheckpointIds)) {
        const nextCursorOrdinal = await this.settlePolicyDeniedCheckpoint(
          snapshot,
          recoveredCheckpoint,
          entries,
        );
        if (nextCursorOrdinal === undefined) return unavailableMemoryResult();
        expectedCursorOrdinal = nextCursorOrdinal;
      } else {
        const recoveredSnapshot = rebuildCompactionSnapshot(currentSnapshot, recoveredCheckpoint);
        const recoveredBoundary = compactionBoundaryEntry(entries, recoveredCheckpoint);
        const recoveredOperationId = recoveredSnapshot
          ? memoryExtractionOperationId(recoveredSnapshot)
          : undefined;
        if (!recoveredSnapshot || !recoveredBoundary || !recoveredOperationId) {
          return unavailableMemoryResult();
        }
        const recovered = await this.processRange({
          snapshot: recoveredSnapshot,
          trigger: 'compaction',
          operationId: recoveredOperationId,
          expectedCursorOrdinal,
          targetBoundaryOrdinal: recoveredBoundary.ordinal,
          entries,
          compactionCheckpoints,
          policyDeniedCheckpointIds,
          prioritizeCurrentTurn: false,
        });
        if (recovered.kind === 'blocked') {
          await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
          return unavailableMemoryResult();
        }
        if (recovered.kind === 'counted_failure') {
          const settled = await this.settleCountedFailure({
            snapshot: recoveredSnapshot,
            trigger: recovered.failedTrigger ?? 'compaction',
            operationId: recovered.failedOperationId ?? recoveredOperationId,
            expectedCursorOrdinal: recovered.failedExpectedCursorOrdinal ?? expectedCursorOrdinal,
            throughOrdinal: recovered.failedThroughOrdinal ?? recoveredBoundary.ordinal,
            coverageHash:
              recovered.coverageHash ??
              memoryCoverageHash(
                entries.filter(
                  ({ ordinal }) =>
                    ordinal > expectedCursorOrdinal && ordinal <= recoveredBoundary.ordinal,
                ),
              ),
            failureClass: recovered.failureClass,
          });
          if (!settled) {
            await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
          }
          return unavailableMemoryResult();
        }
        expectedCursorOrdinal = recovered.nextCursorOrdinal;
      }
    }

    if (expectedCursorOrdinal >= boundary.ordinal) {
      return snapshot.trigger === 'remember'
        ? { status: 'not_applicable', requestedItems: [] }
        : unavailableMemoryResult();
    }

    const processed = await this.processRange({
      snapshot: currentSnapshot,
      trigger: snapshot.trigger,
      operationId,
      expectedCursorOrdinal,
      targetBoundaryOrdinal: boundary.ordinal,
      entries,
      compactionCheckpoints,
      policyDeniedCheckpointIds,
      prioritizeCurrentTurn: snapshot.trigger === 'remember',
    });
    if (processed.kind === 'committed') {
      return rememberResultFromReceipt(snapshot.trigger, processed.receipt);
    }
    if (processed.kind === 'counted_failure') {
      const settled = await this.settleCountedFailure({
        snapshot: currentSnapshot,
        trigger: processed.failedTrigger ?? snapshot.trigger,
        operationId: processed.failedOperationId ?? operationId,
        expectedCursorOrdinal: processed.failedExpectedCursorOrdinal ?? expectedCursorOrdinal,
        throughOrdinal: processed.failedThroughOrdinal ?? boundary.ordinal,
        coverageHash:
          processed.coverageHash ??
          memoryCoverageHash(
            entries.filter(
              ({ ordinal }) => ordinal > expectedCursorOrdinal && ordinal <= boundary.ordinal,
            ),
          ),
        failureClass: processed.failureClass,
      });
      if (!settled) {
        await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
      }
    } else if (processed.kind === 'blocked') {
      await this.settleCompactionIfCurrentlyDenied(snapshot, operationId);
    }
    return unavailableMemoryResult();
  }

  private async processRange(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly trigger: MemoryExtractionTrigger;
    readonly operationId: string;
    readonly expectedCursorOrdinal: number;
    readonly targetBoundaryOrdinal: number;
    readonly expectedCoverageHash?: string;
    readonly entries: readonly MemoryExtractionEventEntry[];
    readonly compactionCheckpoints: readonly HistoryCompactCheckpoint[];
    readonly policyDeniedCheckpointIds: ReadonlySet<string>;
    readonly prioritizeCurrentTurn: boolean;
    readonly allowSplit?: boolean;
  }): Promise<CoverageProcessingResult> {
    const pendingEntries = input.entries.filter(
      ({ ordinal }) =>
        ordinal > input.expectedCursorOrdinal && ordinal <= input.targetBoundaryOrdinal,
    );
    const coverageHash = memoryCoverageHash(pendingEntries);
    if (input.expectedCoverageHash && input.expectedCoverageHash !== coverageHash) {
      return { kind: 'blocked' };
    }
    const processSplit = async (): Promise<CoverageProcessingResult | undefined> => {
      if (input.allowSplit === false) return undefined;
      let maximumSplitIndex: number | undefined;
      if (input.trigger === 'remember') {
        const requestedTurnStart = pendingEntries.findIndex(
          ({ event }) =>
            event.runId === input.snapshot.runId && event.turnId === input.snapshot.turnId,
        );
        if (requestedTurnStart <= 0) return undefined;
        maximumSplitIndex = requestedTurnStart;
      }
      const split = memoryRangeSplitCandidates(pendingEntries, maximumSplitIndex).find(
        ({ first, second }) => {
          const firstThroughOrdinal = first.at(-1)!.ordinal;
          const firstTrigger: MemoryExtractionTrigger = 'extract';
          const firstPrepared = this.prepareRange({
            ...input,
            trigger: firstTrigger,
            targetBoundaryOrdinal: firstThroughOrdinal,
            prioritizeCurrentTurn: false,
            pendingEntries: first,
            coverageHash: memoryCoverageHash(first),
          });
          const secondPrepared = this.prepareRange({
            ...input,
            expectedCursorOrdinal: firstThroughOrdinal,
            pendingEntries: second,
            coverageHash: memoryCoverageHash(second),
          });
          return (
            preparedMemoryRangeFits(firstPrepared, firstTrigger) &&
            preparedMemoryRangeFits(secondPrepared, input.trigger)
          );
        },
      );
      if (!split) {
        return undefined;
      }
      const firstThroughOrdinal = split.first.at(-1)!.ordinal;
      const first = await this.processRange({
        ...input,
        // A split prefix is an independent incidental range. It cannot retain
        // the full Compaction checkpoint identity because its boundary is
        // earlier than that checkpoint, and it cannot retain remember semantics
        // because the requested Turn is deliberately kept in the final segment.
        trigger: 'extract',
        operationId: memorySegmentOperationId(
          input.operationId,
          input.expectedCursorOrdinal,
          firstThroughOrdinal,
          input.snapshot.trigger === 'compaction',
        ),
        targetBoundaryOrdinal: firstThroughOrdinal,
        expectedCoverageHash: memoryCoverageHash(split.first),
        prioritizeCurrentTurn: false,
        allowSplit: false,
      });
      if (first.kind !== 'committed') return first;
      return this.processRange({
        ...input,
        expectedCursorOrdinal: first.nextCursorOrdinal,
        expectedCoverageHash: memoryCoverageHash(split.second),
        allowSplit: false,
      });
    };
    const prepared = this.prepareRange({ ...input, pendingEntries, coverageHash });
    if (!prepared) {
      const split = await processSplit();
      if (split) return split;
      return {
        kind: 'counted_failure',
        failureClass: 'evidence',
        failedTrigger: input.trigger,
        failedOperationId: input.operationId,
        failedExpectedCursorOrdinal: input.expectedCursorOrdinal,
        failedThroughOrdinal: input.targetBoundaryOrdinal,
        coverageHash,
      };
    }
    if (
      (prepared.coverage.evidence.length > 0 || input.trigger === 'remember') &&
      !memoryRequestFits(prepared.snapshot, prepared.firstPrompt, 'proposal')
    ) {
      const split = await processSplit();
      if (split) return split;
      return {
        kind: 'counted_failure',
        failureClass: 'provider',
        failedTrigger: input.trigger,
        failedOperationId: input.operationId,
        failedExpectedCursorOrdinal: input.expectedCursorOrdinal,
        failedThroughOrdinal: input.targetBoundaryOrdinal,
        coverageHash,
      };
    }
    const processed = await this.processCoverage({
      snapshot: prepared.snapshot,
      trigger: input.trigger,
      operationId: input.operationId,
      expectedCursorOrdinal: input.expectedCursorOrdinal,
      coverage: prepared.coverage,
      entries: input.entries,
      boundaryOrdinal: input.targetBoundaryOrdinal,
      coverageHash,
      localizationAfterOrdinal: latestPolicyDeniedBoundaryOrdinal(
        input.compactionCheckpoints,
        input.entries,
        input.policyDeniedCheckpointIds,
        input.targetBoundaryOrdinal,
      ),
      requestedEvidenceContainsSensitiveText: prepared.requestedEvidenceContainsSensitiveText,
    });
    return processed.kind === 'counted_failure'
      ? {
          ...processed,
          failedTrigger: input.trigger,
          failedOperationId: input.operationId,
          failedExpectedCursorOrdinal: input.expectedCursorOrdinal,
          failedThroughOrdinal: input.targetBoundaryOrdinal,
          coverageHash,
        }
      : processed;
  }

  private prepareRange(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly trigger: MemoryExtractionTrigger;
    readonly expectedCursorOrdinal: number;
    readonly targetBoundaryOrdinal: number;
    readonly entries: readonly MemoryExtractionEventEntry[];
    readonly compactionCheckpoints: readonly HistoryCompactCheckpoint[];
    readonly policyDeniedCheckpointIds: ReadonlySet<string>;
    readonly prioritizeCurrentTurn: boolean;
    readonly pendingEntries: readonly MemoryExtractionEventEntry[];
    readonly coverageHash: string;
  }):
    | {
        readonly snapshot: MemoryExtractionSourceSnapshot;
        readonly coverage: MemoryCoveragePlan;
        readonly firstPrompt: string;
        readonly requestedEvidenceContainsSensitiveText: boolean;
      }
    | undefined {
    const rangeSnapshot = buildMemoryRangeSnapshot({
      snapshot: input.snapshot,
      entries: input.entries,
      checkpoints: input.compactionCheckpoints,
      policyDeniedCheckpointIds: input.policyDeniedCheckpointIds,
      afterOrdinal: input.expectedCursorOrdinal,
      throughOrdinal: input.targetBoundaryOrdinal,
    });
    if (!rangeSnapshot) return undefined;
    const priorityEvidence = input.prioritizeCurrentTurn
      ? projectMemoryExtractionEvidence(
          input.pendingEntries
            .filter(
              ({ event }) =>
                event.runId === rangeSnapshot.runId && event.turnId === rangeSnapshot.turnId,
            )
            .map(({ event }) => event),
        )
      : [];
    const requestedEvidenceContainsSensitiveText =
      input.trigger === 'remember' && memoryEvidenceContainsSensitiveText(priorityEvidence);
    const coverage = planMemoryCoverage({
      pendingEntries: input.pendingEntries,
      ...(input.trigger === 'remember' ? { priorityEvidence } : {}),
      sourceEventMessagePositions: rangeSnapshot.sourceEventMessagePositions,
      sourceMessages: rangeSnapshot.sourceMessages,
    });
    if (!coverage || coverage.entries.length === 0) return undefined;
    const firstPrompt = buildFirstMemoryProposalPrompt({
      trigger: input.trigger,
      now: this.now(),
      evidence: coverage.evidence,
      sourceEventMessagePositions: rangeSnapshot.sourceEventMessagePositions,
    });
    return {
      snapshot: rangeSnapshot,
      coverage,
      firstPrompt,
      requestedEvidenceContainsSensitiveText,
    };
  }

  private async processCoverage(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly trigger: MemoryExtractionTrigger;
    readonly operationId: string;
    readonly expectedCursorOrdinal: number;
    readonly coverage: MemoryCoveragePlan;
    readonly entries: readonly MemoryExtractionEventEntry[];
    readonly boundaryOrdinal: number;
    readonly coverageHash: string;
    readonly localizationAfterOrdinal: number;
    readonly requestedEvidenceContainsSensitiveText: boolean;
  }): Promise<CoverageProcessingResult> {
    const { snapshot, coverage } = input;
    if (input.requestedEvidenceContainsSensitiveText) {
      return this.commitSensitiveNoOp(input);
    }
    const budget: MemoryModelCallBudget = { remaining: MAX_MEMORY_EXTRACTION_MODEL_CALLS };
    let lastFailureClass: MemoryExtractionFailureClass = 'schema';
    do {
      const attempt = await this.processCoverageAttempt(input, budget);
      if (attempt.kind === 'committed' || attempt.kind === 'blocked') return attempt;
      lastFailureClass = attempt.failureClass;
    } while (budget.remaining > 0);
    return { kind: 'counted_failure', failureClass: lastFailureClass };
  }

  private async processCoverageAttempt(
    input: {
      readonly snapshot: MemoryExtractionSourceSnapshot;
      readonly trigger: MemoryExtractionTrigger;
      readonly operationId: string;
      readonly expectedCursorOrdinal: number;
      readonly coverage: MemoryCoveragePlan;
      readonly entries: readonly MemoryExtractionEventEntry[];
      readonly boundaryOrdinal: number;
      readonly coverageHash: string;
      readonly localizationAfterOrdinal: number;
      readonly requestedEvidenceContainsSensitiveText: boolean;
    },
    budget: MemoryModelCallBudget,
  ): Promise<CoverageProcessingResult> {
    const { snapshot, trigger, coverage } = input;
    let requestedItems: readonly MemoryProposalItem[] = [];
    let incidentalItems: readonly MemoryProposalItem[] = [];
    let requestedStatus: 'resolved' | 'not_applicable' | 'unresolved' = 'not_applicable';
    let requestedAdmissionEvidence = coverage.evidence;
    let localizedInterpretationContext: string | undefined;

    if (coverage.evidence.length > 0 || trigger === 'remember') {
      const firstCall = await this.callModel(
        snapshot,
        buildFirstMemoryProposalPrompt({
          trigger,
          now: this.now(),
          evidence: coverage.evidence,
          sourceEventMessagePositions: snapshot.sourceEventMessagePositions,
        }),
        'proposal',
        budget,
      );
      if (firstCall.kind !== 'ok') return firstCall;
      const first = parseMemoryProposal(firstCall.raw);
      if (!first) return { kind: 'counted_failure', failureClass: 'schema' };
      if (
        trigger !== 'remember' &&
        (first.requestedItems.length > 0 ||
          (first.status === 'complete'
            ? first.requestedStatus !== 'not_applicable'
            : first.requestedStatus !== 'unresolved'))
      ) {
        return { kind: 'counted_failure', failureClass: 'schema' };
      }
      requestedItems = first.requestedItems;
      incidentalItems = first.incidentalItems;
      requestedStatus = first.requestedStatus;

      if (first.status === 'search_required') {
        if (!(await this.allowed(snapshot.sessionId))) {
          return { kind: 'blocked' };
        }
        const localizedEntries = searchSameSessionMemoryHistory(
          input.entries,
          input.boundaryOrdinal,
          first.search,
          input.localizationAfterOrdinal,
        );
        if (localizedEntries.length === 0) {
          return { kind: 'counted_failure', failureClass: 'localization' };
        }
        localizedInterpretationContext = renderMemoryLocalizationContext(localizedEntries);
        if (!localizedInterpretationContext) {
          return { kind: 'counted_failure', failureClass: 'localization' };
        }
        const localizedVisibleEvidence = bindProviderVisibleEvidence(
          projectMemoryExtractionEvidence(
            localizedEntries.map(({ event }) => event),
            { snippetTerms: first.search.terms },
          ),
          snapshot.sourceMessages,
          snapshot.sourceEventMessagePositions,
        );
        const localizedEvidence = fitMemoryExtractionEvidence(
          localizedVisibleEvidence,
          undefined,
          snapshot.sourceEventMessagePositions,
        );
        if (!localizedEvidence) {
          return { kind: 'counted_failure', failureClass: 'evidence' };
        }
        if (trigger === 'remember' && memoryEvidenceContainsSensitiveText(localizedEvidence)) {
          return this.commitSensitiveNoOp(input);
        }
        if (budget.remaining <= 0) {
          return { kind: 'counted_failure', failureClass: 'localization' };
        }
        const localizedPrompt = fittingLocalizedMemoryPrompt({
          snapshot,
          trigger,
          now: this.now(),
          evidence: trigger === 'remember' ? localizedEvidence : coverage.evidence,
          interpretationContext: localizedInterpretationContext,
        });
        if (!localizedPrompt) {
          return { kind: 'counted_failure', failureClass: 'localization' };
        }
        localizedInterpretationContext = localizedPrompt.interpretationContext;
        const localizedCall = await this.callModel(
          snapshot,
          localizedPrompt.prompt,
          'localized',
          budget,
        );
        if (localizedCall.kind !== 'ok') return localizedCall;
        const localized = parseLocalizedMemoryProposal(localizedCall.raw);
        if (!localized) return { kind: 'counted_failure', failureClass: 'schema' };
        if (localized.status === 'cannot_resolve') {
          return { kind: 'counted_failure', failureClass: 'localization' };
        }
        if ('coverageStatus' in localized) {
          if (localized.status !== 'complete') {
            return { kind: 'counted_failure', failureClass: 'schema' };
          }
          if (
            trigger !== 'remember' &&
            (localized.requestedStatus !== 'not_applicable' || localized.requestedItems.length > 0)
          ) {
            return { kind: 'counted_failure', failureClass: 'schema' };
          }
          requestedItems = localized.requestedItems;
          incidentalItems = [...incidentalItems, ...localized.incidentalItems];
          requestedStatus = localized.requestedStatus;
        } else {
          // Backward-compatible parser branch for in-flight PR 2-A responses.
          requestedItems = localized.requestedItems;
          requestedStatus = localized.status;
        }
        if (trigger === 'remember') requestedAdmissionEvidence = localizedEvidence;
      } else if (first.status === 'cannot_resolve') {
        return { kind: 'counted_failure', failureClass: 'localization' };
      }
    }

    if (requestedStatus === 'unresolved') {
      return { kind: 'counted_failure', failureClass: 'localization' };
    }
    const requestedEvidenceByRef = new Map(
      requestedAdmissionEvidence.map((entry) => [entry.sourceRef, entry]),
    );
    const coverageEvidenceByRef = new Map(
      coverage.evidence.map((entry) => [entry.sourceRef, entry]),
    );
    const coverageEventIds = new Set(coverage.entries.map(({ event }) => event.id));
    const candidates: Array<{
      readonly candidateId: string;
      readonly requested: boolean;
      readonly proposal: MemoryProposalItem;
    }> = [];
    let noOpReason: 'sensitive_information' | undefined;
    proposalLoop: for (const [requested, proposals] of [
      [true, requestedItems],
      [false, incidentalItems],
    ] as const) {
      for (const proposal of proposals) {
        if (deterministicMemoryPolicyRejection(proposal)) {
          if (requested) {
            noOpReason = 'sensitive_information';
            break proposalLoop;
          }
          continue;
        }
        const admission = admitMemoryProposalItemDetailed(
          proposal,
          requested ? requestedEvidenceByRef : coverageEvidenceByRef,
        );
        if (!admission.admitted) {
          if (requested) {
            return {
              kind: 'counted_failure',
              failureClass: admission.reason === 'evidence' ? 'evidence' : 'requested_admission',
            };
          }
          continue;
        }
        if (
          !requested &&
          admission.fields.citedEvents.some((event) => !coverageEventIds.has(event.id))
        ) {
          continue;
        }
        candidates.push({
          candidateId: `candidate_${candidates.length}`,
          requested,
          proposal,
        });
      }
    }

    const writes: MemoryItemWrite[] = [];
    const requestedItemIndexes: number[] = [];
    if (!noOpReason && candidates.length > 0) {
      const canonicalPrompt = buildMemoryCanonicalizationPrompt({
        now: this.now(),
        candidates: candidates.map(({ candidateId, requested, proposal }) => ({
          candidateId,
          requested,
          evidence: proposal.evidence.map(({ sourceRef, quote }) => {
            const source = (requested ? requestedEvidenceByRef : coverageEvidenceByRef).get(
              sourceRef,
            )!;
            return {
              sourceRef,
              quote,
              observedAt: minuteTimestamp(Math.max(...source.events.map((event) => event.ts))),
            };
          }),
          ...(localizedInterpretationContext
            ? { interpretationContext: localizedInterpretationContext }
            : {}),
        })),
      });
      let byId:
        | Map<
            string,
            NonNullable<ReturnType<typeof parseMemoryCanonicalization>>['results'][number]
          >
        | undefined;
      let canonicalFailureClass: MemoryExtractionFailureClass = 'schema';
      while (!byId && budget.remaining > 0) {
        const canonicalCall = await this.callModel(
          snapshot,
          canonicalPrompt,
          'canonicalize',
          budget,
        );
        if (canonicalCall.kind === 'blocked') return canonicalCall;
        if (canonicalCall.kind === 'counted_failure') {
          canonicalFailureClass = canonicalCall.failureClass;
          continue;
        }
        const results = parseMemoryCanonicalization(canonicalCall.raw)?.results;
        if (!results || results.length !== candidates.length) {
          canonicalFailureClass = 'schema';
          continue;
        }
        const indexed = new Map(results.map((result) => [result.candidateId, result]));
        if (
          indexed.size !== candidates.length ||
          candidates.some(({ candidateId }) => !indexed.has(candidateId))
        ) {
          canonicalFailureClass = 'schema';
          continue;
        }
        byId = indexed;
      }
      if (!byId) return { kind: 'counted_failure', failureClass: canonicalFailureClass };

      for (const candidate of candidates) {
        const result = byId.get(candidate.candidateId)!;
        if (result.status === 'rejected') {
          if (candidate.requested) {
            return { kind: 'counted_failure', failureClass: 'requested_admission' };
          }
          continue;
        }
        const canonicalProposal: MemoryProposalItem = {
          ...result.item,
          evidence: candidate.proposal.evidence,
        };
        if (deterministicMemoryPolicyRejection(canonicalProposal)) {
          if (candidate.requested) {
            noOpReason = 'sensitive_information';
            break;
          }
          continue;
        }
        const admission = admitMemoryProposalItemDetailed(
          canonicalProposal,
          candidate.requested ? requestedEvidenceByRef : coverageEvidenceByRef,
        );
        if (!admission.admitted) {
          if (candidate.requested) {
            return {
              kind: 'counted_failure',
              failureClass: admission.reason === 'evidence' ? 'evidence' : 'requested_admission',
            };
          }
          continue;
        }
        if (candidate.requested) requestedItemIndexes.push(writes.length);
        writes.push(memoryItemWrite(snapshot, admission.fields, candidate.requested));
      }
    }

    if (noOpReason) {
      writes.length = 0;
      requestedItemIndexes.length = 0;
    }

    if (!(await this.allowed(snapshot.sessionId))) return { kind: 'blocked' };
    const committed = await this.ports.commit({
      operationId: input.operationId,
      sessionId: snapshot.sessionId,
      expectedCursorOrdinal: input.expectedCursorOrdinal,
      nextCursorOrdinal: coverage.entries.at(-1)!.ordinal,
      coverageHash: input.coverageHash,
      items: writes,
      requestedItemIndexes,
      ...(noOpReason ? { noOpReason } : {}),
      trigger,
      ...(trigger === 'compaction' && snapshot.compactionCheckpointId
        ? { compactionCheckpointId: snapshot.compactionCheckpointId }
        : {}),
    });
    return {
      kind: 'committed',
      receipt: committed.receipt,
      nextCursorOrdinal: coverage.entries.at(-1)!.ordinal,
    };
  }

  private async commitSensitiveNoOp(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly trigger: MemoryExtractionTrigger;
    readonly operationId: string;
    readonly expectedCursorOrdinal: number;
    readonly coverage: MemoryCoveragePlan;
    readonly coverageHash: string;
  }): Promise<CoverageProcessingResult> {
    if (!(await this.allowed(input.snapshot.sessionId))) return { kind: 'blocked' };
    const nextCursorOrdinal = input.coverage.entries.at(-1)!.ordinal;
    const committed = await this.ports.commit({
      operationId: input.operationId,
      sessionId: input.snapshot.sessionId,
      expectedCursorOrdinal: input.expectedCursorOrdinal,
      nextCursorOrdinal,
      coverageHash: input.coverageHash,
      items: [],
      requestedItemIndexes: [],
      noOpReason: 'sensitive_information',
      trigger: input.trigger,
      ...(input.trigger === 'compaction' && input.snapshot.compactionCheckpointId
        ? { compactionCheckpointId: input.snapshot.compactionCheckpointId }
        : {}),
    });
    return { kind: 'committed', receipt: committed.receipt, nextCursorOrdinal };
  }

  private async callModel(
    snapshot: MemoryExtractionSourceSnapshot,
    prompt: string,
    stage: 'proposal' | 'localized' | 'canonicalize',
    budget: MemoryModelCallBudget,
  ): Promise<
    | { readonly kind: 'ok'; readonly raw: string }
    | { readonly kind: 'counted_failure'; readonly failureClass: 'provider' }
    | { readonly kind: 'blocked' }
  > {
    if (budget.remaining <= 0) {
      return { kind: 'counted_failure', failureClass: 'provider' };
    }
    if (!memoryRequestFits(snapshot, prompt, stage)) {
      budget.remaining = 0;
      return { kind: 'counted_failure', failureClass: 'provider' };
    }
    if (!(await this.allowed(snapshot.sessionId))) return { kind: 'blocked' };
    budget.remaining -= 1;
    const result = await this.ports.generate({
      snapshot,
      prompt,
      stage,
      abortSignal: AbortSignal.timeout(60_000),
    });
    if (result.ok) return { kind: 'ok', raw: result.text };
    if (!(await this.allowed(snapshot.sessionId))) return { kind: 'blocked' };
    return result.errorClass === 'provider' || result.errorClass === 'timeout'
      ? { kind: 'counted_failure', failureClass: 'provider' }
      : { kind: 'blocked' };
  }

  private async settleCountedFailure(input: {
    readonly snapshot: MemoryExtractionSourceSnapshot;
    readonly trigger: MemoryExtractionTrigger;
    readonly operationId: string;
    readonly expectedCursorOrdinal: number;
    readonly throughOrdinal: number;
    readonly coverageHash: string;
    readonly failureClass: MemoryExtractionFailureClass;
  }): Promise<SettleMemoryExtractionFailureResult | undefined> {
    if (!(await this.allowed(input.snapshot.sessionId))) return undefined;
    return this.ports.settleFailure({
      operationId: input.operationId,
      sessionId: input.snapshot.sessionId,
      expectedCursorOrdinal: input.expectedCursorOrdinal,
      failedThroughOrdinal: input.throughOrdinal,
      coverageHash: input.coverageHash,
      failureClass: input.failureClass,
      trigger: input.trigger,
      ...(input.trigger === 'compaction' && input.snapshot.compactionCheckpointId
        ? { compactionCheckpointId: input.snapshot.compactionCheckpointId }
        : {}),
    });
  }

  private async allowedOrSettleCompaction(
    snapshot: MemoryExtractionSourceSnapshot,
    operationId: string,
  ): Promise<boolean> {
    const gate = await this.ports.readGate(snapshot.sessionId);
    if (gate.allowed) return true;
    if (gate.reason !== 'unavailable') {
      await this.settleDeniedCompaction(snapshot, operationId);
    }
    return false;
  }

  private async settleCompactionIfCurrentlyDenied(
    snapshot: MemoryExtractionSourceSnapshot,
    operationId: string,
  ): Promise<void> {
    if (snapshot.trigger !== 'compaction') return;
    const gate = await this.ports.readGate(snapshot.sessionId);
    if (!gate.allowed && gate.reason !== 'unavailable') {
      await this.settleDeniedCompaction(snapshot, operationId);
    }
  }

  /**
   * A policy rejection after the checkpoint is intentional, not a crash gap.
   * Settle the whole frozen range atomically without model access or Item writes
   * so a later enabled Compaction cannot recover history from the denied period.
   */
  private async settleDeniedCompaction(
    snapshot: MemoryExtractionSourceSnapshot,
    _operationId: string,
  ): Promise<void> {
    if (snapshot.trigger !== 'compaction') return;
    const entries = await this.ports.readSessionEvents(snapshot.sessionId);
    const checkpoints = await this.ports.readCompactionCheckpoints(snapshot.sessionId);
    const checkpoint = checkpoints.find(
      (candidate) => candidate.checkpointId === snapshot.compactionCheckpointId,
    );
    if (!checkpoint || !compactionCheckpointMatchesSnapshot([checkpoint], snapshot)) return;
    await this.ports.recordCompactionPolicyDenial({
      sessionId: snapshot.sessionId,
      compactionCheckpointId: checkpoint.checkpointId,
      deniedAt: this.now(),
    });
    await this.settlePolicyDeniedCheckpoint(snapshot, checkpoint, entries);
  }

  private async settlePolicyDeniedCheckpoint(
    snapshot: MemoryExtractionSourceSnapshot,
    checkpoint: HistoryCompactCheckpoint,
    entries: readonly MemoryExtractionEventEntry[],
  ): Promise<number | undefined> {
    const boundary = compactionBoundaryEntry(entries, checkpoint);
    if (!boundary) return;
    const cursor = await this.ports.readCursor(snapshot.sessionId);
    const expectedCursorOrdinal = cursor?.processedOrdinal ?? 0;
    if (expectedCursorOrdinal >= boundary.ordinal) return expectedCursorOrdinal;
    const coverageEntries = entries.filter(
      ({ ordinal }) => ordinal > expectedCursorOrdinal && ordinal <= boundary.ordinal,
    );
    if (coverageEntries.length === 0) return;
    await this.ports.commit({
      operationId: policySkipOperationId(snapshot.sessionId, checkpoint.checkpointId),
      sessionId: snapshot.sessionId,
      expectedCursorOrdinal,
      nextCursorOrdinal: boundary.ordinal,
      coverageHash: memoryCoverageHash(coverageEntries),
      items: [],
      requestedItemIndexes: [],
      skipReason: 'policy_denied',
      trigger: 'compaction',
      compactionCheckpointId: checkpoint.checkpointId,
    });
    return boundary.ordinal;
  }

  private async allowed(sessionId: string): Promise<boolean> {
    return (await this.ports.readGate(sessionId)).allowed;
  }

  private now(): number {
    return (this.ports.now ?? Date.now)();
  }
}

function memoryExtractionOperationId(snapshot: MemoryExtractionSourceSnapshot): string | undefined {
  const stableBoundary =
    snapshot.trigger === 'remember'
      ? snapshot.toolCallId
      : snapshot.trigger === 'extract'
        ? snapshot.terminalEventId
        : snapshot.compactionCheckpointId;
  if (!stableBoundary) return undefined;
  return `memory_${createHash('sha256')
    .update(
      JSON.stringify({
        sessionId: snapshot.sessionId,
        trigger: snapshot.trigger,
        stableBoundary,
        ...(snapshot.trigger === 'compaction'
          ? {}
          : { runId: snapshot.runId, turnId: snapshot.turnId }),
      }),
    )
    .digest('hex')}`;
}

function memoryCoverageHash(entries: readonly MemoryExtractionEventEntry[]): string {
  return createHash('sha256')
    .update(JSON.stringify(entries.map(({ ordinal, event }) => [ordinal, event.id])))
    .digest('hex');
}

function memorySegmentOperationId(
  operationId: string,
  afterOrdinal: number,
  throughOrdinal: number,
  portableCompactionPrefix: boolean,
): string {
  const prefix = portableCompactionPrefix ? 'memory_compaction_segment' : 'memory_segment';
  return `${prefix}_${createHash('sha256')
    .update(JSON.stringify({ operationId, afterOrdinal, throughOrdinal }))
    .digest('hex')}`;
}

function memoryRangeSplitCandidates(
  entries: readonly MemoryExtractionEventEntry[],
  maximumSplitIndex = entries.length - 1,
): readonly {
  readonly first: readonly MemoryExtractionEventEntry[];
  readonly second: readonly MemoryExtractionEventEntry[];
}[] {
  if (entries.length < 2) return [];
  const weights = entries.map(memoryRangeEventWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let prefix = 0;
  const candidates = entries
    .slice(1)
    .map((entry, offset) => {
      const index = offset + 1;
      prefix += weights[offset]!;
      return {
        index,
        turnBoundary: entries[index - 1]!.event.turnId !== entry.event.turnId,
        distance: Math.abs(prefix - total / 2),
      };
    })
    .filter(({ index }) => index <= maximumSplitIndex);
  return candidates
    .sort(
      (left, right) =>
        Number(right.turnBoundary) - Number(left.turnBoundary) ||
        left.distance - right.distance ||
        left.index - right.index,
    )
    .map(({ index }) => ({ first: entries.slice(0, index), second: entries.slice(index) }));
}

function preparedMemoryRangeFits(
  prepared:
    | {
        readonly snapshot: MemoryExtractionSourceSnapshot;
        readonly coverage: MemoryCoveragePlan;
        readonly firstPrompt: string;
      }
    | undefined,
  trigger: MemoryExtractionTrigger,
): boolean {
  if (!prepared) return false;
  return (
    (prepared.coverage.evidence.length === 0 && trigger !== 'remember') ||
    memoryRequestFits(prepared.snapshot, prepared.firstPrompt, 'proposal')
  );
}

function memoryRangeEventWeight({ event }: MemoryExtractionEventEntry): number {
  if (
    !event.partial &&
    event.content?.kind === 'text' &&
    ((event.role === 'user' && event.author === 'user') ||
      (event.role === 'model' && event.author === 'agent'))
  ) {
    // Text appears once in the interpretation messages and, for user text, once
    // more in the bounded evidence index when it cannot be referenced by position.
    return Math.max(1, event.content.text.length * (event.role === 'user' ? 2 : 1));
  }
  return 1;
}

function memoryRequestFits(
  snapshot: MemoryExtractionSourceSnapshot,
  prompt: string,
  stage: 'proposal' | 'localized' | 'canonicalize',
): boolean {
  const contextWindow = snapshot.sourceContextWindowTokens;
  if (contextWindow === undefined) return true;
  const outputReserve = memoryExtractionMaxOutputTokens(snapshot);
  const inputBudget = Math.max(1, contextWindow - outputReserve);
  const payloadChars =
    prompt.length +
    (stage === 'canonicalize'
      ? 0
      : (snapshot.sourceSystemPrompt?.length ?? 0) +
        safeJsonLength(snapshot.sourceMessages) +
        safeJsonLength(snapshot.sourceTools) +
        safeJsonLength(snapshot.sourceActiveTools) +
        safeJsonLength(snapshot.sourceProviderOptions));
  return Math.ceil(payloadChars / 4) <= inputBudget;
}

function fittingLocalizedMemoryPrompt(input: {
  readonly snapshot: MemoryExtractionSourceSnapshot;
  readonly trigger: MemoryExtractionTrigger;
  readonly now: number;
  readonly evidence: readonly MemoryCoveragePlan['evidence'][number][];
  readonly interpretationContext: string;
}): { readonly prompt: string; readonly interpretationContext: string } | undefined {
  const build = (interpretationContext: string): string =>
    buildLocalizedMemoryProposalPrompt({
      trigger: input.trigger,
      now: input.now,
      evidence: input.evidence,
      interpretationContext,
      sourceEventMessagePositions: input.snapshot.sourceEventMessagePositions,
    });
  const full = build(input.interpretationContext);
  if (memoryRequestFits(input.snapshot, full, 'localized')) {
    return { prompt: full, interpretationContext: input.interpretationContext };
  }
  const codePoints = Array.from(input.interpretationContext);
  let low = 1;
  let high = codePoints.length;
  let best: { readonly prompt: string; readonly interpretationContext: string } | undefined;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    const context = centeredContextSlice(codePoints, size);
    const prompt = build(context);
    if (memoryRequestFits(input.snapshot, prompt, 'localized')) {
      best = { prompt, interpretationContext: context };
      low = size + 1;
    } else {
      high = size - 1;
    }
  }
  return best;
}

function centeredContextSlice(codePoints: readonly string[], maximum: number): string {
  if (codePoints.length <= maximum) return codePoints.join('');
  const head = Math.ceil(maximum / 2);
  const tail = Math.floor(maximum / 2);
  return `${codePoints.slice(0, head).join('')}\n[localized context truncated]\n${
    tail > 0 ? codePoints.slice(-tail).join('') : ''
  }`;
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function memoryEvidenceContainsSensitiveText(
  evidence: readonly { readonly events: readonly MemoryExtractionEventEntry['event'][] }[],
): boolean {
  return evidence.some(({ events }) =>
    events.some(
      ({ content }) => content?.kind === 'text' && redactSecrets(content.text) !== content.text,
    ),
  );
}

function pendingRetryOperationId(
  triggerOperationId: string,
  pending: PendingMemoryExtractionFailure,
): string {
  return `memory_retry_${createHash('sha256')
    .update(
      JSON.stringify({
        triggerOperationId,
        firstOperationId: pending.firstOperationId,
        coverageHash: pending.coverageHash,
      }),
    )
    .digest('hex')}`;
}

function policySkipOperationId(sessionId: string, checkpointId: string): string {
  return `memory_policy_skip_${createHash('sha256')
    .update(JSON.stringify({ sessionId, checkpointId }))
    .digest('hex')}`;
}

function validSourceContextContract(snapshot: MemoryExtractionSourceSnapshot): boolean {
  if (snapshot.trigger === 'compaction') {
    return (
      snapshot.rebuildSourceContextFromCompactionCheckpoint === true &&
      snapshot.sourceMessages.length === 0 &&
      snapshot.sourceEventMessagePositions === undefined
    );
  }
  return snapshot.rebuildSourceContextFromCompactionCheckpoint === undefined;
}

function compactionBoundaryEntry(
  entries: readonly MemoryExtractionEventEntry[],
  checkpoint: HistoryCompactCheckpoint,
): MemoryExtractionEventEntry | undefined {
  const boundary = checkpoint.memoryExtractionBoundary;
  if (!boundary) return undefined;
  return entries.find(
    ({ event }) =>
      event.id === boundary.runtimeEventId &&
      event.runId === boundary.runId &&
      event.turnId === boundary.turnId,
  );
}

function compactionCheckpointMatchesSnapshot(
  checkpoints: readonly HistoryCompactCheckpoint[],
  snapshot: MemoryExtractionSourceSnapshot,
): boolean {
  if (!snapshot.compactionCheckpointId || !snapshot.compactionBoundaryEventId) return false;
  const checkpoint = checkpoints.find(
    (candidate) => candidate.checkpointId === snapshot.compactionCheckpointId,
  );
  return (
    checkpoint?.memoryExtractionBoundary?.runtimeEventId === snapshot.compactionBoundaryEventId
  );
}

function earliestUnprocessedCompactionCheckpoint(
  checkpoints: readonly HistoryCompactCheckpoint[],
  entries: readonly MemoryExtractionEventEntry[],
  cursorOrdinal: number,
  currentBoundaryOrdinal: number,
  currentCheckpointId?: string,
): HistoryCompactCheckpoint | undefined {
  return checkpoints
    .map((checkpoint) => ({ checkpoint, boundary: compactionBoundaryEntry(entries, checkpoint) }))
    .filter(
      (
        candidate,
      ): candidate is {
        checkpoint: HistoryCompactCheckpoint;
        boundary: MemoryExtractionEventEntry;
      } =>
        candidate.boundary !== undefined &&
        candidate.boundary.ordinal > cursorOrdinal &&
        candidate.boundary.ordinal <= currentBoundaryOrdinal &&
        candidate.checkpoint.checkpointId !== currentCheckpointId,
    )
    .sort((left, right) => left.boundary.ordinal - right.boundary.ordinal)[0]?.checkpoint;
}

function rebuildCompactionSnapshot(
  current: MemoryExtractionSourceSnapshot,
  checkpoint: HistoryCompactCheckpoint | undefined,
): MemoryExtractionSourceSnapshot | undefined {
  const boundary = checkpoint?.memoryExtractionBoundary;
  if (!checkpoint || !boundary || boundary.disposition === 'policy_denied') return undefined;
  return {
    trigger: 'compaction',
    sourceHeader: current.sourceHeader,
    ...(current.sourceSystemPrompt ? { sourceSystemPrompt: current.sourceSystemPrompt } : {}),
    sourceMessages: [],
    rebuildSourceContextFromCompactionCheckpoint: true,
    sourceTools: current.sourceTools,
    sourceActiveTools: current.sourceActiveTools,
    ...(current.sourceProviderOptions
      ? { sourceProviderOptions: current.sourceProviderOptions }
      : {}),
    ...(current.sourceMaxOutputTokens !== undefined
      ? { sourceMaxOutputTokens: current.sourceMaxOutputTokens }
      : {}),
    ...(current.sourceContextWindowTokens !== undefined
      ? { sourceContextWindowTokens: current.sourceContextWindowTokens }
      : {}),
    sessionId: current.sessionId,
    runId: current.runId,
    turnId: current.turnId,
    workspaceKey: current.workspaceKey,
    compactionCheckpointId: checkpoint.checkpointId,
    compactionBoundaryEventId: boundary.runtimeEventId,
  };
}

function rebuildExplicitPendingSnapshot(
  current: MemoryExtractionSourceSnapshot,
  pending: PendingMemoryExtractionFailure,
  boundary: MemoryExtractionEventEntry | undefined,
  entries: readonly MemoryExtractionEventEntry[],
): MemoryExtractionSourceSnapshot | undefined {
  if (!boundary || pending.firstTrigger === 'compaction') return undefined;
  const portableCompactionSegment = pending.firstOperationId.startsWith(
    'memory_compaction_segment_',
  );
  const shared = {
    sourceHeader: current.sourceHeader,
    ...(!portableCompactionSegment && current.sourceSystemPrompt
      ? { sourceSystemPrompt: current.sourceSystemPrompt }
      : {}),
    sourceMessages: [],
    sourceTools: portableCompactionSegment ? {} : current.sourceTools,
    sourceActiveTools: portableCompactionSegment ? [] : current.sourceActiveTools,
    ...(!portableCompactionSegment && current.sourceProviderOptions
      ? { sourceProviderOptions: current.sourceProviderOptions }
      : {}),
    ...(current.sourceMaxOutputTokens !== undefined
      ? { sourceMaxOutputTokens: current.sourceMaxOutputTokens }
      : {}),
    ...(current.sourceContextWindowTokens !== undefined
      ? { sourceContextWindowTokens: current.sourceContextWindowTokens }
      : {}),
    sessionId: current.sessionId,
    runId: boundary.event.runId,
    turnId: boundary.event.turnId,
    workspaceKey: current.workspaceKey,
  };
  if (pending.firstTrigger === 'remember') {
    const call = entries.find(
      ({ ordinal, event }) =>
        ordinal > boundary.ordinal &&
        event.runId === boundary.event.runId &&
        event.turnId === boundary.event.turnId &&
        event.content?.kind === 'function_call' &&
        event.content.name === MEMORY_REMEMBER_TOOL_NAME,
    );
    return call?.event.content?.kind === 'function_call'
      ? { ...shared, trigger: 'remember', toolCallId: call.event.content.id }
      : undefined;
  }
  return { ...shared, trigger: 'extract', terminalEventId: boundary.event.id };
}

function buildMemoryRangeSnapshot(input: {
  readonly snapshot: MemoryExtractionSourceSnapshot;
  readonly entries: readonly MemoryExtractionEventEntry[];
  readonly checkpoints: readonly HistoryCompactCheckpoint[];
  readonly policyDeniedCheckpointIds: ReadonlySet<string>;
  readonly afterOrdinal: number;
  readonly throughOrdinal: number;
}): MemoryExtractionSourceSnapshot | undefined {
  const afterEvent = input.entries.find(({ ordinal }) => ordinal === input.afterOrdinal)?.event;
  const throughEvent = input.entries.find(({ ordinal }) => ordinal === input.throughOrdinal)?.event;
  if (!throughEvent) return undefined;
  const sourceCheckpoint = input.snapshot.compactionCheckpointId
    ? input.checkpoints.find(
        (checkpoint) => checkpoint.checkpointId === input.snapshot.compactionCheckpointId,
      )
    : latestCheckpointAtOrBefore(input.checkpoints, input.entries, input.throughOrdinal);
  const previousCheckpointCandidate =
    input.snapshot.trigger === 'compaction'
      ? sourceCheckpoint?.previousCheckpointId
        ? input.checkpoints.find(
            (checkpoint) => checkpoint.checkpointId === sourceCheckpoint.previousCheckpointId,
          )
        : undefined
      : sourceCheckpoint;
  if (
    input.snapshot.trigger === 'compaction' &&
    sourceCheckpoint?.previousCheckpointId &&
    !previousCheckpointCandidate
  ) {
    return undefined;
  }
  const previousCheckpoint =
    previousCheckpointCandidate &&
    checkpointSummaryIsPolicySafe(
      previousCheckpointCandidate,
      input.checkpoints,
      input.policyDeniedCheckpointIds,
    )
      ? previousCheckpointCandidate
      : undefined;
  const sourceContext = buildMemoryCompactionSourceContext(
    input.entries.map(({ event }) => event),
    throughEvent.id,
    {
      ...(afterEvent ? { afterEventId: afterEvent.id } : {}),
      ...(previousCheckpoint ? { previousCheckpoint } : {}),
    },
  );
  if (!sourceContext) return undefined;
  return {
    ...input.snapshot,
    ...(input.snapshot.trigger === 'compaction'
      ? { sourceSystemPrompt: undefined, sourceProviderOptions: undefined }
      : {}),
    sourceMessages: sourceContext.messages,
    // Automatic extraction is an isolated portable stage. Carrying the Agent's
    // System Prompt or tool catalog adds no interpretation value and can consume
    // the auxiliary context window before any conversation text is considered.
    sourceTools: input.snapshot.trigger === 'compaction' ? {} : input.snapshot.sourceTools,
    sourceActiveTools:
      input.snapshot.trigger === 'compaction'
        ? []
        : input.snapshot.sourceActiveTools.filter(
            (name) => input.snapshot.sourceTools[name]?.kind !== 'provider',
          ),
    ...(sourceContext.eventMessagePositions
      ? { sourceEventMessagePositions: sourceContext.eventMessagePositions }
      : { sourceEventMessagePositions: undefined }),
    ...(input.snapshot.trigger === 'compaction'
      ? { rebuildSourceContextFromCompactionCheckpoint: true as const }
      : {}),
  };
}

function isPolicyDeniedCheckpoint(
  checkpoint: HistoryCompactCheckpoint,
  policyDeniedCheckpointIds: ReadonlySet<string>,
): boolean {
  return (
    checkpoint.memoryExtractionBoundary?.disposition === 'policy_denied' ||
    policyDeniedCheckpointIds.has(checkpoint.checkpointId)
  );
}

function latestPolicyDeniedBoundaryOrdinal(
  checkpoints: readonly HistoryCompactCheckpoint[],
  entries: readonly MemoryExtractionEventEntry[],
  policyDeniedCheckpointIds: ReadonlySet<string>,
  throughOrdinal: number,
): number {
  const ordinals = new Map(entries.map(({ ordinal, event }) => [event.id, ordinal]));
  return checkpoints.reduce((latest, checkpoint) => {
    if (!isPolicyDeniedCheckpoint(checkpoint, policyDeniedCheckpointIds)) return latest;
    const boundaryId = checkpoint.memoryExtractionBoundary?.runtimeEventId;
    const ordinal = boundaryId ? ordinals.get(boundaryId) : undefined;
    return ordinal !== undefined && ordinal <= throughOrdinal ? Math.max(latest, ordinal) : latest;
  }, 0);
}

function checkpointSummaryIsPolicySafe(
  checkpoint: HistoryCompactCheckpoint,
  checkpoints: readonly HistoryCompactCheckpoint[],
  policyDeniedCheckpointIds: ReadonlySet<string>,
): boolean {
  const byId = new Map(checkpoints.map((candidate) => [candidate.checkpointId, candidate]));
  const seen = new Set<string>();
  let current: HistoryCompactCheckpoint | undefined = checkpoint;
  while (current) {
    if (seen.has(current.checkpointId)) return false;
    seen.add(current.checkpointId);
    if (isPolicyDeniedCheckpoint(current, policyDeniedCheckpointIds)) return false;
    if (!current.previousCheckpointId) return true;
    current = byId.get(current.previousCheckpointId);
    if (!current) return false;
  }
  return true;
}

function latestCheckpointAtOrBefore(
  checkpoints: readonly HistoryCompactCheckpoint[],
  entries: readonly MemoryExtractionEventEntry[],
  throughOrdinal: number,
): HistoryCompactCheckpoint | undefined {
  const ordinals = new Map(entries.map(({ ordinal, event }) => [event.id, ordinal]));
  return checkpoints
    .flatMap((checkpoint) => {
      const ordinal = ordinals.get(checkpoint.coverage.through.runtimeEventId);
      return ordinal !== undefined && ordinal <= throughOrdinal ? [{ checkpoint, ordinal }] : [];
    })
    .sort(
      (left, right) =>
        right.ordinal - left.ordinal || right.checkpoint.createdAt - left.checkpoint.createdAt,
    )[0]?.checkpoint;
}

function validCompactionBootstrapOrdinal(
  entries: readonly MemoryExtractionEventEntry[],
  checkpoint: HistoryCompactCheckpoint,
): number | undefined {
  const compactable = entries.filter(({ event }) => isHistoryCompactContentEvent(event));
  const matched = matchHistoryCompactCheckpointPrefix(
    checkpoint,
    compactable.map(({ event }) => event),
  );
  if (matched.reason) return undefined;
  if (checkpoint.phase === 'mid_turn' && checkpoint.headAnchor) {
    const anchorIndex = entries.findIndex(
      ({ event }) => event.id === checkpoint.headAnchor!.runtimeEventId,
    );
    return anchorIndex > 0 ? entries[anchorIndex - 1]!.ordinal : undefined;
  }
  const throughId = matched.coveredRuntimeEvents.at(-1)?.id;
  if (!throughId) return undefined;
  return entries.find(({ event }) => event.id === throughId)?.ordinal;
}

function findExtractionBoundary(
  entries: readonly MemoryExtractionEventEntry[],
  snapshot: MemoryExtractionSourceSnapshot,
): MemoryExtractionEventEntry | undefined {
  if (snapshot.trigger === 'extract') {
    return entries.find(
      ({ event }) =>
        event.id === snapshot.terminalEventId &&
        event.runId === snapshot.runId &&
        event.turnId === snapshot.turnId,
    );
  }
  if (snapshot.trigger === 'compaction') {
    if (!snapshot.compactionCheckpointId || !snapshot.compactionBoundaryEventId) return undefined;
    return entries.find(
      ({ event }) =>
        event.id === snapshot.compactionBoundaryEventId && event.sessionId === snapshot.sessionId,
    );
  }
  if (!snapshot.toolCallId) return undefined;
  const callIndex = entries.findIndex(
    ({ event }) =>
      event.runId === snapshot.runId &&
      event.turnId === snapshot.turnId &&
      event.content?.kind === 'function_call' &&
      event.content.id === snapshot.toolCallId &&
      event.content.name === MEMORY_REMEMBER_TOOL_NAME,
  );
  if (callIndex < 1) return undefined;
  for (let index = callIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!entry.event.partial && !isMemoryEvent(entry.event)) return entry;
  }
  return undefined;
}

function isMemoryEvent(event: MemoryExtractionEventEntry['event']): boolean {
  return (
    (event.content?.kind === 'function_call' || event.content?.kind === 'function_response') &&
    isMemoryToolName(event.content.name)
  );
}

function memoryItemWrite(
  snapshot: MemoryExtractionSourceSnapshot,
  fields: AdmittedProposalFields,
  requested: boolean,
): MemoryItemWrite {
  const sources = new Map<string, MemoryItemWrite['sources'][number]>();
  for (const event of fields.citedEvents) {
    sources.set(event.id, {
      sessionId: event.sessionId,
      runId: event.runId,
      turnId: event.turnId,
      eventId: event.id,
    });
  }
  return {
    content: fields.content,
    kind: fields.kind,
    statementType: fields.statementType,
    temporalType: fields.temporalType,
    scopeType: fields.scopeType,
    scopeKey: fields.scopeType === 'workspace' ? snapshot.workspaceKey : null,
    eventStartedAt: fields.eventStartedAt,
    eventEndedAt: fields.eventEndedAt,
    observedAt: minuteTimestamp(Math.max(...fields.citedEvents.map((event) => event.ts))),
    origin: requested ? 'user_requested' : 'agent_extracted',
    keys: fields.keys.map(({ key, keyType }) => ({
      key,
      keyType,
      keyOrigin: requested ? 'user' : 'llm',
    })),
    sources: [...sources.values()],
  };
}

function rememberResultFromReceipt(
  trigger: MemoryExtractionTrigger,
  receipt: MemoryExtractionReceipt,
): MemoryRememberResult {
  if (trigger !== 'remember') return unavailableMemoryResult();
  if (receipt.status === 'discarded') return unavailableMemoryResult();
  if (receipt.status === 'remembered' && receipt.requestedItems.length > 0) {
    return { status: 'remembered', requestedItems: receipt.requestedItems };
  }
  return {
    status: 'not_applicable',
    requestedItems: [],
    ...(receipt.noOpReason ? { reason: receipt.noOpReason } : {}),
  };
}

function unavailableMemoryResult(): MemoryRememberResult {
  return { status: 'unavailable', requestedItems: [] };
}
