import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createBootstrapSource,
  createDevelopmentEnvironmentFile,
  createMacosDevelopmentLaunch,
  isDevelopmentAppRunning,
  isDevelopmentRuntimeCurrent,
  quitMacosDevelopmentApp,
  rebuildDevelopmentRuntime,
  selectDevelopmentEnvironment,
  shouldUseMacosDevelopmentApp,
  writeDevelopmentEnvironment,
} from './dev-app-runtime.mjs';

test('launches the signed development bundle through LaunchServices', () => {
  assert.deepEqual(createMacosDevelopmentLaunch('/repo/Maka Dev.app'), {
    command: 'open',
    args: ['-n', '-a', '/repo/Maka Dev.app'],
  });
});

test('keeps the signed bundle workflow opt-in', () => {
  assert.equal(shouldUseMacosDevelopmentApp('darwin', { MAKA_DEV_TCC: '1' }), true);
  assert.equal(shouldUseMacosDevelopmentApp('darwin', { MAKA_DEV_TCC: 'true' }), true);
  assert.equal(shouldUseMacosDevelopmentApp('darwin', { MAKA_DEV_TCC: ' TRUE ' }), true);
  assert.equal(shouldUseMacosDevelopmentApp('darwin', {}), false);
  assert.equal(shouldUseMacosDevelopmentApp('darwin', { MAKA_DEV_TCC: '0' }), false);
  assert.equal(shouldUseMacosDevelopmentApp('darwin', { MAKA_DEV_TCC: '' }), false);
  // Opting in elsewhere must never reach codesign or LaunchServices.
  assert.equal(shouldUseMacosDevelopmentApp('linux', { MAKA_DEV_TCC: '1' }), false);
  assert.equal(shouldUseMacosDevelopmentApp('win32', { MAKA_DEV_TCC: 'true' }), false);
});

test('forwards application secrets but leaves PATH to the main process', () => {
  const env = selectDevelopmentEnvironment(
    {
      OPENAI_API_KEY: 'openai-secret',
      GH_TOKEN: 'github-secret',
      GITHUB_TOKEN: 'github-fallback',
      RIVE_BIN: '/tools/rive',
      MAKA_MODEL: 'test-model',
      CUA_ENDPOINT: 'http://cua',
      API_SECRET: 'do-not-forward',
      PATH: '/should/not/travel',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
    'http://localhost:4173',
  );
  assert.equal(env.VITE_DEV_SERVER_URL, 'http://localhost:4173');
  assert.equal(env.OPENAI_API_KEY, 'openai-secret');
  assert.equal(env.GH_TOKEN, 'github-secret');
  assert.equal(env.GITHUB_TOKEN, 'github-fallback');
  assert.equal(env.RIVE_BIN, '/tools/rive');
  assert.equal(env.MAKA_MODEL, 'test-model');
  assert.equal(env.CUA_ENDPOINT, 'http://cua');
  assert.equal('API_SECRET' in env, false);
  // shell-env.ts resolves the login-shell PATH itself, and treats TERM /
  // COLORTERM as proof it need not bother. Forwarding either would make it
  // skip resolution and leave the app with a worse PATH than it derives.
  assert.equal('PATH' in env, false);
  assert.equal('TERM' in env, false);
  assert.equal('COLORTERM' in env, false);
  // Secrets travel in a 0600 file, never on a command line.
  assert.equal(createMacosDevelopmentLaunch('/repo/Maka Dev.app').args.includes('openai-secret'), false);
});

test('boots the repository app from constants alone', () => {
  const source = createBootstrapSource(
    '/repo/apps/desktop',
    '/user-data/Maka Dev',
    '/repo/apps/desktop/.maka-dev/dev-env.json',
  );
  assert.match(source, /app\.setAppPath\(desktopDir\)/);
  assert.match(source, /process\.chdir\(desktopDir\)/);
  assert.match(source, /dist\/main\/main\.js/);
  assert.match(source, /\/repo\/apps\/desktop/);
  assert.match(source, /\/user-data\/Maka Dev/);
  assert.match(source, /app\.commandLine\.appendSwitch/);
  // The whole point: a relaunch carries no arguments and no live supervisor,
  // so the bootstrap must not depend on either.
  assert.doesNotMatch(source, /process\.argv/);
  assert.doesNotMatch(source, /supervisorPid/);
  assert.doesNotMatch(source, /process\.kill/);
  assert.doesNotThrow(() => new Function(source));
});

test('publishes the environment file atomically and privately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-dev-env-'));
  const file = join(dir, 'dev-env.json');
  const content = createDevelopmentEnvironmentFile({
    env: { OPENAI_API_KEY: 'secret' },
    viteUrl: 'http://localhost:5173',
    userDataDir: '/tmp/custom-profile',
    electronArgs: ['--enable-logging', '--remote-debugging-port=9222'],
  });
  writeDevelopmentEnvironment(content, { file });
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.schemaVersion, 1);
  assert.equal(written.env.OPENAI_API_KEY, 'secret');
  assert.equal(written.env.VITE_DEV_SERVER_URL, 'http://localhost:5173');
  assert.equal(written.userDataDir, '/tmp/custom-profile');
  assert.deepEqual(written.electronArgs, ['--enable-logging', '--remote-debugging-port=9222']);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // Rewriting must not require any prior ownership handshake.
  writeDevelopmentEnvironment({ ...content, env: {} }, { file });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).env, {});
});

test('reuses only an exact, valid development runtime cache', () => {
  const current = {
    marker: {
      schemaVersion: 5,
      electronVersion: '43.1.1',
      bundleId: 'com.maka.dev',
      desktopDir: '/repo/apps/desktop',
    },
    schemaVersion: 5,
    electronVersion: '43.1.1',
    bundleId: 'com.maka.dev',
    desktopDir: '/repo/apps/desktop',
    signatureValid: true,
  };
  assert.equal(isDevelopmentRuntimeCurrent(current), true);
  assert.equal(isDevelopmentRuntimeCurrent({ ...current, signatureValid: false }), false);
  assert.equal(isDevelopmentRuntimeCurrent({ ...current, electronVersion: '44.0.0' }), false);
  assert.equal(isDevelopmentRuntimeCurrent({ ...current, schemaVersion: 6 }), false);
  assert.equal(isDevelopmentRuntimeCurrent({ ...current, bundleId: 'com.other' }), false);
  // A moved repo must rebuild: the bootstrap embeds the old absolute path.
  assert.equal(isDevelopmentRuntimeCurrent({ ...current, desktopDir: '/moved' }), false);
  // A marker with no schema version is not implicitly v1.
  const { schemaVersion: _omitted, ...markerWithoutSchema } = current.marker;
  assert.equal(isDevelopmentRuntimeCurrent({ ...current, marker: markerWithoutSchema }), false);
  assert.equal(isDevelopmentRuntimeCurrent({ ...current, marker: null }), false);
});

test('does not commit a cache marker when runtime preparation fails', async () => {
  const steps = [];
  await assert.rejects(
    rebuildDevelopmentRuntime({
      reset: () => steps.push('reset'),
      build: () => {
        steps.push('build');
        throw new Error('codesign failed');
      },
      writeMarker: () => steps.push('marker'),
    }),
    /codesign failed/,
  );
  assert.deepEqual(steps, ['reset', 'build']);
});

test('shutdown targets this worktree bundle and escalates after a grace period', async () => {
  const signals = [];
  const delays = [];
  const stopped = await quitMacosDevelopmentApp({
    platform: 'darwin',
    executable: '/repo-a/.maka-dev/Maka Dev.app/Contents/MacOS/Electron',
    graceMs: 3_000,
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    signal: (name, executable) => {
      signals.push([name, executable]);
      return true;
    },
  });
  assert.equal(stopped, true);
  // Matching the worktree's own bundle path is what keeps a concurrent
  // worktree's app untouched without tracking pids.
  assert.deepEqual(signals, [
    ['TERM', '/repo-a/.maka-dev/Maka Dev.app/Contents/MacOS/Electron'],
    ['KILL', '/repo-a/.maka-dev/Maka Dev.app/Contents/MacOS/Electron'],
  ]);
  assert.deepEqual(delays, [3_000]);
});

test('shutdown is inert when nothing matches or the platform differs', async () => {
  const attempted = [];
  assert.equal(
    await quitMacosDevelopmentApp({
      platform: 'darwin',
      signal: (name) => {
        attempted.push(name);
        return false;
      },
    }),
    false,
  );
  assert.deepEqual(attempted, ['TERM'], 'a missed TERM must not escalate to KILL');
  assert.equal(
    await quitMacosDevelopmentApp({
      platform: 'linux',
      signal: () => assert.fail('must not signal off darwin'),
    }),
    false,
  );
});

test('liveness probe checks the worktree bundle path', () => {
  const probed = [];
  assert.equal(
    isDevelopmentAppRunning({
      executable: '/repo-a/Maka Dev.app/Contents/MacOS/Electron',
      probe: (path) => {
        probed.push(path);
        return true;
      },
    }),
    true,
  );
  assert.deepEqual(probed, ['/repo-a/Maka Dev.app/Contents/MacOS/Electron']);
  assert.equal(isDevelopmentAppRunning({ probe: () => false }), false);
});
