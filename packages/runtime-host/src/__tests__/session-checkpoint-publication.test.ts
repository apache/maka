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
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { messageContentDigest, normalizeMessageContent } from '@maka/core/events';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { createMemoryExecutionPersistenceProvider } from '@maka/storage/test-only/memory-execution-persistence';
import { createSessionBundleFileService } from '@maka/storage/session-bundle-file-service';
import { openFileSessionRepository } from '@maka/storage/file-session-repository';
import { materializeSessionCheckpointV1 } from '@maka/storage/session-repository';
import type { SessionBundleLimits } from '@maka/storage/session-bundle-contract';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { HostCheckpointError } from '../server/session-checkpoint-coordinator.js';
import type { HostCheckpointWorkspaceAuthority } from '../server/session-checkpoint-publication.js';

const limits: SessionBundleLimits = {
  maxCompressedBytes: 8 * 1024 * 1024,
  maxDecompressedTarBytes: 16 * 1024 * 1024,
  maxPayloadBytes: 8 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxEntryCount: 1000,
  maxManifestBytes: 256 * 1024,
  maxStateIdentityBytes: 64 * 1024,
  maxPathBytes: 255,
  maxPathDepth: 32,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(
  options: {
    memory?: boolean;
    disabled?: boolean;
    corruptAuthority?: boolean;
    workspace?: HostCheckpointWorkspaceAuthority;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-host-checkpoint-'));
  const state = join(root, 'state');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: state, kind: 'interactive' }),
  );
  assert.ok(owner);
  if (options.corruptAuthority) {
    const operations = join(owner.controlDirectory, 'session-checkpoints-v1', 'operations');
    await mkdir(operations, { recursive: true });
    await writeFile(join(operations, 'authority-v1.json'), '{"schemaVersion":999}');
  }
  const provider = options.memory ? createMemoryExecutionPersistenceProvider() : undefined;
  const composition = await createExecutionRuntimeHostComposition(
    {
      owner,
      hostEpoch: 'checkpoint-test-epoch',
      acquireResidency: () => ({ release() {} }),
      retainUntilProcessExit: () => {},
      requestDrain: () => {},
    },
    { bootstrapRuntimePolicy: false },
    {
      executionPersistenceProvider: provider,
      checkpointPublication: options.disabled
        ? undefined
        : {
            limits,
            // This test directory is private and has no writers except those owned by
            // the fixture. This is NOT a production claim about arbitrary directories.
            workspace: options.workspace ?? {
              runExclusive: async (_input, operation) => operation(),
            },
            privateStagingRootAuthority:
              process.platform === 'win32'
                ? {
                    verifyPrivateStagingRoot: async ({ canonicalPath }) => ({ canonicalPath }),
                  }
                : undefined,
          },
    },
  );
  await composition.recover();
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease, provider);
  const session = await stores.sessionStore.create({
    cwd: workspace,
    llmConnectionSlug: 'test',
    model: 'test',
    permissionMode: 'ask',
    name: 'Checkpoint test',
    labels: [],
  });
  await stores.sessionStore.appendMessage(session.id, {
    type: 'user',
    id: 'message-before',
    turnId: 'turn-before',
    ts: 1,
    text: 'before checkpoint',
  });
  await writeFile(join(workspace, 'file.txt'), 'workspace at checkpoint');
  return {
    root,
    state,
    workspace,
    owner,
    composition,
    stores,
    session,
    async materialize(result: Awaited<ReturnType<typeof composition.sessionCheckpoints.publish>>) {
      const repository = await openFileSessionRepository({
        storageRoot: join(owner.controlDirectory, 'session-checkpoints-v1', 'repository'),
      });
      const source = await materializeSessionCheckpointV1({
        objectStore: repository.objectStore,
        checkpoint: result.committed.checkpoint,
        destination: join(root, 'materialized.tar.zst'),
        maxBytes: limits.maxCompressedBytes,
      });
      return createSessionBundleFileService().hydrate({
        source,
        expectedSessionId: result.binding.repositorySessionId,
        destinationRoot: join(root, 'inspection-only'),
        limits,
      });
    },
    async close() {
      await composition.close();
      await owner.close();
      await rm(owner.controlDirectory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('real Host publishes a verified Bundle/Manifest and provider fence covers the entire workspace copy', {
  timeout: 20_000,
}, async () => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture({
    workspace: {
      runExclusive: async (_input, operation) => {
        entered.resolve();
        await release.promise;
        return operation();
      },
    },
  });
  try {
    const pending = f.composition.sessionCheckpoints.publish({
      sessionId: f.session.id,
      requestId: 'capture',
    });
    await entered.promise;
    let changed = false;
    const write = f.stores.sessionStore
      .appendMessage(f.session.id, {
        type: 'user',
        id: 'message-after',
        turnId: 'turn-after',
        ts: 2,
        text: 'after checkpoint',
      })
      .then(() => {
        changed = true;
      });
    await setImmediate();
    assert.equal(changed, false, 'live mutation must not enter a held snapshot boundary');
    release.resolve();
    const result = await pending;
    await write;
    assert.equal(result.committed.ref.revision, 'r1');
    assert.equal(result.binding.makaSessionId, f.session.id);
    const hydrated = await f.materialize(result);
    assert.equal(
      await readFile(join(hydrated.workspaceRoot, 'file.txt'), 'utf8'),
      'workspace at checkpoint',
    );
    const database = new DatabaseSync(join(hydrated.stateRoot, 'runtime.sqlite'), {
      readOnly: true,
    });
    try {
      assert.equal(
        database
          .prepare('SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?')
          .get(f.session.id)?.n,
        1,
      );
    } finally {
      database.close();
    }
    assert.equal((await f.stores.sessionStore.readMessages(f.session.id)).length, 2);
    assert.deepEqual(
      await f.composition.sessionCheckpoints.publish({
        sessionId: f.session.id,
        requestId: 'capture',
      }),
      result,
    );
    await f.composition.close();
    await assert.rejects(
      f.composition.sessionCheckpoints.publish({ sessionId: f.session.id, requestId: 'closed' }),
      hasCode('closed'),
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

test('corrupt optional checkpoint metadata does not prevent real Host live-state recovery', async () => {
  const f = await fixture({ corruptAuthority: true });
  try {
    await assert.rejects(
      f.composition.sessionCheckpoints.publish({ sessionId: f.session.id, requestId: 'failed' }),
      hasCode('publication_failed'),
    );
    assert.equal((await f.stores.sessionStore.readMessages(f.session.id)).length, 1);
    assert.equal(
      await readFile(
        join(f.owner.controlDirectory, 'session-checkpoints-v1', 'operations', 'authority-v1.json'),
        'utf8',
      ),
      '{"schemaVersion":999}',
    );
  } finally {
    await f.close();
  }
});

for (const mode of ['disabled', 'memory'] as const) {
  test(`real Host ${mode} publication is explicitly unsupported; live writes still work`, async () => {
    const f = await fixture({ [mode]: true });
    try {
      await assert.rejects(
        f.composition.sessionCheckpoints.publish({
          sessionId: f.session.id,
          requestId: 'unsupported',
        }),
        hasCode('unsupported'),
      );
      assert.equal((await f.stores.sessionStore.readMessages(f.session.id)).length, 1);
      await assert.rejects(
        readFile(
          join(
            f.owner.controlDirectory,
            'session-checkpoints-v1',
            'operations',
            'authority-v1.json',
          ),
        ),
      );
    } finally {
      await f.close();
    }
  });
}
test('real Host rejects pending message admission without undoing the live commit', async () => {
  const f = await fixture();
  try {
    const content = normalizeMessageContent({ text: 'pending' });
    await f.stores.sessionStore.commitMessageAdmission({
      sessionId: f.session.id,
      turnId: 'pending-turn',
      runId: 'pending-run',
      messageId: 'pending-message',
      content,
      submittedContentDigest: messageContentDigest(content),
      submittedPlacement: 'next_turn',
      placement: 'next_turn',
      disposition: 'followup',
      skillInvocation: { loaded: [], failed: [], receipts: [] },
      admittedAt: Date.now(),
    });
    await assert.rejects(
      f.composition.sessionCheckpoints.publish({ sessionId: f.session.id, requestId: 'busy' }),
      hasCode('busy'),
    );
    assert.equal((await f.stores.sessionStore.listMessageAdmissions(f.session.id)).length, 1);
    assert.equal((await f.stores.sessionStore.readMessages(f.session.id)).length, 1);
  } finally {
    await f.close();
  }
});
test('real Host rejects secrets and shared workspaces rather than publishing partial state', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, '.env'), 'test secret');
    await assert.rejects(
      f.composition.sessionCheckpoints.publish({ sessionId: f.session.id, requestId: 'secret' }),
      hasCode('publication_failed'),
    );
    await rm(join(f.workspace, '.env'));
    await f.stores.sessionStore.create({
      cwd: f.workspace,
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    await assert.rejects(
      f.composition.sessionCheckpoints.publish({ sessionId: f.session.id, requestId: 'shared' }),
      hasCode('unsupported'),
    );
  } finally {
    await f.close();
  }
});

for (const phase of ['before-cas', 'after-cas'] as const) {
  test(`real Host killed ${phase} retries the exact prepared checkpoint without recapture`, {
    timeout: 30_000,
  }, async () => {
    const f = await fixture();
    let successor: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
    let successorOwner: typeof f.owner | undefined;
    let child: ReturnType<typeof fork> | undefined;
    let closed: Promise<void> | undefined;
    try {
      // Start from an existing committed head, so a pre-CAS crash must preserve it.
      const initial = await f.composition.sessionCheckpoints.publish({
        sessionId: f.session.id,
        requestId: 'initial',
      });
      await f.composition.close();
      await f.owner.close();
      child = fork(
        new URL('./fixtures/session-checkpoint-crash-host.js', import.meta.url),
        [f.state, f.session.id, 'crash', phase],
        {
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        },
      );
      closed = new Promise<void>((resolve) => child!.once('close', () => resolve()));
      const [message] = await Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(15_000) }),
        closed.then(() => {
          throw new Error('Checkpoint child exited before its crash point');
        }),
      ]);
      assert.deepEqual(message, { phase });
      child.kill('SIGKILL');
      await closed;
      const repository = await openFileSessionRepository({
        storageRoot: join(f.owner.controlDirectory, 'session-checkpoints-v1', 'repository'),
      });
      assert.equal(
        (await repository.checkoutCurrent(initial.binding.repositorySessionId)).ref.revision,
        phase === 'before-cas' ? 'r1' : 'r2',
      );
      // A newer live file must NOT get captured under the interrupted identity.
      await writeFile(join(f.workspace, 'file.txt'), 'newer live contents');
      const acquired = await tryAcquireInteractiveRootOwner(
        await resolveStorageRoot({ path: f.state, kind: 'interactive' }),
      );
      assert.ok(acquired);
      successorOwner = acquired;
      successor = await createExecutionRuntimeHostComposition(
        {
          owner: acquired,
          hostEpoch: 'successor',
          acquireResidency: () => ({ release() {} }),
          retainUntilProcessExit: () => {},
          requestDrain: () => {},
        },
        { bootstrapRuntimePolicy: false },
        {
          checkpointPublication: {
            limits,
            workspace: {
              runExclusive: async () => {
                throw new Error('must not recapture');
              },
            },
            privateStagingRootAuthority:
              process.platform === 'win32'
                ? {
                    verifyPrivateStagingRoot: async ({ canonicalPath }) => ({ canonicalPath }),
                  }
                : undefined,
          },
        },
      );
      await successor.recover();
      const result = await successor.sessionCheckpoints.publish({
        sessionId: f.session.id,
        requestId: 'crash',
      });
      assert.equal(result.committed.ref.revision, 'r2');
      assert.deepEqual(
        await successor.sessionCheckpoints.publish({ sessionId: f.session.id, requestId: 'crash' }),
        result,
      );
      const hydrated = await f.materialize(result);
      assert.equal(
        await readFile(join(hydrated.workspaceRoot, 'file.txt'), 'utf8'),
        'workspace at checkpoint',
      );
      assert.equal(await readFile(join(f.workspace, 'file.txt'), 'utf8'), 'newer live contents');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      await successor?.close();
      await successorOwner?.close();
      await f.close();
    }
  });
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof HostCheckpointError && error.code === code;
}
