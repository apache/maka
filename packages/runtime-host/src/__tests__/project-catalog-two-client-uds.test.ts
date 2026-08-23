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
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveProjectCatalogForWrite } from '@maka/storage';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  connectRuntimeHost,
  readRuntimeHostProjects,
  readRuntimeHostSessions,
  type RuntimeHostConnection,
} from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import { RuntimeHostKernel } from '../server/index.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const REQUEST_TIMEOUT_MS = 5_000;

test('two UDS clients converge on one Host-owned Project Catalog', {
  skip: process.platform === 'win32',
  timeout: 20_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-catalog-two-client-'));
  const dataRoot = join(base, 'data-root');
  const oldPath = join(base, 'old-location');
  const newPath = join(base, 'new-location');
  await mkdir(oldPath);
  const capability = await resolveStorageRoot({ path: dataRoot, kind: 'interactive' });
  const seeded = await seedCatalog(capability, oldPath, newPath);
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let host: RuntimeHostKernel | undefined;
  const connections: RuntimeHostConnection[] = [];
  try {
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 30_000,
      composition: defineInteractiveRuntimeHostComposition(createExecutionRuntimeHostComposition),
    });
    const [desktop, tui] = await Promise.all([connectClient(dataRoot), connectClient(dataRoot)]);
    connections.push(desktop, tui);
    assert.deepEqual(await readRuntimeHostProjects(desktop), await readRuntimeHostProjects(tui));

    const desktopChanged = nextProjectChange(desktop);
    const tuiChanged = nextProjectChange(tui);
    const relinked = await desktop.request(
      'project.catalog.mutate',
      { kind: 'relink', projectId: seeded.originalProjectId, path: newPath },
      REQUEST_TIMEOUT_MS,
    );
    assert.equal(relinked.kind, 'project');
    assert.deepEqual(await Promise.all([desktopChanged, tuiChanged]), [1, 1]);

    const [desktopProjects, tuiProjects] = await Promise.all([
      readRuntimeHostProjects(desktop),
      readRuntimeHostProjects(tui),
    ]);
    assert.deepEqual(tuiProjects, desktopProjects);
    assert.equal(desktopProjects.length, 1);
    assert.equal(desktopProjects[0]?.id, seeded.originalProjectId);
    assert.deepEqual(desktopProjects[0]?.aliases, [seeded.duplicateProjectId]);

    const sessions = await readRuntimeHostSessions(tui);
    for (const sessionId of seeded.sessionIds) {
      const session = sessions.find(({ id }) => id === sessionId);
      assert.ok(session);
      assert.equal(session && 'kind' in session, false);
      if (!session || 'kind' in session) continue;
      assert.deepEqual(session.workspace, {
        target: { kind: 'project', projectId: seeded.originalProjectId },
        hostCwd: seeded.destinationPath,
      });
    }
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const connection of connections) {
      await connection.close().catch((error: unknown) => cleanupErrors.push(error));
    }
    await host?.close().catch((error: unknown) => cleanupErrors.push(error));
    if (!host && !owner.closed) {
      await owner.close().catch((error: unknown) => cleanupErrors.push(error));
    }
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    }).catch((error: unknown) => cleanupErrors.push(error));
    await rm(base, { recursive: true, force: true }).catch((error: unknown) =>
      cleanupErrors.push(error),
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Project Catalog UDS test cleanup failed');
    }
  }
});

async function seedCatalog(
  capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>,
  oldPath: string,
  newPath: string,
): Promise<{
  originalProjectId: string;
  duplicateProjectId: string;
  destinationPath: string;
  sessionIds: readonly [string, string];
}> {
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire Project Catalog seed owner');
  const catalog = await openInteractiveProjectCatalogForWrite(owner.lease);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  try {
    const original = await catalog.register(oldPath);
    await rename(oldPath, newPath);
    const destinationPath = await realpath(newPath);
    const duplicate = await catalog.register(newPath);
    const first = await stores.sessionStore.create(sessionInput(oldPath, original.id));
    const second = await stores.sessionStore.create(sessionInput(destinationPath, duplicate.id));
    return {
      originalProjectId: original.id,
      duplicateProjectId: duplicate.id,
      destinationPath,
      sessionIds: [first.id, second.id],
    };
  } finally {
    catalog.close();
    await stores.sessionStore.close?.();
    await owner.close();
  }
}

function sessionInput(cwd: string, projectId: string) {
  return {
    cwd,
    projectId,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
  };
}

async function connectClient(rootPath: string): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({
    rootPath,
    protocol: PROTOCOL,
    connectTimeoutMs: REQUEST_TIMEOUT_MS,
    handshakeTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (result.kind !== 'connected') {
    throw new Error(`Runtime Host Client did not connect: ${result.kind}`);
  }
  return result.connection;
}

function nextProjectChange(connection: RuntimeHostConnection): Promise<number> {
  return new Promise((resolve) => {
    const unsubscribe = connection.subscribeProjectCatalogChanges((revision) => {
      unsubscribe();
      resolve(revision);
    });
  });
}
