import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { buildHistoryCompactBlockFromSummary } from '../context-budget.js';
import type { HistoryCompactWriteInput } from '../ai-sdk-compaction-contract.js';
import {
  loadHistoryCompactBlocksFromArtifacts,
  persistHistoryCompactBlocksToArtifacts,
} from '../history-compact-artifacts.js';
import { memoryArtifactStore } from './memory-artifact-store.js';

describe('history compact artifacts', () => {
  test('persists a compact block within default limits when the fold covers many events', async () => {
    const store = memoryArtifactStore();
    const foldedEvents = Array.from({ length: 60 }, (_, index) =>
      textEvent(`old-${index}`, `turn-${Math.floor(index / 4)}`, `folded fact number ${index}`),
    );
    const input: HistoryCompactWriteInput = {
      sessionId: 'session-1',
      turnId: 'turn-write',
      source: {
        draftBlock: buildHistoryCompactBlockFromSummary({
          sessionId: 'session-1',
          foldedRuntimeEvents: foldedEvents,
          summary: 'deterministic fallback',
          highWaterName: 'test-history-compact',
          highWaterSeq: 1,
          now: 1_800_000_000_000,
          charsPerToken: 4,
        }),
        foldedRuntimeEvents: foldedEvents,
      },
      limits: {
        maxBlocks: 1,
        maxBlockEstimatedTokens: 1_024,
        maxEstimatedTokens: 2_048,
        charsPerToken: 4,
      },
    };

    const write = await persistHistoryCompactBlocksToArtifacts(store, input, {
      now: () => 1_800_000_000_100,
      summarize: () => 'short summary of a long session',
    });

    assert.deepEqual(write.skippedReasonCounts, undefined);
    assert.equal(write.blocks.length, 1);
    assert.ok((write.blocks[0]?.estimatedTokens ?? 0) <= 1_024);
    assert.equal(write.blocks[0]?.sourceArchiveRefs?.length, 60);
  });

  test('loads a metadata-heavy block without an explicit byte cap', async () => {
    const store = memoryArtifactStore();
    const foldedEvents = Array.from({ length: 60 }, (_, index) =>
      textEvent(`old-${index}`, `turn-${Math.floor(index / 4)}`, `folded fact number ${index}`),
    );
    const write = await persistHistoryCompactBlocksToArtifacts(
      store,
      {
        sessionId: 'session-1',
        turnId: 'turn-write',
        source: {
          draftBlock: buildHistoryCompactBlockFromSummary({
            sessionId: 'session-1',
            foldedRuntimeEvents: foldedEvents,
            summary: 'deterministic fallback',
            highWaterName: 'test-history-compact',
            highWaterSeq: 1,
            now: 1_800_000_000_000,
            charsPerToken: 4,
          }),
          foldedRuntimeEvents: foldedEvents,
        },
        limits: {
          maxBlocks: 1,
          maxBlockEstimatedTokens: 1_024,
          maxEstimatedTokens: 2_048,
          charsPerToken: 4,
        },
      },
      {
        now: () => 1_800_000_000_100,
        summarize: () => 'short summary of a long session',
      },
    );
    assert.equal(write.blocks.length, 1);

    const loaded = await loadHistoryCompactBlocksFromArtifacts(store, {
      sessionId: 'session-1',
      maxBlocks: 1,
      maxEstimatedTokens: 2_048,
    });

    assert.deepEqual(loaded.skippedReasonCounts, undefined);
    assert.equal(loaded.blocks[0]?.blockId, write.blocks[0]?.blockId);
  });

  test('keeps read-only compatibility with legacy V1 blocks larger than 1 MiB', async () => {
    const store = memoryArtifactStore();
    const foldedEvents = Array.from({ length: 6_000 }, (_, index) =>
      textEvent(`legacy-${index}`, `legacy-turn-${Math.floor(index / 4)}`, `legacy fact ${index}`),
    );
    const block = buildHistoryCompactBlockFromSummary({
      sessionId: 'session-1',
      foldedRuntimeEvents: foldedEvents,
      summary: 'legacy V1 summary',
      highWaterName: 'legacy-history-compact',
      highWaterSeq: 1,
      now: 1_800_000_000_000,
      charsPerToken: 4,
    });
    const serialized = JSON.stringify(block);
    assert.ok(Buffer.byteLength(serialized, 'utf8') > 1_048_576);
    await store.create({
      sessionId: 'session-1',
      turnId: 'turn-write',
      name: `history-compact-${block.blockId}.json`,
      kind: 'file',
      content: serialized,
      mimeType: 'application/json',
      source: 'history_compact_block',
    });

    const loaded = await loadHistoryCompactBlocksFromArtifacts(store, {
      sessionId: 'session-1',
      maxBlocks: 1,
      maxEstimatedTokens: 2_048,
    });

    assert.equal(loaded.blocks[0]?.blockId, block.blockId);
  });

  test('skips a block whose persisted token estimate understates its rendered size', async () => {
    const store = memoryArtifactStore();
    const foldedEvents = [textEvent('old-0', 'turn-0', 'folded fact')];
    const block = buildHistoryCompactBlockFromSummary({
      sessionId: 'session-1',
      foldedRuntimeEvents: foldedEvents,
      summary: 'short summary',
      highWaterName: 'test-history-compact',
      highWaterSeq: 1,
      now: 1_800_000_000_000,
      charsPerToken: 4,
    });
    await store.create({
      sessionId: 'session-1',
      turnId: 'turn-write',
      name: `history-compact-${block.blockId}.json`,
      kind: 'file',
      content: JSON.stringify({
        ...block,
        summary: 'oversized '.repeat(4_000),
        estimatedTokens: 1,
      }),
      mimeType: 'application/json',
      source: 'history_compact_block',
    });

    const loaded = await loadHistoryCompactBlocksFromArtifacts(store, {
      sessionId: 'session-1',
      maxBlocks: 1,
      maxEstimatedTokens: 2_048,
    });

    assert.equal(loaded.blocks.length, 0);
    assert.deepEqual(loaded.skippedReasonCounts, { max_total_tokens: 1 });
  });
});

function textEvent(id: string, turnId: string, text: string): RuntimeEvent {
  return {
    id,
    sessionId: 'session-1',
    runId: 'run-1',
    turnId,
    invocationId: 'invocation-1',
    ts: 1_800_000_000_000,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
}
