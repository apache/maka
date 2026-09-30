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
import { afterEach, test } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import { normalizeModelOverrides, type ModelOverride } from '@maka/core/model-thinking';
import { ToastProvider } from '@maka/ui';
import { ConversationServicesProvider, type ConversationServices } from '../../renderer/features/conversation/index.js';
import {
  stubConversationServices,
  useComposerModelOptions,
} from '../../renderer/features/conversation/testing.js';

const MODEL = 'gpt-5.5';
const HOST_A = { profileId: 'local', hostId: 'host-a' };
const HOST_B = { profileId: 'remote', hostId: 'host-b' };

type Options = Parameters<typeof useComposerModelOptions>[0];
type Update = NonNullable<ConversationServices['connections']>['updateModelOverride'];
type UpdateInput = Parameters<Update>[0];

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
let mountedRoot: Root | undefined;

function connection(override: ModelOverride | undefined): ProjectedLlmConnection {
  return {
    connectionId: 'relay',
    slug: 'relay',
    providerType: 'custom',
    name: 'Relay',
    enabled: true,
    defaultModel: MODEL,
    enabledModelIds: [MODEL],
    ...(override ? { modelOverrides: { [MODEL]: override } } : {}),
    createdAt: 1,
    updatedAt: 1,
    catalogEntries: [],
  };
}

const same = (left: ModelOverride | null | undefined, right: ModelOverride | null | undefined) =>
  JSON.stringify(normalizeModelOverrides({ model: left ?? {} })?.model ?? {}) ===
  JSON.stringify(normalizeModelOverrides({ model: right ?? {} })?.model ?? {});

/** A Host store that rejects a write whose `expected` is not what it holds, like the real IPC. */
function fakeHosts() {
  const stored = new Map<string, ModelOverride | null>();
  const calls: UpdateInput[] = [];
  let hold: Promise<void> | undefined;
  const update: Update = async (input) => {
    calls.push(input);
    if (hold) await hold;
    const key = input.host?.hostId ?? '';
    if (!same(stored.get(key) ?? null, input.expected)) {
      throw new Error('Model parameters changed. Reopen the editor before saving again.');
    }
    stored.set(key, input.value);
    return input.value;
  };
  return {
    stored,
    calls,
    update,
    holdNext() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => { release = resolve; });
      return () => { hold = undefined; release(); };
    },
  };
}

async function mount(update: Update, initial: Options) {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  mountedRoot = createRoot(container);
  const services = stubConversationServices({ connections: { updateModelOverride: update } });
  let current: ReturnType<typeof useComposerModelOptions> = {};
  function Probe(props: { options: Options }) {
    current = useComposerModelOptions(props.options);
    return null;
  }
  const render = (options: Options) => act(() => mountedRoot?.render(
    createElement(ToastProvider, {
      children: createElement(ConversationServicesProvider, {
        services,
        children: createElement(Probe, { options }),
      }),
    }),
  ));
  await render(initial);
  return {
    render,
    get onFastChange() {
      return current.onFastChange;
    },
  };
}

function options(host: Options['host'], override: ModelOverride | undefined): Options {
  return {
    uiLocale: 'en',
    connections: [connection(override)],
    model: { connectionId: 'relay', slug: 'relay', model: MODEL },
    host,
  };
}

test('a Fast toggle after an edit made elsewhere is based on the edited override', async () => {
  const hosts = fakeHosts();
  const probe = await mount(hosts.update, options(HOST_A, undefined));
  await act(() => probe.onFastChange?.(true));
  assert.deepEqual(hosts.stored.get(HOST_A.hostId), { serviceTier: 'fast' });

  // Settings (or another window) changes the same model's override.
  const edited: ModelOverride = { serviceTier: 'fast', contextWindow: 256_000 };
  hosts.stored.set(HOST_A.hostId, edited);
  await probe.render(options(HOST_A, edited));

  await act(() => probe.onFastChange?.(false));
  assert.deepEqual(hosts.calls.at(-1)?.expected, edited);
  assert.deepEqual(hosts.stored.get(HOST_A.hostId), { contextWindow: 256_000 });

  await act(() => probe.onFastChange?.(true));
  assert.deepEqual(hosts.stored.get(HOST_A.hostId), { contextWindow: 256_000, serviceTier: 'fast' });
});

test('an edit elsewhere that restores the pre-save override is written over, not skipped', async () => {
  const hosts = fakeHosts();
  const probe = await mount(hosts.update, options(HOST_A, undefined));
  await act(() => probe.onFastChange?.(true));
  await probe.render(options(HOST_A, { serviceTier: 'fast' }));

  // Settings turns Fast back off: the list now shows the override this composer saved over.
  hosts.stored.set(HOST_A.hostId, null);
  await probe.render(options(HOST_A, undefined));

  await act(() => probe.onFastChange?.(true));
  assert.equal(hosts.calls.length, 2, 'turning Fast on again reaches the Host');
  assert.deepEqual(hosts.calls.at(-1)?.expected, null);
  assert.deepEqual(hosts.stored.get(HOST_A.hostId), { serviceTier: 'fast' });
});

test('a refresh that lands before the save resolves still lets an edit elsewhere win', async () => {
  const hosts = fakeHosts();
  const probe = await mount(hosts.update, options(HOST_A, undefined));
  const release = hosts.holdNext();
  let save: Promise<void> | undefined;
  await act(async () => { save = probe.onFastChange?.(true); });
  // The connection-changed refresh arrives before the save's own reply.
  await probe.render(options(HOST_A, { serviceTier: 'fast' }));
  await act(async () => {
    release();
    await save;
  });
  assert.deepEqual(hosts.stored.get(HOST_A.hostId), { serviceTier: 'fast' });

  hosts.stored.set(HOST_A.hostId, null);
  await probe.render(options(HOST_A, undefined));

  await act(() => probe.onFastChange?.(true));
  assert.equal(hosts.calls.length, 2, 'turning Fast on again reaches the Host');
  assert.deepEqual(hosts.calls.at(-1)?.expected, null);
  assert.deepEqual(hosts.stored.get(HOST_A.hostId), { serviceTier: 'fast' });
});

test('a toggle queued behind a pending save stays on the Host it was clicked on', async () => {
  const hosts = fakeHosts();
  const probe = await mount(hosts.update, options(HOST_A, undefined));
  const release = hosts.holdNext();
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  await act(async () => {
    first = probe.onFastChange?.(true);
    second = probe.onFastChange?.(false);
  });
  // The composer moves to a Session on another Host whose connection shares the identity.
  await probe.render(options(HOST_B, undefined));
  await act(async () => {
    release();
    await first;
    await second;
  });

  assert.deepEqual(
    hosts.calls.map((call) => ({ host: call.host?.hostId, expected: call.expected, value: call.value })),
    [
      { host: HOST_A.hostId, expected: null, value: { serviceTier: 'fast' } },
      { host: HOST_A.hostId, expected: { serviceTier: 'fast' }, value: {} },
    ],
  );
  assert.deepEqual(hosts.stored.get(HOST_A.hostId), {});
  assert.equal(hosts.stored.has(HOST_B.hostId), false);
});

test('Fast is not offered when the Host is unknown', async () => {
  const hosts = fakeHosts();
  const probe = await mount(hosts.update, options(undefined, undefined));
  assert.equal(probe.onFastChange, undefined);
});

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});
