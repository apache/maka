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
import type { DesktopRuntimeHostProfileAddInput } from '../../preload/bridge-contract.js';
import type { DesktopRuntimeHostManagedService } from '../runtime-host-managed-services.js';
import { createDesktopRuntimeHostOnboarding } from '../runtime-host-onboarding.js';

test('persists a verified SSH profile without projecting its credential', async () => {
  let saved:
    | (DesktopRuntimeHostProfileAddInput & {
        readonly managedService?: DesktopRuntimeHostManagedService;
      })
    | undefined;
  const harness = createHarness({
    profiles: {
      addAndEnableVerified: async (input) => {
        saved = input;
        return { profileId: input.profile.id };
      },
    },
    runSetup: async (_input, onProgress) => {
      onProgress({ phase: 'installing_service' });
      return {
        serviceId: 'b'.repeat(64),
        rootPath: '/home/operator/.config/Maka/workspaces/default',
        operatorPath: '/home/operator/.local/share/maka/operator',
        rootId: 'a'.repeat(64),
        endpoint: 'ws://127.0.0.1:7443/runtime-host',
        credential: 'secret-access-token',
      };
    },
  });

  const result = await harness.invoke('runtime-host-onboarding:start', {
    name: 'Lab',
    destination: 'operator@example.com',
  });

  assert.equal((result as { kind?: string }).kind, 'complete');
  assert.equal(saved?.profile.name, 'Lab');
  assert.deepEqual(saved?.profile.transport, {
    kind: 'ssh',
    destination: 'operator@example.com',
    remotePort: 7443,
    websocketPath: '/runtime-host',
  });
  assert.deepEqual(saved?.managedService, {
    id: 'b'.repeat(64),
    rootPath: '/home/operator/.config/Maka/workspaces/default',
    operatorPath: '/home/operator/.local/share/maka/operator',
  });
  assert.equal(saved?.credential, 'secret-access-token');
  assert.doesNotMatch(JSON.stringify(harness.events), /secret-access-token/u);
  await harness.onboarding.close();
  assert.equal(harness.handlers.size, 0);
});

test('projects invalid setup input as a recoverable failure', async () => {
  const harness = createHarness();

  const result = await harness.invoke('runtime-host-onboarding:start', {
    destination: '',
  });
  assert.deepEqual(result, {
    kind: 'failed',
    message: 'Remote Runtime Host setup input is invalid',
    revision: 1,
  });
  await harness.invoke('runtime-host-onboarding:reset');
  assert.deepEqual(await harness.invoke('runtime-host-onboarding:getSnapshot'), {
    kind: 'idle',
    revision: 2,
  });
  await harness.onboarding.close();
});

test('finishes Host pairing after the cancellable SSH phase has completed', async () => {
  let finishPairing!: (value: { profileId: string }) => void;
  const pairing = new Promise<{ profileId: string }>((resolve) => {
    finishPairing = resolve;
  });
  let pairingStarted = false;
  let completeReceived = false;
  let finishSetup!: (value: {
    serviceId: string;
    rootPath: string;
    operatorPath: string;
    rootId: string;
    endpoint: string;
    credential: string;
  }) => void;
  const setupDrain = new Promise<{
    serviceId: string;
    rootPath: string;
    operatorPath: string;
    rootId: string;
    endpoint: string;
    credential: string;
  }>((resolve) => {
    finishSetup = resolve;
  });
  const harness = createHarness({
    profiles: {
      addAndEnableVerified: async () => {
        pairingStarted = true;
        return pairing;
      },
    },
    runSetup: async (_input, _onProgress, onComplete) => {
      onComplete();
      completeReceived = true;
      return setupDrain;
    },
  });

  const setup = harness.invoke('runtime-host-onboarding:start', {
    destination: 'operator@example.com',
  }) as Promise<unknown>;
  while (!completeReceived) await Promise.resolve();
  assert.equal(await harness.invoke('runtime-host-onboarding:cancel'), false);

  finishSetup({
    serviceId: 'b'.repeat(64),
    rootPath: '/home/operator/.config/Maka/workspaces/default',
    operatorPath: '/home/operator/.local/share/maka/operator',
    rootId: 'a'.repeat(64),
    endpoint: 'ws://127.0.0.1:7443/runtime-host',
    credential: 'candidate-token',
  });
  while (!pairingStarted) await Promise.resolve();

  finishPairing({ profileId: 'office' });
  assert.deepEqual(await setup, { kind: 'complete', profileId: 'office', revision: 3 });
  await harness.onboarding.close();
});

test('resolves the setup package only when onboarding starts', async () => {
  let resolutions = 0;
  const harness = createHarness({
    resolveSetupPackage: () => {
      resolutions += 1;
      throw new Error('Desktop does not declare an exact Runtime Host setup package');
    },
  });

  assert.deepEqual(await harness.invoke('runtime-host-onboarding:getSnapshot'), {
    kind: 'idle',
    revision: 0,
  });
  assert.equal(resolutions, 0);
  assert.deepEqual(
    await harness.invoke('runtime-host-onboarding:start', {
      destination: 'operator@example.com',
    }),
    {
      kind: 'failed',
      message: 'Desktop does not declare an exact Runtime Host setup package',
      revision: 2,
    },
  );
  assert.equal(resolutions, 1);
  await harness.onboarding.close();
});

type OnboardingInput = Parameters<typeof createDesktopRuntimeHostOnboarding>[0];
type HarnessOverrides = Partial<Omit<OnboardingInput, 'ipcMain' | 'send' | 'profiles'>> & {
  readonly profiles?: Partial<OnboardingInput['profiles']>;
};

function createHarness(overrides: HarnessOverrides = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: unknown[] = [];
  const { profiles, ...rest } = overrides;
  const onboarding = createDesktopRuntimeHostOnboarding({
    clientInstanceId: 'stable-client',
    profiles: {
      addAndEnableVerified: async () => assert.fail('profile must not be saved'),
      ...profiles,
    },
    resolveSetupPackage: () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    runSetup: async () => assert.fail('SSH must not start'),
    ...rest,
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    send: (snapshot) => events.push(snapshot),
  });
  return {
    onboarding,
    handlers,
    events,
    invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel);
      assert.ok(handler);
      return handler({}, ...args);
    },
  };
}
