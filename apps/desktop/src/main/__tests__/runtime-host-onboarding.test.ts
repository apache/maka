import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopRuntimeHostProfileAddInput } from '../../preload/bridge-contract.js';
import { createDesktopRuntimeHostOnboarding } from '../runtime-host-onboarding.js';

test('persists a verified SSH profile without projecting its credential', async () => {
  let saved: DesktopRuntimeHostProfileAddInput | undefined;
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
    rootId: string;
    endpoint: string;
    credential: string;
  }) => void;
  const setupDrain = new Promise<{
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

function createHarness(
  overrides: Partial<Omit<OnboardingInput, 'ipcMain' | 'send'>> = {},
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: unknown[] = [];
  const onboarding = createDesktopRuntimeHostOnboarding({
    clientInstanceId: 'stable-client',
    profiles: { addAndEnableVerified: async () => assert.fail('profile must not be saved') },
    resolveSetupPackage: () => ({ kind: 'npm', specifier: 'maka-agent@0.2.0' }),
    runSetup: async () => assert.fail('SSH must not start'),
    ...overrides,
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
