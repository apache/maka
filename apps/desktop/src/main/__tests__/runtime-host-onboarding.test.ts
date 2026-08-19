import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopRuntimeHostProfileAddInput } from '../../preload/bridge-contract.js';
import { createDesktopRuntimeHostOnboarding } from '../runtime-host-onboarding.js';
import type { DesktopRuntimeHostProfileService } from '../runtime-host-profile-service.js';

test('persists a verified SSH profile without projecting its credential', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: unknown[] = [];
  let resetAfterCompletion: Promise<unknown> | undefined;
  let saved: DesktopRuntimeHostProfileAddInput | undefined;
  const profiles: Pick<DesktopRuntimeHostProfileService, 'addAndEnableVerified'> = {
    addAndEnableVerified: async (input) => {
      saved = input;
      return { profileId: input.profile.id };
    },
  };
  const onboarding = createDesktopRuntimeHostOnboarding({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    clientInstanceId: 'stable-client',
    profiles,
    setupPackage: { kind: 'npm', specifier: 'maka-agent@next' },
    runSetup: async (_input, onProgress) => {
      onProgress({ phase: 'installing_service' });
      return {
        rootId: 'a'.repeat(64),
        endpoint: 'ws://127.0.0.1:7443/runtime-host',
        credential: 'secret-access-token',
      };
    },
    send: (snapshot) => {
      events.push(snapshot);
      if (snapshot.kind === 'complete') {
        resetAfterCompletion = handlers.get('runtime-host-onboarding:reset')?.({}) as
          | Promise<unknown>
          | undefined;
      }
    },
  });
  const start = handlers.get('runtime-host-onboarding:start');
  assert.ok(start);

  const result = await start({}, {
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
  assert.doesNotMatch(JSON.stringify(events), /secret-access-token/u);
  await resetAfterCompletion;
  const getSnapshot = handlers.get('runtime-host-onboarding:getSnapshot');
  assert.ok(getSnapshot);
  assert.equal((await getSnapshot({}) as { kind?: string }).kind, 'idle');
  await onboarding.close();
  assert.equal(handlers.size, 0);
});

test('projects invalid setup input as a recoverable failure', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const onboarding = createDesktopRuntimeHostOnboarding({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    clientInstanceId: 'stable-client',
    profiles: {
      addAndEnableVerified: async () => assert.fail('not used'),
    },
    setupPackage: { kind: 'npm', specifier: 'maka-agent@0.2.0' },
    runSetup: async () => assert.fail('invalid input must not start SSH'),
    send: () => undefined,
  });

  const result = await handlers.get('runtime-host-onboarding:start')?.({}, {
    destination: '',
  });
  assert.deepEqual(result, {
    kind: 'failed',
    message: 'Remote Runtime Host setup input is invalid',
    revision: 1,
  });
  await handlers.get('runtime-host-onboarding:reset')?.({});
  assert.deepEqual(await handlers.get('runtime-host-onboarding:getSnapshot')?.({}), {
    kind: 'idle',
    revision: 2,
  });
  await onboarding.close();
});

test('finishes Host pairing after the cancellable SSH phase has completed', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
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
  const profiles: Pick<DesktopRuntimeHostProfileService, 'addAndEnableVerified'> = {
    addAndEnableVerified: async () => {
      pairingStarted = true;
      return pairing;
    },
  };
  const onboarding = createDesktopRuntimeHostOnboarding({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      removeHandler: (channel) => handlers.delete(channel),
    },
    clientInstanceId: 'stable-client',
    profiles,
    setupPackage: { kind: 'npm', specifier: 'maka-agent@0.2.0' },
    runSetup: async (_input, _onProgress, onComplete) => {
      onComplete();
      completeReceived = true;
      return setupDrain;
    },
    send: () => undefined,
  });
  const start = handlers.get('runtime-host-onboarding:start');
  const cancel = handlers.get('runtime-host-onboarding:cancel');
  assert.ok(start);
  assert.ok(cancel);

  const setup = start({}, { destination: 'operator@example.com' }) as Promise<unknown>;
  while (!completeReceived) await Promise.resolve();
  assert.equal(await cancel({}), false);

  finishSetup({
    rootId: 'a'.repeat(64),
    endpoint: 'ws://127.0.0.1:7443/runtime-host',
    credential: 'candidate-token',
  });
  while (!pairingStarted) await Promise.resolve();

  finishPairing({ profileId: 'office' });
  assert.deepEqual(await setup, { kind: 'complete', profileId: 'office', revision: 3 });
  await onboarding.close();
});
