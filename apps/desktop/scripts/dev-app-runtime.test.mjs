import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMacosDevelopmentLaunch,
  createDevelopmentSession,
  createRelaunchBootstrapSource,
  isDevelopmentRuntimeCurrent,
  rebuildDevelopmentRuntime,
  selectDevelopmentEnvironment,
  shouldUseMacosDevelopmentApp,
} from './dev-app-runtime.mjs';

test('launches the signed development bundle through LaunchServices', () => {
  assert.deepEqual(createMacosDevelopmentLaunch('/repo/Maka Dev.app'), {
    command: 'open',
    args: ['-n', '-a', '/repo/Maka Dev.app'],
  });
  assert.equal(shouldUseMacosDevelopmentApp('darwin'), true);
  assert.equal(shouldUseMacosDevelopmentApp('linux'), false);
});

test('stores the Vite URL and curated environment without command-line secrets', () => {
  const env = selectDevelopmentEnvironment({
    VITE_DEV_SERVER_URL: 'http://localhost:5173',
    OPENAI_API_KEY: 'openai-secret',
    MAKA_MODEL: 'test-model',
    API_SECRET: 'do-not-forward',
  }, 'http://localhost:4173');
  assert.equal(env.VITE_DEV_SERVER_URL, 'http://localhost:4173');
  assert.equal(env.OPENAI_API_KEY, 'openai-secret');
  assert.equal(env.MAKA_MODEL, 'test-model');
  assert.equal('API_SECRET' in env, false);
  assert.equal(createMacosDevelopmentLaunch('/repo/Maka Dev.app').args.includes('openai-secret'), false);
});

test('boots the repository app and recovers a live supervisor session on reopen', () => {
  const source = createRelaunchBootstrapSource(
    '/repo/apps/desktop',
    '/user-data/Maka Dev',
    '/repo/.maka-dev/session.json',
    '/repo/.maka-dev/app.pid',
  );
  assert.match(source, /app\.setAppPath\(desktopDir\)/);
  assert.match(source, /app\.setPath\('userData', userDataDir\)/);
  assert.match(source, /process\.chdir\(desktopDir\)/);
  assert.match(source, /dist\/main\/main\.js/);
  assert.match(source, /\/repo\/apps\/desktop/);
  assert.match(source, /\/user-data\/Maka Dev/);
  assert.match(source, /candidate\.supervisorPid/);
  assert.match(source, /Object\.assign\(process\.env, session\.env\)/);
  assert.match(source, /appPidFile/);
});

test('honors an explicit development user-data directory in the session', () => {
  const session = createDevelopmentSession({
    supervisorPid: 42,
    env: {},
    userDataDir: '/tmp/custom-profile',
  });
  assert.equal(session.userDataDir, '/tmp/custom-profile');
});

test('reuses only an exact, valid development runtime cache', () => {
  const current = {
    marker: { schemaVersion: 3, electronVersion: '43.1.1', bundleId: 'com.maka.dev' },
    schemaVersion: 3,
    electronVersion: '43.1.1',
    bundleId: 'com.maka.dev',
    signatureValid: true,
  };
  assert.equal(isDevelopmentRuntimeCurrent(current), true, 'exact cache hit');
  assert.equal(
    isDevelopmentRuntimeCurrent({ ...current, electronVersion: '44.0.0' }),
    false,
    'Electron change',
  );
  assert.equal(
    isDevelopmentRuntimeCurrent({ ...current, schemaVersion: 4 }),
    false,
    'schema change',
  );
  assert.equal(
    isDevelopmentRuntimeCurrent({ ...current, bundleId: 'com.maka.other' }),
    false,
    'bundle ID change',
  );
  assert.equal(
    isDevelopmentRuntimeCurrent({ ...current, signatureValid: false }),
    false,
    'failed signature verification',
  );
  assert.equal(
    isDevelopmentRuntimeCurrent({ ...current, marker: { ...current.marker, schemaVersion: undefined } }),
    false,
    'missing schema is never accepted as a legacy default',
  );
  assert.equal(
    isDevelopmentRuntimeCurrent({ ...current, marker: 'corrupt' }),
    false,
    'corrupt marker shape',
  );
});

test('does not commit a cache marker when runtime preparation fails', async () => {
  let markerWritten = false;
  await assert.rejects(() =>
    rebuildDevelopmentRuntime({
      reset: () => undefined,
      build: () => {
        throw new Error('codesign failed');
      },
      writeMarker: () => {
        markerWritten = true;
      },
    }),
  );
  assert.equal(markerWritten, false);
});
