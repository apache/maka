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
import { connectRuntimeHost } from '@maka/runtime-host/client';
import {
  RUNTIME_HOST_PROTOCOL_VERSION,
  type EffectivePricingEntry,
} from '@maka/runtime-host/protocol';
import {
  createUnavailableDomainOperationHandlers,
  defineInteractiveRuntimeHostComposition,
  RuntimeHostKernel,
  type RuntimeHostComposition,
} from '@maka/runtime-host/server';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import {
  DesktopRuntimeHostClient,
  DesktopRuntimeHostClientError,
} from '../runtime-host-client.js';

test('drives the Desktop Pricing adapter through a real Runtime Host connection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-desktop-pricing-client-'));
  let host: RuntimeHostKernel | undefined;
  try {
    const capability = await resolveStorageRoot({ path: base, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    let revision = 1;
    let mutationRequests = 0;
    let entries: EffectivePricingEntry[] = [
      builtin('provider:first', 1),
      builtin('provider:second', 2),
    ];
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 10_000,
      composition: defineInteractiveRuntimeHostComposition(async () => ({
        handlers: handlers({
          'pricing.query': async (input) => {
            if (input.kind === 'continue' && input.revision !== revision) {
              return {
                ok: true,
                result: {
                  kind: 'revision_changed',
                  expectedRevision: input.revision,
                  actualRevision: revision,
                },
              };
            }
            const offset = input.kind === 'start' ? 0 : input.offset;
            const pageEntries = entries.slice(offset, offset + 1);
            const nextOffset = offset + pageEntries.length;
            return {
              ok: true,
              result: {
                kind: 'page',
                revision,
                offset,
                entries: pageEntries,
                nextOffset: nextOffset < entries.length ? nextOffset : null,
              },
            };
          },
          'pricing.mutate': async (input) => {
            mutationRequests += 1;
            if (input.expectedRevision !== revision) {
              return {
                ok: true,
                result: {
                  kind: 'revision_conflict',
                  expectedRevision: input.expectedRevision,
                  actualRevision: revision,
                },
              };
            }
            assert.equal(input.mutation.kind, 'upsert');
            if (input.mutation.kind !== 'upsert') throw new Error('Expected an upsert');
            entries = [entries[0]!, {
              pricing: input.mutation.pricing,
              source: 'custom',
              resetEffect: 'restore_builtin',
            }];
            revision += 1;
            return { ok: true, result: { kind: 'committed', revision } };
          },
        }),
        beginDrain() {},
        async recover() {},
        async close() {},
      })),
    });
    const connected = await connectRuntimeHost({
      rootPath: base,
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') throw new Error('Desktop did not connect to Runtime Host');
    const client = new DesktopRuntimeHostClient(connected.connection);

    const initial = await client.loadPricingSnapshot();
    assert.equal(initial.hostEpoch, connected.connection.hostEpoch);
    assert.equal(initial.connectionId, connected.connection.connectionId);
    assert.deepEqual(initial.entries, entries);

    await client.close();
    const reconnected = await connectRuntimeHost({
      rootPath: base,
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
    });
    assert.equal(reconnected.kind, 'connected');
    if (reconnected.kind !== 'connected') {
      throw new Error('Desktop did not reconnect to Runtime Host');
    }
    assert.equal(reconnected.connection.hostEpoch, connected.connection.hostEpoch);
    assert.notEqual(reconnected.connection.connectionId, connected.connection.connectionId);
    const reconnectedClient = new DesktopRuntimeHostClient(reconnected.connection);

    const override = pricing('provider:second', 4);
    await assert.rejects(
      () =>
        reconnectedClient.applyPricingMutation({
          base: initial,
          mutation: { kind: 'upsert', pricing: override },
        }),
      (error: unknown) =>
        error instanceof DesktopRuntimeHostClientError &&
        error.code === 'pricing_snapshot_stale',
    );
    assert.equal(mutationRequests, 0);

    const reloaded = await reconnectedClient.loadPricingSnapshot();
    assert.deepEqual(
      await reconnectedClient.applyPricingMutation({
        base: reloaded,
        mutation: { kind: 'upsert', pricing: override },
      }),
      {
        kind: 'saved',
        disposition: 'committed',
        snapshot: {
          hostEpoch: reconnected.connection.hostEpoch,
          connectionId: reconnected.connection.connectionId,
          revision: 2,
          entries: [builtin('provider:first', 1), custom(override)],
        },
      },
    );
    assert.equal(mutationRequests, 1);

    await reconnectedClient.close();
  } finally {
    await host?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

type TestHandlers = Partial<RuntimeHostComposition['handlers']>;

function handlers(overrides: TestHandlers): RuntimeHostComposition['handlers'] {
  return {
    ...createUnavailableDomainOperationHandlers(),
    ...overrides,
  } as RuntimeHostComposition['handlers'];
}

function builtin(modelKey: string, inputUsdPer1M: number): EffectivePricingEntry {
  return { pricing: pricing(modelKey, inputUsdPer1M), source: 'builtin' };
}

function custom(value: ReturnType<typeof pricing>): EffectivePricingEntry {
  return { pricing: value, source: 'custom', resetEffect: 'restore_builtin' };
}

function pricing(modelKey: string, inputUsdPer1M: number) {
  return {
    modelKey,
    inputUsdPer1M,
    outputUsdPer1M: inputUsdPer1M * 2,
    cacheReadUsdPer1M: inputUsdPer1M / 2,
    cacheWriteUsdPer1M: inputUsdPer1M * 1.5,
  };
}
