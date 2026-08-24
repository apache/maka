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
import {
  RuntimeHostOperationError,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import type {
  EffectivePricingEntry,
  OperationInput,
  OperationKey,
} from '@maka/runtime-host/protocol';
import {
  DesktopRuntimeHostClient,
  DesktopRuntimeHostClientError,
  type DesktopPricingSnapshot,
} from '../runtime-host-client.js';

test('restarts a paginated Pricing read instead of mixing revisions', async () => {
  const stale = builtin('provider:stale', 1);
  const freshOne = builtin('provider:fresh-1', 2);
  const freshTwo = custom('provider:fresh-2', 3, 'become_unpriced');
  const { client, requests } = clientWithResponses([
    page(1, 0, [stale], 1),
    { kind: 'revision_changed', expectedRevision: 1, actualRevision: 2 },
    page(2, 0, [freshOne], 1),
    page(2, 1, [freshTwo], null),
  ]);

  assert.deepEqual(await client.loadPricingSnapshot(), {
    hostEpoch: 'host-current',
    connectionId: 'connection-current',
    revision: 2,
    entries: [freshOne, freshTwo],
  });
  assert.deepEqual(requests, [
    { operation: 'pricing.query', input: { kind: 'start' } },
    {
      operation: 'pricing.query',
      input: { kind: 'continue', revision: 1, offset: 1 },
    },
    { operation: 'pricing.query', input: { kind: 'start' } },
    {
      operation: 'pricing.query',
      input: { kind: 'continue', revision: 2, offset: 1 },
    },
  ]);
});

test('fails after bounded Pricing snapshot restarts under continuous churn', async () => {
  const responses = Array.from({ length: 3 }).flatMap((_, index) => [
    page(index, 0, [builtin(`provider:model-${index}`, index + 1)], 1),
    { kind: 'revision_changed', expectedRevision: index, actualRevision: index + 1 },
  ]);
  const { client, requests } = clientWithResponses(responses);

  await assert.rejects(
    () => client.loadPricingSnapshot(),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === 'pricing_unstable',
  );
  assert.equal(requests.filter(({ operation }) => operation === 'pricing.query').length, 6);
});

test('rejects duplicate or non-canonical keys split across Pricing pages', async () => {
  const { client } = clientWithResponses([
    page(1, 0, [builtin('provider:second', 2)], 1),
    page(1, 1, [builtin('provider:first', 1)], null),
  ]);

  await assert.rejects(
    () => client.loadPricingSnapshot(),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === 'pricing_unstable',
  );
});

test('rejects a Pricing mutation from another Host Epoch before dispatch', async () => {
  const { client, requests } = clientWithResponses([]);

  await assert.rejects(
    () =>
      client.applyPricingMutation({
        base: snapshot('host-replaced', 4, [builtin('provider:model', 1)]),
        mutation: { kind: 'delete', modelKey: 'provider:model' },
      }),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError &&
      error.code === 'pricing_snapshot_stale',
  );
  assert.deepEqual(requests, []);
});

test('rejects a Pricing mutation from a previous connection with the same Host Epoch', async () => {
  const { client, requests } = clientWithResponses([]);

  await assert.rejects(
    () =>
      client.applyPricingMutation({
        base: snapshot(
          'host-current',
          4,
          [builtin('provider:model', 1)],
          'connection-previous',
        ),
        mutation: { kind: 'delete', modelKey: 'provider:model' },
      }),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError &&
      error.code === 'pricing_snapshot_stale',
  );
  assert.deepEqual(requests, []);
});

test('reloads authority after a committed Pricing mutation', async () => {
  const updated = custom('provider:model', 2, 'restore_builtin');
  const { client, requests } = clientWithResponses([
    { kind: 'committed', revision: 5 },
    page(5, 0, [updated], null),
  ]);
  const base = snapshot('host-current', 4, [builtin('provider:model', 1)]);

  assert.deepEqual(
    await client.applyPricingMutation({
      base,
      mutation: { kind: 'upsert', pricing: updated.pricing },
    }),
    {
      kind: 'saved',
      disposition: 'committed',
      snapshot: snapshot('host-current', 5, [updated]),
    },
  );
  assert.deepEqual(requests.map(({ operation }) => operation), [
    'pricing.mutate',
    'pricing.query',
  ]);
});

test('keeps a known save outcome distinct when the authoritative reload fails', async () => {
  const { client } = clientWithResponses([
    { kind: 'unchanged', revision: 4 },
    new RuntimeHostOperationError('pricing.query', 'host_draining', 'Host is draining'),
  ]);
  const base = snapshot('host-current', 4, [builtin('provider:model', 1)]);

  assert.deepEqual(
    await client.applyPricingMutation({
      base,
      mutation: { kind: 'delete', modelKey: 'provider:model' },
    }),
    { kind: 'saved_refresh_failed', disposition: 'unchanged' },
  );
});

test('propagates a typed rejected mutation without classifying it as uncertain', async () => {
  const rejected = new RuntimeHostOperationError(
    'pricing.mutate',
    'invalid_request',
    'Pricing mutation is invalid',
  );
  const { client, requests } = clientWithResponses([rejected]);

  await assert.rejects(
    () =>
      client.applyPricingMutation({
        base: snapshot('host-current', 4, [builtin('provider:model', 1)]),
        mutation: { kind: 'delete', modelKey: 'provider:model' },
      }),
    (error: unknown) => error === rejected,
  );
  assert.deepEqual(requests.map(({ operation }) => operation), ['pricing.mutate']);
});

test('does not replay a conflicting mutation and reports when authority already matches', async () => {
  const intended = custom('provider:model', 4, 'restore_builtin');
  const { client, requests } = clientWithResponses([
    { kind: 'revision_conflict', expectedRevision: 2, actualRevision: 3 },
    page(3, 0, [intended], null),
  ]);

  assert.deepEqual(
    await client.applyPricingMutation({
      base: snapshot('host-current', 2, [builtin('provider:model', 1)]),
      mutation: { kind: 'upsert', pricing: intended.pricing },
    }),
    {
      kind: 'synchronized',
      reason: 'revision_conflict',
      snapshot: snapshot('host-current', 3, [intended]),
    },
  );
  assert.equal(requests.filter(({ operation }) => operation === 'pricing.mutate').length, 1);
});

test('requires review when a conflicting write differs from fresh authority', async () => {
  const intended = custom('provider:model', 4, 'restore_builtin');
  const current = custom('provider:model', 5, 'restore_builtin');
  const { client } = clientWithResponses([
    { kind: 'revision_conflict', expectedRevision: 2, actualRevision: 3 },
    page(3, 0, [current], null),
  ]);

  assert.deepEqual(
    await client.applyPricingMutation({
      base: snapshot('host-current', 2, [builtin('provider:model', 1)]),
      mutation: { kind: 'upsert', pricing: intended.pricing },
    }),
    {
      kind: 'review_required',
      reason: 'revision_conflict',
      snapshot: snapshot('host-current', 3, [current]),
    },
  );
});

test('reconciles an uncertain mutation without claiming which command committed it', async () => {
  const intended = custom('provider:model', 4, 'restore_builtin');
  const { client, requests } = clientWithResponses([
    new RuntimeHostOperationError(
      'pricing.mutate',
      'commit_outcome_unknown',
      'Commit outcome is unknown',
    ),
    page(3, 0, [intended], null),
  ]);

  assert.deepEqual(
    await client.applyPricingMutation({
      base: snapshot('host-current', 2, [builtin('provider:model', 1)]),
      mutation: { kind: 'upsert', pricing: intended.pricing },
    }),
    {
      kind: 'synchronized',
      reason: 'outcome_unknown',
      snapshot: snapshot('host-current', 3, [intended]),
    },
  );
  assert.equal(requests.filter(({ operation }) => operation === 'pricing.mutate').length, 1);
});

test('requires review after response loss when fresh authority differs', async () => {
  const intended = custom('provider:model', 4, 'restore_builtin');
  const current = custom('provider:model', 5, 'restore_builtin');
  const { client } = clientWithResponses([
    new Error('connection closed before the response arrived'),
    page(3, 0, [current], null),
  ]);

  assert.deepEqual(
    await client.applyPricingMutation({
      base: snapshot('host-current', 2, [builtin('provider:model', 1)]),
      mutation: { kind: 'upsert', pricing: intended.pricing },
    }),
    {
      kind: 'review_required',
      reason: 'outcome_unknown',
      snapshot: snapshot('host-current', 3, [current]),
    },
  );
});

test('keeps writes blocked when uncertain-outcome reconciliation cannot reload authority', async () => {
  const { client } = clientWithResponses([
    new Error('connection closed before the response arrived'),
    new Error('replacement Host is not available yet'),
  ]);

  assert.deepEqual(
    await client.applyPricingMutation({
      base: snapshot('host-current', 2, [builtin('provider:model', 1)]),
      mutation: { kind: 'delete', modelKey: 'provider:model' },
    }),
    { kind: 'reconciliation_unavailable', reason: 'outcome_unknown' },
  );
});

test('distinguishes reset from Custom-only delete while reconciling', async () => {
  const resetBase = custom('provider:reset', 2, 'restore_builtin');
  const deleteBase = custom('provider:delete', 2, 'become_unpriced');
  const { client: resetClient } = clientWithResponses([
    { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 },
    page(2, 0, [builtin('provider:reset', 1)], null),
  ]);
  const { client: deleteClient } = clientWithResponses([
    { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 },
    page(2, 0, [], null),
  ]);

  assert.equal(
    (
      await resetClient.applyPricingMutation({
        base: snapshot('host-current', 1, [resetBase]),
        mutation: { kind: 'delete', modelKey: 'provider:reset' },
      })
    ).kind,
    'synchronized',
  );
  assert.equal(
    (
      await deleteClient.applyPricingMutation({
        base: snapshot('host-current', 1, [deleteBase]),
        mutation: { kind: 'delete', modelKey: 'provider:delete' },
      })
    ).kind,
    'synchronized',
  );
});

test('requires custom provenance when an upsert equals the bundled values', async () => {
  const value = builtin('provider:model', 2);
  const { client } = clientWithResponses([
    { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 },
    page(2, 0, [value], null),
  ]);

  assert.equal(
    (
      await client.applyPricingMutation({
        base: snapshot('host-current', 1, [value]),
        mutation: { kind: 'upsert', pricing: value.pricing },
      })
    ).kind,
    'review_required',
  );
});

test('captures the canonical mutation target before an uncertain request settles', async () => {
  const pending = deferred<unknown>();
  const original = pricing('provider:model', 4);
  const { client, requests } = clientWithResponses([
    pending.promise,
    page(2, 0, [custom('provider:model', 4, 'restore_builtin')], null),
  ]);
  const operation = client.applyPricingMutation({
    base: snapshot('host-current', 1, [builtin('provider:model', 1)]),
    mutation: { kind: 'upsert', pricing: original },
  });

  original.modelKey = 'provider:changed-after-dispatch';
  original.inputUsdPer1M = 99;
  pending.reject(new Error('response lost after dispatch'));

  assert.deepEqual(await operation, {
    kind: 'synchronized',
    reason: 'outcome_unknown',
    snapshot: snapshot('host-current', 2, [custom('provider:model', 4, 'restore_builtin')]),
  });
  assert.deepEqual(requests[0], {
    operation: 'pricing.mutate',
    input: {
      expectedRevision: 1,
      mutation: { kind: 'upsert', pricing: pricing('provider:model', 4) },
    },
  });
});

test('does not collapse an omitted cache rate into an explicit zero during reconciliation', async () => {
  const intended = {
    modelKey: 'provider:model',
    inputUsdPer1M: 1,
    outputUsdPer1M: 2,
  };
  const current = {
    ...intended,
    cacheReadUsdPer1M: 0,
  };
  const { client } = clientWithResponses([
    { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 },
    page(2, 0, [{ pricing: current, source: 'custom', resetEffect: 'restore_builtin' }], null),
  ]);

  assert.equal(
    (
      await client.applyPricingMutation({
        base: snapshot('host-current', 1, [builtin('provider:model', 1)]),
        mutation: { kind: 'upsert', pricing: intended },
      })
    ).kind,
    'review_required',
  );
});

interface RecordedRequest {
  operation: OperationKey;
  input: unknown;
}

function clientWithResponses(responses: unknown[]): {
  client: DesktopRuntimeHostClient;
  requests: RecordedRequest[];
} {
  const remaining = [...responses];
  const requests: RecordedRequest[] = [];
  const connection = {
    hostEpoch: 'host-current',
    connectionId: 'connection-current',
    request: async <K extends OperationKey>(operation: K, input: OperationInput<K>) => {
      requests.push({ operation, input });
      if (remaining.length === 0) throw new Error(`Unexpected operation: ${operation}`);
      const response = remaining.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    close: async () => undefined,
  } as unknown as RuntimeHostConnection;
  return { client: new DesktopRuntimeHostClient(connection), requests };
}

function snapshot(
  hostEpoch: string,
  revision: number,
  entries: readonly EffectivePricingEntry[],
  connectionId = 'connection-current',
): DesktopPricingSnapshot {
  return { hostEpoch, connectionId, revision, entries };
}

function page(
  revision: number,
  offset: number,
  entries: readonly EffectivePricingEntry[],
  nextOffset: number | null,
) {
  return { kind: 'page' as const, revision, offset, entries, nextOffset };
}

function builtin(modelKey: string, inputUsdPer1M: number): EffectivePricingEntry {
  return { pricing: pricing(modelKey, inputUsdPer1M), source: 'builtin' };
}

function custom(
  modelKey: string,
  inputUsdPer1M: number,
  resetEffect: 'restore_builtin' | 'become_unpriced',
): EffectivePricingEntry {
  return { pricing: pricing(modelKey, inputUsdPer1M), source: 'custom', resetEffect };
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
