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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import {
  openInteractiveArtifactStoreForWrite,
  createReadImageSnapshotPlanner,
} from '@maka/storage/artifact-stores';
import { encodeDurableToolResultOutputWithArtifacts } from '@maka/runtime/durable-tool-result-projection';
import { deferred } from '@maka/core/test-only/async-primitives';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { createHostExecutionArtifactServices } from '../server/execution-artifacts.js';
import { restoreArtifactV1Shape } from './fixtures/artifact-v1.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('a refused projection preserves a shared image until Session cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-shared-projection-'));
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  assert.ok(owner);
  const store = await openInteractiveArtifactStoreForWrite(owner.lease);
  const entered = deferred();
  const fail = deferred();
  let rejected: PromiseLike<unknown> | undefined;
  try {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=',
      'base64',
    );
    const image = {
      type: 'file' as const,
      mediaType: 'image/png',
      data: { type: 'data' as const, data: bytes.toString('base64') },
    };
    const plan = createReadImageSnapshotPlanner(store);
    const shared = () =>
      plan({
        sessionId: 'session-1',
        turnId: 'turn-1',
        name: 'Tool Result image',
        bytes,
        mimeType: 'image/png',
      });
    let ordinal = 0;
    rejected = Promise.resolve(
      encodeDurableToolResultOutputWithArtifacts(
        {
          type: 'content',
          value: [
            image,
            {
              ...image,
              data: {
                type: 'data',
                data: Buffer.concat([bytes, Buffer.from([0])]).toString('base64'),
              },
            },
          ],
        },
        'session-1',
        () => {
          if (++ordinal === 1) return shared();
          return {
            ref: {
              kind: 'session_file' as const,
              sessionId: 'session-1',
              relativePath: 'failed-image',
            },
            persist: async () => {
              entered.resolve();
              await fail.promise;
              throw new Error('injected publication failure');
            },
          };
        },
      ),
    );
    await entered.promise;
    const accepted = await encodeDurableToolResultOutputWithArtifacts(
      { type: 'content', value: [image] },
      'session-1',
      shared,
    );
    assert.equal(accepted.kind, 'content');
    fail.resolve();
    assert.equal(((await rejected) as { kind: string }).kind, 'failure');
    const ref = shared().ref;
    assert.deepEqual(
      await store.readDurableAttachmentBinary({
        sessionId: ref.sessionId,
        artifactId: ref.relativePath,
      }),
      {
        ok: true,
        base64: bytes.toString('base64'),
        mimeType: 'image/png',
      },
    );
    const record = (await store.getInSession(ref.sessionId, ref.relativePath)).record;
    assert.ok(record);
    await store.purgeSessionArtifacts('session-1');
    await assert.rejects(stat(join(root, 'artifacts', record.relativePath)), { code: 'ENOENT' });
    assert.equal((await store.listPage('session-1', { offset: 0, limit: 10 })).total, 0);
    assert.deepEqual(
      await store.readDurableAttachmentBinary({
        sessionId: ref.sessionId,
        artifactId: ref.relativePath,
      }),
      {
        ok: false,
        reason: 'not_found',
      },
    );
  } finally {
    fail.resolve();
    await rejected;
    store.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    const services = createHostExecutionArtifactServices({
      artifacts: store,
      sessionAdmission: new SessionAdmissionGate(),
      sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
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
    const archived = await services.toolResultArchive.services.archiveToolResult(archiveInput);
    assert.ok(archived, 'the host archive writer always reports where it stored the body');
    assert.deepEqual(
      await services.toolResultArchive.services.archiveToolResult(archiveInput),
      archived,
    );
    assert.deepEqual(
      await services.toolResultArchive.services.readToolResultArchive({
        ...archiveInput,
        kind: 'maka.archived_tool_result',
        artifactId: archived.artifactId,
      }),
      { ok: true, serializedResult },
    );
    await store.close();
    restoreArtifactV1Shape(join(base, 'root'));
    const upgraded = await openInteractiveArtifactStoreForWrite(owner.lease);
    try {
      const successor = createHostExecutionArtifactServices({
        artifacts: upgraded,
        sessionAdmission: new SessionAdmissionGate(),
        sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
        requestDrain: () => assert.fail('reading an upgraded archive must not drain'),
      });
      assert.deepEqual(
        await successor.toolResultArchive.services.readToolResultArchive({
          ...archiveInput,
          kind: 'maka.archived_tool_result',
          artifactId: archived.artifactId,
        }),
        { ok: true, serializedResult },
      );
    } finally {
      upgraded.close();
    }
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
});
