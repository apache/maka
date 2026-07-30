import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import type { ArtifactRecord, ArtifactTextReadResult } from '@maka/core';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  loadSynthesisCacheBlocksFromArtifacts,
  persistSynthesisCacheBlocksToArtifacts,
  type SynthesisCacheArtifactStore,
} from '../synthesis-cache-artifacts.js';
import type { SynthesisCacheBlock, SynthesisSourceRef } from '../context-budget.js';
import type { SynthesisCacheWriteInput } from '../ai-sdk-compaction-contract.js';

/**
 * A faithful in-memory stand-in for `@maka/storage`'s `ArtifactStore`. The glue
 * is typed against the structural artifact-store contract, so runtime can be
 * tested without depending on `@maka/storage`; the real store is exercised
 * end-to-end by the desktop app and the headless Harbor smoke.
 */
class FakeArtifactStore {
  private readonly records: ArtifactRecord[] = [];
  private seq = 0;

  async create(
    input: Parameters<SynthesisCacheArtifactStore['create']>[0],
  ): Promise<ArtifactRecord> {
    const content = input.content;
    const record: ArtifactRecord = {
      id: input.id ?? `artifact-${++this.seq}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      createdAt: input.now ?? 0,
      name: input.name,
      kind: input.kind,
      relativePath: `${input.sessionId}/${input.name}`,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      status: 'live',
    };
    this.records.push(record);
    this.contents.set(record.id, content);
    return record;
  }

  private readonly contents = new Map<string, string>();

  async list(
    sessionId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<ArtifactRecord[]> {
    return this.records.filter(
      (record) =>
        record.sessionId === sessionId && (opts.includeDeleted || record.status === 'live'),
    );
  }

  async readText(
    artifactId: string,
    opts: { maxBytes?: number } = {},
  ): Promise<ArtifactTextReadResult> {
    const text = this.contents.get(artifactId);
    if (text === undefined) return { ok: false, reason: 'not_found' };
    if (opts.maxBytes !== undefined && Buffer.byteLength(text, 'utf8') > opts.maxBytes) {
      return { ok: false, reason: 'too_large' };
    }
    return { ok: true, text };
  }

  async delete(artifactId: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.id === artifactId);
    if (record) record.status = 'deleted';
  }
}

describe('synthesis cache artifact lifecycle', () => {
  test('persists generated synthesis blocks and loads them back through the artifact store', async () => {
    const store = new FakeArtifactStore();
    const sourceResult = {
      key: 'key-alpha',
      sentinel: 'SYNTH_SENTINEL',
      rows: ['stable fact row'],
    };
    const sourceRef = archiveSourceRef({
      bodySha256: sha256(JSON.stringify(sourceResult)),
      originalBytes: Buffer.byteLength(JSON.stringify(sourceResult), 'utf8'),
    });
    const input: SynthesisCacheWriteInput = {
      sessionId: 'session-1',
      turnId: 'turn-write',
      source: {
        createdFrom: 'gated_archive_retrieval',
        query: 'Recover key-alpha sentinel',
        hydratedRuntimeEvents: [toolResultEvent(sourceResult)],
        retrievedArchiveRefs: [sourceRef],
        archiveRetrievalMode: 'history_search_gated',
      },
      limits: {
        maxBlocks: 1,
        maxBlockEstimatedTokens: 1_024,
        maxEstimatedTokens: 2_048,
        charsPerToken: 4,
      },
    };

    const createdArtifacts: string[] = [];
    const write = await persistSynthesisCacheBlocksToArtifacts(store, input, {
      now: () => 1_800_000_000_100,
      onArtifactCreated: (artifact) => {
        createdArtifacts.push(artifact.id);
      },
    });
    assert.equal(write.blocks.length, 1);
    assert.equal(createdArtifacts.length, 1);

    const records = await store.list('session-1');
    assert.equal(records.length, 1);
    assert.equal(records[0]?.source, 'synthesis_cache_block');
    assert.equal(records[0]?.kind, 'file');

    const loaded = await loadSynthesisCacheBlocksFromArtifacts(store, {
      sessionId: 'session-1',
      maxBlocks: 1,
      maxEstimatedTokens: 2_048,
      maxBytes: 16_384,
    });
    assert.equal(loaded.blocks.length, 1);
    assert.equal(loaded.blocks[0]?.blockId, write.blocks[0]?.blockId);
    assert.equal(loaded.skipped, undefined);
  });

  test('rejects deleted, wrong-source, wrong-session, malformed, wrong-version, and oversized blocks', async () => {
    const store = new FakeArtifactStore();
    await store.create({
      id: 'valid',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'valid.json',
      kind: 'file',
      content: JSON.stringify(synthesisBlock({ blockId: 'valid' })),
      mimeType: 'application/json',
      source: 'synthesis_cache_block',
      now: 100,
    });
    await store.create({
      id: 'wrong-source',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'wrong-source.json',
      kind: 'file',
      content: JSON.stringify(synthesisBlock({ blockId: 'wrong-source' })),
      mimeType: 'application/json',
      source: 'tool_result_archive',
      now: 110,
    });
    await store.create({
      id: 'wrong-session',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'wrong-session.json',
      kind: 'file',
      content: JSON.stringify(
        synthesisBlock({ blockId: 'wrong-session', sessionId: 'session-other' }),
      ),
      mimeType: 'application/json',
      source: 'synthesis_cache_block',
      now: 120,
    });
    await store.create({
      id: 'invalid-json',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'invalid-json.json',
      kind: 'file',
      content: '{not-json',
      mimeType: 'application/json',
      source: 'synthesis_cache_block',
      now: 130,
    });
    await store.create({
      id: 'wrong-version',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'wrong-version.json',
      kind: 'file',
      content: JSON.stringify({ ...synthesisBlock({ blockId: 'wrong-version' }), version: 2 }),
      mimeType: 'application/json',
      source: 'synthesis_cache_block',
      now: 140,
    });
    await store.create({
      id: 'bad-estimate',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'bad-estimate.json',
      kind: 'file',
      content: JSON.stringify({
        ...synthesisBlock({ blockId: 'bad-estimate' }),
        estimatedTokens: 'tiny',
      }),
      mimeType: 'application/json',
      source: 'synthesis_cache_block',
      now: 145,
    });
    await store.create({
      id: 'oversized',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'oversized.json',
      kind: 'file',
      content: JSON.stringify(synthesisBlock({ blockId: 'oversized', estimatedTokens: 999 })),
      mimeType: 'application/json',
      source: 'synthesis_cache_block',
      now: 150,
    });
    await store.create({
      id: 'deleted',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'deleted.json',
      kind: 'file',
      content: JSON.stringify(synthesisBlock({ blockId: 'deleted' })),
      mimeType: 'application/json',
      source: 'synthesis_cache_block',
      now: 160,
    });
    await store.delete('deleted');

    const loaded = await loadSynthesisCacheBlocksFromArtifacts(store, {
      sessionId: 'session-1',
      maxBlocks: 10,
      maxEstimatedTokens: 100,
      maxBytes: 20_000,
    });

    assert.deepEqual(
      loaded.blocks.map((block) => block.blockId),
      ['valid'],
    );
    assert.equal(loaded.skippedReasonCounts?.deleted, 1);
    assert.equal(loaded.skippedReasonCounts?.session_mismatch, 1);
    assert.equal(loaded.skippedReasonCounts?.invalid_json, 1);
    assert.equal(loaded.skippedReasonCounts?.invalid_schema_version, 2);
    assert.equal(loaded.skippedReasonCounts?.max_total_tokens, 1);
  });
});

function toolResultEvent(result: unknown): RuntimeEvent {
  return {
    id: 'runtime-result-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    invocationId: 'invocation-1',
    ts: 1_800_000_000_000,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'tool-call-1',
      name: 'Read',
      result,
    },
  };
}

function archiveSourceRef(
  overrides: Partial<Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }>> = {},
): Extract<SynthesisSourceRef, { kind: 'archived_tool_result' }> {
  return {
    kind: 'archived_tool_result',
    sessionId: 'session-1',
    turnId: 'turn-1',
    runtimeEventId: 'runtime-result-1',
    toolCallId: 'tool-call-1',
    toolName: 'Read',
    artifactId: 'archive-artifact-1',
    bodySha256: sha256('archive'),
    originalEstimatedTokens: 12,
    originalBytes: 48,
    placeholderReason: 'stale_tool_result_pruned_before_compact',
    ...overrides,
  };
}

function synthesisBlock(overrides: Partial<SynthesisCacheBlock> = {}): SynthesisCacheBlock {
  const sessionId = overrides.sessionId ?? 'session-1';
  const blockId = overrides.blockId ?? 'valid';
  return {
    kind: 'maka.synthesis_cache_block',
    version: 1,
    blockId,
    sessionId,
    createdAt: 1_800_000_000_000,
    highWaterName: `high-water-${blockId}`,
    highWaterSeq: 1,
    coverage: {
      queryKeys: ['key-alpha'],
      turnIds: ['turn-1'],
      runtimeEventIds: ['runtime-result-1'],
      toolNames: ['Read'],
      toolCallIds: ['tool-call-1'],
      artifactIds: ['archive-artifact-1'],
      bodySha256: [sha256('archive')],
    },
    summary: 'The stable answer for key-alpha is SYNTH_SENTINEL.',
    limitations: ['Raw output is not included.'],
    sourceRefs: [archiveSourceRef({ sessionId })],
    estimatedTokens: 24,
    createdFrom: 'gated_archive_retrieval',
    ...overrides,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
