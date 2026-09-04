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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  openFileSessionRepository,
  type FileSessionRepository,
} from '../file-session-repository.js';
import {
  materializeSessionCheckpointV1,
  publishSessionCheckpointV1,
  SessionRepositoryError,
} from '../session-repository.js';
import type { SessionBundleArtifact, Sha256Digest } from '../session-bundle-contract.js';

test('persists a current Manifest head and first immutable object prefix across reopened adapters', async () => {
  await withTemporaryDirectory(async (root) => {
    const first = await openFileSessionRepository({ storageRoot: root });
    const initial = await publishCheckpoint(
      first,
      await writeArtifact(root, 'initial.tar.zst', 'initial bytes'),
    );
    const created = await first.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      checkpoint: initial,
    });
    const next = await publishCheckpoint(
      first,
      await writeArtifact(root, 'next.tar.zst', 'next bytes'),
    );
    const committed = await first.commit({
      sessionId: created.ref.sessionId,
      expectedRevision: created.ref.revision,
      checkpoint: next,
      commitId: 'commit-a',
    });

    const reopened = await openFileSessionRepository({ storageRoot: root });
    assert.deepEqual(await reopened.checkoutCurrent('session-a'), committed);
    await assert.rejects(
      reopened.checkoutExact(created.ref),
      hasRepositoryCode('revision_not_available'),
    );
    await reopened.objectStore.assertReadable(committed.checkpoint.manifest);
    await reopened.objectStore.assertReadable(committed.checkpoint.value.compatibilityBundle);
  });
});

test('serializes concurrent local CAS writers across adapter instances', async () => {
  await withTemporaryDirectory(async (root) => {
    const left = await openFileSessionRepository({ storageRoot: root });
    const right = await openFileSessionRepository({ storageRoot: root });
    const initial = await publishCheckpoint(
      left,
      await writeArtifact(root, 'initial.tar.zst', 'initial bytes'),
    );
    const created = await left.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      checkpoint: initial,
    });
    const leftCheckpoint = await publishCheckpoint(
      left,
      await writeArtifact(root, 'left.tar.zst', 'left bytes'),
    );
    const rightCheckpoint = await publishCheckpoint(
      right,
      await writeArtifact(root, 'right.tar.zst', 'right bytes'),
    );

    const results = await Promise.allSettled([
      left.commit({
        sessionId: created.ref.sessionId,
        expectedRevision: created.ref.revision,
        checkpoint: leftCheckpoint,
      }),
      right.commit({
        sessionId: created.ref.sessionId,
        expectedRevision: created.ref.revision,
        checkpoint: rightCheckpoint,
      }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected);
    if (!rejected || rejected.status !== 'rejected') return;
    assert.ok(rejected.reason instanceof SessionRepositoryError);
    assert.equal(rejected.reason.code, 'revision_conflict');
  });
});

test('persists Fork source binding and crash recovery across reopened adapters', async () => {
  await withTemporaryDirectory(async (root) => {
    const first = await openFileSessionRepository({ storageRoot: root });
    const sourceCheckpoint = await publishCheckpoint(
      first,
      await writeArtifact(root, 'source.tar.zst', 'source bytes'),
    );
    const source = await first.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      checkpoint: sourceCheckpoint,
    });
    const pending = await first.claimFork({
      forkId: 'fork-a',
      source: source.ref,
      targetSessionId: 'session-b',
    });
    assert.equal(pending.state, 'pending');
    assert.equal(pending.sourceAgentId, 'agent-a');
    assert.deepEqual(pending.sourceCheckpoint, sourceCheckpoint);

    const advancedCheckpoint = await publishCheckpoint(
      first,
      await writeArtifact(root, 'source-advanced.tar.zst', 'source advanced bytes'),
    );
    await first.commit({
      sessionId: source.ref.sessionId,
      expectedRevision: source.ref.revision,
      checkpoint: advancedCheckpoint,
    });

    const afterCrash = await openFileSessionRepository({ storageRoot: root });
    const recovered = await afterCrash.claimFork({
      forkId: 'fork-a',
      source: source.ref,
      targetSessionId: 'session-b',
    });
    assert.deepEqual(recovered.sourceCheckpoint, sourceCheckpoint);
    await afterCrash.objectStore.assertReadable(recovered.sourceCheckpoint.manifest);
    await afterCrash.objectStore.assertReadable(
      recovered.sourceCheckpoint.value.compatibilityBundle,
    );
    const recoveredBundle = join(root, 'recovered-source.tar.zst');
    const bundleSource = await materializeSessionCheckpointV1({
      objectStore: afterCrash.objectStore,
      checkpoint: recovered.sourceCheckpoint,
      destination: recoveredBundle,
      maxBytes: 1024,
    });
    assert.equal(bundleSource.path, recoveredBundle);
    assert.equal(
      bundleSource.expectedArchiveDigest,
      sourceCheckpoint.value.compatibilityBundle.digest,
    );
    assert.equal((await readFile(recoveredBundle)).toString(), 'source bytes');
    const targetCheckpoint = await publishCheckpoint(
      afterCrash,
      await writeArtifact(root, 'target.tar.zst', 'target bytes'),
    );
    await assert.rejects(
      afterCrash.createSession({
        sessionId: 'session-b',
        agentId: 'agent-a',
        checkpoint: targetCheckpoint,
        lastCommittedActivationId: 'source-activation',
        forkedFrom: source.ref,
        createdByForkId: 'fork-a',
      }),
      /Fork-created Session must not carry an Activation identity/,
    );
    const target = await afterCrash.createSession({
      sessionId: 'session-b',
      agentId: 'agent-a',
      checkpoint: targetCheckpoint,
      forkedFrom: source.ref,
      createdByForkId: 'fork-a',
    });

    const afterTargetCrash = await openFileSessionRepository({ storageRoot: root });
    const completed = await afterTargetCrash.completeFork({ forkId: 'fork-a' });
    assert.deepEqual(completed.target, target.ref);
    assert.deepEqual(await afterTargetCrash.completeFork({ forkId: 'fork-a' }), completed);
  });
});

test('fails closed when durable local control-plane state is corrupt', async () => {
  await withTemporaryDirectory(async (root) => {
    const repository = await openFileSessionRepository({ storageRoot: root });
    const checkpoint = await publishCheckpoint(
      repository,
      await writeArtifact(root, 'initial.tar.zst', 'initial bytes'),
    );
    await repository.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      checkpoint,
    });
    await writeFile(join(root, 'session-repository-v1.json'), '{broken', 'utf8');
    const reopened = await openFileSessionRepository({ storageRoot: root });
    await assert.rejects(
      reopened.checkoutCurrent('session-a'),
      hasRepositoryCode('integrity_mismatch'),
    );
  });
});

test('fails closed when persisted revision allocation contradicts its current head', async () => {
  await withTemporaryDirectory(async (root) => {
    const repository = await openFileSessionRepository({ storageRoot: root });
    const initial = await publishCheckpoint(
      repository,
      await writeArtifact(root, 'initial.tar.zst', 'initial bytes'),
    );
    const created = await repository.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      checkpoint: initial,
    });
    const next = await publishCheckpoint(
      repository,
      await writeArtifact(root, 'next.tar.zst', 'next bytes'),
    );
    await repository.commit({
      sessionId: created.ref.sessionId,
      expectedRevision: created.ref.revision,
      checkpoint: next,
      commitId: 'commit-a',
    });

    const statePath = join(root, 'session-repository-v1.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      sessions: Array<{ nextRevisionNumber: number }>;
    };
    state.sessions[0].nextRevisionNumber = 2;
    await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8');

    const reopened = await openFileSessionRepository({ storageRoot: root });
    await assert.rejects(
      reopened.checkoutCurrent('session-a'),
      hasRepositoryCode('integrity_mismatch'),
    );
  });
});

test('fails closed when a persisted commit receipt contradicts the current head', async () => {
  await withTemporaryDirectory(async (root) => {
    const repository = await openFileSessionRepository({ storageRoot: root });
    const initial = await publishCheckpoint(
      repository,
      await writeArtifact(root, 'initial.tar.zst', 'initial bytes'),
    );
    const created = await repository.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      checkpoint: initial,
    });
    const next = await publishCheckpoint(
      repository,
      await writeArtifact(root, 'next.tar.zst', 'next bytes'),
    );
    await repository.commit({
      sessionId: created.ref.sessionId,
      expectedRevision: created.ref.revision,
      checkpoint: next,
      commitId: 'commit-a',
    });

    const statePath = join(root, 'session-repository-v1.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      commits: Array<{ result: { checkpoint: unknown } }>;
      sessions: Array<{ createdRevision: { checkpoint: unknown } }>;
    };
    state.commits[0].result.checkpoint = state.sessions[0].createdRevision.checkpoint;
    await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8');

    const reopened = await openFileSessionRepository({ storageRoot: root });
    await assert.rejects(
      reopened.checkoutCurrent('session-a'),
      hasRepositoryCode('integrity_mismatch'),
    );
  });
});

test('uses Session and CAS preflight errors before checking an unrelated candidate object', async () => {
  await withTemporaryDirectory(async (root) => {
    const repository = await openFileSessionRepository({ storageRoot: root });
    const initial = await publishCheckpoint(
      repository,
      await writeArtifact(root, 'initial.tar.zst', 'initial bytes'),
    );
    const created = await repository.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      checkpoint: initial,
    });
    const unreadableCreateCandidate = await publishCheckpoint(
      repository,
      await writeArtifact(root, 'create-candidate.tar.zst', 'create candidate bytes'),
    );
    await removeLocalObject(root, unreadableCreateCandidate.manifest);
    await assert.rejects(
      repository.createSession({
        sessionId: 'session-a',
        agentId: 'agent-other',
        checkpoint: unreadableCreateCandidate,
      }),
      hasRepositoryCode('session_already_exists'),
    );

    const next = await publishCheckpoint(
      repository,
      await writeArtifact(root, 'next.tar.zst', 'next bytes'),
    );
    await repository.commit({
      sessionId: created.ref.sessionId,
      expectedRevision: created.ref.revision,
      checkpoint: next,
    });
    const unreadableCommitCandidate = await publishCheckpoint(
      repository,
      await writeArtifact(root, 'commit-candidate.tar.zst', 'commit candidate bytes'),
    );
    await removeLocalObject(root, unreadableCommitCandidate.manifest);
    await assert.rejects(
      repository.commit({
        sessionId: created.ref.sessionId,
        expectedRevision: created.ref.revision,
        checkpoint: unreadableCommitCandidate,
      }),
      hasRepositoryCode('revision_conflict'),
    );
  });
});

test('streams immutable object publication and materialization across concurrent adapters', async () => {
  await withTemporaryDirectory(async (root) => {
    const left = await openFileSessionRepository({ storageRoot: root });
    const right = await openFileSessionRepository({ storageRoot: root });
    const payload = Buffer.alloc(1024 * 1024 + 17, 0x61);
    const artifactPath = join(root, 'large.tar.zst');
    await writeFile(artifactPath, payload);
    const artifact: SessionBundleArtifact = {
      path: artifactPath,
      archiveDigest: digest(payload),
      compressedBytes: payload.byteLength,
      decompressedTarBytes: payload.byteLength,
      payloadBytes: payload.byteLength,
      entryCount: 1,
    };

    const [leftCheckpoint, rightCheckpoint] = await Promise.all([
      publishCheckpoint(left, artifact),
      publishCheckpoint(right, artifact),
    ]);
    assert.deepEqual(leftCheckpoint, rightCheckpoint);

    const destination = join(root, 'materialized-large.tar.zst');
    await left.objectStore.materialize({
      ref: leftCheckpoint.value.compatibilityBundle,
      destination,
      maxBytes: payload.byteLength,
    });
    assert.deepEqual(await readFile(destination), payload);
    await assert.rejects(
      left.objectStore.materialize({
        ref: leftCheckpoint.value.compatibilityBundle,
        destination: join(root, 'too-small.tar.zst'),
        maxBytes: payload.byteLength - 1,
      }),
      hasRepositoryCode('quota_exceeded'),
    );
    await (await openFileSessionRepository({ storageRoot: root })).objectStore.assertReadable(
      leftCheckpoint.value.compatibilityBundle,
    );
  });
});

function publishCheckpoint(repository: FileSessionRepository, artifact: SessionBundleArtifact) {
  return publishSessionCheckpointV1({
    objectStore: repository.objectStore,
    compatibilityBundle: artifact,
  });
}

async function withTemporaryDirectory(operation: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-file-session-repository-'));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeArtifact(
  directory: string,
  name: string,
  contents: string,
): Promise<SessionBundleArtifact> {
  const bytes = Buffer.from(contents);
  const path = join(directory, name);
  await writeFile(path, bytes);
  return {
    path,
    archiveDigest: digest(bytes),
    compressedBytes: bytes.byteLength,
    decompressedTarBytes: bytes.byteLength,
    payloadBytes: bytes.byteLength,
    entryCount: 1,
  };
}

function digest(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest;
}

async function removeLocalObject(root: string, ref: { readonly objectRef: string }): Promise<void> {
  const id = ref.objectRef.slice('maka-local-object://v1/'.length);
  await rm(join(root, 'objects', id.slice(0, 2), id));
}

function hasRepositoryCode(code: SessionRepositoryError['code']): (error: unknown) => boolean {
  return (error): boolean => error instanceof SessionRepositoryError && error.code === code;
}
