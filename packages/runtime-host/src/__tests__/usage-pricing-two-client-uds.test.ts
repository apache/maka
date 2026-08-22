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
import { lstat, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  comparePricingModelKeys,
  PRICING_MODEL_KEY_MAX_CHARS,
} from '@maka/core/usage-stats/pricing';
import type { PricingConfig } from '@maka/core/usage-stats/types';
import { BUILTIN_PRICING } from '@maka/runtime/telemetry';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type StorageRootLease,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import {
  RUNTIME_HOST_PROTOCOL_VERSION,
  type EffectivePricingEntry,
  type PricingQueryResult,
} from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { RuntimeHostKernel } from '../server/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { HostUsagePricingCoordinator } from '../server/usage-pricing-coordinator.js';

const PROTOCOL = {
  min: RUNTIME_HOST_PROTOCOL_VERSION,
  max: RUNTIME_HOST_PROTOCOL_VERSION,
} as const;
const REQUEST_TIMEOUT_MS = 5_000;
const CONNECTION_CONTEXT: ConnectionContext = {
  hostEpoch: 'usage-pricing-test',
  connectionId: 'usage-pricing-test-connection',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

test('forged root leases cannot open the Interactive usage authority', async () => {
  await assert.rejects(
    openInteractiveUsageStoresForWrite({} as StorageRootLease<'interactive', 'write'>),
    (error: unknown) =>
      error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
  );
});

test('usage authority drain rejects a new pricing mutation with typed lifecycle failure', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-usage-pricing-drain-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'interactive-root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, 'test must acquire the real Interactive write lease');
  try {
    const stores = await openInteractiveUsageStoresForWrite(owner.lease);
    let drainRequests = 0;
    const coordinator = new HostUsagePricingCoordinator(
      stores,
      () => {
        drainRequests += 1;
      },
      new RuntimePolicyActivationGate(),
    );
    await stores.beginDrain();
    assert.deepEqual(
      await coordinator.handlers['pricing.mutate'](
        {
          expectedRevision: 0,
          mutation: { kind: 'upsert', pricing: pricing('provider:model', 1) },
        },
        CONNECTION_CONTEXT,
      ),
      {
        ok: false,
        error: { code: 'host_draining', message: 'Runtime Host is draining' },
      },
    );
    assert.equal(drainRequests, 0);
    await stores.close();
  } finally {
    await owner.close();
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
});

test('pricing changes invalidate backend snapshots while unchanged writes do not', async () => {
  await withUsageAuthority('pricing-backend-invalidation', async ({ stores }) => {
    let drainRequests = 0;
    let invalidations = 0;
    const coordinator = new HostUsagePricingCoordinator(
      stores,
      () => {
        drainRequests += 1;
      },
      new RuntimePolicyActivationGate(),
      () => {
        invalidations += 1;
      },
    );
    const value = pricing('provider:model', 1);
    assert.deepEqual(
      await coordinator.handlers['pricing.mutate'](
        {
          expectedRevision: 0,
          mutation: { kind: 'upsert', pricing: value },
        },
        CONNECTION_CONTEXT,
      ),
      {
        ok: true,
        result: { kind: 'committed', revision: 1 },
      },
    );
    assert.equal(invalidations, 1);

    assert.deepEqual(
      await coordinator.handlers['pricing.mutate'](
        {
          expectedRevision: 1,
          mutation: { kind: 'upsert', pricing: value },
        },
        CONNECTION_CONTEXT,
      ),
      {
        ok: true,
        result: { kind: 'unchanged', revision: 1 },
      },
    );
    assert.equal(invalidations, 1);
    assert.equal(drainRequests, 0);
  });
});

test('pricing mutation registers backend invalidation before the next activation', async () => {
  await withUsageAuthority('pricing-activation-gate', async ({ stores }) => {
    const activation = new RuntimePolicyActivationGate();
    const priorActivationEntered = deferred();
    const releasePriorActivation = deferred();
    const order: string[] = [];
    const priorActivation = activation.runBackendActivation(async () => {
      priorActivationEntered.resolve();
      await releasePriorActivation.promise;
    });
    await priorActivationEntered.promise;

    const coordinator = new HostUsagePricingCoordinator(
      stores,
      () => {},
      activation,
      () => {
        order.push('invalidation');
      },
    );
    const mutation = coordinator.handlers['pricing.mutate'](
      {
        expectedRevision: 0,
        mutation: { kind: 'upsert', pricing: pricing('provider:fenced', 1) },
      },
      CONNECTION_CONTEXT,
    );
    let nextActivationStarted = false;
    const nextActivation = activation.runBackendActivation(() => {
      nextActivationStarted = true;
      order.push('activation');
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await stores.pricing.snapshot()).revision, 0);
    assert.equal(nextActivationStarted, false);

    releasePriorActivation.resolve();
    await priorActivation;
    assert.deepEqual(await mutation, {
      ok: true,
      result: { kind: 'committed', revision: 1 },
    });
    await nextActivation;
    assert.equal(nextActivationStarted, true);
    assert.deepEqual(order, ['invalidation', 'activation']);
  });
});

test('pricing root identity failure requests drain while expected failures do not', async () => {
  await withUsageAuthority('pricing-publication', async ({ root, stores }) => {
    let drainRequests = 0;
    const coordinator = new HostUsagePricingCoordinator(
      stores,
      () => {
        drainRequests += 1;
      },
      new RuntimePolicyActivationGate(),
    );
    assert.deepEqual(
      await coordinator.handlers['pricing.mutate'](
        {
          expectedRevision: 1,
          mutation: { kind: 'delete', modelKey: 'provider:missing' },
        },
        CONNECTION_CONTEXT,
      ),
      {
        ok: true,
        result: {
          kind: 'revision_conflict',
          expectedRevision: 1,
          actualRevision: 0,
        },
      },
    );
    assert.deepEqual(
      await coordinator.handlers['pricing.mutate'](
        {
          expectedRevision: 0,
          mutation: {
            kind: 'upsert',
            pricing: { ...pricing('provider:invalid', 1), inputUsdPer1M: -1 },
          },
        },
        CONNECTION_CONTEXT,
      ),
      {
        ok: false,
        error: { code: 'invalid_request', message: 'Pricing mutation is invalid' },
      },
    );
    assert.equal(drainRequests, 0);
    assert.deepEqual(
      await coordinator.handlers['usage.query'](
        {
          kind: 'logs',
          source: 'llm',
          query: { range: 'all' },
          offset: 1,
        },
        CONNECTION_CONTEXT,
      ),
      {
        ok: false,
        error: { code: 'invalid_request', message: 'Usage offset is invalid' },
      },
    );
    assert.equal(drainRequests, 0);

    const movedRoot = `${root}-moved`;
    await rename(root, movedRoot);
    assert.deepEqual(
      await coordinator.handlers['pricing.mutate'](
        {
          expectedRevision: 0,
          mutation: { kind: 'upsert', pricing: pricing('provider:publication', 1) },
        },
        CONNECTION_CONTEXT,
      ),
      {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'Pricing authority persistence failed',
        },
      },
    );
    assert.equal(drainRequests, 1);
    await rename(movedRoot, root);
  });
});

test('pricing query rejects continue offsets at and past the effective catalog end', async () => {
  await withUsageAuthority('pricing-offset', async ({ stores }) => {
    const coordinator = new HostUsagePricingCoordinator(
      stores,
      () => {},
      new RuntimePolicyActivationGate(),
    );
    const entryCount = builtinPricingEntries().length;
    assert.ok(entryCount > 0, 'the Runtime must expose at least one built-in price');

    for (const offset of [entryCount, entryCount + 1]) {
      assert.deepEqual(
        await coordinator.handlers['pricing.query'](
          { kind: 'continue', revision: 0, offset },
          CONNECTION_CONTEXT,
        ),
        {
          ok: false,
          error: { code: 'invalid_request', message: 'Pricing offset is invalid' },
        },
      );
    }
  });
});

test('deleting absent pricing overrides is unchanged and preserves revision', async () => {
  await withUsageAuthority('pricing-delete-absent', async ({ stores }) => {
    let invalidations = 0;
    const coordinator = new HostUsagePricingCoordinator(
      stores,
      () => {
        invalidations += 1;
      },
      new RuntimePolicyActivationGate(),
    );
    const builtin = BUILTIN_PRICING[0];
    assert.ok(builtin, 'the Runtime must expose at least one built-in price');

    for (const modelKey of ['provider:missing', builtin.modelKey]) {
      assert.deepEqual(
        await coordinator.handlers['pricing.mutate'](
          {
            expectedRevision: 0,
            mutation: { kind: 'delete', modelKey },
          },
          CONNECTION_CONTEXT,
        ),
        { ok: true, result: { kind: 'unchanged', revision: 0 } },
      );
    }

    assert.deepEqual(await stores.pricing.snapshot(), { revision: 0, overrides: [] });
    assert.equal(invalidations, 0);
  });
});

test('pricing query projects built-in and custom authority with reset effects', async () => {
  await withUsageAuthority('effective-pricing', async ({ stores }) => {
    const coordinator = new HostUsagePricingCoordinator(
      stores,
      () => {},
      new RuntimePolicyActivationGate(),
    );
    const builtin = BUILTIN_PRICING[0];
    assert.ok(builtin, 'the Runtime must expose at least one built-in price');

    const initial = await readCoordinatorPricing(coordinator);
    assert.deepEqual(initial.entries, builtinPricingEntries());

    assert.deepEqual(
      await coordinator.handlers['pricing.mutate'](
        {
          expectedRevision: 0,
          mutation: { kind: 'upsert', pricing: builtin },
        },
        CONNECTION_CONTEXT,
      ),
      { ok: true, result: { kind: 'committed', revision: 1 } },
    );
    const customOnly = pricing('acme:custom-only', 0.8);
    assert.deepEqual(
      await coordinator.handlers['pricing.mutate'](
        {
          expectedRevision: 1,
          mutation: { kind: 'upsert', pricing: customOnly },
        },
        CONNECTION_CONTEXT,
      ),
      { ok: true, result: { kind: 'committed', revision: 2 } },
    );

    const customized = await readCoordinatorPricing(coordinator);
    assert.deepEqual(
      customized.entries.find((entry) => entry.pricing.modelKey === builtin.modelKey),
      { pricing: builtin, source: 'custom', resetEffect: 'restore_builtin' },
    );
    assert.deepEqual(
      customized.entries.find((entry) => entry.pricing.modelKey === customOnly.modelKey),
      { pricing: customOnly, source: 'custom', resetEffect: 'become_unpriced' },
    );

    assert.deepEqual(
      await coordinator.handlers['pricing.mutate'](
        {
          expectedRevision: 2,
          mutation: { kind: 'delete', modelKey: builtin.modelKey },
        },
        CONNECTION_CONTEXT,
      ),
      { ok: true, result: { kind: 'committed', revision: 3 } },
    );
    const reset = await readCoordinatorPricing(coordinator);
    assert.deepEqual(
      reset.entries.find((entry) => entry.pricing.modelKey === builtin.modelKey),
      { pricing: builtin, source: 'builtin' },
    );

    assert.deepEqual(
      await coordinator.handlers['pricing.mutate'](
        {
          expectedRevision: 3,
          mutation: { kind: 'delete', modelKey: customOnly.modelKey },
        },
        CONNECTION_CONTEXT,
      ),
      { ok: true, result: { kind: 'committed', revision: 4 } },
    );
    const deleted = await readCoordinatorPricing(coordinator);
    assert.equal(
      deleted.entries.some((entry) => entry.pricing.modelKey === customOnly.modelKey),
      false,
    );
  });
});

describe('production Usage/Pricing UDS', () => {
  test('two clients share usage projection and one revision-CAS pricing authority', {
    skip: process.platform === 'win32',
    timeout: 60_000,
  }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-usage-pricing-two-client-'));
    const root = join(base, 'root');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    let host: RuntimeHostKernel | undefined;
    let successor: RuntimeHostKernel | undefined;
    let firstOwner: InteractiveRootOwner | undefined;
    let successorOwner: InteractiveRootOwner | undefined;
    let preHostUsageStores:
      | Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>
      | undefined;
    const clients: RuntimeHostConnection[] = [];
    let endpoint: string | undefined;

    try {
      firstOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(firstOwner, 'test must acquire the real Interactive write lease');
      preHostUsageStores = await openInteractiveUsageStoresForWrite(firstOwner.lease);
      await Promise.all([
        preHostUsageStores.telemetry.recordLlmCall(usageRecord('usage-a', 10, 'openai', 'gpt-a')),
        preHostUsageStores.telemetry.recordLlmCall(
          usageRecord('usage-b', 20, 'anthropic', 'claude-b', 'error'),
        ),
        preHostUsageStores.telemetry.recordToolInvocation(toolRecord('tool-a', 30)),
      ]);
      host = await RuntimeHostKernel.start({
        owner: firstOwner,
        idleGraceMs: 30_000,
        composition: defineInteractiveRuntimeHostComposition(createExecutionRuntimeHostComposition),
      });
      firstOwner = undefined;
      preHostUsageStores = undefined;
      endpoint = host.endpoint;

      const [desktop, tui] = await Promise.all([connectClient(root), connectClient(root)]);
      clients.push(desktop, tui);
      const [desktopUsage, tuiUsage] = await Promise.all([readUsage(desktop), readUsage(tui)]);
      assert.deepEqual(tuiUsage, desktopUsage);
      assert.equal(desktopUsage.summary.kind, 'summary');
      assert.equal(desktopUsage.summary.summary.totalRequests, 2);
      assert.equal(desktopUsage.buckets.kind, 'buckets');
      assert.equal(desktopUsage.buckets.total, 2);
      assert.equal(desktopUsage.logs.kind, 'logs');
      assert.deepEqual(
        desktopUsage.logs.rows.map((row) => row.id),
        ['usage-b', 'usage-a'],
      );
      assert.equal(desktopUsage.toolLogs.kind, 'logs');
      assert.equal(desktopUsage.toolLogs.source, 'tool');
      assert.deepEqual(desktopUsage.toolLogs.rows, [
        {
          source: 'tool',
          id: 'tool-a',
          ts: 30,
          toolCallId: 'call-tool-a',
          toolName: 'Read',
          providerId: 'openai',
          modelId: 'gpt-a',
          durationMs: 12,
          status: 'success',
          argsSummary: '{"path":"README.md"}',
          resultSummary: { kind: 'text', itemCount: 1 },
          bytesIn: 20,
          bytesOut: 40,
          startedAt: 30,
          sessionId: 'session-a',
          turnId: 'turn-a',
        },
      ]);

      const initial = await readPricing(desktop);
      assert.equal(initial.revision, 0);
      assert.deepEqual(initial.entries, builtinPricingEntries());
      const decomposedModelKey = 'e\u0301';
      const composedModelKey = '\u00e9';
      const candidates = [pricing(decomposedModelKey, 1), pricing(composedModelKey, 2)] as const;
      const outcomes = await Promise.all([
        desktop.request(
          'pricing.mutate',
          {
            expectedRevision: initial.revision,
            mutation: { kind: 'upsert', pricing: candidates[0] },
          },
          REQUEST_TIMEOUT_MS,
        ),
        tui.request(
          'pricing.mutate',
          {
            expectedRevision: initial.revision,
            mutation: { kind: 'upsert', pricing: candidates[1] },
          },
          REQUEST_TIMEOUT_MS,
        ),
      ]);
      assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), [
        'committed',
        'revision_conflict',
      ]);
      const loserIndex = outcomes.findIndex((outcome) => outcome.kind === 'revision_conflict');
      const conflict = outcomes[loserIndex];
      assert.ok(conflict?.kind === 'revision_conflict');
      if (!conflict || conflict.kind !== 'revision_conflict') {
        throw new Error('Expected one pricing revision conflict');
      }
      assert.deepEqual(conflict, {
        kind: 'revision_conflict',
        expectedRevision: 0,
        actualRevision: 1,
      });

      const loser = loserIndex === 0 ? desktop : tui;
      const loserPricing = candidates[loserIndex];
      const afterConflict = requirePricingPage(
        await loser.request('pricing.query', { kind: 'start' }, REQUEST_TIMEOUT_MS),
      );
      assert.equal(afterConflict.revision, conflict.actualRevision);
      const retry = await loser.request(
        'pricing.mutate',
        {
          expectedRevision: afterConflict.revision,
          mutation: { kind: 'upsert', pricing: loserPricing },
        },
        REQUEST_TIMEOUT_MS,
      );
      assert.deepEqual(retry, { kind: 'committed', revision: 2 });

      const [desktopPricing, tuiPricing] = await Promise.all([
        readPricing(desktop),
        readPricing(tui),
      ]);
      assert.deepEqual(tuiPricing, desktopPricing);
      assert.equal(desktopPricing.revision, 2);
      const customEntries = desktopPricing.entries.filter(
        (entry): entry is Extract<EffectivePricingEntry, { source: 'custom' }> =>
          entry.source === 'custom',
      );
      assert.deepEqual(
        customEntries.map((entry) => entry.pricing.modelKey),
        [decomposedModelKey, composedModelKey],
      );
      assert.ok(customEntries.every((entry) => entry.resetEffect === 'become_unpriced'));
      assert.notEqual(customEntries[0]?.pricing.modelKey, customEntries[1]?.pricing.modelKey);

      let revision = desktopPricing.revision;
      for (let index = 0; index < 126; index += 1) {
        const result = await desktop.request(
          'pricing.mutate',
          {
            expectedRevision: revision,
            mutation: { kind: 'upsert', pricing: maximumCjkPricing(index) },
          },
          REQUEST_TIMEOUT_MS,
        );
        assert.equal(result.kind, 'committed');
        if (result.kind !== 'committed') throw new Error('CJK pricing seed did not commit');
        revision = result.revision;
      }
      assert.equal(revision, 128);

      const firstFullPage = requirePricingPage(
        await desktop.request('pricing.query', { kind: 'start' }, REQUEST_TIMEOUT_MS),
      );
      assert.ok(firstFullPage.nextOffset);
      const changed = await tui.request(
        'pricing.mutate',
        {
          expectedRevision: firstFullPage.revision,
          mutation: {
            kind: 'upsert',
            pricing: {
              ...maximumCjkPricing(0),
              inputUsdPer1M: 1,
              outputUsdPer1M: 2,
            },
          },
        },
        REQUEST_TIMEOUT_MS,
      );
      assert.deepEqual(changed, { kind: 'committed', revision: 129 });
      const stale = await desktop.request(
        'pricing.query',
        {
          kind: 'continue',
          revision: firstFullPage.revision,
          offset: firstFullPage.nextOffset,
        },
        REQUEST_TIMEOUT_MS,
      );
      assert.deepEqual(stale, {
        kind: 'revision_changed',
        expectedRevision: 128,
        actualRevision: 129,
      });

      const [fullDesktopPricing, fullTuiPricing] = await Promise.all([
        readPricing(desktop),
        readPricing(tui),
      ]);
      assert.deepEqual(fullTuiPricing, fullDesktopPricing);
      assert.equal(fullDesktopPricing.revision, 129);
      assert.equal(fullDesktopPricing.entries.length, builtinPricingEntries().length + 128);
      assert.ok(fullDesktopPricing.pageCount > 1);
      assert.equal(
        fullDesktopPricing.entries.filter(
          (entry) => entry.pricing.modelKey.length === PRICING_MODEL_KEY_MAX_CHARS,
        ).length,
        126,
      );

      await Promise.all([desktop.close(), tui.close()]);
      clients.length = 0;
      await host.close();
      host = undefined;
      await assert.rejects(lstat(endpoint), { code: 'ENOENT' });

      successorOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successorOwner, 'successor must reacquire the released Interactive owner');
      successor = await RuntimeHostKernel.start({
        owner: successorOwner,
        idleGraceMs: 30_000,
        composition: defineInteractiveRuntimeHostComposition(createExecutionRuntimeHostComposition),
      });
      successorOwner = undefined;
      const [desktopAfterRestart, tuiAfterRestart] = await Promise.all([
        connectClient(root),
        connectClient(root),
      ]);
      clients.push(desktopAfterRestart, tuiAfterRestart);
      const [usageAfterRestart, pricingAfterRestart, pricingFromSecondClient] = await Promise.all([
        readUsage(desktopAfterRestart),
        readPricing(desktopAfterRestart),
        readPricing(tuiAfterRestart),
      ]);
      assert.deepEqual(pricingFromSecondClient, pricingAfterRestart);
      assert.equal(pricingAfterRestart.revision, 129);
      assert.deepEqual(pricingAfterRestart.entries, fullDesktopPricing.entries);
      assert.equal(pricingAfterRestart.entries.length, builtinPricingEntries().length + 128);
      assert.ok(pricingAfterRestart.pageCount > 1);
      assert.equal(usageAfterRestart.summary.kind, 'summary');
      if (usageAfterRestart.summary.kind === 'summary') {
        assert.equal(usageAfterRestart.summary.summary.totalRequests, 2);
      }
      assert.equal(usageAfterRestart.toolLogs.kind, 'logs');
      if (usageAfterRestart.toolLogs.kind === 'logs') {
        assert.deepEqual(
          usageAfterRestart.toolLogs.rows.map((row) => row.id),
          ['tool-a'],
        );
      }
    } finally {
      const cleanupErrors: unknown[] = [];
      const closedClients = await Promise.allSettled(clients.map((client) => client.close()));
      cleanupErrors.push(...rejectedReasons(closedClients));
      await host?.close().catch((error: unknown) => cleanupErrors.push(error));
      await successor?.close().catch((error: unknown) => cleanupErrors.push(error));
      if (firstOwner && !firstOwner.closed) {
        await preHostUsageStores?.close().catch((error: unknown) => cleanupErrors.push(error));
      }
      await firstOwner?.close().catch((error: unknown) => cleanupErrors.push(error));
      await successorOwner?.close().catch((error: unknown) => cleanupErrors.push(error));
      await rm(join(resolveRootControlNamespace(), capability.rootId), {
        recursive: true,
        force: true,
      }).catch((error: unknown) => cleanupErrors.push(error));
      await rm(base, { recursive: true, force: true }).catch((error: unknown) =>
        cleanupErrors.push(error),
      );
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Usage/Pricing UDS cleanup failed');
      }
    }
  });
});

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

async function readUsage(client: RuntimeHostConnection) {
  const query = { range: { from: 0, to: 100 } } as const;
  const [summary, buckets, logs, toolLogs] = await Promise.all([
    client.request('usage.query', { kind: 'summary', query }, REQUEST_TIMEOUT_MS),
    client.request(
      'usage.query',
      { kind: 'buckets', query, groupBy: 'provider' },
      REQUEST_TIMEOUT_MS,
    ),
    client.request('usage.query', { kind: 'logs', source: 'llm', query }, REQUEST_TIMEOUT_MS),
    client.request(
      'usage.query',
      {
        kind: 'logs',
        source: 'tool',
        query: { range: query.range, toolName: 'Read', status: 'success' },
      },
      REQUEST_TIMEOUT_MS,
    ),
  ]);
  return { summary, buckets, logs, toolLogs };
}

async function readPricing(client: RuntimeHostConnection): Promise<{
  revision: number;
  entries: readonly EffectivePricingEntry[];
  pageCount: number;
}> {
  const first = requirePricingPage(
    await client.request('pricing.query', { kind: 'start' }, REQUEST_TIMEOUT_MS),
  );
  const entries = [...first.entries];
  let nextOffset = first.nextOffset;
  let pageCount = 1;
  while (nextOffset !== null) {
    const page = requirePricingPage(
      await client.request(
        'pricing.query',
        { kind: 'continue', revision: first.revision, offset: nextOffset },
        REQUEST_TIMEOUT_MS,
      ),
    );
    assert.equal(page.revision, first.revision);
    assert.equal(page.offset, nextOffset);
    entries.push(...page.entries);
    nextOffset = page.nextOffset;
    pageCount += 1;
  }
  return { revision: first.revision, entries, pageCount };
}

async function readCoordinatorPricing(
  coordinator: HostUsagePricingCoordinator,
): Promise<Extract<PricingQueryResult, { kind: 'page' }>> {
  const outcome = await coordinator.handlers['pricing.query'](
    { kind: 'start' },
    CONNECTION_CONTEXT,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error('Expected an effective pricing page');
  const first = requirePricingPage(outcome.result);
  const entries = [...first.entries];
  let nextOffset = first.nextOffset;
  while (nextOffset !== null) {
    const nextOutcome = await coordinator.handlers['pricing.query'](
      { kind: 'continue', revision: first.revision, offset: nextOffset },
      CONNECTION_CONTEXT,
    );
    assert.equal(nextOutcome.ok, true);
    if (!nextOutcome.ok) throw new Error('Expected an effective pricing page');
    const page = requirePricingPage(nextOutcome.result);
    assert.equal(page.revision, first.revision);
    assert.equal(page.offset, nextOffset);
    entries.push(...page.entries);
    nextOffset = page.nextOffset;
  }
  return { ...first, entries, nextOffset: null };
}

function builtinPricingEntries(): readonly EffectivePricingEntry[] {
  return [...BUILTIN_PRICING]
    .sort((left, right) => comparePricingModelKeys(left.modelKey, right.modelKey))
    .map((pricing) => ({ pricing, source: 'builtin' }));
}

function requirePricingPage(
  result: PricingQueryResult,
): Extract<PricingQueryResult, { kind: 'page' }> {
  assert.equal(result.kind, 'page');
  if (result.kind !== 'page') throw new Error('Pricing revision changed during page read');
  return result;
}

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function usageRecord(
  id: string,
  ts: number,
  providerId: string,
  modelId: string,
  status: 'success' | 'error' = 'success',
) {
  return {
    id,
    providerId,
    modelId,
    inputTokens: 10,
    outputTokens: 5,
    cacheHitInputTokens: 2,
    cacheMissInputTokens: 8,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 1,
    reasoningTokens: 0,
    totalTokens: 15,
    latencyMs: 25,
    costUsd: 0.01,
    startedAt: ts,
    date: '2026-07-29',
    ts,
    status,
  };
}

function toolRecord(id: string, ts: number) {
  return {
    id,
    sessionId: 'session-a',
    turnId: 'turn-a',
    toolCallId: `call-${id}`,
    toolName: 'Read',
    providerId: 'openai',
    modelId: 'gpt-a',
    durationMs: 12,
    status: 'success' as const,
    argsSummary: '{"path":"README.md"}',
    resultSummary: { kind: 'text', itemCount: 1 },
    bytesIn: 20,
    bytesOut: 40,
    startedAt: ts,
    date: '2026-07-29',
    ts,
  };
}

function pricing(modelKey: string, inputUsdPer1M: number) {
  return { modelKey, inputUsdPer1M, outputUsdPer1M: inputUsdPer1M * 2 };
}

function maximumCjkPricing(index: number): PricingConfig {
  return {
    modelKey: String.fromCodePoint(0x4e00 + index).repeat(PRICING_MODEL_KEY_MAX_CHARS),
    inputUsdPer1M: Number.MAX_VALUE,
    outputUsdPer1M: Number.MAX_VALUE,
    cacheReadUsdPer1M: Number.MAX_VALUE,
    cacheWriteUsdPer1M: Number.MAX_VALUE,
  };
}

function rejectedReasons(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}

async function withUsageAuthority(
  name: string,
  run: (context: {
    root: string;
    stores: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), `maka-usage-pricing-${name}-`));
  const capability = await resolveStorageRoot({
    path: join(base, 'interactive-root'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, 'test must acquire the real Interactive write lease');
  const stores = await openInteractiveUsageStoresForWrite(owner.lease);
  try {
    await run({ root: capability.canonicalPath, stores });
  } finally {
    await stores.close().catch(() => undefined);
    await owner.close();
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(base, { recursive: true, force: true });
  }
}
