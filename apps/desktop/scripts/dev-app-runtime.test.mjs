import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  createMacosDevelopmentLaunch,
  createDevelopmentSession,
  createRelaunchBootstrapSource,
  developmentUserDataDir,
  waitForDevelopmentAppLaunch,
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
  // The single-instance lock must be acquired before app.pid is written, so a
  // losing second instance never clobbers the winner's pid record.
  assert.match(source, /app\.requestSingleInstanceLock\(\)/);
  assert.ok(
    source.indexOf('requestSingleInstanceLock') < source.indexOf('writeFileSync(appPidFile'),
    'lock acquisition must precede the app.pid write',
  );
});

test('forwards GitHub and Rive development credentials through the curated environment', () => {
  const env = selectDevelopmentEnvironment({
    GH_TOKEN: 'gh-token',
    GITHUB_TOKEN: 'github-token',
    RIVE_BIN: '/opt/rive/bin/rive',
    UNRELATED_SECRET: 'do-not-forward',
  });
  assert.equal(env.GH_TOKEN, 'gh-token');
  assert.equal(env.GITHUB_TOKEN, 'github-token');
  assert.equal(env.RIVE_BIN, '/opt/rive/bin/rive');
  assert.equal('UNRELATED_SECRET' in env, false);
});

test('isolates userData per linked worktree while keeping the primary profile stable', () => {
  const support = join('/Users', 'dev', 'Library', 'Application Support');
  // Primary checkout: `.git` is a directory -> historical profile, unchanged.
  assert.equal(
    developmentUserDataDir('/repo/main', support, () => false),
    join(support, 'Maka Dev'),
  );
  // Linked worktree: `.git` is a file -> stable, checkout-specific profile.
  const worktreeProfile = developmentUserDataDir('/repo/wt-a', support, () => true);
  assert.match(worktreeProfile, /Maka Dev \([0-9a-f]{8}\)$/);
  // Different worktrees get different profiles; same worktree is deterministic.
  assert.notEqual(worktreeProfile, developmentUserDataDir('/repo/wt-b', support, () => true));
  assert.equal(worktreeProfile, developmentUserDataDir('/repo/wt-a', support, () => true));
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
    marker: {
      schemaVersion: 3,
      electronVersion: '43.1.1',
      bundleId: 'com.maka.dev',
      desktopDir: '/repo/apps/desktop',
    },
    schemaVersion: 3,
    electronVersion: '43.1.1',
    bundleId: 'com.maka.dev',
    desktopDir: '/repo/apps/desktop',
    signatureValid: true,
  };
  assert.equal(isDevelopmentRuntimeCurrent(current), true, 'exact cache hit');
  assert.equal(
    isDevelopmentRuntimeCurrent({ ...current, desktopDir: '/moved/apps/desktop' }),
    false,
    'repo moved: bootstrap path in the marker is stale',
  );
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

test('resolves once the bootstrap records a live app owned by this supervisor', async () => {
  let clock = 0;
  let polls = 0;
  const pid = await waitForDevelopmentAppLaunch({
    supervisorPid: 100,
    timeoutMs: 5000,
    intervalMs: 250,
    now: () => clock,
    sleep: async () => {
      clock += 250;
    },
    // App.pid only appears (owned by this supervisor) after two polls.
    readRecord: () => (polls++ < 2 ? null : { pid: 4242, supervisorPid: 100 }),
    isAlive: () => true,
  });
  assert.equal(pid, 4242);
});

test('rejects when no live app.pid appears before the launch deadline', async () => {
  let clock = 0;
  await assert.rejects(
    () =>
      waitForDevelopmentAppLaunch({
        supervisorPid: 100,
        timeoutMs: 1000,
        intervalMs: 250,
        now: () => clock,
        sleep: async () => {
          clock += 250;
        },
        readRecord: () => null, // bootstrap crashed: pid never written
        isAlive: () => true,
      }),
    /did not start within 1000ms/,
  );
});

test('ignores an app.pid owned by a different supervisor', async () => {
  let clock = 0;
  await assert.rejects(
    () =>
      waitForDevelopmentAppLaunch({
        supervisorPid: 100,
        timeoutMs: 1000,
        intervalMs: 250,
        now: () => clock,
        sleep: async () => {
          clock += 250;
        },
        // A stale record from another supervisor must not count as our launch.
        readRecord: () => ({ pid: 4242, supervisorPid: 999 }),
        isAlive: () => true,
      }),
    /did not start within/,
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
