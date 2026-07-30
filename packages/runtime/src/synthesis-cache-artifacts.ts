import type { ArtifactRecord, ArtifactSource } from '@maka/core';
import { estimateTokens } from './context-budget-helpers.js';
import {
  buildSynthesisCacheBlocksFromHydratedArchives,
  validateSynthesisCacheBlockShape,
  type SynthesisCacheBlock,
} from './synthesis-cache.js';
import type {
  SynthesisCacheLoadInput,
  SynthesisCacheLoadResult,
  SynthesisCacheWriteInput,
  SynthesisCacheWriteResult,
} from './ai-sdk-compaction-contract.js';

/**
 * The synthesis-cache persistence glue lives here (rather than on a desktop or
 * headless surface) so every embedder shares one implementation — mirroring the
 * sibling `history-compact-artifacts` module. It is typed against the
 * *structural* artifact-store contract below instead of importing
 * `@maka/storage`, keeping runtime storage-agnostic; `@maka/storage`'s
 * `ArtifactStore` satisfies this interface, so desktop and headless both pass
 * their real store unchanged.
 */
export interface SynthesisCacheArtifactStore {
  create(input: {
    id?: string;
    sessionId: string;
    turnId: string;
    name: string;
    kind: 'file';
    content: string;
    mimeType?: string;
    source: ArtifactSource;
    summary?: string;
    now?: number;
  }): Promise<ArtifactRecord>;
  list(sessionId: string, options?: { includeDeleted?: boolean }): Promise<ArtifactRecord[]>;
  readText(
    artifactId: string,
    options?: { maxBytes?: number },
  ): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
}

export interface PersistSynthesisCacheBlocksDeps {
  now?: () => number;
  onArtifactCreated?: (artifact: ArtifactRecord) => void | Promise<void>;
}

export async function persistSynthesisCacheBlocksToArtifacts(
  artifactStore: Pick<SynthesisCacheArtifactStore, 'create'>,
  input: SynthesisCacheWriteInput,
  deps: PersistSynthesisCacheBlocksDeps = {},
): Promise<SynthesisCacheWriteResult> {
  const now = deps.now?.() ?? Date.now();
  const built = buildSynthesisCacheBlocksFromHydratedArchives({
    sessionId: input.sessionId,
    query: input.source.query,
    hydratedRuntimeEvents: input.source.hydratedRuntimeEvents,
    retrievedArchiveRefs: input.source.retrievedArchiveRefs,
    archiveRetrievalMode: input.source.archiveRetrievalMode,
    limits: input.limits,
    ...(input.requestShapeHashBefore
      ? { requestShapeHashBefore: input.requestShapeHashBefore }
      : {}),
    ...(input.requestShapeHashAfter ? { requestShapeHashAfter: input.requestShapeHashAfter } : {}),
    now,
  });
  const persisted: SynthesisCacheBlock[] = [];
  for (const block of built.blocks) {
    const artifact = await artifactStore.create({
      sessionId: input.sessionId,
      turnId: input.turnId,
      name: `synthesis-cache-${block.blockId}.json`,
      kind: 'file',
      content: JSON.stringify(block, null, 2),
      mimeType: 'application/json',
      source: 'synthesis_cache_block',
      summary: 'Synthesis cache block for context budget replay',
      now,
    });
    await deps.onArtifactCreated?.(artifact);
    persisted.push(block);
  }
  return {
    blocks: persisted,
    ...(built.skipped > 0 ? { skipped: built.skipped } : {}),
    ...(built.skippedReasonCounts ? { skippedReasonCounts: built.skippedReasonCounts } : {}),
  };
}

export async function loadSynthesisCacheBlocksFromArtifacts(
  artifactStore: Pick<SynthesisCacheArtifactStore, 'list' | 'readText'>,
  input: SynthesisCacheLoadInput,
): Promise<SynthesisCacheLoadResult> {
  const maxBlocks = input.maxBlocks ?? 1;
  const maxEstimatedTokens = input.maxEstimatedTokens ?? 2_048;
  const maxBytes = input.maxBytes ?? maxEstimatedTokens * 4;
  const skippedReasonCounts: Record<string, number> = {};
  const blocks: SynthesisCacheBlock[] = [];
  const records = await artifactStore.list(input.sessionId, { includeDeleted: true });
  for (const record of records) {
    if (record.status !== 'live') {
      incrementSynthesisCacheCount(skippedReasonCounts, 'deleted');
      continue;
    }
    if (record.source !== 'synthesis_cache_block' || record.kind !== 'file') {
      continue;
    }
    if (record.sessionId !== input.sessionId) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'session_mismatch');
      continue;
    }
    if (blocks.length >= maxBlocks) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'max_blocks');
      continue;
    }
    if (record.sizeBytes > maxBytes) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'max_bytes');
      continue;
    }
    const read = await artifactStore.readText(record.id, { maxBytes });
    if (!read.ok) {
      incrementSynthesisCacheCount(skippedReasonCounts, read.reason);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text) as unknown;
    } catch {
      incrementSynthesisCacheCount(skippedReasonCounts, 'invalid_json');
      continue;
    }
    if (hasSessionId(parsed) && parsed.sessionId !== input.sessionId) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'session_mismatch');
      continue;
    }
    if (!validateSynthesisCacheBlockShape(parsed, input.sessionId)) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'invalid_schema_version');
      continue;
    }
    const block = parsed as SynthesisCacheBlock;
    const estimatedTokens = block.estimatedTokens ?? estimateTokens(read.text.length, 4);
    if (estimatedTokens > maxEstimatedTokens) {
      incrementSynthesisCacheCount(skippedReasonCounts, 'max_total_tokens');
      continue;
    }
    blocks.push({
      ...block,
      estimatedTokens,
    });
  }
  const skipped = Object.values(skippedReasonCounts).reduce((total, count) => total + count, 0);
  return {
    blocks,
    ...(skipped > 0 ? { skipped } : {}),
    ...(skipped > 0 ? { skippedReasonCounts } : {}),
  };
}

function hasSessionId(value: unknown): value is { sessionId: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    'sessionId' in value &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string'
  );
}

function incrementSynthesisCacheCount(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}
