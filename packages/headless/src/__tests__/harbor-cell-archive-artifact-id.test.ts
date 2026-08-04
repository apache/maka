import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  buildToolResultArchiveResourceRef,
  parseToolResultArchiveResourceRef,
} from '@maka/runtime';
import { buildHarborCellContextBudgetBackendOptions } from '../harbor-cell-context-budget-env.js';

describe('Harbor archive artifact ids', () => {
  test('grammar-hostile and over-length inputs round-trip through runtime refs', async () => {
    await withArchiveDir(async (archiveDir) => {
      const identities = [
        { sessionId: 'session=1', runtimeEventId: 'event=1' },
        { sessionId: 's'.repeat(96), runtimeEventId: 'e'.repeat(96) },
      ];

      for (const identity of identities) {
        const archived = await archiveToolResult(archiveDir, identity);
        assert.deepEqual(
          parseToolResultArchiveResourceRef(
            buildToolResultArchiveResourceRef({
              artifactId: archived.artifactId,
              bodySha256: archived.bodySha256,
              originalBytes: archived.originalBytes,
            }),
          ),
          archived,
        );
      }
    });
  });

  test('ids that differ only beyond their readable prefix do not collide', async () => {
    await withArchiveDir(async (archiveDir) => {
      const sharedPrefix = 's'.repeat(120);
      const first = await archiveToolResult(archiveDir, {
        sessionId: `${sharedPrefix}-first`,
        runtimeEventId: 'event-1',
      });
      const second = await archiveToolResult(archiveDir, {
        sessionId: `${sharedPrefix}-second`,
        runtimeEventId: 'event-1',
      });

      assert.notEqual(first.artifactId, second.artifactId);
    });
  });
});

async function withArchiveDir(run: (archiveDir: string) => Promise<void>): Promise<void> {
  const archiveDir = await mkdtemp(join(tmpdir(), 'maka-harbor-archive-id-'));
  try {
    await run(archiveDir);
  } finally {
    await rm(archiveDir, { recursive: true, force: true });
  }
}

async function archiveToolResult(
  archiveDir: string,
  identity: { sessionId: string; runtimeEventId: string },
): Promise<{ artifactId: string; bodySha256: string; originalBytes: number }> {
  const serializedResult = JSON.stringify({ body: 'archived tool output' });
  const bodySha256 = createHash('sha256').update(serializedResult).digest('hex');
  const originalBytes = Buffer.byteLength(serializedResult, 'utf8');
  const recorder = buildHarborCellContextBudgetBackendOptions({
    MAKA_CONTEXT_TOOL_RESULT_ARCHIVE_DIR: archiveDir,
  }).archiveToolResult;
  assert.ok(recorder);

  const archived = await recorder({
    ...identity,
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    toolName: 'Read',
    result: { body: 'archived tool output' },
    serializedResult,
    originalEstimatedTokens: 9,
    originalBytes,
    rewriteVersion: 1,
    reason: 'stale_tool_result_pruned_before_compact',
    bodySha256,
  });
  assert.ok(archived);
  return { ...archived, bodySha256, originalBytes };
}
