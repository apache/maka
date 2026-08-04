import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connectRuntimeHost } from '@maka/runtime-host/client';
import {
  HOST_OPERATION_SPECS,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type EffectivePricingEntry,
  type OperationKey,
} from '@maka/runtime-host/protocol';
import {
  RuntimeHostKernel,
  type RuntimeHostComposition,
} from '@maka/runtime-host/server';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { DesktopRuntimeHostClient } from '../runtime-host-client.js';

test('drives the Desktop Pricing adapter through a real Runtime Host connection', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-desktop-pricing-client-'));
  let host: RuntimeHostKernel | undefined;
  try {
    const capability = await resolveStorageRoot({ path: base, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    let revision = 1;
    let entries: EffectivePricingEntry[] = [
      builtin('provider:first', 1),
      builtin('provider:second', 2),
    ];
    host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 10_000,
      compositionFactory: async () => ({
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
      }),
    });
    const connected = await connectRuntimeHost({
      rootPath: base,
      surface: 'desktop',
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
    assert.deepEqual(initial.entries, entries);

    const override = pricing('provider:second', 4);
    assert.deepEqual(
      await client.applyPricingMutation({
        base: initial,
        mutation: { kind: 'upsert', pricing: override },
      }),
      {
        kind: 'saved',
        disposition: 'committed',
        snapshot: {
          hostEpoch: connected.connection.hostEpoch,
          revision: 2,
          entries: [builtin('provider:first', 1), custom(override)],
        },
      },
    );

    await client.close();
  } finally {
    await host?.close().catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

type TestHandlers = Partial<RuntimeHostComposition['handlers']>;

function handlers(overrides: TestHandlers): RuntimeHostComposition['handlers'] {
  const unavailable = Object.fromEntries(
    (Object.keys(HOST_OPERATION_SPECS) as OperationKey[])
      .filter((operation) => operation !== 'host.status')
      .map((operation) => [
        operation,
        async () => ({
          ok: false,
          error: {
            code: 'operation_unavailable',
            message: `${operation} is unavailable in the Desktop Pricing adapter fixture`,
          },
        }),
      ]),
  );
  return { ...unavailable, ...overrides } as RuntimeHostComposition['handlers'];
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
