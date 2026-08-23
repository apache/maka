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

import type { AgentRunEvent, AgentRunStore } from '@maka/core/agent-run';
import {
  canReplaceHistoryCompactCheckpoint,
  isTextHistoryCompactCheckpoint,
  validateHistoryCompactCheckpointShape,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import {
  findCheckpointSummaryDefect,
  findCheckpointSummaryTruncationDefect,
} from './history-compact-summary-validation.js';

interface LedgerCheckpointCandidate {
  checkpoint: HistoryCompactCheckpoint;
  event: AgentRunEvent;
}

/**
 * Version-aware semantic admission at the load authority (#3029, #3041).
 * A checkpoint stamped with the sectioned summary format is held to the
 * complete shared predicate (minus the size floor, whose covered-span
 * estimate is not durable), so a malformed summary that slipped through a
 * direct recorder or copy seam never becomes authoritative again after
 * restart. Unmarked legacy checkpoints predate the sectioned contract, so
 * their summaries may omit `## Goal` etc. and remain usable; only a
 * truncated fragment — which poisons every subsequent replay with a
 * half-finished thought regardless of writer — is quarantined.
 */
function hasLoadableHistoryCompactSummary(checkpoint: HistoryCompactCheckpoint): boolean {
  if (!isTextHistoryCompactCheckpoint(checkpoint)) return true;
  if (checkpoint.summaryFormat !== undefined) {
    return findCheckpointSummaryDefect(checkpoint.summary) === undefined;
  }
  return findCheckpointSummaryTruncationDefect(checkpoint.summary) === undefined;
}

export async function loadHistoryCompactCheckpointsFromRunLedger(
  runStore: Pick<AgentRunStore, 'listSessionRuns' | 'readEvents'>,
  sessionId: string,
): Promise<HistoryCompactCheckpoint[]> {
  const checkpoints = new Map<string, HistoryCompactCheckpoint>();
  for (const run of await runStore.listSessionRuns(sessionId)) {
    for (const event of await runStore.readEvents(sessionId, run.runId)) {
      if (event.type !== 'history_compact_checkpoint_recorded') continue;
      const checkpoint = event.data?.checkpoint;
      if (
        validateHistoryCompactCheckpointShape(checkpoint, sessionId) &&
        hasLoadableHistoryCompactSummary(checkpoint)
      ) {
        checkpoints.set(checkpoint.checkpointId, checkpoint);
      }
    }
  }
  return [...checkpoints.values()];
}

export async function loadLatestHistoryCompactCheckpointFromRunLedger(
  runStore: Pick<
    AgentRunStore,
    'listSessionRuns' | 'readEvents' | 'readEventProjection' | 'repairEventProjection'
  >,
  sessionId: string,
): Promise<HistoryCompactCheckpoint | undefined> {
  let replaceEventId: string | undefined;
  if (runStore.readEventProjection) {
    try {
      const projected = await runStore.readEventProjection(
        sessionId,
        'history_compact_checkpoint_recorded',
      );
      if (projected === null) return undefined;
      const checkpoint = projected?.data?.checkpoint;
      if (
        validateHistoryCompactCheckpointShape(checkpoint, sessionId) &&
        hasLoadableHistoryCompactSummary(checkpoint)
      ) {
        return checkpoint;
      }
      replaceEventId = projected?.id;
    } catch {
      // Recover the derived projection from the canonical ledger below.
    }
  }
  const runs = await runStore.listSessionRuns(sessionId);
  const candidates: LedgerCheckpointCandidate[] = [];
  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
    const run = runs[runIndex]!;
    const events = await runStore.readEvents(sessionId, run.runId);
    for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
      const event = events[eventIndex]!;
      if (event.type !== 'history_compact_checkpoint_recorded') continue;
      const checkpoint = event.data?.checkpoint;
      if (
        validateHistoryCompactCheckpointShape(checkpoint, sessionId) &&
        hasLoadableHistoryCompactSummary(checkpoint)
      ) {
        candidates.push({ checkpoint, event });
      }
    }
  }
  const selected = selectRecoveredCheckpoint(candidates);
  await runStore
    .repairEventProjection?.(
      sessionId,
      'history_compact_checkpoint_recorded',
      selected?.event ?? null,
      replaceEventId ? { replaceEventId } : undefined,
    )
    .catch(() => {
      // Recovery succeeded; a later cold read can retry this derived-state repair.
    });
  return selected?.checkpoint;
}

function selectRecoveredCheckpoint(
  candidates: readonly LedgerCheckpointCandidate[],
): LedgerCheckpointCandidate | undefined {
  // Once source-bound checkpoints exist, never recover a legacy checkpoint
  // that cannot prove its projection ordering/cursors, even if it was written
  // later by an older binary.
  const sourceBound = candidates.filter((candidate) => candidate.checkpoint.source !== undefined);
  const compatible = sourceBound.length > 0 ? sourceBound : candidates;
  const maxCoverage = compatible.reduce(
    (max, candidate) => Math.max(max, candidate.checkpoint.coverage.eventCount),
    0,
  );
  const furthest = compatible.filter(
    (candidate) => candidate.checkpoint.coverage.eventCount === maxCoverage,
  );
  const byCheckpointId = new Map(
    furthest.map((candidate) => [candidate.checkpoint.checkpointId, candidate] as const),
  );
  const checkpointsWithSuccessors = new Set<string>();
  for (const candidate of furthest) {
    const previousId = candidate.checkpoint.previousCheckpointId;
    const previous = previousId ? byCheckpointId.get(previousId) : undefined;
    if (previous && canReplaceHistoryCompactCheckpoint(previous.checkpoint, candidate.checkpoint)) {
      checkpointsWithSuccessors.add(previous.checkpoint.checkpointId);
    }
  }
  const tips = furthest.filter(
    (candidate) => !checkpointsWithSuccessors.has(candidate.checkpoint.checkpointId),
  );
  const pool = tips.length > 0 ? tips : furthest;
  return pool.reduce<LedgerCheckpointCandidate | undefined>((selected, candidate) => {
    if (!selected) return candidate;
    if (candidate.event.ts !== selected.event.ts) {
      return candidate.event.ts > selected.event.ts ? candidate : selected;
    }
    return candidate.event.id > selected.event.id ? candidate : selected;
  }, undefined);
}
