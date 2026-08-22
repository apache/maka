import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  defaultRuntimeHostDiagnosticTarget,
  runOnDefaultRuntimeHost,
} from '../../renderer/default-runtime-host-operation.js';

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test('binds a default Host operation and its diagnostics to one authoritative identity', async () => {
  const host = { profileId: 'profile-b', hostId: 'host-b' };
  (globalThis as { window?: unknown }).window = {
    maka: {
      runtimeHostProfiles: {
        getDefaultHost: async () => host,
      },
    },
  };
  let operatedOn: unknown;
  const error = await runOnDefaultRuntimeHost(async (boundHost) => {
    operatedOn = boundHost;
    throw new Error('Host B failed');
  }).catch((caught: unknown) => caught);

  assert.deepEqual(operatedOn, host);
  assert.equal(error instanceof Error ? error.message : '', 'Host B failed');
  assert.deepEqual(defaultRuntimeHostDiagnosticTarget(error), { profileId: 'profile-b' });
});

test('does not invent Host authority when resolving the default Host fails', async () => {
  (globalThis as { window?: unknown }).window = {
    maka: {
      runtimeHostProfiles: {
        getDefaultHost: async () => {
          throw new Error('No default Host');
        },
      },
    },
  };
  const error = await runOnDefaultRuntimeHost(async () => undefined).catch(
    (caught: unknown) => caught,
  );

  assert.equal(defaultRuntimeHostDiagnosticTarget(error), undefined);
});
