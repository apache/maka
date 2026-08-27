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
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeRuntimeHostOwnerConnectionCode } from '@maka/runtime-host/client';
import type { RuntimeHostDesktopManager } from '../runtime-host-desktop-manager.js';
import { createDesktopLocalRuntimeHostRemoteAccess } from '../runtime-host-local-remote-access.js';
import type { createDesktopRuntimeHostLocalOperator } from '../runtime-host-local-operator.js';

test('enabling remote access hands the same root to one managed service before Desktop resumes', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-local-remote-access-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const clientDataRoot = join(base, 'client');
  const rootPath = join(clientDataRoot, 'workspaces', 'default');
  await mkdir(rootPath, { recursive: true });
  const handlers = new Map<string, Parameters<Electron.IpcMain['handle']>[1]>();
  let retired = false;
  let resumed = false;
  const manager = {
    async retireOwnedLocalHost() {
      retired = true;
      return { kind: 'retired' as const, resume: () => { resumed = true; } };
    },
  } as unknown as RuntimeHostDesktopManager;
  const peer = {
    peerId: '12D3KooWpeer',
    routeHints: ['/ip4/192.0.2.1/udp/41000/quic-v1'],
    coordinationRelays: [],
  };
  const operator = {
    async runSetup(input: { readonly rootPath: string }) {
      assert.equal(retired, true);
      assert.equal(input.rootPath, rootPath);
      return {
        serviceId: 'b'.repeat(64),
        operatorPath: join(base, 'operator'),
        rootPath,
        rootId: 'a'.repeat(64),
        credential: 'pending-credential',
        directPeer: peer,
      };
    },
    async runPeer() {
      return {
        kind: 'result' as const,
        action: 'status' as const,
        status: {
          state: 'enabled' as const,
          serviceState: 'running',
          rootId: 'a'.repeat(64),
          ...peer,
        },
      };
    },
    async runService() {
      throw new Error('rollback is not expected');
    },
    async close() {},
  } as unknown as ReturnType<typeof createDesktopRuntimeHostLocalOperator>;
  const service = createDesktopLocalRuntimeHostRemoteAccess({
    ipcMain: {
      handle: (channel, handler) => { handlers.set(channel, handler); },
      removeHandler: (channel) => { handlers.delete(channel); },
    },
    clientDataRoot,
    rootPath,
    directPeerAvailable: true,
    manager: () => manager,
    resolveSetupPackage: async () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    operator,
  });
  t.after(() => service.close());

  const enable = handlers.get('local-runtime-host-remote-access:enable');
  assert.ok(enable);
  const result = await enable({} as Electron.IpcMainInvokeEvent, {
    allowInterruptActiveTasks: false,
    coordinationRelays: [],
  }) as { readonly kind: string; readonly connectionCode: string };
  assert.equal(result.kind, 'enabled');
  assert.equal(resumed, true);
  assert.deepEqual(decodeRuntimeHostOwnerConnectionCode(result.connectionCode), {
    name: decodeRuntimeHostOwnerConnectionCode(result.connectionCode).name,
    rootId: 'a'.repeat(64),
    transport: { kind: 'libp2p-direct', ...peer },
    credential: 'pending-credential',
  });
  assert.equal(
    JSON.parse(await readFile(join(clientDataRoot, 'runtime-host-local-service.json'), 'utf8'))
      .rootPath,
    rootPath,
  );
});
