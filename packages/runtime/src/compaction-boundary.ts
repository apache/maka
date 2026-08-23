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

import type {
  CompactionDecisionDiagnostic,
  ContextBudgetDiagnostic,
} from '@maka/core/usage-stats/types';

export type CompactionStage = 'priorReplay' | 'activeStep';
export type CompactionSourceKind = 'runtimeEvents' | 'providerMessages';
export type CompactionBoundaryKind =
  | 'historyCompact'
  | 'synthesisCache'
  | 'staleToolResultPrune'
  | 'activeToolResultPrune'
  | 'semanticCompact';
export type CompactionDecisionKind = 'unchanged' | 'replaced' | 'failedOpen';

export interface CompactionCoverage {
  turnIds?: readonly string[];
  runtimeEventIds?: readonly string[];
  toolCallIds?: readonly string[];
  contentKinds?: readonly string[];
  bodySha256?: readonly string[];
  providerMessageSourceIds?: readonly string[];
}

export interface CompactionArchiveRef {
  kind: 'toolResult' | 'runtimeEventSource' | 'compactSource';
  sessionId?: string;
  turnId?: string;
  runtimeEventId?: string;
  toolCallId?: string;
  toolName?: string;
  artifactId: string;
  bodySha256: string;
  originalEstimatedTokens?: number;
  originalBytes?: number;
}

export interface CompactionBoundary {
  kind: CompactionBoundaryKind;
  stage: CompactionStage;
  schemaVersion: number;
  boundaryId: string;
  predecessorBoundaryId?: string;
  cumulativeCoverageDigest?: string;
  sessionId: string;
  createdAt?: number;
  highWaterName?: string;
  highWaterSeq?: number;
  coverage: CompactionCoverage;
  preservedAnchor?: {
    headProviderMessageSourceIds?: readonly string[];
    headRuntimeEventIds?: readonly string[];
    tailRuntimeEventIds?: readonly string[];
    tailProviderMessageSourceIds?: readonly string[];
    tailTurnIds?: readonly string[];
  };
  archiveRefs?: readonly CompactionArchiveRef[];
  sourceHashes?: readonly string[];
  renderedText?: string;
  estimatedTokens?: number;
  validationStatus?: 'valid' | 'invalid' | 'notValidated';
  validationReason?: string;
}

export interface CompactionDecision {
  stage: CompactionStage;
  sourceKind: CompactionSourceKind;
  decision: CompactionDecisionKind;
  /** Compaction phase; absent = pre_turn. */
  phase?: 'pre_turn' | 'mid_turn';
  boundaryKind?: CompactionBoundaryKind;
  boundaryIds?: readonly string[];
  coverage?: CompactionCoverage;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  estimatedTokensSaved?: number;
  candidateEstimatedTokens?: number;
  preservedHeadEstimatedTokens?: number;
  preservedTailEstimatedTokens?: number;
  acceptedProjectionEstimatedTokens?: number;
  compactCallUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    totalTokens?: number;
  };
  reason?: string;
  failOpenReason?: string;
  skippedReasonCounts?: Readonly<Record<string, number>>;
  validationReasonCounts?: Readonly<Record<string, number>>;
}

export interface HistoryCompactBoundaryLike {
  version: number;
  blockId: string;
  sessionId: string;
  createdAt: number;
  highWaterName: string;
  highWaterSeq: number;
  coverage: {
    turnIds: readonly string[];
    runtimeEventIds: readonly string[];
    contentKinds: readonly string[];
    bodySha256: readonly string[];
  };
  sourceArchiveRefs?: readonly {
    runtimeEventId: string;
    artifactId: string;
    bodySha256: string;
    originalEstimatedTokens: number;
    originalBytes: number;
  }[];
  estimatedTokens?: number;
}

export function historyCompactBlockToCompactionBoundary(
  block: HistoryCompactBoundaryLike,
  options: {
    stage?: CompactionStage;
    renderedText?: string;
    preservedAnchor?: CompactionBoundary['preservedAnchor'];
    validationStatus?: CompactionBoundary['validationStatus'];
    validationReason?: string;
  } = {},
): CompactionBoundary {
  return {
    kind: 'historyCompact',
    stage: options.stage ?? 'priorReplay',
    schemaVersion: block.version,
    boundaryId: block.blockId,
    sessionId: block.sessionId,
    createdAt: block.createdAt,
    highWaterName: block.highWaterName,
    highWaterSeq: block.highWaterSeq,
    coverage: {
      turnIds: block.coverage.turnIds,
      runtimeEventIds: block.coverage.runtimeEventIds,
      contentKinds: block.coverage.contentKinds,
      bodySha256: block.coverage.bodySha256,
    },
    ...(options.preservedAnchor ? { preservedAnchor: options.preservedAnchor } : {}),
    ...(block.sourceArchiveRefs && block.sourceArchiveRefs.length > 0
      ? {
          archiveRefs: block.sourceArchiveRefs.map((ref) => ({
            kind: 'runtimeEventSource' as const,
            sessionId: block.sessionId,
            runtimeEventId: ref.runtimeEventId,
            artifactId: ref.artifactId,
            bodySha256: ref.bodySha256,
            originalEstimatedTokens: ref.originalEstimatedTokens,
            originalBytes: ref.originalBytes,
          })),
        }
      : {}),
    sourceHashes: block.coverage.bodySha256,
    ...(options.renderedText !== undefined ? { renderedText: options.renderedText } : {}),
    ...(block.estimatedTokens !== undefined ? { estimatedTokens: block.estimatedTokens } : {}),
    validationStatus: options.validationStatus ?? 'notValidated',
    ...(options.validationReason ? { validationReason: options.validationReason } : {}),
  };
}

export function compactionDecisionToDiagnostic(
  decision: CompactionDecision,
): CompactionDecisionDiagnostic {
  const estimatedTokensSaved =
    decision.estimatedTokensSaved ??
    (decision.estimatedTokensBefore !== undefined && decision.estimatedTokensAfter !== undefined
      ? Math.max(0, decision.estimatedTokensBefore - decision.estimatedTokensAfter)
      : undefined);
  return {
    stage: decision.stage,
    sourceKind: decision.sourceKind,
    decision: decision.decision,
    ...(decision.phase ? { phase: decision.phase } : {}),
    ...(decision.boundaryKind ? { boundaryKind: decision.boundaryKind } : {}),
    ...(decision.boundaryIds ? { boundaryIds: [...decision.boundaryIds] } : {}),
    ...(decision.coverage?.turnIds ? { coveredTurns: decision.coverage.turnIds.length } : {}),
    ...(decision.coverage?.runtimeEventIds
      ? { coveredRuntimeEvents: decision.coverage.runtimeEventIds.length }
      : {}),
    ...(decision.coverage?.toolCallIds
      ? { coveredToolCalls: decision.coverage.toolCallIds.length }
      : {}),
    ...(decision.coverage?.providerMessageSourceIds
      ? { coveredProviderMessages: decision.coverage.providerMessageSourceIds.length }
      : {}),
    ...(decision.coverage?.bodySha256 ? { coverageHashes: [...decision.coverage.bodySha256] } : {}),
    ...(decision.estimatedTokensBefore !== undefined
      ? { estimatedTokensBefore: decision.estimatedTokensBefore }
      : {}),
    ...(decision.estimatedTokensAfter !== undefined
      ? { estimatedTokensAfter: decision.estimatedTokensAfter }
      : {}),
    ...(estimatedTokensSaved !== undefined ? { estimatedTokensSaved } : {}),
    ...(decision.candidateEstimatedTokens !== undefined
      ? { candidateEstimatedTokens: decision.candidateEstimatedTokens }
      : {}),
    ...(decision.preservedHeadEstimatedTokens !== undefined
      ? { preservedHeadEstimatedTokens: decision.preservedHeadEstimatedTokens }
      : {}),
    ...(decision.preservedTailEstimatedTokens !== undefined
      ? { preservedTailEstimatedTokens: decision.preservedTailEstimatedTokens }
      : {}),
    ...(decision.acceptedProjectionEstimatedTokens !== undefined
      ? { acceptedProjectionEstimatedTokens: decision.acceptedProjectionEstimatedTokens }
      : {}),
    ...(decision.compactCallUsage?.inputTokens !== undefined
      ? { compactCallInputTokens: decision.compactCallUsage.inputTokens }
      : {}),
    ...(decision.compactCallUsage?.outputTokens !== undefined
      ? { compactCallOutputTokens: decision.compactCallUsage.outputTokens }
      : {}),
    ...(decision.compactCallUsage?.cacheReadInputTokens !== undefined
      ? { compactCallCacheReadInputTokens: decision.compactCallUsage.cacheReadInputTokens }
      : {}),
    ...(decision.compactCallUsage?.cacheWriteInputTokens !== undefined
      ? { compactCallCacheWriteInputTokens: decision.compactCallUsage.cacheWriteInputTokens }
      : {}),
    ...(decision.compactCallUsage?.totalTokens !== undefined
      ? { compactCallTotalTokens: decision.compactCallUsage.totalTokens }
      : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.failOpenReason ? { failOpenReason: decision.failOpenReason } : {}),
    ...(decision.skippedReasonCounts
      ? { skippedReasonCounts: { ...decision.skippedReasonCounts } }
      : {}),
    ...(decision.validationReasonCounts
      ? { validationReasonCounts: { ...decision.validationReasonCounts } }
      : {}),
  };
}

export function compactionDecisionDiagnosticPatch(
  decision: CompactionDecision,
): Partial<ContextBudgetDiagnostic> {
  return { compactionDecisions: [compactionDecisionToDiagnostic(decision)] };
}
