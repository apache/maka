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
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { connectExistingRuntimeHost } from '@maka/runtime-host/client';
import {
  RuntimeHostKernel,
  defineInteractiveRuntimeHostComposition,
  createUnavailableDomainOperationHandlers,
} from '@maka/runtime-host/server';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import { launchRuntimeHostLocalSourceRetirement } from '../runtime-host-local-source-retirement.js';
import { retireRuntimeHostLifecycleOwner } from '../runtime-host-lifecycle-transaction.js';
import { withRuntimeHostManagedServiceDeploymentLock } from '../runtime-host-service-manager.js';

for (const policy of ['refuse_active_work', 'interrupt_active_work'] as const)
  test(`managed source handoff preserves connection/work admission before ${policy}`, {
    timeout: 15_000,
  }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'maka-managed-source-handoff-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const capability = await resolveStorageRoot({
      path: join(directory, 'state'),
      kind: 'interactive',
    });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    let releaseWork = () => {};
    const host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 60_000,
      composition: defineInteractiveRuntimeHostComposition(async (context) => {
        const work = context.acquireResidency('background-work');
        releaseWork = () => work.release();
        return {
          handlers: createUnavailableDomainOperationHandlers(),
          beginDrain() {
            releaseWork();
          },
          async recover() {},
          async close() {},
        };
      }),
    });
    t.after(() => host.close());
    const idleSurface = await connectExistingRuntimeHost({
      rootPath: capability.canonicalPath,
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    });
    assert.equal(idleSurface.kind, 'connected');
    if (idleSurface.kind !== 'connected') return;
    t.after(() => idleSurface.connection.close());
    const incompatibleConnect: typeof connectExistingRuntimeHost = (input) =>
      connectExistingRuntimeHost({
        ...input,
        protocol: {
          min: RUNTIME_HOST_PROTOCOL_VERSION + 1,
          max: RUNTIME_HOST_PROTOCOL_VERSION + 1,
        },
      });
    const observed = await incompatibleConnect({
      rootPath: capability.canonicalPath,
      protocol: { min: 0, max: 0 },
    });
    assert.equal(observed.kind, 'incompatible');
    await withRuntimeHostManagedServiceDeploymentLock(join(directory, 'control'), async (lease) => {
      assert.ok(lease !== undefined);
      const retire = (activeWorkPolicy: 'refuse_active_work' | 'interrupt_active_work') =>
        retireRuntimeHostLifecycleOwner({
          rootPath: capability.canonicalPath,
          rootId: capability.rootId,
          expectedOwner: { hostEpoch: host.hostEpoch, pid: process.pid },
          connectExisting: incompatibleConnect,
          prepareSourceRetirement: (signal) =>
            launchRuntimeHostLocalSourceRetirement({
              sourceCliPath: fileURLToPath(new URL('../cli.js', import.meta.url)),
              sourceNodePath: process.execPath,
              rootPath: capability.canonicalPath,
              expectedRootId: capability.rootId,
              expectedHostEpoch: host.hostEpoch,
              activeWorkPolicy,
              inheritableAuthorityLeaseFd: lease,
              signal,
            }),
        });
      // Legacy admission conservatively counts another connection as in use;
      // neither the parent nor the source helper may override that with a snapshot.
      assert.deepEqual(await retire('refuse_active_work'), { kind: 'active_tasks' });
      assert.equal(host.state, 'ready');
      await idleSurface.connection.close();
      assert.deepEqual(await retire('refuse_active_work'), { kind: 'active_tasks' });
      if (policy === 'refuse_active_work') releaseWork();
      const result = await retire(policy);
      assert.equal(result.kind, 'retired');
      if (result.kind === 'retired') await result.owner.close();
    });
    await host.closed;
  });
