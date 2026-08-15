import type { AgentRunEvent, AgentRunStore } from '@maka/core/agent-run';
import {
  canReplaceHistoryCompactCheckpoint,
  validateHistoryCompactCheckpointShape,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';

interface LedgerCheckpointCandidate {
  checkpoint: HistoryCompactCheckpoint;
  event: AgentRunEvent;
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
      if (validateHistoryCompactCheckpointShape(checkpoint, sessionId)) {
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
      if (validateHistoryCompactCheckpointShape(checkpoint, sessionId)) return checkpoint;
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
      if (validateHistoryCompactCheckpointShape(checkpoint, sessionId)) {
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
