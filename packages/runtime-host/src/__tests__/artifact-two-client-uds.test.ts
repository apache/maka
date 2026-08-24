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
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { ARTIFACT_ENTITY_ID_MAX_CHARS } from '@maka/core/artifacts';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import {
  connectRuntimeHost,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION, type ArtifactQueryResult } from '../protocol/index.js';
import { removePosixEndpointDirectories } from './fixtures/endpoint-hygiene.js';

const CURRENT_PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const PROCESS_TIMEOUT_MS = 30_000;
const BULK_ARTIFACT_COUNT = 24;
const BULK_ARTIFACT_SUMMARY = 's'.repeat(7 * 1024);
const MAX_ARTIFACT_ID = 'a'.repeat(ARTIFACT_ENTITY_ID_MAX_CHARS);
const PROTECTED_ARTIFACTS = [
  { id: 'deep-research-evidence', source: 'deep_research' },
  { id: 'tool-result-archive', source: 'tool_result_archive' },
] as const;

test('production Host recovers Artifact publication and preserves deletes across owner death', {
  timeout: 120_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-artifacts-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const { sessionId, otherSessionId } = await seedExecutionRoot(capability, root);
  const residue = await createPublicationResidue(root, sessionId);
  let firstHost: ExecutionHostHandle | undefined;
  let successor: ExecutionHostHandle | undefined;
  try {
    firstHost = await startHost(root, capability.rootId);
    await assert.rejects(() => stat(residue.stagingPath), { code: 'ENOENT' });
    await assert.rejects(() => stat(residue.targetPath), { code: 'ENOENT' });

    const desktop = await connectClient(root);
    const tui = await connectClient(root);
    const deleteA = MAX_ARTIFACT_ID;
    const deleteB = 'artifact-003';
    try {
      const [desktopPage, tuiPage] = await Promise.all([
        firstArtifactPage(desktop, sessionId),
        firstArtifactPage(tui, sessionId),
      ]);
      assert.deepEqual(tuiPage, desktopPage);
      assert.ok(desktopPage.nextCursor);
      assert.equal(desktopPage.nextCursor, String(desktopPage.artifacts.length));
      assert.ok(desktopPage.artifacts.length < 128, 'first page must be byte limited');
      const [desktopTraversal, tuiTraversal] = await Promise.all([
        collectArtifacts(desktop, desktopPage),
        collectArtifacts(tui, tuiPage),
      ]);
      const desktopArtifacts = desktopTraversal.artifacts;
      const tuiArtifacts = tuiTraversal.artifacts;
      assert.deepEqual(tuiArtifacts, desktopArtifacts);
      assert.equal(tuiTraversal.pageCount, desktopTraversal.pageCount);
      assert.ok(desktopTraversal.pageCount > 3);
      assert.equal(desktopArtifacts.length, 135 + BULK_ARTIFACT_COUNT);
      assert.equal(
        new Set(desktopArtifacts.map((artifact) => artifact.id)).size,
        135 + BULK_ARTIFACT_COUNT,
      );
      assert.equal(JSON.stringify(desktopArtifacts).includes('relativePath'), false);
      assert.deepEqual(
        desktopArtifacts.slice(0, 4 + BULK_ARTIFACT_COUNT).map((artifact) => artifact.id),
        [
          'small-text',
          'small-binary',
          'deep-research-evidence',
          'tool-result-archive',
          ...Array.from(
            { length: BULK_ARTIFACT_COUNT },
            (_, index) => `bulk-${index.toString().padStart(3, '0')}`,
          ),
        ],
      );

      const [text, binary] = await Promise.all([
        desktop.request('artifact.query', {
          kind: 'read_text',
          sessionId,
          artifactId: 'small-text',
        }),
        tui.request('artifact.query', {
          kind: 'read_binary',
          sessionId,
          artifactId: 'small-binary',
        }),
      ]);
      assert.deepEqual(text, {
        kind: 'text',
        sessionId,
        artifactId: 'small-text',
        preview: { ok: true, text: 'small text preview' },
      });
      assert.equal(binary.kind, 'binary');
      assert.ok(binary.kind === 'binary' && binary.preview.ok);
      if (binary.kind === 'binary' && binary.preview.ok) {
        assert.equal(binary.preview.mimeType, 'image/png');
        assert.deepEqual(Buffer.from(binary.preview.base64, 'base64'), tinyPng());
      }
      assert.deepEqual(
        await desktop.request('artifact.query', {
          kind: 'read_text',
          sessionId,
          artifactId: 'replacement-expanded-text',
        }),
        {
          kind: 'text',
          sessionId,
          artifactId: 'replacement-expanded-text',
          preview: { ok: false, reason: 'too_large' },
        },
      );
      assert.deepEqual(
        await tui.request('artifact.query', {
          kind: 'read_text',
          sessionId: otherSessionId,
          artifactId: 'small-text',
        }),
        {
          kind: 'text',
          sessionId: otherSessionId,
          artifactId: 'small-text',
          preview: { ok: false, reason: 'not_found' },
        },
      );

      assert.equal((await getArtifact(desktop, sessionId, deleteA)).artifact?.id, deleteA);
      const [deletedA, deletedB] = await Promise.all([
        desktop.request('artifact.delete', { sessionId, artifactId: deleteA }),
        tui.request('artifact.delete', { sessionId, artifactId: deleteB }),
      ]);
      assert.equal(deletedA.artifact.status, 'deleted');
      assert.equal(deletedB.artifact.status, 'deleted');
      assert.deepEqual(
        await desktop.request('artifact.delete', { sessionId, artifactId: deleteA }),
        deletedA,
      );
      await assert.rejects(
        tui.request('artifact.delete', {
          sessionId: otherSessionId,
          artifactId: deleteA,
        }),
        operationError('not_found'),
      );

      const protectedBefore = await Promise.all(
        PROTECTED_ARTIFACTS.map(({ id }) => getArtifact(desktop, sessionId, id)),
      );
      for (const [index, artifact] of PROTECTED_ARTIFACTS.entries()) {
        const client = index % 2 === 0 ? desktop : tui;
        await assert.rejects(
          client.request('artifact.delete', { sessionId, artifactId: artifact.id }),
          operationError('operation_conflict'),
        );
      }
      const protectedAfter = await Promise.all(
        PROTECTED_ARTIFACTS.map(({ id }) => getArtifact(tui, sessionId, id)),
      );
      assert.deepEqual(protectedAfter, protectedBefore);

      const stale = await tui.request('artifact.query', {
        kind: 'list_continue',
        sessionId,
        revision: desktopPage.revision,
        cursor: desktopPage.nextCursor!,
      });
      assert.equal(stale.kind, 'revision_changed');
      if (stale.kind === 'revision_changed') {
        assert.equal(stale.expected, desktopPage.revision);
        assert.notEqual(stale.actual, desktopPage.revision);
      }
      const staleWithOutOfRangeCursor = await tui.request('artifact.query', {
        kind: 'list_continue',
        sessionId,
        revision: desktopPage.revision,
        cursor: '999999',
      });
      assert.equal(staleWithOutOfRangeCursor.kind, 'revision_changed');

      await killHost(firstHost);
      firstHost = undefined;
      await Promise.allSettled([desktop.closed, tui.closed]);
    } finally {
      await Promise.allSettled([desktop.close(), tui.close()]);
    }

    successor = await startHost(root, capability.rootId);
    const observer = await connectClient(root);
    try {
      for (const artifactId of [deleteA, deleteB]) {
        const getResult = await getArtifact(observer, sessionId, artifactId);
        const readResult = await observer.request('artifact.query', {
          kind: 'read_text',
          sessionId,
          artifactId,
        });
        assert.equal(getResult.artifact?.status, 'deleted');
        assert.equal(readResult.kind, 'text');
        if (readResult.kind === 'text') {
          assert.deepEqual(readResult.preview, { ok: false, reason: 'deleted' });
        }
      }
      for (const artifact of PROTECTED_ARTIFACTS) {
        const getResult = await getArtifact(observer, sessionId, artifact.id);
        assert.equal(getResult.artifact?.status, 'live');
        assert.equal(getResult.artifact?.source, artifact.source);
        const readResult = await observer.request('artifact.query', {
          kind: 'read_text',
          sessionId,
          artifactId: artifact.id,
        });
        assert.equal(readResult.kind, 'text');
        if (readResult.kind === 'text') {
          assert.deepEqual(readResult.preview, {
            ok: true,
            text: `protected ${artifact.source}`,
          });
        }
      }
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

type Page = Extract<ArtifactQueryResult, { kind: 'page' }>;
type ArtifactResult = Extract<ArtifactQueryResult, { kind: 'artifact' }>;

async function seedExecutionRoot(
  capability: StorageRootCapability<'interactive'>,
  root: string,
): Promise<{ readonly sessionId: string; readonly otherSessionId: string }> {
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, 'Artifact test could not acquire the interactive root owner');
  let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
  let artifacts: Awaited<ReturnType<typeof openInteractiveArtifactStoreForWrite>> | undefined;
  try {
    stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const otherSession = await stores.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const openedArtifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    artifacts = openedArtifacts;
    await openedArtifacts.recover();
    await Promise.all([
      ...Array.from({ length: 130 }, (_, index) =>
        openedArtifacts.create({
          id: index === 2 ? MAX_ARTIFACT_ID : `artifact-${index.toString().padStart(3, '0')}`,
          sessionId: session.id,
          turnId: 'turn-1',
          name: `artifact-${index}.txt`,
          kind: 'file',
          content: `content ${index}`,
          mimeType: 'text/plain',
          source: 'fixture',
          now: 10_000 - index,
        }),
      ),
      openedArtifacts.create({
        id: 'small-text',
        sessionId: session.id,
        turnId: 'turn-1',
        name: 'small.txt',
        kind: 'file',
        content: 'small text preview',
        mimeType: 'text/plain',
        source: 'fixture',
        now: 20_000,
      }),
      openedArtifacts.create({
        id: 'small-binary',
        sessionId: session.id,
        turnId: 'turn-1',
        name: 'small.png',
        kind: 'image',
        content: tinyPng(),
        mimeType: 'image/png',
        source: 'fixture',
        now: 19_999,
      }),
      openedArtifacts.create({
        id: 'replacement-expanded-text',
        sessionId: session.id,
        turnId: 'turn-1',
        name: 'replacement-expanded.txt',
        kind: 'file',
        content: Buffer.alloc(12 * 1024, 0xff),
        mimeType: 'text/plain',
        source: 'fixture',
        now: 9_000,
      }),
      ...PROTECTED_ARTIFACTS.map((artifact, index) =>
        openedArtifacts.create({
          id: artifact.id,
          sessionId: session.id,
          turnId: 'turn-1',
          name: `${artifact.id}.txt`,
          kind: 'file',
          content: `protected ${artifact.source}`,
          mimeType: 'text/plain',
          source: artifact.source,
          now: 19_998 - index,
        }),
      ),
      ...Array.from({ length: BULK_ARTIFACT_COUNT }, (_, index) => {
        const id = `bulk-${index.toString().padStart(3, '0')}`;
        return openedArtifacts.create({
          id,
          sessionId: session.id,
          turnId: 'turn-1',
          name: `${id}.txt`,
          kind: 'file',
          content: `bulk artifact payload ${index}`,
          mimeType: 'text/plain',
          source: 'fixture',
          summary: BULK_ARTIFACT_SUMMARY,
          now: 19_000 - index,
        });
      }),
    ]);
    return { sessionId: session.id, otherSessionId: otherSession.id };
  } finally {
    artifacts?.close();
    await stores?.sessionStore.close?.();
    await owner.close();
  }
}

async function createPublicationResidue(
  root: string,
  sessionId: string,
): Promise<{ stagingPath: string; targetPath: string }> {
  const sessionDirectory = join(root, 'artifacts', sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  const targetPath = join(sessionDirectory, 'publication-residue-residue.txt');
  const hash = createHash('sha256').update(basename(targetPath)).digest('hex');
  const stagingPath = join(
    dirname(targetPath),
    `.artifact-publish.${hash}.00000000-0000-4000-8000-000000000000.tmp`,
  );
  await writeFile(stagingPath, 'uncommitted publication', { flag: 'wx' });
  await link(stagingPath, targetPath);
  return { stagingPath, targetPath };
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
    host.child.send({ type: 'shutdown' });
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
  if (!host) return;
  await terminateChild(host.child);
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

async function connectClient(rootPath: string): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({
    rootPath,
    protocol: CURRENT_PROTOCOL,
  });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Runtime Host did not accept the Client');
  return result.connection;
}

async function firstArtifactPage(client: RuntimeHostConnection, sessionId: string): Promise<Page> {
  const result = await client.request('artifact.query', { kind: 'list_start', sessionId });
  assert.equal(result.kind, 'page');
  if (result.kind !== 'page') assert.fail('Artifact start query must return a page');
  return result;
}

async function collectArtifacts(
  client: RuntimeHostConnection,
  first: Page,
): Promise<{ artifacts: Page['artifacts']; pageCount: number }> {
  const artifacts = [...first.artifacts];
  let pageCount = 1;
  let cursor = first.nextCursor;
  while (cursor !== null) {
    assert.equal(cursor, String(artifacts.length));
    const result = await client.request('artifact.query', {
      kind: 'list_continue',
      sessionId: first.sessionId,
      revision: first.revision,
      cursor,
    });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') assert.fail('Stable Artifact continuation must return a page');
    assert.equal(result.revision, first.revision);
    assert.ok(result.artifacts.length > 0, 'Artifact continuation must advance the cursor');
    artifacts.push(...result.artifacts);
    pageCount += 1;
    cursor = result.nextCursor;
  }
  return { artifacts, pageCount };
}

async function getArtifact(
  client: RuntimeHostConnection,
  sessionId: string,
  artifactId: string,
): Promise<ArtifactResult> {
  const result = await client.request('artifact.query', {
    kind: 'get',
    sessionId,
    artifactId,
  });
  assert.equal(result.kind, 'artifact');
  if (result.kind !== 'artifact') assert.fail('Artifact get query must return an item');
  return result;
}

function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
}

function operationError(code: RuntimeHostOperationError['code']) {
  return (error: unknown): boolean =>
    error instanceof RuntimeHostOperationError && error.code === code;
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
