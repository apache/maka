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

import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core/session';
import type { RuntimeReadModelSessionView } from '@maka/runtime/runtime-read-model';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { RuntimeHostKernel } from '../server/host-kernel.js';
import { createUnavailableDomainOperationHandlers } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { HostSessionEffectCoordinator } from '../server/session-effect-coordinator.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;

test('two Clients share one durable Session recap effect', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-effect-uds-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  let modelCalls = 0;
  const modelStarted = gate();
  const modelRelease = gate();
  const host = await RuntimeHostKernel.start({
    owner,
    idleGraceMs: 10_000,
    composition: defineInteractiveRuntimeHostComposition(async (context) => {
      const artifacts = await openInteractiveArtifactStoreForWrite(context.owner.lease);
      const coordinator = new HostSessionEffectCoordinator({
        model: {
          generateTitle: async () => undefined,
          generateRecap: async () => {
            modelCalls += 1;
            modelStarted.release();
            await modelRelease.promise;
            return {
              ok: true,
              modelId: 'openrouter/free',
              messages: [{ role: 'user', content: 'canonical history' }],
              raw: 'We connected two Clients to one recap effect.',
            };
          },
        },
        readModel: {
          getSessionView: async () => ({ events: [] }) as unknown as RuntimeReadModelSessionView,
        },
        artifacts,
        sessions: { probeSessionRemoval: async () => ({ kind: 'present' }) },
        readSessionHeader: async () =>
          ({ isArchived: false, status: 'active' }) as unknown as SessionHeader,
        sessionAdmission: new SessionAdmissionGate(),
        acquireResidency: () => context.acquireResidency('session-effect'),
        requestDrain: context.requestDrain,
      });
      return {
        handlers: {
          ...createUnavailableDomainOperationHandlers(),
          ...coordinator.handlers,
        },
        beginDrain: () => coordinator.beginDrain(),
        recover: () => artifacts.recover(),
        close: async () => {
          await coordinator.close();
          artifacts.close();
        },
      };
    }),
  });
  let desktop: RuntimeHostConnection | undefined;
  let tui: RuntimeHostConnection | undefined;
  try {
    desktop = await connect(root);
    tui = await connect(root);
    const input = { sessionId: 'session-1', effectId: 'effect-1', reason: 'manual' as const };
    const desktopResult = desktop.generateSessionRecap(input);
    await modelStarted.promise;
    const tuiResult = tui.generateSessionRecap(input);
    modelRelease.release();
    const [first, second] = await Promise.all([desktopResult, tuiResult]);
    assert.deepEqual(first, {
      kind: 'generated',
      effectId: 'effect-1',
      reason: 'manual',
      text: 'We connected two Clients to one recap effect.',
      raw: 'We connected two Clients to one recap effect.',
    });
    assert.deepEqual(second, first);
    assert.equal(modelCalls, 1);
  } finally {
    await Promise.allSettled([desktop?.close(), tui?.close()]);
    await host.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function connect(rootPath: string): Promise<RuntimeHostConnection> {
  const result = await connectRuntimeHost({ rootPath, protocol: PROTOCOL });
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') throw new Error('Unable to connect to Runtime Host');
  return result.connection;
}
