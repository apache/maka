import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMacosDevelopmentLaunch,
  createRelaunchBootstrapSource,
  isDevelopmentRuntimeCurrent,
  rebuildDevelopmentRuntime,
} from './dev-app-runtime.mjs';

test('launches the signed development bundle through LaunchServices', () => {
  assert.deepEqual(
    createMacosDevelopmentLaunch('/repo/Maka Dev.app', ['/repo/desktop', '--flag'], {}, '/dev-data'),
    {
    command: 'open',
    args: [
      '-n',
      '-W',
      '-a',
      '/repo/Maka Dev.app',
      '--args',
      '/repo/desktop',
      '--flag',
      '--user-data-dir=/dev-data',
    ],
    },
  );
});

test('forwards the Vite URL without copying unrelated environment secrets', () => {
  const launch = createMacosDevelopmentLaunch('/repo/Maka Dev.app', ['/repo/desktop'], {
    VITE_DEV_SERVER_URL: 'http://localhost:5173',
    API_SECRET: 'do-not-forward',
  });
  assert.deepEqual(launch.args.slice(2, 4), [
    '--env',
    'VITE_DEV_SERVER_URL=http://localhost:5173',
  ]);
  assert.equal(launch.args.some((arg) => arg.includes('do-not-forward')), false);
});

test('boots the repository app with stable user data when macOS reopens without arguments', () => {
  const source = createRelaunchBootstrapSource('/repo/apps/desktop', '/user-data/Maka Dev');
  assert.match(source, /app\.setAppPath\(desktopDir\)/);
  assert.match(source, /app\.setPath\('userData', userDataDir\)/);
  assert.match(source, /process\.chdir\(desktopDir\)/);
  assert.match(source, /dist\/main\/main\.js/);
  assert.match(source, /\/repo\/apps\/desktop/);
  assert.match(source, /\/user-data\/Maka Dev/);
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
});

test('does not commit a cache marker when runtime preparation fails', () => {
  let markerWritten = false;
  assert.throws(() =>
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
