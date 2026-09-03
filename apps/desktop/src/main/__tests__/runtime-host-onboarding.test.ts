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
import type { EnvironmentRuntimeHostProfile } from '@maka/runtime-host/client';
import type { DesktopRuntimeHostProfileAddInput } from '../../preload/bridge-contract.js';
import type {
  DesktopRuntimeHostManagedSshServiceTarget,
  DesktopRuntimeHostManagedWslServiceTarget,
} from '../runtime-host-managed-services.js';
import { createDesktopRuntimeHostOnboarding } from '../runtime-host-onboarding.js';

test('persists a verified on-demand SSH profile without endpoint or credential projection', async () => {
  let setupInput: unknown;
  let saved:
    | (DesktopRuntimeHostProfileAddInput & {
        readonly managedService?: DesktopRuntimeHostManagedSshServiceTarget;
      })
    | undefined;
  const harness = createHarness({
    profiles: {
      addAndEnableVerified: async (input) => {
        saved = input;
        return { profileId: input.profile.id };
      },
    },
    runSetup: async (input, onProgress) => {
      setupInput = input;
      onProgress({ phase: 'installing_service' });
      return {
        serviceId: 'b'.repeat(64),
        deploymentId: '00000000-0000-4000-8000-000000000001',
        rootPath: '/home/operator/.config/Maka/workspaces/default',
        operatorPath: '/home/operator/.local/share/maka/operator',
        rootId: 'a'.repeat(64),
        endpoint: 'ws://127.0.0.1:7443/runtime-host',
        credential: 'secret-access-token',
      };
    },
  });

  const result = await harness.invoke('runtime-host-onboarding:start', {
    kind: 'ssh',
    name: 'Lab',
    destination: 'operator@example.com',
    projectDirectoryRoots: [{ label: 'Work', path: '/srv/work' }],
  });

  assert.equal((result as { kind?: string }).kind, 'complete');
  assert.equal(saved?.profile.name, 'Lab');
  if (saved?.profile.kind !== 'remote') assert.fail('expected remote profile');
  assert.deepEqual(saved.profile.transport, {
    kind: 'ssh',
    destination: 'operator@example.com',
    activation: {
      kind: 'ssh_operator',
      operatorPath: '/home/operator/.local/share/maka/operator',
    },
  });
  assert.deepEqual(saved?.managedService, {
    deployment: {
      id: 'b'.repeat(64),
      rootPath: '/home/operator/.config/Maka/workspaces/default',
      deploymentId: '00000000-0000-4000-8000-000000000001',
    },
    control: {
      kind: 'ssh_operator',
      operatorPath: '/home/operator/.local/share/maka/operator',
    },
  });
  assert.equal(saved?.credential, 'secret-access-token');
  assert.deepEqual(
    (setupInput as { projectDirectoryRoots?: unknown }).projectDirectoryRoots,
    [{ label: 'Work', path: '/srv/work' }],
  );
  assert.equal((setupInput as { lifecycle?: unknown }).lifecycle, 'on_demand');
  assert.doesNotMatch(JSON.stringify(harness.events), /secret-access-token/u);
  await harness.onboarding.close();
  assert.equal(harness.handlers.size, 0);
});

test('onboards WSL as a credential-free environment profile', async () => {
  let saved:
    | {
        readonly profile: EnvironmentRuntimeHostProfile;
        readonly managedService: DesktopRuntimeHostManagedWslServiceTarget;
      }
    | undefined;
  const peerTargets: string[] = [];
  const harness = createHarness({
    profiles: {
      addManagedEnvironmentAndEnable: async (input) => {
        saved = input;
        return {
          profileId: input.profile.id,
        };
      },
    },
    runWslSetup: async (_input, _onProgress, onComplete) => {
      onComplete();
      return {
        serviceId: 'a'.repeat(64),
        deploymentId: '00000000-0000-4000-8000-000000000001',
        rootPath: '/home/operator/.config/Maka/workspaces/default',
        rootId: 'a'.repeat(64),
        operatorPath: '/home/operator/.local/share/maka/operator',
      };
    },
    resolveSetupPackage: (peerTarget) => {
      peerTargets.push(peerTarget);
      return { kind: 'npm', specifier: 'maka-agent@0.2.0' };
    },
  });

  const result = await harness.invoke('runtime-host-onboarding:start', {
    kind: 'wsl',
    distribution: 'Ubuntu-24.04',
  });

  assert.equal((result as { kind?: string }).kind, 'complete');
  assert.deepEqual(saved?.profile, {
    id: saved?.profile.id,
    name: 'Ubuntu-24.04',
    kind: 'environment',
    provider: { kind: 'wsl', distribution: 'Ubuntu-24.04' },
    rootId: 'a'.repeat(64),
    operatorPath: '/home/operator/.local/share/maka/operator',
  });
  assert.deepEqual(saved?.managedService, {
    deployment: {
      id: 'a'.repeat(64),
      rootPath: '/home/operator/.config/Maka/workspaces/default',
      deploymentId: '00000000-0000-4000-8000-000000000001',
    },
  });
  assert.deepEqual(peerTargets, ['none']);
  await harness.onboarding.close();
});

test('projects WSL setup failures as recoverable onboarding state', async () => {
  const harness = createHarness({
    runWslSetup: async () => {
      throw new Error('WSL requires Linux Node.js');
    },
  });

  assert.deepEqual(
    await harness.invoke('runtime-host-onboarding:start', {
      kind: 'wsl',
      distribution: 'Ubuntu',
    }),
    {
      kind: 'failed',
      message: 'WSL requires Linux Node.js',
      revision: 3,
    },
  );
  await harness.onboarding.close();
});

test('projects invalid setup input as a recoverable failure', async () => {
  const harness = createHarness();

  const result = await harness.invoke('runtime-host-onboarding:start', {
    kind: 'ssh',
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

test('rejects relative remote Project roots before starting SSH setup', async () => {
  const harness = createHarness();

  const result = await harness.invoke('runtime-host-onboarding:start', {
    kind: 'ssh',
    destination: 'operator@example.com',
    projectDirectoryRoots: [{ label: 'Work', path: 'srv/work' }],
  });
  assert.deepEqual(result, {
    kind: 'failed',
    message: 'Runtime Host Project directory is invalid',
    revision: 1,
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
    deploymentId: string;
    rootPath: string;
    operatorPath: string;
    rootId: string;
    endpoint: string;
    credential: string;
  }) => void;
  const setupDrain = new Promise<{
    serviceId: string;
    deploymentId: string;
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
    kind: 'ssh',
    destination: 'operator@example.com',
  }) as Promise<unknown>;
  while (!completeReceived) await Promise.resolve();
  assert.equal(await harness.invoke('runtime-host-onboarding:cancel'), false);

  finishSetup({
    serviceId: 'b'.repeat(64),
    deploymentId: '00000000-0000-4000-8000-000000000001',
    rootPath: '/home/operator/.config/Maka/workspaces/default',
    operatorPath: '/home/operator/.local/share/maka/operator',
    rootId: 'a'.repeat(64),
    endpoint: 'ws://127.0.0.1:7443/runtime-host',
    credential: 'candidate-token',
  });
  while (!pairingStarted) await Promise.resolve();

  finishPairing({ profileId: 'office' });
  assert.deepEqual(await setup, { kind: 'complete', profileId: 'office', revision: 4 });
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
      kind: 'ssh',
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
      addManagedEnvironmentAndEnable: async () => assert.fail('profile must not be saved'),
      addAndEnableVerified: async () => assert.fail('profile must not be saved'),
      ...profiles,
    },
    setupPackageMode: 'published',
    resolveSshDevelopmentPeerTarget: async () =>
      assert.fail('published setup must not inspect the development target'),
    resolveSetupPackage: () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    runSetup: async () => assert.fail('SSH must not start'),
    runWslSetup: async () => assert.fail('WSL must not start'),
    listWslDistributions: async () => [],
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
