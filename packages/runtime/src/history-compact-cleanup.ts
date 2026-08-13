import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ArtifactRecord } from '@maka/core/artifacts';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { estimateRuntimeEventsTokens } from './context-budget-helpers.js';
import {
  validateHistoryCompactBlockShape,
  type HistoryCompactBlock,
  type HistoryCompactSourceArchiveRef,
} from './history-compact.js';
import type { HistoryCompactArtifactStore } from './history-compact-artifacts.js';
import {
  matchHistoryCompactCheckpointPrefix,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import { stableStringify } from './request-shape.js';

export interface HistoryCompactCleanupSkip {
  artifactId: string;
  reason: string;
}

export interface HistoryCompactCleanupResult {
  purgedArtifactIds: string[];
  skipped: HistoryCompactCleanupSkip[];
}

export type HistoryCompactCleanupDiagnostic =
  | {
      kind: 'skipped';
      artifactCount: number;
      reasonCounts: Record<string, number>;
    }
  | {
      kind: 'failed';
      message: string;
    };

interface HistoryCompactCleanupInput {
  sessionId: string;
  checkpoint: HistoryCompactCheckpoint;
  runtimeEvents: readonly RuntimeEvent[];
  artifactStore: Pick<HistoryCompactArtifactStore, 'list' | 'readText' | 'purge'>;
  onDiagnostic?: (diagnostic: HistoryCompactCleanupDiagnostic) => void;
}

export async function cleanupLegacyHistoryCompactArtifacts(
  input: HistoryCompactCleanupInput,
): Promise<HistoryCompactCleanupResult> {
  try {
    return await runLegacyHistoryCompactCleanup(input);
  } catch (error) {
    emitDiagnostic(input.onDiagnostic, {
      kind: 'failed',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runLegacyHistoryCompactCleanup(
  input: HistoryCompactCleanupInput,
): Promise<HistoryCompactCleanupResult> {
  const records = (
    await input.artifactStore.list(input.sessionId, { includeDeleted: true })
  ).filter(
    (record) =>
      record.source === 'history_compact_block' || record.source === 'history_compact_source',
  );
  const compactableEvents = input.runtimeEvents.filter(
    (event) => estimateRuntimeEventsTokens([event], 4) > 0,
  );
  const checkpointMatch = matchHistoryCompactCheckpointPrefix(input.checkpoint, compactableEvents);
  if (checkpointMatch.reason) {
    return reportCleanupResult(input.onDiagnostic, {
      purgedArtifactIds: [],
      skipped: records.map((record) => ({
        artifactId: record.id,
        reason: `checkpoint_${checkpointMatch.reason}`,
      })),
    });
  }

  const recordsById = new Map(records.map((record) => [record.id, record] as const));
  const eligibleIds = new Set<string>();
  const skipReasons = new Map<string, string>();
  for (const blockRecord of records.filter((record) => record.source === 'history_compact_block')) {
    const read = await input.artifactStore.readText(blockRecord.id, {
      maxBytes: blockRecord.sizeBytes,
      includeDeleted: true,
    });
    if (!read.ok) {
      skipReasons.set(blockRecord.id, `block_${read.reason}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text) as unknown;
    } catch {
      skipReasons.set(blockRecord.id, 'block_invalid_json');
      continue;
    }
    if (!validateHistoryCompactBlockShape(parsed, input.sessionId)) {
      skipReasons.set(blockRecord.id, 'block_invalid_schema');
      continue;
    }
    const coveredEvents = matchLegacyBlockPrefix(parsed, checkpointMatch.coveredRuntimeEvents);
    if (!coveredEvents) {
      skipReasons.set(blockRecord.id, 'block_coverage_mismatch');
      continue;
    }
    const group = await validateLinkedSourceArtifacts({
      block: parsed,
      coveredEvents,
      recordsById,
      artifactStore: input.artifactStore,
    });
    if (!group.ok) {
      skipReasons.set(blockRecord.id, group.reason);
      for (const artifactId of group.linkedArtifactIds) {
        if (!skipReasons.has(artifactId)) skipReasons.set(artifactId, group.reason);
      }
      continue;
    }
    eligibleIds.add(blockRecord.id);
    for (const artifactId of group.artifactIds) eligibleIds.add(artifactId);
  }

  for (const record of records) {
    if (!eligibleIds.has(record.id) && !skipReasons.has(record.id)) {
      skipReasons.set(
        record.id,
        record.source === 'history_compact_source' ? 'source_unlinked' : 'block_unverified',
      );
    }
  }
  const purgedArtifactIds = [...eligibleIds].sort();
  if (purgedArtifactIds.length > 0) await input.artifactStore.purge(purgedArtifactIds);
  return reportCleanupResult(input.onDiagnostic, {
    purgedArtifactIds,
    skipped: records
      .filter((record) => !eligibleIds.has(record.id))
      .map((record) => ({
        artifactId: record.id,
        reason: skipReasons.get(record.id) ?? 'unverified',
      }))
      .sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
  });
}

function reportCleanupResult(
  onDiagnostic: ((diagnostic: HistoryCompactCleanupDiagnostic) => void) | undefined,
  result: HistoryCompactCleanupResult,
): HistoryCompactCleanupResult {
  if (result.skipped.length === 0) return result;
  const reasonCounts: Record<string, number> = {};
  for (const item of result.skipped) {
    reasonCounts[item.reason] = (reasonCounts[item.reason] ?? 0) + 1;
  }
  emitDiagnostic(onDiagnostic, {
    kind: 'skipped',
    artifactCount: result.skipped.length,
    reasonCounts,
  });
  return result;
}

function emitDiagnostic(
  onDiagnostic: ((diagnostic: HistoryCompactCleanupDiagnostic) => void) | undefined,
  diagnostic: HistoryCompactCleanupDiagnostic,
): void {
  try {
    onDiagnostic?.(diagnostic);
  } catch {
    // Reclaim diagnostics must not change cleanup or replay behavior.
  }
}

function matchLegacyBlockPrefix(
  block: HistoryCompactBlock,
  checkpointEvents: readonly RuntimeEvent[],
): RuntimeEvent[] | undefined {
  const coverageIds = new Set(block.coverage.runtimeEventIds);
  if (coverageIds.size !== block.coverage.runtimeEventIds.length) return undefined;
  const coveredEvents: RuntimeEvent[] = [];
  for (const event of checkpointEvents) {
    if (!coverageIds.has(event.id)) break;
    coveredEvents.push(event);
  }
  if (coveredEvents.length === 0 || coveredEvents.length !== coverageIds.size) return undefined;
  if (
    !sameStrings(
      block.coverage.runtimeEventIds,
      uniqueSorted(coveredEvents.map((event) => event.id)),
    )
  ) {
    return undefined;
  }
  if (
    !sameStrings(block.coverage.turnIds, uniqueSorted(coveredEvents.map((event) => event.turnId)))
  ) {
    return undefined;
  }
  if (
    !sameStrings(
      block.coverage.contentKinds,
      uniqueSorted(coveredEvents.map((event) => event.content?.kind ?? 'none')),
    )
  )
    return undefined;
  if (
    !sameStrings(
      block.coverage.bodySha256,
      uniqueSorted(coveredEvents.map((event) => sha256(stableStringify(event.content ?? {})))),
    )
  )
    return undefined;
  if (block.sourceRefs.length !== coveredEvents.length) return undefined;
  for (let index = 0; index < coveredEvents.length; index += 1) {
    const event = coveredEvents[index]!;
    const ref = block.sourceRefs[index];
    if (
      ref?.kind !== 'runtime_event' ||
      ref.sessionId !== event.sessionId ||
      ref.turnId !== event.turnId ||
      ref.runtimeEventId !== event.id ||
      ref.role !== event.role ||
      ref.contentKind !== (event.content?.kind ?? 'none')
    )
      return undefined;
  }
  return coveredEvents;
}

async function validateLinkedSourceArtifacts(input: {
  block: HistoryCompactBlock;
  coveredEvents: readonly RuntimeEvent[];
  recordsById: ReadonlyMap<string, ArtifactRecord>;
  artifactStore: Pick<HistoryCompactArtifactStore, 'readText'>;
}): Promise<
  { ok: true; artifactIds: string[] } | { ok: false; reason: string; linkedArtifactIds: string[] }
> {
  const refs = input.block.sourceArchiveRefs;
  if (!refs || refs.length !== input.coveredEvents.length) {
    return {
      ok: false,
      reason: 'source_links_missing',
      linkedArtifactIds: refs?.map((ref) => ref.artifactId) ?? [],
    };
  }
  const refsByEventId = new Map<string, HistoryCompactSourceArchiveRef>();
  for (const ref of refs) {
    if (refsByEventId.has(ref.runtimeEventId)) {
      return {
        ok: false,
        reason: 'source_links_duplicate',
        linkedArtifactIds: refs.map((item) => item.artifactId),
      };
    }
    refsByEventId.set(ref.runtimeEventId, ref);
  }
  const artifactIds: string[] = [];
  for (const event of input.coveredEvents) {
    const ref = refsByEventId.get(event.id);
    if (!ref) {
      return { ok: false, reason: 'source_link_missing', linkedArtifactIds: artifactIds };
    }
    const record = input.recordsById.get(ref.artifactId);
    if (
      !record ||
      record.sessionId !== event.sessionId ||
      record.source !== 'history_compact_source' ||
      record.kind !== 'file'
    ) {
      return {
        ok: false,
        reason: 'source_ownership_mismatch',
        linkedArtifactIds: [...artifactIds, ref.artifactId],
      };
    }
    const read = await input.artifactStore.readText(record.id, {
      maxBytes: record.sizeBytes,
      includeDeleted: true,
    });
    if (!read.ok) {
      return {
        ok: false,
        reason: `source_${read.reason}`,
        linkedArtifactIds: [...artifactIds, record.id],
      };
    }
    let archivedEvent: unknown;
    try {
      archivedEvent = JSON.parse(read.text) as unknown;
    } catch {
      return {
        ok: false,
        reason: 'source_invalid_json',
        linkedArtifactIds: [...artifactIds, record.id],
      };
    }
    const body = serializeSourceBody(event.content ?? {});
    if (
      stableStringify(archivedEvent) !== stableStringify(event) ||
      ref.runtimeEventId !== event.id ||
      ref.bodySha256 !== sha256(body) ||
      ref.originalBytes !== Buffer.byteLength(body, 'utf8')
    ) {
      return {
        ok: false,
        reason: 'source_content_mismatch',
        linkedArtifactIds: [...artifactIds, record.id],
      };
    }
    artifactIds.push(record.id);
  }
  return { ok: true, artifactIds };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function serializeSourceBody(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
