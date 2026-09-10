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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import { connectRuntimeHost } from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import {
  createUnavailableDomainOperationHandlers,
  defineInteractiveRuntimeHostComposition,
  RuntimeHostKernel,
} from '@maka/runtime-host/server';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import type { DesktopRuntimeHostCandidate, DesktopRuntimeHostCandidateStartInput } from '../runtime-host-desktop-candidate.js';
import { startRuntimeHostDesktopManager } from '../runtime-host-desktop-manager.js';
import { prepareRuntimeHostQuit } from '../runtime-host-quit.js';

test('quit fences a real Host before Desktop cleanup without waiting for Host cleanup', { timeout: 10_000 }, async () => {
  const rootPath = await mkdtemp(join(tmpdir(), 'maka-desktop-quit-'));
  const finishHostCleanup = deferred<void>();
  let host: RuntimeHostKernel | undefined;
  let manager: Awaited<ReturnType<typeof startRuntimeHostDesktopManager>> | undefined;
  let draining = false;
  let releaseActivity = () => {};
  try {
    const owner = await tryAcquireInteractiveRootOwner(await resolveStorageRoot({ path: rootPath, kind: 'interactive' }));
    assert.ok(owner);
    host = await RuntimeHostKernel.start({
      owner,
      composition: defineInteractiveRuntimeHostComposition(async (context) => {
        const activity = context.acquireResidency('test-background-work');
        releaseActivity = () => activity.release();
        return {
          handlers: createUnavailableDomainOperationHandlers(),
          recover: async () => {},
          beginDrain: () => { draining = true; },
          close: () => finishHostCleanup.promise,
        };
      }),
    });
    const result = await connectRuntimeHost({
      rootPath,
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    });
    assert.equal(result.kind, 'connected');
    if (result.kind !== 'connected') return;
    const connection = result.connection;
    manager = await startRuntimeHostDesktopManager({ rootPath } as DesktopRuntimeHostCandidateStartInput, {
      startCandidate: async () => ({
        kind: 'ready',
        candidate: {
          client: new DesktopRuntimeHostClient(connection),
          hostOwnership: 'owned_ephemeral', hostPid: process.pid,
          closed: connection.closed, close: () => connection.close(),
        } as DesktopRuntimeHostCandidate,
      }),
      waitForHostExit: async () => assert.fail('quit must not wait for Host cleanup'),
    });
    assert.equal(await prepareRuntimeHostQuit(manager, {
      confirmInterrupt: async () => false,
    }), 'cancelled');
    assert.equal(draining, false);
    assert.equal(host.state, 'ready');
    // Work settles after a cancelled quit; the next quit must atomically stop admission.
    releaseActivity();
    assert.equal(await prepareRuntimeHostQuit(manager, {
      confirmInterrupt: async () => assert.fail('idle quit needs no consent'),
    }), 'ready');
    assert.equal(draining, true);
    await manager.close();
    assert.notEqual(host.state, 'closed');
  } finally {
    releaseActivity();
    finishHostCleanup.resolve();
    await manager?.close();
    await host?.close();
    await rm(rootPath, { recursive: true, force: true });
  }
});
