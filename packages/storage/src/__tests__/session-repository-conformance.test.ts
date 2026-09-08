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
import { mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openFileSessionRepository } from '../file-session-repository.js';
import {
  createInMemoryImmutableObjectStore,
  createInMemorySessionRepository,
  publishSessionCheckpointV1,
  SESSION_BUNDLE_OBJECT_MEDIA_TYPE,
  SessionRepositoryError,
  type ImmutableObjectRef,
  type ImmutableObjectStore,
  type SessionRepository,
  type StoredSessionCheckpoint,
} from '../session-repository.js';
import type { Sha256Digest } from '../session-bundle-contract.js';

for (const backend of ['memory', 'file'] as const) {
  test(`${backend}: preserves structured commit identities across reads and reopen`, async () => {
    await withRepository(backend, async ({ directory, repository, objectStore, reopen }) => {
      const checkpoint = await publishCheckpoint(objectStore, directory, 'initial');
      const next = await publishCheckpoint(objectStore, directory, 'next');
      const identities = [
        { sessionId: 'a', commitId: 'b\u0000c' },
        { sessionId: 'a\u0000b', commitId: 'c' },
      ];
      const unrelated = await repository.createSession({
        sessionId: 'unrelated',
        agentId: 'agent',
        checkpoint,
      });
      for (const { sessionId } of identities) {
        await repository.createSession({ sessionId, agentId: 'agent', checkpoint });
      }
      const inputs = identities.map((identity) => ({
        ...identity,
        expectedRevision: 'r1',
        checkpoint: next,
      }));
      const results = [];
      for (const input of inputs) results.push(await repository.commit(input));
      assert.deepEqual(
        results.map((result) => result.ref.revision),
        ['r2', 'r2'],
      );

      for (const reader of [repository, await reopen()]) {
        assert.deepEqual(await reader.checkoutCurrent('unrelated'), unrelated);
        for (const [index, input] of inputs.entries()) {
          assert.deepEqual(await reader.checkoutCurrent(input.sessionId), results[index]);
          assert.deepEqual(await reader.checkoutExact(results[index].ref), results[index]);
          assert.deepEqual(await reader.commit(input), results[index]);
          await assert.rejects(
            reader.commit({ ...input, checkpoint }),
            hasRepositoryCode('idempotency_conflict'),
          );
        }
      }
      const writer = await reopen();
      for (const input of inputs) {
        const advanced = await writer.commit({
          ...input,
          commitId: 'after-reopen',
          expectedRevision: 'r2',
          checkpoint,
        });
        assert.equal(advanced.ref.revision, 'r3');
        assert.deepEqual(await (await reopen()).checkoutCurrent(input.sessionId), advanced);
      }
    });
  });

  for (const existing of ['caller data', 'previous materialization'] as const) {
    test(`${backend}: failed materialization preserves ${existing}`, async () => {
      await withRepository(backend, async ({ directory, objectStore }) => {
        const checkpoint = await publishCheckpoint(objectStore, directory, 'initial');
        const ref = checkpoint.value.compatibilityBundle;
        const destination = join(directory, 'materialized.tar.zst');
        const input = { ref, destination, maxBytes: ref.bytes };
        const expected = existing === 'caller data' ? 'unrelated caller contents' : 'initial';
        if (existing === 'caller data') await writeFile(destination, expected);
        else await objectStore.materialize(input);

        await assert.rejects(objectStore.materialize(input), hasRepositoryCode('io_failure'));
        assert.equal(await readFile(destination, 'utf8'), expected);
      });
    });
  }

  test(`${backend}: concurrent materialization preserves the exclusive winner`, async () => {
    await withRepository(backend, async ({ directory, objectStore }) => {
      const checkpoint = await publishCheckpoint(objectStore, directory, 'initial');
      const ref = checkpoint.value.compatibilityBundle;
      const destination = join(directory, 'materialized.tar.zst');
      const input = { ref, destination, maxBytes: ref.bytes };
      const results = await Promise.allSettled([
        objectStore.materialize(input),
        objectStore.materialize(input),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const failure = results.find((result) => result.status === 'rejected');
      assert.ok(failure?.status === 'rejected');
      assert.ok(hasRepositoryCode('io_failure')(failure.reason));
      assert.equal(await readFile(destination, 'utf8'), 'initial');
    });
  });

  for (const concurrent of ['identical', 'conflicting', 'absent'] as const) {
    test(`${backend}: reconciles ${concurrent} Fork claim before rejecting an advanced source`, {
      timeout: 10_000,
    }, async (t) => {
      await withRepository(backend, async ({ directory, repository, objectStore, reopen }) => {
        const checkpoint = await publishCheckpoint(objectStore, directory, 'initial');
        const next = await publishCheckpoint(objectStore, directory, 'next');
        const source = await repository.createSession({
          sessionId: 'source',
          agentId: 'agent',
          checkpoint,
        });
        const input = { forkId: 'fork', source: source.ref, targetSessionId: 'target' };
        const reading = deferred();
        const released = deferred();
        const assertReadable = objectStore.assertReadable.bind(objectStore);
        let blockNextBundleRead = true;
        t.mock.method(objectStore, 'assertReadable', async (ref: ImmutableObjectRef) => {
          await assertReadable(ref);
          if (blockNextBundleRead && ref.mediaType === SESSION_BUNDLE_OBJECT_MEDIA_TYPE) {
            blockNextBundleRead = false;
            reading.resolve();
            await released.promise;
          }
        });

        const claim = repository.claimFork(input);
        try {
          await Promise.race([
            reading.promise,
            claim.then(() => {
              throw new Error('Claim completed before verification barrier');
            }),
          ]);
          const winningInput = {
            ...input,
            targetSessionId: concurrent === 'conflicting' ? 'other-target' : 'target',
          };
          const winner =
            concurrent === 'absent' ? undefined : await (await reopen()).claimFork(winningInput);
          const advanced = await (await reopen()).commit({
            sessionId: source.ref.sessionId,
            expectedRevision: source.ref.revision,
            checkpoint: next,
          });
          released.resolve();

          if (concurrent === 'identical') {
            assert.deepEqual(await claim, winner);
          } else {
            await assert.rejects(
              claim,
              hasRepositoryCode(
                concurrent === 'conflicting'
                  ? 'idempotency_conflict'
                  : 'source_revision_not_available',
              ),
            );
          }
          const reader = await reopen();
          assert.deepEqual(await reader.checkoutCurrent('source'), advanced);
          if (winner) {
            assert.deepEqual(winner.sourceCheckpoint, checkpoint);
            assert.deepEqual(await reader.claimFork(winningInput), winner);
          } else {
            // The rejected attempt must not leave a claim behind.
            const admitted = await reader.claimFork({ ...input, source: advanced.ref });
            assert.deepEqual(admitted.source, advanced.ref);
            assert.deepEqual(admitted.sourceCheckpoint, next);
          }
        } finally {
          released.resolve();
          await Promise.allSettled([claim]);
        }
      });
    });
  }
}

test('memory: cleans up a partial file only after owning its exclusive creation', async (t) => {
  await withRepository('memory', async ({ directory, objectStore }) => {
    const checkpoint = await publishCheckpoint(objectStore, directory, 'initial');
    const ref = checkpoint.value.compatibilityBundle;
    const destination = join(directory, 'materialized.tar.zst');
    const input = { ref, destination, maxBytes: ref.bytes };
    const probe = await open(join(directory, 'handle-probe'), 'wx');
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const failure = new Error('Injected failure after partial write');
    const write = prototype.writeFile;
    const mocked = t.mock.method(prototype, 'writeFile', async function (this: FileHandle) {
      await write.call(this, Buffer.from('partial'));
      throw failure;
    });
    try {
      await assert.rejects(
        objectStore.materialize(input),
        (error: unknown) =>
          error instanceof SessionRepositoryError &&
          error.code === 'io_failure' &&
          error.cause === failure,
      );
      await assert.rejects(readFile(destination), { code: 'ENOENT' });
    } finally {
      mocked.mock.restore();
    }
    await objectStore.materialize(input);
    assert.equal(await readFile(destination, 'utf8'), 'initial');
  });
});

test('file: still rejects a genuinely duplicated commit identity on reopen', async () => {
  await withRepository('file', async ({ directory, repository, objectStore, reopen }) => {
    const checkpoint = await publishCheckpoint(objectStore, directory, 'initial');
    await repository.createSession({ sessionId: 'a\u0000b', agentId: 'agent', checkpoint });
    await repository.commit({
      sessionId: 'a\u0000b',
      commitId: 'c',
      expectedRevision: 'r1',
      checkpoint,
    });
    const path = join(directory, 'repository', 'session-repository-v1.json');
    const state = JSON.parse(await readFile(path, 'utf8')) as { commits: unknown[] };
    state.commits.push(state.commits[0]);
    await writeFile(path, JSON.stringify(state));
    await assert.rejects(
      (await reopen()).checkoutCurrent('a\u0000b'),
      (error: unknown) =>
        error instanceof SessionRepositoryError &&
        error.code === 'integrity_mismatch' &&
        error.cause instanceof Error &&
        error.cause.message === 'Commit identity is duplicated',
    );
  });
});

interface RepositoryContext {
  directory: string;
  repository: SessionRepository;
  objectStore: ImmutableObjectStore;
  /** The memory implementation shares its state; the file implementation reopens from disk. */
  reopen(): Promise<SessionRepository>;
}

async function withRepository(
  backend: 'memory' | 'file',
  operation: (context: RepositoryContext) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'maka-repository-conformance-'));
  try {
    if (backend === 'file') {
      const storageRoot = join(directory, 'repository');
      const repository = await openFileSessionRepository({ storageRoot });
      await operation({
        directory,
        repository,
        objectStore: repository.objectStore,
        reopen: () => openFileSessionRepository({ storageRoot }),
      });
    } else {
      const objectStore = createInMemoryImmutableObjectStore();
      const repository = createInMemorySessionRepository({ objectStore });
      await operation({ directory, repository, objectStore, reopen: async () => repository });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function publishCheckpoint(
  objectStore: ImmutableObjectStore,
  directory: string,
  contents: string,
): Promise<StoredSessionCheckpoint> {
  const bytes = Buffer.from(contents);
  const path = join(directory, `${contents}.tar.zst`);
  await writeFile(path, bytes);
  return publishSessionCheckpointV1({
    objectStore,
    compatibilityBundle: {
      path,
      archiveDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Sha256Digest,
      compressedBytes: bytes.byteLength,
      decompressedTarBytes: bytes.byteLength,
      payloadBytes: bytes.byteLength,
      entryCount: 1,
    },
  });
}

function hasRepositoryCode(code: SessionRepositoryError['code']): (error: unknown) => boolean {
  return (error) => error instanceof SessionRepositoryError && error.code === code;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
