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
import { act, createElement } from 'react';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { ProjectedLlmConnection, UpdateConnectionInput } from '@maka/core/llm-connections';
import { resolveDeclaredContextWindow } from '@maka/runtime/context-budget-policy';
import { LocaleProvider, ToastProvider } from '@maka/ui';
import {
  ConnectionSettingsServicesProvider,
  ModelContextTargetBoundary,
  type ConnectionSettingsServices,
  type ModelContextTargetControl,
} from '../../renderer/features/connection-settings/index.js';
import { modelProfilesWithContextTarget } from '@maka/core/model-thinking';
import type { DesktopConnectionSnapshot } from '../../shared/desktop-connection-snapshot.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

test('sets one model context target without dropping its other declarations', () => {
  assert.deepEqual(
    modelProfilesWithContextTarget(
      {
        current: { vision: true, contextWindow: 1_000_000 },
        other: { contextWindow: 128_000 },
      },
      'current',
      256_000,
    ),
    {
      current: { vision: true, contextWindow: 256_000 },
      other: { contextWindow: 128_000 },
    },
  );
});

test('auto removes only the context target and clears an empty table', () => {
  assert.deepEqual(
    modelProfilesWithContextTarget({ current: { vision: false, contextWindow: 256_000 } }, 'current', undefined),
    { current: { vision: false } },
  );
  assert.equal(
    modelProfilesWithContextTarget({ current: { contextWindow: 256_000 } }, 'current', undefined),
    null,
  );
});

test('saves against the selected Host and connection even when the visible route changes', async () => {
  const { root } = installReactRenderer();
  const read = deferred<DesktopConnectionSnapshot>();
  const host = { profileId: 'profile-a', hostId: 'host-a' };
  const identity = { connectionId: 'connection-a', slug: 'token-plan' };
  const current: ProjectedLlmConnection = {
    ...identity,
    name: 'Token Plan',
    providerType: 'alibaba-token-plan',
    defaultModel: 'qwen3.8-max',
    enabled: true,
    enabledModelIds: ['qwen3.8-max', 'other'],
    createdAt: 1,
    updatedAt: 1,
    catalogEntries: [],
    relayModelProfiles: { 'qwen3.8-max': { vision: false }, other: { contextWindow: 128_000 } },
  };
  const writes: Array<{ identity: unknown; patch: UpdateConnectionInput }> = [];
  const requestedHosts: unknown[] = [];
  const services: ConnectionSettingsServices = {
    forHost: (selectedHost) => {
      requestedHosts.push(selectedHost);
      return {
        connections: {
          getSnapshot: () => read.promise,
          update: async (savedIdentity: typeof identity, patch: UpdateConnectionInput) => {
            writes.push({ identity: savedIdentity, patch });
            return current;
          },
        },
      } as unknown as ReturnType<ConnectionSettingsServices['forHost']>;
    },
  };
  let control: ModelContextTargetControl = { pending: false };
  const render = (modelId: string) => root.render(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(ToastProvider, {
      children: createElement(ConnectionSettingsServicesProvider, {
        services,
        children: createElement(ModelContextTargetBoundary, {
          host,
          connection: identity,
          modelId,
          children: (value) => { control = value; return null; },
        }),
      }),
    }),
  }));

  await act(() => render('qwen3.8-max'));
  assert.ok(control.onChange);
  let saving: Promise<void> | undefined;
  await act(() => { saving = control.onChange?.(256_000); });
  assert.equal(control.pending, true);
  await act(() => render('other'));
  await act(async () => {
    read.resolve({ connections: [current], defaultConnection: identity.slug, chatModelChoices: [] });
    await saving;
  });

  assert.deepEqual(requestedHosts, [host]);
  assert.deepEqual(writes, [{
    identity,
    patch: {
      relayModelProfiles: {
        'qwen3.8-max': { vision: false, contextWindow: 256_000 },
        other: { contextWindow: 128_000 },
      },
    },
  }]);
  assert.equal(control.pending, false);
  const saved = { ...current, relayModelProfiles: writes[0]!.patch.relayModelProfiles ?? undefined };
  assert.equal(resolveDeclaredContextWindow(saved, 'qwen3.8-max'), 256_000);
  const automatic = {
    ...saved,
    relayModelProfiles: modelProfilesWithContextTarget(saved.relayModelProfiles, 'qwen3.8-max', undefined) ?? undefined,
  };
  assert.equal(resolveDeclaredContextWindow(automatic, 'qwen3.8-max'), undefined);
});
