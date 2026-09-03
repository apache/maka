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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createInMemoryImmutableObjectStore,
  createInMemorySessionRepository,
  createSessionCheckpointManifestV1,
  encodeSessionCheckpointManifestV1,
  publishSessionCheckpointV1,
  SESSION_BUNDLE_OBJECT_MEDIA_TYPE,
  SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE,
  SessionRepositoryError,
  type ImmutableObjectInput,
  type ImmutableObjectRef,
  type ImmutableObjectStore,
  type SessionCheckpointManifestV1,
  type SessionRepository,
  type StoredSessionCheckpoint,
} from '../session-repository.js';
import type { SessionBundleArtifact, Sha256Digest } from '../session-bundle-contract.js';

test('publishes and verifies Bundle then Manifest before creating an exact head', async () => {
  await withTemporaryDirectory(async (directory) => {
    const base = createInMemoryImmutableObjectStore();
    const events: string[] = [];
    const objectStore: ImmutableObjectStore = {
      publish: async (input) => {
        events.push(`publish:${input.mediaType}`);
        return base.publish(input);
      },
      assertReadable: async (ref) => {
        events.push(`assert:${ref.mediaType}`);
        await base.assertReadable(ref);
      },
    };
    const repository = createInMemorySessionRepository({ objectStore });
    const artifact = await writeArtifact(directory, 'initial.tar.zst', 'initial Bundle bytes');
    const checkpoint = await publishCheckpoint(objectStore, artifact);

    assert.deepEqual(events, [
      `publish:${SESSION_BUNDLE_OBJECT_MEDIA_TYPE}`,
      `assert:${SESSION_BUNDLE_OBJECT_MEDIA_TYPE}`,
      `publish:${SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE}`,
      `assert:${SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE}`,
    ]);
    assert.equal(checkpoint.value.schemaVersion, 1);
    assert.equal(checkpoint.value.compatibilityBundle.digest, artifact.archiveDigest);

    const created = await repository.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      checkpoint,
      lastCommittedActivationId: 'activation-a',
    });

    assert.equal(repository.forkIdempotencyRetention, 'indefinite');
    assert.equal(created.ref.revision, 'r1');
    assert.deepEqual(created.checkpoint, checkpoint);
    assert.deepEqual(await repository.checkoutExact(created.ref), created);
  });
});

test('retains only the current Manifest revision and never falls forward', async () => {
  await withReadySession(async ({ repository, objectStore, directory, created }) => {
    const checkpoint = await publishCheckpoint(
      objectStore,
      await writeArtifact(directory, 'next.tar.zst', 'next Bundle bytes'),
    );
    const committed = await repository.commit({
      sessionId: created.ref.sessionId,
      expectedRevision: created.ref.revision,
      checkpoint,
    });

    await assert.rejects(
      repository.checkoutExact(created.ref),
      hasRepositoryCode('revision_not_available'),
    );
    assert.deepEqual(await repository.checkoutExact(committed.ref), committed);
  });
});

test('a source-head race returns the requested Manifest and Bundle rather than a newer head', async () => {
  await withTemporaryDirectory(async (directory) => {
    const base = createInMemoryImmutableObjectStore();
    let blockNextBundleRead = false;
    let reading: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const objectStore: ImmutableObjectStore = {
      publish: (input) => base.publish(input),
      assertReadable: async (ref) => {
        await base.assertReadable(ref);
        if (!blockNextBundleRead || ref.mediaType !== SESSION_BUNDLE_OBJECT_MEDIA_TYPE) return;
        blockNextBundleRead = false;
        reading?.();
        await readReleased;
      },
    };
    const repository = createInMemorySessionRepository({ objectStore });
    const initial = await publishCheckpoint(
      objectStore,
      await writeArtifact(directory, 'initial.tar.zst', 'initial'),
    );
    const created = await repository.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      checkpoint: initial,
    });
    const next = await publishCheckpoint(
      objectStore,
      await writeArtifact(directory, 'next.tar.zst', 'next'),
    );

    blockNextBundleRead = true;
    const exactRead = repository.checkoutExact(created.ref);
    await readStarted;
    const committed = await repository.commit({
      sessionId: created.ref.sessionId,
      expectedRevision: created.ref.revision,
      checkpoint: next,
    });
    releaseRead?.();

    assert.deepEqual(await exactRead, created);
    assert.deepEqual(await repository.checkoutExact(committed.ref), committed);
  });
});

test('rejects stale concurrent writers without overwriting the winning head', async () => {
  await withReadySession(async ({ repository, objectStore, directory, created }) => {
    const left = await publishCheckpoint(
      objectStore,
      await writeArtifact(directory, 'left.tar.zst', 'left'),
    );
    const right = await publishCheckpoint(
      objectStore,
      await writeArtifact(directory, 'right.tar.zst', 'right'),
    );
    const results = await Promise.allSettled([
      repository.commit({
        sessionId: created.ref.sessionId,
        expectedRevision: created.ref.revision,
        checkpoint: left,
      }),
      repository.commit({
        sessionId: created.ref.sessionId,
        expectedRevision: created.ref.revision,
        checkpoint: right,
      }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected);
    if (!rejected || rejected.status !== 'rejected') return;
    assert.ok(rejected.reason instanceof SessionRepositoryError);
    assert.equal(rejected.reason.code, 'revision_conflict');

    const winner = results.find(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<SessionRepository['commit']>>> =>
        result.status === 'fulfilled',
    );
    assert.ok(winner);
    if (!winner) return;
    assert.deepEqual(await repository.checkoutExact(winner.value.ref), winner.value);
  });
});

test('reconciles concurrent and later retries of one commit identity', async () => {
  await withReadySession(async ({ repository, objectStore, directory, created }) => {
    const checkpoint = await publishCheckpoint(
      objectStore,
      await writeArtifact(directory, 'first.tar.zst', 'first'),
    );
    const input = {
      sessionId: created.ref.sessionId,
      expectedRevision: created.ref.revision,
      checkpoint,
      commitId: 'commit-a',
    };
    const [first, concurrentRetry] = await Promise.all([
      repository.commit(input),
      repository.commit(input),
    ]);

    assert.deepEqual(concurrentRetry, first);
    assert.deepEqual(await repository.commit(input), first);
    const nextCheckpoint = await publishCheckpoint(
      objectStore,
      await writeArtifact(directory, 'second.tar.zst', 'second'),
    );
    const second = await repository.commit({
      sessionId: created.ref.sessionId,
      expectedRevision: first.ref.revision,
      checkpoint: nextCheckpoint,
    });
    assert.equal(second.ref.revision, 'r3');
    await assert.rejects(
      repository.commit({ ...input, checkpoint: nextCheckpoint }),
      hasRepositoryCode('idempotency_conflict'),
    );
  });
});

test('never makes a head visible for an unpublished Manifest', async () => {
  await withReadySession(async ({ repository, created, checkpoint }) => {
    const manifestBytes = encodeSessionCheckpointManifestV1(checkpoint.value);
    const unpublished: StoredSessionCheckpoint = {
      manifest: {
        objectRef: 'memory://immutable-objects/not-published',
        digest: digest(manifestBytes),
        bytes: manifestBytes.byteLength,
        mediaType: SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE,
      },
      value: checkpoint.value,
    };
    await assert.rejects(
      repository.commit({
        sessionId: created.ref.sessionId,
        expectedRevision: created.ref.revision,
        checkpoint: unpublished,
      }),
      hasRepositoryCode('object_not_found'),
    );
    assert.deepEqual(await repository.checkoutExact(created.ref), created);
  });
});

test('never makes a head visible when a Manifest names an unreadable Bundle', async () => {
  await withReadySession(async ({ repository, objectStore, created }) => {
    const missingBundle: ImmutableObjectRef = {
      objectRef: 'memory://immutable-objects/missing-bundle',
      digest: digest('missing Bundle bytes'),
      bytes: Buffer.byteLength('missing Bundle bytes'),
      mediaType: SESSION_BUNDLE_OBJECT_MEDIA_TYPE,
    };
    const value = createSessionCheckpointManifestV1(missingBundle);
    const checkpoint = await publishManifest(objectStore, value);

    await assert.rejects(
      repository.commit({
        sessionId: created.ref.sessionId,
        expectedRevision: created.ref.revision,
        checkpoint,
      }),
      hasRepositoryCode('object_not_found'),
    );
    assert.deepEqual(await repository.checkoutExact(created.ref), created);
  });
});

test('fails closed when Bundle bytes do not match their trusted archive digest', async () => {
  await withTemporaryDirectory(async (directory) => {
    const objectStore = createInMemoryImmutableObjectStore();
    const artifact = await writeArtifact(directory, 'corrupt.tar.zst', 'real bytes');
    await assert.rejects(
      publishSessionCheckpointV1({
        objectStore,
        compatibilityBundle: { ...artifact, archiveDigest: digest('different bytes') },
      }),
      hasRepositoryCode('integrity_mismatch'),
    );
  });
});

test('rejects a Manifest value that does not match its immutable reference', async () => {
  await withReadySession(async ({ repository, objectStore, directory, created, checkpoint }) => {
    const other = await publishCheckpoint(
      objectStore,
      await writeArtifact(directory, 'other.tar.zst', 'other'),
    );
    const mismatched: StoredSessionCheckpoint = {
      manifest: checkpoint.manifest,
      value: other.value,
    };

    await assert.rejects(
      repository.commit({
        sessionId: created.ref.sessionId,
        expectedRevision: created.ref.revision,
        checkpoint: mismatched,
      }),
      hasRepositoryCode('integrity_mismatch'),
    );
  });
});

test('claims Fork identity before target creation and resumes both crash windows', async () => {
  await withReadySession(async ({ repository, checkpoint, created }) => {
    const request = {
      forkId: 'fork-a',
      source: created.ref,
      targetSessionId: 'session-b',
    };

    const pending = await repository.claimFork(request);
    assert.equal(pending.state, 'pending');
    assert.deepEqual(await repository.claimFork(request), pending);

    // Simulates a retry after a crash before target creation.
    const target = await repository.createSession({
      sessionId: request.targetSessionId,
      agentId: created.agentId,
      checkpoint,
      forkedFrom: created.ref,
      createdByForkId: request.forkId,
    });
    assert.equal(target.ref.revision, 'r1');
    assert.notDeepEqual(target.ref, created.ref);

    // Simulates a retry after target creation but before operation completion.
    assert.deepEqual(
      await repository.createSession({
        sessionId: request.targetSessionId,
        agentId: created.agentId,
        checkpoint,
        forkedFrom: created.ref,
        createdByForkId: request.forkId,
      }),
      target,
    );
    const completed = await repository.completeFork({ forkId: request.forkId });
    assert.equal(completed.state, 'completed');
    assert.deepEqual(completed.target, target.ref);
    assert.deepEqual(await repository.completeFork({ forkId: request.forkId }), completed);

    await assert.rejects(
      repository.claimFork({ ...request, targetSessionId: 'other-session' }),
      hasRepositoryCode('idempotency_conflict'),
    );
  });
});

test('never adopts a target created by a different Fork operation', async () => {
  await withReadySession(async ({ repository, checkpoint, created }) => {
    await repository.claimFork({
      forkId: 'fork-owner',
      source: created.ref,
      targetSessionId: 'session-b',
    });
    await repository.claimFork({
      forkId: 'fork-contender',
      source: created.ref,
      targetSessionId: 'session-b',
    });
    await repository.createSession({
      sessionId: 'session-b',
      agentId: created.agentId,
      checkpoint,
      forkedFrom: created.ref,
      createdByForkId: 'fork-owner',
    });

    await assert.rejects(
      repository.createSession({
        sessionId: 'session-b',
        agentId: created.agentId,
        checkpoint,
        forkedFrom: created.ref,
        createdByForkId: 'fork-contender',
      }),
      hasRepositoryCode('session_already_exists'),
    );
    await assert.rejects(
      repository.completeFork({ forkId: 'fork-contender' }),
      hasRepositoryCode('idempotency_conflict'),
    );
  });
});

test('keeps a Fork pending until its target checkpoint is readable', async () => {
  await withTemporaryDirectory(async (directory) => {
    const base = createInMemoryImmutableObjectStore();
    let failedObjectRef: string | undefined;
    const objectStore: ImmutableObjectStore = {
      publish: (input) => base.publish(input),
      assertReadable: async (ref) => {
        if (ref.objectRef === failedObjectRef) {
          throw new SessionRepositoryError('integrity_mismatch', 'Fork target is damaged');
        }
        await base.assertReadable(ref);
      },
    };
    const repository = createInMemorySessionRepository({ objectStore });
    const checkpoint = await publishCheckpoint(
      objectStore,
      await writeArtifact(directory, 'fork-target.tar.zst', 'fork target'),
    );
    const source = await repository.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      checkpoint,
    });
    await repository.claimFork({
      forkId: 'fork-a',
      source: source.ref,
      targetSessionId: 'session-b',
    });
    await repository.createSession({
      sessionId: 'session-b',
      agentId: source.agentId,
      checkpoint,
      forkedFrom: source.ref,
      createdByForkId: 'fork-a',
    });

    failedObjectRef = checkpoint.manifest.objectRef;
    await assert.rejects(
      repository.completeFork({ forkId: 'fork-a' }),
      hasRepositoryCode('integrity_mismatch'),
    );
    failedObjectRef = undefined;
    assert.equal((await repository.completeFork({ forkId: 'fork-a' })).state, 'completed');
  });
});

test('uses independent CAS sequences for source and Fork target Sessions', async () => {
  await withReadySession(async ({ repository, objectStore, directory, checkpoint, created }) => {
    await repository.claimFork({
      forkId: 'fork-a',
      source: created.ref,
      targetSessionId: 'session-b',
    });
    const target = await repository.createSession({
      sessionId: 'session-b',
      agentId: created.agentId,
      checkpoint,
      forkedFrom: created.ref,
      createdByForkId: 'fork-a',
    });
    const targetCheckpoint = await publishCheckpoint(
      objectStore,
      await writeArtifact(directory, 'target-next.tar.zst', 'target next'),
    );
    const advancedTarget = await repository.commit({
      sessionId: target.ref.sessionId,
      expectedRevision: target.ref.revision,
      checkpoint: targetCheckpoint,
    });

    assert.equal(advancedTarget.ref.revision, 'r2');
    assert.deepEqual(await repository.checkoutExact(created.ref), created);
  });
});

test('fails closed when a published Manifest or Bundle disappears or changes', async () => {
  await withTemporaryDirectory(async (directory) => {
    for (const target of ['manifest', 'bundle'] as const) {
      for (const code of ['object_not_found', 'integrity_mismatch'] as const) {
        const base = createInMemoryImmutableObjectStore();
        let failedObjectRef: string | undefined;
        const objectStore: ImmutableObjectStore = {
          publish: (input) => base.publish(input),
          assertReadable: async (ref) => {
            if (ref.objectRef === failedObjectRef) {
              throw new SessionRepositoryError(code, 'Object changed after publication');
            }
            await base.assertReadable(ref);
          },
        };
        const repository = createInMemorySessionRepository({ objectStore });
        const checkpoint = await publishCheckpoint(
          objectStore,
          await writeArtifact(directory, `${target}-${code}.tar.zst`, `${target}-${code}`),
        );
        const created = await repository.createSession({
          sessionId: `session-${target}-${code}`,
          agentId: 'agent-a',
          checkpoint,
        });
        failedObjectRef =
          target === 'manifest'
            ? checkpoint.manifest.objectRef
            : checkpoint.value.compatibilityBundle.objectRef;

        await assert.rejects(repository.checkoutExact(created.ref), hasRepositoryCode(code));
      }
    }
  });
});

async function withReadySession(
  operation: (context: {
    repository: SessionRepository;
    objectStore: ImmutableObjectStore;
    directory: string;
    checkpoint: StoredSessionCheckpoint;
    created: Awaited<ReturnType<SessionRepository['createSession']>>;
  }) => Promise<void>,
): Promise<void> {
  await withTemporaryDirectory(async (directory) => {
    const objectStore = createInMemoryImmutableObjectStore();
    const repository = createInMemorySessionRepository({ objectStore });
    const checkpoint = await publishCheckpoint(
      objectStore,
      await writeArtifact(directory, 'initial.tar.zst', 'initial Bundle bytes'),
    );
    const created = await repository.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      checkpoint,
    });
    await operation({ repository, objectStore, directory, checkpoint, created });
  });
}

function publishCheckpoint(
  objectStore: ImmutableObjectStore,
  compatibilityBundle: SessionBundleArtifact,
): Promise<StoredSessionCheckpoint> {
  return publishSessionCheckpointV1({ objectStore, compatibilityBundle });
}

async function publishManifest(
  objectStore: ImmutableObjectStore,
  value: SessionCheckpointManifestV1,
): Promise<StoredSessionCheckpoint> {
  const bytes = encodeSessionCheckpointManifestV1(value);
  const input: ImmutableObjectInput = {
    digest: digest(bytes),
    bytes: bytes.byteLength,
    mediaType: SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE,
    source: { kind: 'bytes', value: bytes },
  };
  const manifest = await objectStore.publish(input);
  await objectStore.assertReadable(manifest);
  return { manifest, value };
}

async function withTemporaryDirectory(
  operation: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-repository-'));
  try {
    await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
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

function digest(value: Uint8Array | string): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest;
}

function hasRepositoryCode(code: SessionRepositoryError['code']): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof SessionRepositoryError && error.code === code;
}
