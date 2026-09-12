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
import { test } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { ClientCapabilityProvider } from '@maka/runtime-host/client';
import {
  McpCapabilityPublication,
  type McpCapabilityPublicationState,
} from '../mcp-capability-publication.js';

test('publication deduplicates a snapshot within one Host connection and republishes on reconnect', async () => {
  const harness = publicationHarness();
  assert.equal(await harness.publication.settle(), 'published');
  assert.equal(await harness.publication.settle(), 'published');
  assert.deepEqual(harness.replacements, [{ identity: 'host:one', revision: 1 }]);
  harness.revision = 2;
  assert.equal(await harness.publication.settle(), 'published');
  harness.identity = 'host:two';
  assert.equal(await harness.publication.settle(), 'published');
  assert.deepEqual(harness.replacements, [
    { identity: 'host:one', revision: 1 },
    { identity: 'host:one', revision: 2 },
    { identity: 'host:two', revision: 2 },
  ]);
  harness.publication.invalidate();
  await harness.publication.settle();
  assert.equal(harness.replacements.length, 4);
  await harness.publication.close();
  assert.deepEqual(harness.unregisters, ['host:two']);
});

test('publication coalesces revisions while a manifest is in flight and awaits the latest delivery', async () => {
  const first = deferred();
  const second = deferred();
  const harness = publicationHarness();
  harness.replace = async () => {
    await (harness.replacements.length === 1 ? first.promise : second.promise);
  };
  const pending = harness.publication.settle();
  harness.revision = 2;
  harness.publication.request();
  harness.revision = 3;
  harness.publication.request();
  first.resolve();
  await nextTurn();
  assert.deepEqual(
    harness.replacements.map((item) => item.revision),
    [1, 3],
  );
  assert.equal(harness.states.includes('published'), false);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await nextTurn();
  assert.equal(settled, false);
  second.resolve();
  assert.equal(await pending, 'published');
  assert.equal(harness.states.filter((state) => state === 'published').length, 1);
  await harness.publication.close();
});

test('an obsolete successful replacement is withdrawn when the latest snapshot becomes empty', async () => {
  const accepted = deferred();
  const harness = publicationHarness();
  harness.replace = () => accepted.promise;
  const pending = harness.publication.settle();
  harness.revision = 2;
  harness.hasTools = false;
  harness.publication.request();
  accepted.resolve();
  assert.equal(await pending, 'not_published');
  assert.deepEqual(harness.unregisters, ['host:one']);
  await harness.publication.close();
  assert.deepEqual(harness.unregisters, ['host:one']);
});

test('an old connection completion cannot unregister or advertise tools on its replacement', async () => {
  const accepted = deferred();
  const harness = publicationHarness();
  harness.replace = () => accepted.promise;
  const pending = harness.publication.settle();
  harness.identity = 'host:two';
  harness.hasTools = false;
  harness.publication.invalidate();
  harness.publication.request();
  accepted.resolve();
  assert.equal(await pending, 'not_published');
  assert.deepEqual(harness.unregisters, []);
  assert.equal(harness.states.includes('published'), false);
  await harness.publication.close();
  assert.deepEqual(harness.unregisters, []);
});

test('failed publication releases its provider and readiness can retry the same revision', async () => {
  const harness = publicationHarness();
  harness.replace = async () => {
    throw new Error('Host rejected publication');
  };
  assert.equal(await harness.publication.settle(), 'error');
  assert.equal(harness.providerClosures, 1);
  assert.deepEqual(harness.unregisters, []);
  harness.replace = async () => undefined;
  assert.equal(await harness.publication.settle(), 'published');
  assert.equal(harness.replacements.length, 2);
  await harness.publication.close();
  assert.deepEqual(harness.unregisters, ['host:one']);
});

test('close waits for an admitted publication then withdraws it without notifying after close', async () => {
  const accepted = deferred();
  const harness = publicationHarness();
  harness.replace = () => accepted.promise;
  harness.publication.request();
  const states = [...harness.states];
  let closed = false;
  const closing = harness.publication.close().then(() => {
    closed = true;
  });
  await nextTurn();
  assert.equal(closed, false);
  accepted.resolve();
  await closing;
  assert.deepEqual(harness.unregisters, ['host:one']);
  assert.deepEqual(harness.states, states);
  harness.publication.request();
  assert.equal(await harness.publication.settle(), 'unavailable');
  await harness.publication.close();
  assert.equal(harness.replacements.length, 1);
  assert.equal(harness.unregisters.length, 1);
});

test('empty snapshots and unavailable connections never create or withdraw a registration', async () => {
  const harness = publicationHarness();
  harness.hasTools = false;
  assert.equal(await harness.publication.settle(), 'not_published');
  harness.identity = undefined;
  assert.equal(await harness.publication.settle(), 'unavailable');
  await harness.publication.close();
  assert.deepEqual(harness.replacements, []);
  assert.deepEqual(harness.unregisters, []);
});

function publicationHarness() {
  const harness = {
    identity: 'host:one' as string | undefined,
    revision: 1,
    hasTools: true,
    providerClosures: 0,
    replacements: [] as { identity: string | undefined; revision: number }[],
    unregisters: [] as (string | undefined)[],
    states: [] as McpCapabilityPublicationState[],
    replace: async (): Promise<void> => undefined,
    publication: undefined as unknown as McpCapabilityPublication,
  };
  harness.publication = new McpCapabilityPublication({
    connectionIdentity: () => harness.identity,
    revision: () => harness.revision,
    createProvider: () =>
      harness.hasTools
        ? provider(() => {
            harness.providerClosures += 1;
          })
        : undefined,
    replace: async () => {
      harness.replacements.push({ identity: harness.identity, revision: harness.revision });
      await harness.replace();
    },
    unregister: async () => {
      harness.unregisters.push(harness.identity);
    },
    onState: (state) => {
      harness.states.push(state);
    },
  });
  return harness;
}

function provider(close: () => void): ClientCapabilityProvider {
  return { offers: () => [], close };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
