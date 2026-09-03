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
  createInMemorySessionRepository,
  SessionRepositoryError,
  type SessionBundleBlobStore,
  type SessionRepository,
  type StoredSessionBundle,
} from '../session-repository.js';
import type { SessionBundleArtifact, Sha256Digest } from '../session-bundle-contract.js';

test('publishes immutable Bundle bytes before creating an exactly-checkoutable head', async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = createInMemorySessionRepository();
    const artifact = await writeArtifact(directory, 'initial.tar.zst', 'initial Bundle bytes');
    const bundle = await repository.publishBundle(artifact);
    const created = await repository.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      bundle,
      lastCommittedActivationId: 'activation-a',
    });

    assert.equal(repository.forkIdempotencyRetention, 'indefinite');
    assert.equal(created.ref.revision, 'r1');
    assert.equal(created.bundle.archiveDigest, artifact.archiveDigest);
    assert.deepEqual(await repository.checkoutExact(created.ref), created);
  });
});

test('retains only the current revision and never falls forward during exact checkout', async () => {
  await withReadySession(async ({ repository, directory, created }) => {
    const bundle = await repository.publishBundle(
      await writeArtifact(directory, 'next.tar.zst', 'next Bundle bytes'),
    );
    const committed = await repository.commit({
      sessionId: created.ref.sessionId,
      expectedRevision: created.ref.revision,
      bundle,
    });

    await assert.rejects(
      repository.checkoutExact(created.ref),
      hasRepositoryCode('revision_not_available'),
    );
    assert.deepEqual(await repository.checkoutExact(committed.ref), committed);
  });
});

test('a source-head race returns requested bytes rather than a newer head', async () => {
  await withTemporaryDirectory(async (directory) => {
    let blockNextRead = false;
    let reading: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const blobStore: SessionBundleBlobStore = {
      publish: async (artifact) => ({
        bundleRef: `test://${artifact.archiveDigest}`,
        archiveDigest: artifact.archiveDigest,
        compressedBytes: artifact.compressedBytes,
      }),
      assertReadable: async () => {
        if (!blockNextRead) return;
        blockNextRead = false;
        reading?.();
        await readReleased;
      },
    };
    const repository = createInMemorySessionRepository({ bundleStore: blobStore });
    const initialArtifact = await writeArtifact(directory, 'initial.tar.zst', 'initial');
    const initialBundle = await repository.publishBundle(initialArtifact);
    const created = await repository.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      bundle: initialBundle,
    });
    const nextBundle = await repository.publishBundle(
      await writeArtifact(directory, 'next.tar.zst', 'next'),
    );

    blockNextRead = true;
    const exactRead = repository.checkoutExact(created.ref);
    await readStarted;
    const committed = await repository.commit({
      sessionId: created.ref.sessionId,
      expectedRevision: created.ref.revision,
      bundle: nextBundle,
    });
    releaseRead?.();

    assert.deepEqual(await exactRead, created);
    assert.deepEqual(await repository.checkoutExact(committed.ref), committed);
  });
});

test('rejects stale concurrent writers without overwriting the winning head', async () => {
  await withReadySession(async ({ repository, directory, created }) => {
    const left = await repository.publishBundle(
      await writeArtifact(directory, 'left.tar.zst', 'left'),
    );
    const right = await repository.publishBundle(
      await writeArtifact(directory, 'right.tar.zst', 'right'),
    );
    const results = await Promise.allSettled([
      repository.commit({
        sessionId: created.ref.sessionId,
        expectedRevision: created.ref.revision,
        bundle: left,
      }),
      repository.commit({
        sessionId: created.ref.sessionId,
        expectedRevision: created.ref.revision,
        bundle: right,
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

test('reconciles a completed commit identity without allocating another revision', async () => {
  await withReadySession(async ({ repository, directory, created }) => {
    const firstBundle = await repository.publishBundle(
      await writeArtifact(directory, 'first.tar.zst', 'first'),
    );
    const firstInput = {
      sessionId: created.ref.sessionId,
      expectedRevision: created.ref.revision,
      bundle: firstBundle,
      commitId: 'commit-a',
    };
    const first = await repository.commit(firstInput);
    const secondBundle = await repository.publishBundle(
      await writeArtifact(directory, 'second.tar.zst', 'second'),
    );
    const second = await repository.commit({
      sessionId: created.ref.sessionId,
      expectedRevision: first.ref.revision,
      bundle: secondBundle,
    });

    assert.deepEqual(await repository.commit(firstInput), first);
    assert.equal((await repository.checkoutExact(second.ref)).ref.revision, 'r3');
    await assert.rejects(
      repository.commit({ ...firstInput, bundle: secondBundle }),
      hasRepositoryCode('idempotency_conflict'),
    );
  });
});

test('never makes a head visible for an unpublished Bundle reference', async () => {
  await withReadySession(async ({ repository, created }) => {
    const unpublished: StoredSessionBundle = {
      bundleRef: 'memory://session-bundles/not-published',
      archiveDigest: digest('unpublished'),
      compressedBytes: 11,
    };
    await assert.rejects(
      repository.commit({
        sessionId: created.ref.sessionId,
        expectedRevision: created.ref.revision,
        bundle: unpublished,
      }),
      hasRepositoryCode('bundle_not_found'),
    );
    assert.deepEqual(await repository.checkoutExact(created.ref), created);
  });
});

test('fails closed when archive bytes do not match the claimed digest', async () => {
  await withTemporaryDirectory(async (directory) => {
    const repository = createInMemorySessionRepository();
    const artifact = await writeArtifact(directory, 'corrupt.tar.zst', 'real bytes');
    await assert.rejects(
      repository.publishBundle({ ...artifact, archiveDigest: digest('different bytes') }),
      hasRepositoryCode('integrity_mismatch'),
    );
  });
});

test('claims Fork identity before target creation and resumes both crash windows', async () => {
  await withReadySession(async ({ repository, bundle, created }) => {
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
      bundle,
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
        bundle,
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
  await withReadySession(async ({ repository, bundle, created }) => {
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
      bundle,
      forkedFrom: created.ref,
      createdByForkId: 'fork-owner',
    });

    await assert.rejects(
      repository.createSession({
        sessionId: 'session-b',
        agentId: created.agentId,
        bundle,
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

test('uses independent CAS sequences for source and Fork target Sessions', async () => {
  await withReadySession(async ({ repository, directory, bundle, created }) => {
    await repository.claimFork({
      forkId: 'fork-a',
      source: created.ref,
      targetSessionId: 'session-b',
    });
    const target = await repository.createSession({
      sessionId: 'session-b',
      agentId: created.agentId,
      bundle,
      forkedFrom: created.ref,
      createdByForkId: 'fork-a',
    });
    const targetBundle = await repository.publishBundle(
      await writeArtifact(directory, 'target-next.tar.zst', 'target next'),
    );
    const advancedTarget = await repository.commit({
      sessionId: target.ref.sessionId,
      expectedRevision: target.ref.revision,
      bundle: targetBundle,
    });

    assert.equal(advancedTarget.ref.revision, 'r2');
    assert.deepEqual(await repository.checkoutExact(created.ref), created);
  });
});

test('fails closed when a published Blob later disappears or no longer verifies', async () => {
  await withTemporaryDirectory(async (directory) => {
    for (const code of ['bundle_not_found', 'integrity_mismatch'] as const) {
      let readable = true;
      const artifact = await writeArtifact(directory, `${code}.tar.zst`, code);
      const stored: StoredSessionBundle = {
        bundleRef: `test://${code}`,
        archiveDigest: artifact.archiveDigest,
        compressedBytes: artifact.compressedBytes,
      };
      const blobStore: SessionBundleBlobStore = {
        publish: async () => stored,
        assertReadable: async () => {
          if (!readable) {
            throw new SessionRepositoryError(code, 'Bundle changed after publication');
          }
        },
      };
      const repository = createInMemorySessionRepository({ bundleStore: blobStore });
      const bundle = await repository.publishBundle(artifact);
      const created = await repository.createSession({
        sessionId: `session-${code}`,
        agentId: 'agent-a',
        bundle,
      });
      readable = false;

      await assert.rejects(repository.checkoutExact(created.ref), hasRepositoryCode(code));
    }
  });
});

async function withReadySession(
  operation: (context: {
    repository: SessionRepository;
    directory: string;
    bundle: StoredSessionBundle;
    created: Awaited<ReturnType<SessionRepository['createSession']>>;
  }) => Promise<void>,
): Promise<void> {
  await withTemporaryDirectory(async (directory) => {
    const repository = createInMemorySessionRepository();
    const bundle = await repository.publishBundle(
      await writeArtifact(directory, 'initial.tar.zst', 'initial Bundle bytes'),
    );
    const created = await repository.createSession({
      sessionId: 'session-a',
      agentId: 'agent-a',
      bundle,
    });
    await operation({ repository, directory, bundle, created });
  });
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
