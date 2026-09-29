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
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openFileSessionRepository } from '@maka/storage/file-session-repository';
import { openSessionCheckpointPublicationStore } from '@maka/storage/session-checkpoint-publication-store';
import {
  type ImmutableObjectStore,
  type SessionRepository,
} from '@maka/storage/session-repository';
import { SessionSnapshotError } from '@maka/storage/quiescent-session-snapshot';
import {
  HostCheckpointError,
  HostSessionCheckpointCoordinator,
} from '../server/session-checkpoint-coordinator.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-checkpoint-publication-'));
  const repository = await openFileSessionRepository({ storageRoot: join(root, 'repository') });
  const directory = join(root, 'journal');
  const journal = await openSessionCheckpointPublicationStore({ directory, rootId: 'test-root' });
  let captures = 0;
  let captureFailure = false;
  let cleanupPending = false;
  let bundleCleanupFailure = false;
  const cleanedBundles: string[] = [];
  const artifact = async (name: string) => {
    const path = join(root, name);
    const bytes = Buffer.from('opaque test bundle ' + name);
    await writeFile(path, bytes);
    return {
      path,
      compressedBytes: bytes.length,
      archiveDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const,
      snapshotCleanup: cleanupPending
        ? {
            state: 'pending_recovery' as const,
            error: new SessionSnapshotError('cleanup_failed', 'test cleanup failure'),
          }
        : { state: 'released' as const },
      decompressedTarBytes: bytes.length,
      payloadBytes: bytes.length,
      entryCount: 1,
    };
  };
  const make = (
    implementation: SessionRepository = repository,
    objects: ImmutableObjectStore = repository.objectStore,
  ) =>
    new HostSessionCheckpointCoordinator({
      journal,
      repository: implementation,
      objects,
      capture: async ({ commitId }) => {
        captures++;
        if (captureFailure) throw new Error('capture interrupted');
        return artifact(commitId);
      },
      cleanupBundle: async (commitId) => {
        if (bundleCleanupFailure) throw new Error('temporary bundle cleanup unavailable');
        await rm(join(root, commitId), { force: true });
        cleanedBundles.push(commitId);
      },
      runAuthorized: (operation) => operation(),
    });
  return {
    root,
    directory,
    repository,
    journal,
    make,
    artifact,
    captures: () => captures,
    cleanedBundles,
    failBundleCleanup: (fail: boolean) => {
      bundleCleanupFailure = fail;
    },
    failCapture: () => {
      captureFailure = true;
    },
    pendCleanup: () => {
      cleanupPending = true;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
function code(expected: string) {
  return (error: unknown) => error instanceof HostCheckpointError && error.code === expected;
}
function intercept(
  repository: SessionRepository,
  overrides: Partial<SessionRepository>,
): SessionRepository {
  return new Proxy(repository, {
    get(target, key) {
      const replacement = Reflect.get(overrides, key);
      if (replacement !== undefined) return replacement;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
for (const method of ['createSession', 'commit'] as const) {
  test(`reconciles a lost ${method} reply across coordinator restart without recapture`, async () => {
    const f = await fixture();
    let first = f.make();
    try {
      const initial =
        method === 'commit'
          ? await first.publish({ sessionId: 'session', requestId: 'initial' })
          : undefined;
      const implementation = intercept(f.repository, {
        [method]: async (input: never) => {
          await f.repository[method](input);
          throw new Error('reply lost after durable commit');
        },
      });
      await first.close();
      first = f.make(implementation);
      await assert.rejects(
        first.publish({ sessionId: 'session', requestId: 'lost' }),
        code('publication_failed'),
      );
      await first.close();
      const count = f.captures();
      const reopenedJournal = await openSessionCheckpointPublicationStore({
        directory: f.directory,
        rootId: 'test-root',
      });
      await reopenedJournal.withSession('session', async (document) => {
        assert.equal(document.requests.at(-1)?.phase, 'prepared');
      });
      first = f.make();
      await assert.rejects(
        first.publish({ sessionId: 'session', requestId: 'blocked' }),
        code('busy'),
      );
      await f.journal.withSession('session', async (document) => {
        assert.ok(
          await readFile(join(f.root, document.requests.at(-1)!.commitId)),
          'a prepared input is not terminal cleanup',
        );
      });
      const recovered = await first.publish({ sessionId: 'session', requestId: 'lost' });
      assert.equal(f.captures(), count);
      assert.equal(recovered.committed.ref.revision, initial ? 'r2' : 'r1');
      assert.deepEqual(await first.publish({ sessionId: 'session', requestId: 'lost' }), recovered);
      const next = await first.publish({ sessionId: 'session', requestId: 'next' });
      assert.equal(next.committed.ref.revision, initial ? 'r3' : 'r2');
      assert.deepEqual(await first.publish({ sessionId: 'session', requestId: 'lost' }), recovered);
      assert.deepEqual(
        await f.repository.checkoutCurrent(recovered.binding.repositorySessionId),
        next.committed,
      );
    } finally {
      await first.close();
      await f.close();
    }
  });
}
test('serializes duplicate requests, retains stable binding, and rejects conflicting identity reuse', async () => {
  const f = await fixture();
  const coordinator = f.make();
  try {
    const input = { sessionId: 'session', requestId: 'same' };
    const [left, right] = await Promise.all([
      coordinator.publish(input),
      coordinator.publish(input),
    ]);
    assert.deepEqual(left, right);
    assert.equal(f.captures(), 1);
    const other = await coordinator.publish({ sessionId: 'other', requestId: 'same' });
    assert.equal(other.binding.agentId, left.binding.agentId);
    assert.notEqual(other.binding.repositorySessionId, left.binding.repositorySessionId);
    await assert.rejects(
      coordinator.publish({ ...input, confirmationGrantId: 'different' }),
      code('conflict'),
    );
  } finally {
    await coordinator.close();
    await f.close();
  }
});
test('never recaptures an interrupted identity and leaves no visible head', async () => {
  const f = await fixture();
  let coordinator = f.make();
  try {
    f.failCapture();
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'interrupted' }),
      code('publication_failed'),
    );
    await coordinator.close();
    coordinator = f.make();
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'interrupted' }),
      code('interrupted'),
    );
    assert.equal(f.captures(), 1);
    await f.journal.withSession('session', async (document) => {
      assert.equal(document.requests[0]?.phase, 'aborted');
      await assert.rejects(f.repository.checkoutCurrent(document.binding.repositorySessionId));
    });
  } finally {
    await coordinator.close();
    await f.close();
  }
});
test('does not rebase a stale snapshot after CAS conflict, and permits a new request', async () => {
  const f = await fixture();
  let coordinator = f.make();
  try {
    const initial = await coordinator.publish({ sessionId: 'session', requestId: 'initial' });
    await coordinator.close();
    coordinator = f.make(
      intercept(f.repository, {
        commit: async (input) => {
          await f.repository.commit({ ...input, commitId: 'concurrent-writer' });
          return f.repository.commit(input);
        },
      }),
    );
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'stale' }),
      code('conflict'),
    );
    const count = f.captures();
    await coordinator.close();
    coordinator = f.make();
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'stale' }),
      code('conflict'),
    );
    assert.equal(f.captures(), count);
    assert.equal(
      (await f.repository.checkoutCurrent(initial.binding.repositorySessionId)).ref.revision,
      'r2',
    );
    assert.equal(
      (await coordinator.publish({ sessionId: 'session', requestId: 'fresh' })).committed.ref
        .revision,
      'r3',
    );
  } finally {
    await coordinator.close();
    await f.close();
  }
});
test('corrupt recovery metadata fails closed without new capture; root binding cannot be adopted', async () => {
  const f = await fixture();
  const coordinator = f.make();
  try {
    await coordinator.publish({ sessionId: 'session', requestId: 'first' });
    const file = (await readdir(f.directory)).find((name) => /^session-.*\.json$/.test(name))!;
    const path = join(f.directory, file);
    const document = JSON.parse(await readFile(path, 'utf8'));
    document.requests[0].result.ref.sessionId = 'unrelated-session';
    await writeFile(path, JSON.stringify(document));
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'first' }),
      code('publication_failed'),
    );
    assert.equal(f.captures(), 1);
    await assert.rejects(
      openSessionCheckpointPublicationStore({ directory: f.directory, rootId: 'other-root' }),
    );
  } finally {
    await coordinator.close();
    await f.close();
  }
});

test('incomplete Manifest verification leaves the previous readable Head unchanged', async () => {
  const f = await fixture();
  let coordinator = f.make();
  try {
    const original = await coordinator.publish({ sessionId: 'session', requestId: 'original' });
    await coordinator.close();
    coordinator = f.make(f.repository, {
      publish: (input) => f.repository.objectStore.publish(input),
      materialize: (input) => f.repository.objectStore.materialize(input),
      assertReadable: async (ref) => {
        if (ref.mediaType.includes('checkpoint-manifest')) throw new Error('Manifest unreadable');
        await f.repository.objectStore.assertReadable(ref);
      },
    });
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'incomplete' }),
      code('publication_failed'),
    );
    assert.deepEqual(
      await f.repository.checkoutCurrent(original.binding.repositorySessionId),
      original.committed,
    );
  } finally {
    await coordinator.close();
    await f.close();
  }
});
test('creation reconciliation never adopts an existing Session with another agent binding', async () => {
  const f = await fixture();
  let coordinator = f.make(
    intercept(f.repository, {
      createSession: async (input) => {
        await f.repository.createSession({ ...input, agentId: 'unrelated-agent' });
        throw new Error('unrelated target now exists');
      },
    }),
  );
  try {
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'create' }),
      code('publication_failed'),
    );
    await coordinator.close();
    coordinator = f.make();
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'create' }),
      code('conflict'),
    );
    assert.equal(f.captures(), 1);
  } finally {
    await coordinator.close();
    await f.close();
  }
});
test('successful publication reports persisted staging cleanup status separately', async () => {
  const f = await fixture();
  const coordinator = f.make();
  try {
    f.pendCleanup();
    const result = await coordinator.publish({ sessionId: 'session', requestId: 'cleanup' });
    assert.equal(result.stagingCleanup, 'pending_recovery');
    assert.deepEqual(
      await f.repository.checkoutCurrent(result.binding.repositorySessionId),
      result.committed,
    );
    assert.deepEqual(
      await coordinator.publish({ sessionId: 'session', requestId: 'cleanup' }),
      result,
    );
  } finally {
    await coordinator.close();
    await f.close();
  }
});

test('post-commit bundle cleanup failure reports the committed receipt and is recoverable', async () => {
  const f = await fixture();
  let coordinator = f.make();
  try {
    f.failBundleCleanup(true);
    const result = await coordinator.publish({ sessionId: 'session', requestId: 'cleanup' });
    assert.equal(result.committed.ref.revision, 'r1');
    assert.equal(Reflect.get(result, 'bundleCleanup'), 'pending_recovery');
    assert.deepEqual(
      await f.repository.checkoutCurrent(result.binding.repositorySessionId),
      result.committed,
    );
    await coordinator.close();
    f.failBundleCleanup(false);
    coordinator = f.make();
    const replay = await coordinator.publish({ sessionId: 'session', requestId: 'cleanup' });
    assert.deepEqual(replay.committed, result.committed);
    assert.equal(Reflect.get(replay, 'bundleCleanup'), 'released');
    assert.equal(f.captures(), 1);
    assert.equal(f.cleanedBundles.length, 1);
  } finally {
    await coordinator.close();
    await f.close();
  }
});

test('CAS conflict cleans only its owned temporary bundle and retries interrupted cleanup', async () => {
  const f = await fixture();
  let coordinator = f.make();
  try {
    await coordinator.publish({ sessionId: 'session', requestId: 'initial' });
    await coordinator.close();
    coordinator = f.make(
      intercept(f.repository, {
        commit: async (input) => {
          await f.repository.commit({ ...input, commitId: 'other-writer' });
          return f.repository.commit(input);
        },
      }),
    );
    f.failBundleCleanup(true);
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'conflict' }),
      code('conflict'),
    );
    let commitId = '';
    await f.journal.withSession('session', async (document) => {
      commitId = document.requests.at(-1)!.commitId;
    });
    assert.ok(await readFile(join(f.root, commitId)));
    await coordinator.close();
    f.failBundleCleanup(false);
    coordinator = f.make();
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'conflict' }),
      code('conflict'),
    );
    await assert.rejects(readFile(join(f.root, commitId)), { code: 'ENOENT' });
    assert.ok(f.cleanedBundles.includes(commitId));
  } finally {
    await coordinator.close();
    await f.close();
  }
});

test('journal reserves receipt capacity before committing a new Head', async () => {
  const f = await fixture();
  const coordinator = f.make();
  try {
    const original = await coordinator.publish({ sessionId: 'session', requestId: 'original' });
    const file = (await readdir(f.directory)).find((name) => /^session-.*\.json$/.test(name))!;
    const path = join(f.directory, file);
    const document = JSON.parse(await readFile(path, 'utf8'));
    // Leave enough disk-document quota for capturing/prepared, but not the
    // subsequent receipt. Unknown extension data is retained by this journal.
    document.padding = '';
    document.padding = 'x'.repeat(
      4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(document)) - 6000,
    );
    await writeFile(path, JSON.stringify(document));
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'full' }),
      code('publication_failed'),
    );
    assert.deepEqual(
      await f.repository.checkoutCurrent(original.binding.repositorySessionId),
      original.committed,
    );
    assert.equal(JSON.parse(await readFile(path, 'utf8')).requests.at(-1).phase, 'capturing');
  } finally {
    await coordinator.close();
    await f.close();
  }
});

test('cancellation and close reject admission without any snapshot', async () => {
  const f = await fixture();
  const coordinator = f.make();
  try {
    const originalFiles = await readdir(f.directory);
    await assert.rejects(
      coordinator.publish({
        sessionId: 'session',
        requestId: 'expired',
        deadlineAt: Date.now() - 1,
      }),
      code('cancelled'),
    );
    assert.deepEqual(
      await readdir(f.directory),
      originalFiles,
      'an expired request must not reserve a journal identity',
    );
    await assert.rejects(
      coordinator.publish({
        sessionId: 'session',
        requestId: 'cancelled',
        signal: AbortSignal.abort(),
      }),
      code('cancelled'),
    );
    assert.equal(f.captures(), 0);
    await coordinator.close();
    await assert.rejects(
      coordinator.publish({ sessionId: 'session', requestId: 'closed' }),
      code('closed'),
    );
  } finally {
    await coordinator.close();
    await f.close();
  }
});
