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
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
} from '@maka/storage/root-authority';
import { connectExistingRuntimeHost } from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { removePosixEndpointDirectories } from './fixtures/endpoint-hygiene.js';

const PROCESS_TIMEOUT_MS = 10_000;

test('a live Host serves Interactive inspection over its real endpoint while retaining exclusive ownership', {
  skip: process.platform === 'win32' ? 'Windows execution Host startup lifecycle' : false,
  timeout: 60_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-inspect-'));
  const root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to seed Interactive inspection root');
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const session = await stores.sessionStore.create({
    cwd: root,
    name: 'Live inspection',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
  });
  await stores.sessionStore.close?.();
  await owner.close();

  let host: ChildProcess | undefined;
  try {
    host = await startHost(root, capability.rootId);
    assert.equal(await tryAcquireInteractiveRootReader(capability), undefined);

    const connected = await connectExistingRuntimeHost({
      rootPath: root,
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') throw new Error('Live inspection did not connect');
    try {
      assert.deepEqual(
        await connected.connection.request('execution.inspect.resolve', { id: session.id }),
        {
          status: 'resolved',
          candidates: [{ kind: 'session', id: session.id }],
          truncated: false,
        },
      );
      const inspected = await connected.connection.request('execution.inspect.query', {
        kind: 'session',
        sessionId: session.id,
      });
      assert.equal(inspected.kind, 'session');
      if (inspected.kind !== 'session') return;
      assert.equal(inspected.document.session.sessionId, session.id);
      assert.equal(inspected.document.session.name, 'Live inspection');
    } finally {
      await connected.connection.close();
    }

    await stopHost(host);
    host = undefined;
    const offlineReader = await tryAcquireInteractiveRootReader(capability);
    assert.ok(offlineReader);
    await offlineReader?.close();
  } finally {
    await terminateHost(host);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await removePosixEndpointDirectories(capability.rootId);
    await rm(base, { recursive: true, force: true });
  }
});

async function startHost(root: string, rootId: string): Promise<ChildProcess> {
  const child = fork(
    new URL('./fixtures/execution-host.js', import.meta.url),
    [root, rootId, '60000'],
    {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
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
          if (
            message &&
            typeof message === 'object' &&
            (message as { type?: unknown }).type === 'ready'
          ) {
            cleanup();
            resolve();
          }
        };
        child.once('error', onError);
        child.once('exit', onExit);
        child.on('message', onMessage);
      }),
      PROCESS_TIMEOUT_MS,
      'execution Host did not become ready',
    );
    return child;
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
}

async function stopHost(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const exit = await withTimeout(
    waitForExit(child),
    PROCESS_TIMEOUT_MS,
    'execution Host did not stop',
  );
  assert.deepEqual(exit, { code: 0, signal: null });
}

async function terminateHost(child: ChildProcess | undefined): Promise<void> {
  if (child) await terminateChild(child);
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await withTimeout(waitForExit(child), PROCESS_TIMEOUT_MS, 'execution Host did not exit').then(
    () => undefined,
    () => undefined,
  );
}

function waitForExit(
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
