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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { HostArtifactCoordinator } from '../server/artifact-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { ARTIFACT_READ_CHUNK_MAX_BYTES } from '../protocol/index.js';

const connectionContext: ConnectionContext = {
  hostEpoch: 'host-epoch-1',
  connectionId: 'connection-1',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('Artifact ingest is connection-bound, replay-safe, and commits one durable AttachmentRef', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-ingest-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const store = await openInteractiveArtifactStoreForWrite(owner.lease);
    await store.recover();
    let now = 0;
    const coordinator = new HostArtifactCoordinator(
      store,
      () => assert.fail('successful ingest must not request Host drain'),
      new SessionAdmissionGate(),
      { probeSessionRemoval: async () => ({ kind: 'present' }) },
      () => now,
    );
    const bytes = Buffer.from('host-owned attachment bytes');
    const begin = {
      kind: 'begin' as const,
      sessionId: 'session-1',
      uploadId: 'upload-1',
      name: 'dir/fixture.txt',
      mimeType: 'text/plain',
      totalBytes: bytes.byteLength,
      contentSha256: digest(bytes),
    };
    assert.deepEqual(await coordinator.handlers['artifact.ingest'](begin, connectionContext), {
      ok: true,
      result: { kind: 'upload_opened', uploadId: 'upload-1', nextOffset: 0 },
    });
    const first = bytes.subarray(0, 8);
    const firstChunk = {
      kind: 'chunk' as const,
      sessionId: 'session-1',
      uploadId: 'upload-1',
      offset: 0,
      chunkBase64: first.toString('base64'),
    };
    const firstAccepted = {
      ok: true as const,
      result: { kind: 'chunk_accepted' as const, uploadId: 'upload-1', nextOffset: first.length },
    };
    assert.deepEqual(
      await coordinator.handlers['artifact.ingest'](firstChunk, connectionContext),
      firstAccepted,
    );
    assert.deepEqual(
      await coordinator.handlers['artifact.ingest'](firstChunk, connectionContext),
      firstAccepted,
    );
    assert.deepEqual(
      await coordinator.handlers['artifact.ingest'](firstChunk, {
        ...connectionContext,
        connectionId: 'connection-2',
      }),
      {
        ok: false,
        error: { code: 'not_found', message: 'Attachment upload was not found' },
      },
    );
    assert.equal(
      (
        await coordinator.handlers['artifact.ingest'](
          {
            kind: 'chunk',
            sessionId: 'session-1',
            uploadId: 'upload-1',
            offset: first.length,
            chunkBase64: bytes.subarray(first.length).toString('base64'),
          },
          connectionContext,
        )
      ).ok,
      true,
    );
    const committed = await coordinator.handlers['artifact.ingest'](
      { kind: 'commit', sessionId: 'session-1', uploadId: 'upload-1' },
      connectionContext,
    );
    assert.equal(committed.ok, true);
    if (!committed.ok || committed.result.kind !== 'committed') return;
    assert.equal(committed.result.attachment.ref.kind, 'session_file');
    if (committed.result.attachment.ref.kind !== 'session_file') return;
    const artifactId = committed.result.attachment.ref.relativePath;
    assert.deepEqual(committed.result.attachment, {
      kind: 'other',
      name: 'dir-fixture.txt',
      mimeType: 'text/plain',
      bytes: bytes.byteLength,
      ref: {
        kind: 'session_file',
        sessionId: 'session-1',
        relativePath: artifactId,
      },
    });
    assert.deepEqual(
      await store.readTextInSession('session-1', artifactId, { maxBytes: bytes.byteLength }),
      { ok: true, text: bytes.toString('utf8') },
    );
    assert.deepEqual(
      await coordinator.handlers['artifact.ingest'](
        { kind: 'commit', sessionId: 'session-1', uploadId: 'upload-1' },
        { ...connectionContext, connectionId: 'connection-after-reconnect' },
      ),
      committed,
    );
    assert.deepEqual(
      await coordinator.handlers['artifact.ingest'](begin, {
        ...connectionContext,
        connectionId: 'connection-after-reconnect',
      }),
      committed,
    );
    const mismatchedBegin = {
      ...begin,
      uploadId: 'upload-digest-mismatch',
      contentSha256: `sha256:${'0'.repeat(64)}` as const,
    };
    assert.equal(
      (await coordinator.handlers['artifact.ingest'](mismatchedBegin, connectionContext)).ok,
      true,
    );
    assert.equal(
      (
        await coordinator.handlers['artifact.ingest'](
          {
            kind: 'chunk',
            sessionId: 'session-1',
            uploadId: mismatchedBegin.uploadId,
            offset: 0,
            chunkBase64: bytes.toString('base64'),
          },
          connectionContext,
        )
      ).ok,
      true,
    );
    assert.deepEqual(
      await coordinator.handlers['artifact.ingest'](
        { kind: 'commit', sessionId: 'session-1', uploadId: mismatchedBegin.uploadId },
        connectionContext,
      ),
      {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'Attachment content digest does not match',
        },
      },
    );
    assert.deepEqual(
      await coordinator.handlers['artifact.ingest'](
        { kind: 'commit', sessionId: 'session-1', uploadId: mismatchedBegin.uploadId },
        connectionContext,
      ),
      {
        ok: false,
        error: { code: 'not_found', message: 'Attachment upload was not found' },
      },
    );
    assert.equal((await store.listPage('session-1', { offset: 0, limit: 10 })).records.length, 1);

    const ttlMs = 5 * 60 * 1000;
    const ttlBegin = {
      ...begin,
      uploadId: 'upload-ttl-conflict',
      totalBytes: 1,
      contentSha256: digest(Buffer.from('x')),
    };
    const exactReplayBegin = { ...ttlBegin, uploadId: 'upload-ttl-exact' };
    assert.equal(
      (await coordinator.handlers['artifact.ingest'](ttlBegin, connectionContext)).ok,
      true,
    );
    assert.equal(
      (await coordinator.handlers['artifact.ingest'](exactReplayBegin, connectionContext)).ok,
      true,
    );
    now = ttlMs - 1;
    const conflictingReplay = await coordinator.handlers['artifact.ingest'](
      { ...ttlBegin, name: 'different.txt' },
      connectionContext,
    );
    assert.equal(conflictingReplay.ok, false);
    if (!conflictingReplay.ok) assert.equal(conflictingReplay.error.code, 'operation_conflict');
    assert.equal(
      (await coordinator.handlers['artifact.ingest'](exactReplayBegin, connectionContext)).ok,
      true,
    );
    now = ttlMs;
    assert.equal(
      (
        await coordinator.handlers['artifact.ingest'](
          {
            kind: 'chunk',
            sessionId: 'session-1',
            uploadId: ttlBegin.uploadId,
            offset: 0,
            chunkBase64: Buffer.from('x').toString('base64'),
          },
          connectionContext,
        )
      ).ok,
      false,
    );
    assert.equal(
      (
        await coordinator.handlers['artifact.ingest'](
          {
            kind: 'chunk',
            sessionId: 'session-1',
            uploadId: exactReplayBegin.uploadId,
            offset: 0,
            chunkBase64: Buffer.from('x').toString('base64'),
          },
          connectionContext,
        )
      ).ok,
      true,
    );
    await store.close();
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Artifact mutation failure requests Host drain and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-coordinator-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const store = await openInteractiveArtifactStoreForWrite(owner.lease);
    await store.recover();
    await store.create({
      id: 'artifact-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'artifact.txt',
      kind: 'file',
      content: 'durable',
      now: 1,
    });

    store.close();
    let drainRequests = 0;
    const coordinator = new HostArtifactCoordinator(
      store,
      () => {
        drainRequests += 1;
      },
      new SessionAdmissionGate(),
      { probeSessionRemoval: async () => ({ kind: 'present' }) },
    );

    assert.deepEqual(
      await coordinator.handlers['artifact.delete'](
        {
          sessionId: 'session-1',
          artifactId: 'artifact-1',
        },
        connectionContext,
      ),
      {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'Artifact deletion could not be committed',
        },
      },
    );
    assert.equal(drainRequests, 1);
    assert.deepEqual(
      await coordinator.handlers['artifact.ingest'](
        {
          kind: 'begin',
          sessionId: 'session-1',
          uploadId: 'upload-after-close',
          name: 'fixture.txt',
          mimeType: 'text/plain',
          totalBytes: 1,
          contentSha256: `sha256:${'0'.repeat(64)}`,
        },
        connectionContext,
      ),
      {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'Attachment publication failed',
        },
      },
    );
    assert.equal(drainRequests, 2);
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Artifact query streams complete content in bounded ordered chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-read-chunks-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const store = await openInteractiveArtifactStoreForWrite(owner.lease);
    await store.recover();
    const content = Buffer.alloc(ARTIFACT_READ_CHUNK_MAX_BYTES + 17, 7);
    await store.create({
      id: 'artifact-large',
      sessionId: 'session-1',
      turnId: 'turn-1',
      name: 'large.bin',
      kind: 'file',
      content,
      now: 1,
    });
    const coordinator = new HostArtifactCoordinator(
      store,
      () => assert.fail('successful read must not request Host drain'),
      new SessionAdmissionGate(),
      { probeSessionRemoval: async () => ({ kind: 'present' }) },
    );

    const first = await coordinator.handlers['artifact.query'](
      {
        kind: 'read_chunk',
        sessionId: 'session-1',
        artifactId: 'artifact-large',
        offset: 0,
      },
      connectionContext,
    );
    assert.equal(first.ok, true);
    if (!first.ok || first.result.kind !== 'chunk') return;
    assert.equal(
      Buffer.from(first.result.chunkBase64, 'base64').byteLength,
      ARTIFACT_READ_CHUNK_MAX_BYTES,
    );
    assert.equal(first.result.nextOffset, ARTIFACT_READ_CHUNK_MAX_BYTES);

    const second = await coordinator.handlers['artifact.query'](
      {
        kind: 'read_chunk',
        sessionId: 'session-1',
        artifactId: 'artifact-large',
        offset: first.result.nextOffset!,
      },
      connectionContext,
    );
    assert.equal(second.ok, true);
    if (!second.ok || second.result.kind !== 'chunk') return;
    assert.equal(Buffer.from(second.result.chunkBase64, 'base64').byteLength, 17);
    assert.equal(second.result.nextOffset, null);
    assert.equal(second.result.totalBytes, content.byteLength);
    store.close();
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
