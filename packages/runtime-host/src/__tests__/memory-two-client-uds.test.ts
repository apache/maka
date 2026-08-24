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
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  openInteractiveMemoryBundleStoreForWrite,
  type MemoryBundleSnapshot,
  type MemoryDocumentSnapshot,
} from '@maka/storage/memory-bundle-store';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import { removePosixEndpointDirectories } from './fixtures/endpoint-hygiene.js';
import {
  MEMORY_DOCUMENT_CHUNK_MAX_BYTES,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type MemoryMutateResult,
  type MemoryQueryResult,
} from '../protocol/index.js';

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const PROCESS_TIMEOUT_MS = 10_000;

test('two UDS clients share one recoverable Memory authority across Host death', {
  skip: process.platform === 'win32' ? 'POSIX process death gate' : false,
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-memory-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const residue = await seedPartialMemoryTransaction(capability, root);
  let firstHost: ExecutionHostHandle | undefined;
  let successor: ExecutionHostHandle | undefined;
  try {
    firstHost = await startHost(root, capability.rootId);
    await assert.rejects(() => stat(residue.transactionPath), { code: 'ENOENT' });
    assert.deepEqual(await readFile(residue.pendingPath), residue.targetPending);

    const desktop = await connectClient(root);
    const tui = await connectClient(root);
    let incompleteUploadId: string;
    try {
      const initial = await memoryState(desktop);
      assert.equal(initial.status, 'ok');
      const [desktopMutation, tuiMutation] = await Promise.all([
        desktop.request('memory.mutate', {
          kind: 'remember',
          expectedRevision: initial.revision,
          title: 'Desktop preference',
          content: 'Keep desktop preference.',
          scope: { kind: 'workspace' },
        }),
        tui.request('memory.mutate', {
          kind: 'remember',
          expectedRevision: initial.revision,
          title: 'TUI preference',
          content: 'Keep TUI preference.',
          scope: { kind: 'workspace' },
        }),
      ]);
      assert.deepEqual([desktopMutation.kind, tuiMutation.kind].sort(), [
        'committed',
        'revision_conflict',
      ]);

      const policy = await desktop.request('runtime.policy.query', {});
      const incognito = await desktop.request('runtime.policy.mutate', {
        expectedRevision: policy.revision,
        operation: { kind: 'set_privacy', value: { incognitoActive: true } },
      });
      assert.equal(incognito.kind, 'committed');
      assert.deepEqual(await tui.request('memory.query', { kind: 'state' }), {
        kind: 'blocked',
        reason: 'incognito_active',
      });
      const currentPolicy = await tui.request('runtime.policy.query', {});
      const visible = await tui.request('runtime.policy.mutate', {
        expectedRevision: currentPolicy.revision,
        operation: { kind: 'set_privacy', value: { incognitoActive: false } },
      });
      assert.equal(visible.kind, 'committed');

      const beforeReplace = await memoryState(desktop);
      const rawContent = [
        '# Maka Memory',
        '',
        '## UDS preference',
        '<!-- maka-memory: id=uds status=active scope=workspace -->',
        'x'.repeat(40_000),
        'Authorization: Bearer sk-live-secret-token-value',
        '',
      ].join('\n');
      const rawBytes = Buffer.from(rawContent);
      const opened = await desktop.request('memory.mutate', {
        kind: 'replace_begin',
        expectedRevision: beforeReplace.revision,
        totalBytes: rawBytes.byteLength,
        contentSha256: revision(rawBytes),
      });
      assert.equal(opened.kind, 'upload_opened');
      if (opened.kind !== 'upload_opened') assert.fail('Memory upload must open');
      const firstChunk = rawBytes.subarray(0, MEMORY_DOCUMENT_CHUNK_MAX_BYTES);
      assert.deepEqual(
        await tui.request('memory.mutate', {
          kind: 'replace_chunk',
          uploadId: opened.uploadId,
          offset: 0,
          chunkBase64: firstChunk.toString('base64'),
        }),
        { kind: 'rejected', reason: 'upload_not_found' },
      );
      for (
        let offset = 0;
        offset < rawBytes.byteLength;
        offset += MEMORY_DOCUMENT_CHUNK_MAX_BYTES
      ) {
        const chunk = rawBytes.subarray(
          offset,
          Math.min(rawBytes.byteLength, offset + MEMORY_DOCUMENT_CHUNK_MAX_BYTES),
        );
        const accepted: MemoryMutateResult = await desktop.request('memory.mutate', {
          kind: 'replace_chunk',
          uploadId: opened.uploadId,
          offset,
          chunkBase64: chunk.toString('base64'),
        });
        assert.equal(accepted.kind, 'chunk_accepted');
      }
      const committed = await desktop.request('memory.mutate', {
        kind: 'replace_commit',
        uploadId: opened.uploadId,
      });
      assert.equal(committed.kind, 'committed');

      const paged = await readDocument(tui, 'memory');
      assert.ok(paged.pageCount > 1);
      assert.match(paged.content, /Authorization: Bearer \[redacted\]/);
      assert.doesNotMatch(paged.content, /sk-live-secret-token-value/);
      assert.ok((await memoryState(tui)).backups.some((backup) => backup.kind === 'save'));

      const abandoned = await connectClient(root);
      const capacityBasis = await memoryState(abandoned);
      for (let index = 0; index < 8; index += 1) {
        const staged = await abandoned.request('memory.mutate', {
          kind: 'replace_begin',
          expectedRevision: capacityBasis.revision,
          totalBytes: 1,
          contentSha256: revision(Buffer.from([index])),
        });
        assert.equal(staged.kind, 'upload_opened');
      }
      await abandoned.close();
      await waitForConnectionCount(desktop, 2);

      const reclaimed = await desktop.request('memory.mutate', {
        kind: 'replace_begin',
        expectedRevision: capacityBasis.revision,
        totalBytes: 1,
        contentSha256: revision(Buffer.from('x')),
      });
      assert.equal(reclaimed.kind, 'upload_opened');
      if (reclaimed.kind !== 'upload_opened')
        assert.fail('Closed Client capacity must be reclaimed');
      await desktop.request('memory.mutate', {
        kind: 'replace_abort',
        uploadId: reclaimed.uploadId,
      });

      const beforeIncomplete = await memoryState(desktop);
      const incomplete = await desktop.request('memory.mutate', {
        kind: 'replace_begin',
        expectedRevision: beforeIncomplete.revision,
        totalBytes: 4,
        contentSha256: revision(Buffer.from('test')),
      });
      assert.equal(incomplete.kind, 'upload_opened');
      if (incomplete.kind !== 'upload_opened') assert.fail('Incomplete upload must open');
      incompleteUploadId = incomplete.uploadId;

      await killHost(firstHost);
      firstHost = undefined;
      await Promise.allSettled([desktop.closed, tui.closed]);
    } finally {
      await Promise.allSettled([desktop.close(), tui.close()]);
    }

    successor = await startHost(root, capability.rootId);
    const observer = await connectClient(root);
    try {
      const recovered = await readDocument(observer, 'memory');
      assert.ok(recovered.pageCount > 1);
      assert.match(recovered.content, /UDS preference/);
      assert.doesNotMatch(recovered.content, /sk-live-secret-token-value/);
      assert.deepEqual(
        await observer.request('memory.mutate', {
          kind: 'replace_commit',
          uploadId: incompleteUploadId!,
        }),
        { kind: 'rejected', reason: 'upload_not_found' },
      );
    } finally {
      await observer.close();
    }
    await stopHost(successor);
    successor = undefined;
  } finally {
    await Promise.allSettled([terminateHost(firstHost), terminateHost(successor)]);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await removePosixEndpointDirectories(capability.rootId);
    await rm(base, { recursive: true, force: true });
  }
});

interface ExecutionHostHandle {
  readonly child: ChildProcess;
  readonly hostEpoch: string;
  readonly endpoint: string;
}

async function seedPartialMemoryTransaction(
  capability: StorageRootCapability<'interactive'>,
  root: string,
): Promise<{
  transactionPath: string;
  pendingPath: string;
  targetPending: Buffer;
}> {
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Memory test could not acquire the interactive root owner');
  try {
    const store = await openInteractiveMemoryBundleStoreForWrite(owner.lease);
    const initial = await store.read();
    const targetMemory = Buffer.from('# Maka Memory\n\n## Seed\nSeed content.\n');
    const targetPending = Buffer.from('# Maka Pending Memory\n');
    const committed = await store.commit({
      expectedRevision: initial.revision,
      memory: targetMemory,
      pending: targetPending,
    });
    const memoryDirectory = join(root, 'memory');
    const pendingPath = join(memoryDirectory, 'PENDING.md');
    await writeFile(pendingPath, '# Old pending generation\n');
    const basis = await store.read();
    const transactionPath = join(memoryDirectory, '.memory-bundle-transaction');
    await mkdir(transactionPath, { mode: 0o700 });
    await writeFile(join(transactionPath, 'MEMORY.md.next'), targetMemory, { mode: 0o600 });
    await writeFile(join(transactionPath, 'PENDING.md.next'), targetPending, { mode: 0o600 });
    await writeFile(
      join(transactionPath, 'decision.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        basis: bundleDecision(basis),
        target: bundleDecision(committed.snapshot),
      })}\n`,
      { mode: 0o600 },
    );
    return { transactionPath, pendingPath, targetPending };
  } finally {
    await owner.close();
  }
}

function bundleDecision(snapshot: MemoryBundleSnapshot) {
  return {
    revision: snapshot.revision,
    memory: documentDecision(snapshot.memory),
    pending: documentDecision(snapshot.pending),
  };
}

function documentDecision(snapshot: MemoryDocumentSnapshot) {
  return {
    kind: snapshot.kind,
    byteLength: snapshot.byteLength,
    revision: snapshot.revision,
    reason: snapshot.kind === 'safe_mode' ? snapshot.reason : null,
  };
}

async function connectClient(rootPath: string): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({
    rootPath,
    protocol: CURRENT_PROTOCOL,
  });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Runtime Host did not accept the Client');
  return result.connection;
}

async function memoryState(
  client: RuntimeHostConnection,
): Promise<Extract<MemoryQueryResult, { kind: 'state' }>> {
  const result = await client.request('memory.query', { kind: 'state' });
  assert.equal(result.kind, 'state');
  if (result.kind !== 'state') assert.fail('Memory state query must return state');
  return result;
}

async function waitForConnectionCount(
  client: RuntimeHostConnection,
  expected: number,
): Promise<void> {
  await withTimeout(
    (async () => {
      for (;;) {
        if ((await client.status()).connections === expected) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })(),
    PROCESS_TIMEOUT_MS,
    `execution Host did not release connection count ${expected}`,
  );
}

async function readDocument(
  client: RuntimeHostConnection,
  document: 'memory' | 'pending',
): Promise<{ content: string; pageCount: number }> {
  const first = await client.request('memory.query', { kind: 'document_start', document });
  assert.equal(first.kind, 'document_page');
  if (first.kind !== 'document_page') assert.fail('Memory document query must return a page');
  const chunks = [Buffer.from(first.chunkBase64, 'base64')];
  let pageCount = 1;
  let cursor = first.nextCursor;
  while (cursor !== null) {
    const page: MemoryQueryResult = await client.request('memory.query', {
      kind: 'document_continue',
      document,
      revision: first.revision,
      cursor,
    });
    assert.equal(page.kind, 'document_page');
    if (page.kind !== 'document_page') {
      assert.fail('Stable Memory continuation must return a page');
    }
    chunks.push(Buffer.from(page.chunkBase64, 'base64'));
    pageCount += 1;
    cursor = page.nextCursor;
  }
  return { content: Buffer.concat(chunks).toString('utf8'), pageCount };
}

async function startHost(root: string, rootId: string): Promise<ExecutionHostHandle> {
  const child = fork(
    new URL('./fixtures/execution-host.js', import.meta.url),
    [root, rootId, '60000'],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  try {
    const ready = await waitForHostReady(child);
    return { child, ...ready };
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
}

async function stopHost(host: ExecutionHostHandle): Promise<void> {
  if (host.child.exitCode === null && host.child.signalCode === null) {
    host.child.kill('SIGTERM');
  }
  const exit = await withTimeout(
    waitForExitResult(host.child),
    PROCESS_TIMEOUT_MS,
    'execution Host did not stop',
  );
  assert.deepEqual(exit, { code: 0, signal: null });
}

async function killHost(host: ExecutionHostHandle): Promise<void> {
  host.child.kill('SIGKILL');
  const exit = await withTimeout(
    waitForExitResult(host.child),
    PROCESS_TIMEOUT_MS,
    'execution Host survived SIGKILL',
  );
  assert.equal(exit.signal, 'SIGKILL');
}

async function terminateHost(host: ExecutionHostHandle | undefined): Promise<void> {
  if (host) await terminateChild(host.child);
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await withTimeout(
    waitForExitResult(child),
    PROCESS_TIMEOUT_MS,
    'execution Host did not exit',
  ).then(
    () => undefined,
    () => undefined,
  );
}

function waitForHostReady(child: ChildProcess): Promise<{ hostEpoch: string; endpoint: string }> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off('error', onError);
        child.off('exit', onExit);
        child.off('message', onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`execution Host exited before readiness: ${code ?? signal}`));
      };
      const onMessage = (message: unknown) => {
        if (!isHostReadyMessage(message)) return;
        cleanup();
        resolve({ hostEpoch: message.hostEpoch, endpoint: message.endpoint });
      };
      child.once('error', onError);
      child.once('exit', onExit);
      child.on('message', onMessage);
    }),
    PROCESS_TIMEOUT_MS,
    'execution Host did not become ready',
  );
}

function isHostReadyMessage(
  value: unknown,
): value is { type: 'ready'; hostEpoch: string; endpoint: string } {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === 'ready' &&
    typeof message.hostEpoch === 'string' &&
    typeof message.endpoint === 'string'
  );
}

function waitForExitResult(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function revision(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
