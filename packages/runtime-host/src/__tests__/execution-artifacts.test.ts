import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createHostExecutionArtifactServices } from '../server/execution-artifacts.js';

test('Hosted execution publishes contained Tool Artifacts and durable result archives', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-execution-artifacts-'));
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside.txt');
  await mkdir(workspace);
  await writeFile(join(workspace, 'inside.txt'), 'inside artifact');
  await writeFile(join(workspace, 'oversized.bin'), '');
  await truncate(join(workspace, 'oversized.bin'), MAX_ATTACHMENT_BYTES + 1);
  await writeFile(outside, 'outside artifact');
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const store = await openInteractiveArtifactStoreForWrite(owner.lease);
    await store.recover();
    const services = createHostExecutionArtifactServices({
      artifacts: store,
      requestDrain: () => assert.fail('successful Artifact writes must not request Host drain'),
    });
    await services.recordToolArtifacts({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-use-1',
      toolName: 'Write',
      args: {},
      result: {},
      cwd: workspace,
      candidates: [
        { kind: 'file', name: 'inside.txt', sourcePath: 'inside.txt' },
        { kind: 'file', name: 'oversized.bin', sourcePath: 'oversized.bin' },
        { kind: 'file', name: 'outside.txt', sourcePath: outside },
      ],
    });
    const published = await store.listPage('session-1', { offset: 0, limit: 10 });
    assert.deepEqual(
      published.records.map((record) => record.name),
      ['inside.txt'],
    );

    const serializedResult = JSON.stringify({ output: 'x'.repeat(2_048) });
    const bodySha256 = createHash('sha256').update(serializedResult).digest('hex');
    const archiveInput = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runtimeEventId: 'runtime-event-1',
      toolCallId: 'tool-call-1',
      toolName: 'Bash',
      result: { output: 'x'.repeat(2_048) },
      serializedResult,
      originalEstimatedTokens: 512,
      originalBytes: Buffer.byteLength(serializedResult),
      rewriteVersion: 1 as const,
      reason: 'stale_tool_result_pruned_before_compact' as const,
      bodySha256,
    };
    const archived = await services.archiveToolResult(archiveInput);
    assert.deepEqual(await services.archiveToolResult(archiveInput), archived);
    assert.deepEqual(
      await services.readToolResultArchive({
        ...archiveInput,
        kind: 'maka.archived_tool_result',
        artifactId: archived.artifactId,
      }),
      { ok: true, serializedResult },
    );
    await store.close();
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});
