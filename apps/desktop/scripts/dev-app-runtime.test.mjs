import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  acquirePidLock,
  assertNoActiveDevelopmentSession,
  clearDevelopmentSession,
  createMacosDevelopmentLaunch,
  createDevelopmentSession,
  createRelaunchBootstrapSource,
  isDevelopmentRuntimeCurrent,
  rebuildDevelopmentRuntime,
  selectDevelopmentEnvironment,
  shouldUseMacosDevelopmentApp,
  quitMacosDevelopmentApp,
  recoverStaleDevelopmentSession,
  waitForMacosDevelopmentApp,
  writeDevelopmentSession,
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
    GH_TOKEN: 'github-secret',
    GITHUB_TOKEN: 'github-fallback',
    RIVE_BIN: '/tools/rive',
    MAKA_MODEL: 'test-model',
    API_SECRET: 'do-not-forward',
  }, 'http://localhost:4173');
  assert.equal(env.VITE_DEV_SERVER_URL, 'http://localhost:4173');
  assert.equal(env.OPENAI_API_KEY, 'openai-secret');
  assert.equal(env.MAKA_MODEL, 'test-model');
  assert.equal(env.GH_TOKEN, 'github-secret');
  assert.equal(env.GITHUB_TOKEN, 'github-fallback');
  assert.equal(env.RIVE_BIN, '/tools/rive');
  assert.equal('API_SECRET' in env, false);
  assert.equal(createMacosDevelopmentLaunch('/repo/Maka Dev.app').args.includes('openai-secret'), false);
});

test('boots the repository app and recovers a live supervisor session on reopen', () => {
  const source = createRelaunchBootstrapSource(
    '/repo/apps/desktop',
    '/user-data/Maka Dev',
    '/repo/.maka-dev/session.json',
    '/repo/.maka-dev/app.pid',
    '/repo/.maka-dev/launch-status.json',
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
  assert.doesNotMatch(source, /writeFileSync\(appPidFile/);
  assert.match(source, /MAKA_DEV_APP_PID_FILE/);
  assert.match(source, /app\.commandLine\.appendSwitch/);
  assert.doesNotThrow(() => new Function(source));
});

test('honors an explicit development user-data directory in the session', () => {
  const session = createDevelopmentSession({
    supervisorPid: 42,
    env: {},
    userDataDir: '/tmp/custom-profile',
    electronArgs: ['--enable-logging', '--remote-debugging-port=9222'],
  });
  assert.equal(session.userDataDir, '/tmp/custom-profile');
  assert.deepEqual(session.electronArgs, ['--enable-logging', '--remote-debugging-port=9222']);
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
    'repository path change',
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

test('session protocol atomically owns, rejects, and clears its state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-dev-session-'));
  const paths = {
    sessionFile: join(dir, 'session.json'),
    appPidFile: join(dir, 'app.pid'),
    launchStatusFile: join(dir, 'launch-status.json'),
    processAlive: (pid) => pid === 42,
  };
  writeFileSync(paths.appPidFile, 'stale');
  writeFileSync(paths.launchStatusFile, 'stale');
  const session = createDevelopmentSession({ supervisorPid: 42, env: {} });
  writeDevelopmentSession(session, paths);
  assert.equal(statSync(paths.sessionFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(paths.sessionFile)).supervisorPid, 42);
  assert.throws(
    () => writeDevelopmentSession({ ...session, supervisorPid: 99 }, paths),
    /already supervised by PID 42/,
  );
  clearDevelopmentSession(99, paths);
  assert.equal(JSON.parse(readFileSync(paths.sessionFile)).supervisorPid, 42);
  clearDevelopmentSession(42, paths);
  assert.throws(() => readFileSync(paths.sessionFile), /ENOENT/);
});

test('launch handshake reports ready, failed, and timeout states', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-dev-launch-'));
  const statusFile = join(dir, 'status.json');
  writeFileSync(statusFile, JSON.stringify({ status: 'ready', pid: process.pid, supervisorPid: 42 }));
  assert.equal(
    (await waitForMacosDevelopmentApp({ statusFile, supervisorPid: 42, timeoutMs: 20 })).pid,
    process.pid,
  );
  writeFileSync(statusFile, JSON.stringify({ status: 'failed', supervisorPid: 42, message: 'boom' }));
  await assert.rejects(
    waitForMacosDevelopmentApp({ statusFile, supervisorPid: 42, timeoutMs: 20 }),
    /boom/,
  );
  await assert.rejects(
    waitForMacosDevelopmentApp({ statusFile: join(dir, 'missing'), timeoutMs: 5, pollMs: 1 }),
    /did not finish starting/,
  );
});

test('PID-scoped quit waits for cleanup and uses a final fallback signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-dev-quit-'));
  const appPidFile = join(dir, 'app.pid');
  writeFileSync(appPidFile, JSON.stringify({ pid: 77, supervisorPid: 42 }));
  const signals = [];
  let checks = 0;
  assert.equal(
    await quitMacosDevelopmentApp({
      platform: 'darwin',
      appPidFile,
      supervisorPid: 42,
      processAlive: () => checks++ < 2,
      kill: (pid, signal) => signals.push([pid, signal]),
      delay: async () => undefined,
    }),
    true,
  );
  assert.deepEqual(signals, [[77, 'SIGTERM'], [77, 'SIGKILL']]);
});

test('a new supervisor recovers an orphan app before replacing stale state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-dev-recover-'));
  const paths = {
    sessionFile: join(dir, 'session.json'),
    appPidFile: join(dir, 'app.pid'),
    launchStatusFile: join(dir, 'launch-status.json'),
  };
  writeFileSync(paths.sessionFile, JSON.stringify({ supervisorPid: 42 }));
  writeFileSync(paths.appPidFile, JSON.stringify({ pid: 77, supervisorPid: 42 }));
  writeFileSync(paths.launchStatusFile, 'stale');
  const signals = [];
  const alive = new Set([77]);
  assert.equal(
    await recoverStaleDevelopmentSession({
      ...paths,
      platform: 'darwin',
      processAlive: (pid) => alive.has(pid),
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        alive.delete(pid);
      },
      delay: async () => undefined,
    }),
    true,
  );
  assert.deepEqual(signals, [[77, 'SIGTERM']]);
  assert.throws(() => readFileSync(paths.sessionFile), /ENOENT/);
  assert.throws(() => readFileSync(paths.appPidFile), /ENOENT/);
});

test('runtime lock rejects a live owner and recovers a stale owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-dev-lock-'));
  const lock = join(dir, 'runtime.lock');
  writeFileSync(lock, '42\n');
  assert.throws(() => acquirePidLock(lock, { processAlive: () => true }), /PID 42/);
  const release = acquirePidLock(lock, { processAlive: () => false });
  assert.equal(Number(readFileSync(lock, 'utf8').trim()), process.pid);
  release();
  assert.throws(() => readFileSync(lock), /ENOENT/);
});

test('runtime rebuild is blocked while a supervised session is live', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-dev-owner-'));
  const sessionFile = join(dir, 'session.json');
  writeFileSync(sessionFile, JSON.stringify({ supervisorPid: 42 }));
  assert.throws(
    () => assertNoActiveDevelopmentSession({ sessionFile, processAlive: () => true }),
    /stop it before rebuilding/,
  );
  assert.doesNotThrow(() =>
    assertNoActiveDevelopmentSession({ sessionFile, processAlive: () => false }),
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
