import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ensureNoRunningDevelopmentApp,
  createBootstrapSource,
  createDevelopmentEnvironmentFile,
  developmentAppPath,
  splitDevelopmentCliArgs,
  toProcessMatchPattern,
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
  // This content is persisted, so a recorded PATH would go stale; shell-env.ts
  // resolves the login-shell PATH in the main process for the GUI-launch case.
  assert.equal('PATH' in env, false);
  assert.equal('TERM' in env, false);
  assert.equal('COLORTERM' in env, false);
});

/**
 * Runs the generated bootstrap for real against a stub `electron` module and a
 * stub main entry. Asserting on the source text only proves it mentions the
 * right identifiers; `new Function` accepts a typo'd `setPathTYPO` or a
 * nonexistent module. Executing it is what pins the behaviour.
 */
async function runBootstrap({ envFileContent } = {}) {
  // realpath: macOS resolves /var to /private/var, which process.cwd() reports.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'maka-boot-')));
  const desktopDir = join(root, 'desktop');
  const envFile = join(root, 'dev-env.json');
  const calls = [];
  mkdirSync(join(desktopDir, 'dist', 'main'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'electron'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', 'electron', 'package.json'),
    JSON.stringify({ name: 'electron', main: 'index.js' }),
  );
  writeFileSync(
    join(root, 'node_modules', 'electron', 'index.js'),
    `const calls = globalThis.__makaCalls;
     module.exports = { app: {
       setAppPath: (p) => calls.push(['setAppPath', p]),
       setPath: (k, v) => calls.push(['setPath', k, v]),
       exit: (c) => calls.push(['exit', c]),
       commandLine: { appendSwitch: (k, v) => calls.push(['switch', k, v ?? null]) },
     } };`,
  );
  writeFileSync(
    join(desktopDir, 'dist', 'main', 'main.js'),
    `import { writeFileSync } from 'node:fs';
     writeFileSync(${JSON.stringify(join(root, 'loaded.json'))}, JSON.stringify({
       cwd: process.cwd(), viteUrl: process.env.VITE_DEV_SERVER_URL ?? null,
       apiKey: process.env.OPENAI_API_KEY ?? null,
     }));`,
  );
  if (envFileContent !== undefined) writeFileSync(envFile, envFileContent);
  const bootstrapFile = join(root, 'bootstrap.cjs');
  writeFileSync(
    bootstrapFile,
    createBootstrapSource(desktopDir, join(root, 'default-user-data'), envFile),
  );
  const nodeModule = createRequire(join(root, 'x.cjs'));
  globalThis.__makaCalls = calls;
  // The bootstrap chdirs by design, and its dynamic import of the main entry
  // resolves on a later tick — so the cwd must stay in place until that entry
  // has run. Restore it only afterwards, so later tests are unaffected.
  const previousCwd = process.cwd();
  // The bootstrap assigns into process.env, which is per-app in production but
  // shared between these tests; snapshot it so cases stay independent.
  const previousEnv = { ...process.env };
  try {
    nodeModule(bootstrapFile);
    const cwd = process.cwd();
    for (let i = 0; i < 20; i += 1) await new Promise((done) => setImmediate(done));
    return { root, desktopDir, calls, cwd, loadedFile: join(root, 'loaded.json') };
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

test('boots the repository app from constants alone, with no env file present', async () => {
  const { desktopDir, calls, loadedFile, root, cwd } = await runBootstrap();
  // The central claim of the design: nothing but build-time constants.
  assert.deepEqual(calls, [
    ['setAppPath', desktopDir],
    ['setPath', 'userData', join(root, 'default-user-data')],
  ]);
  assert.equal(cwd, desktopDir);
  const loaded = JSON.parse(readFileSync(loadedFile, 'utf8'));
  assert.equal(loaded.cwd, desktopDir);
  assert.equal(loaded.viteUrl, null);
});

test('adopts a published environment file: env, userData override, switches', async () => {
  const { calls, loadedFile } = await runBootstrap({
    envFileContent: JSON.stringify(
      createDevelopmentEnvironmentFile({
        argv: ['--enable-logging', '--user-data-dir=/tmp/override-profile'],
        env: { OPENAI_API_KEY: 'secret' },
        viteUrl: 'http://localhost:5173',
      }),
    ),
  });
  assert.deepEqual(calls.filter(([kind]) => kind === 'switch'), [
    ['switch', 'enable-logging', null],
  ]);
  assert.deepEqual(calls.find(([kind]) => kind === 'setPath'), [
    'setPath',
    'userData',
    '/tmp/override-profile',
  ]);
  const loaded = JSON.parse(readFileSync(loadedFile, 'utf8'));
  assert.equal(loaded.viteUrl, 'http://localhost:5173');
  assert.equal(loaded.apiKey, 'secret');
});

test('ignores an unreadable or wrong-schema environment file instead of failing to boot', async () => {
  for (const content of ['not json at all', JSON.stringify({ schemaVersion: 999, env: { OPENAI_API_KEY: 'leak' } })]) {
    const { calls, loadedFile, root } = await runBootstrap({ envFileContent: content });
    assert.deepEqual(calls.find(([kind]) => kind === 'setPath'), [
      'setPath',
      'userData',
      join(root, 'default-user-data'),
    ]);
    assert.equal(JSON.parse(readFileSync(loadedFile, 'utf8')).apiKey, null);
  }
});

test('publishes the environment file atomically and privately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-dev-env-'));
  const file = join(dir, 'dev-env.json');
  const content = createDevelopmentEnvironmentFile({
    env: { OPENAI_API_KEY: 'secret' },
    viteUrl: 'http://localhost:5173',
    argv: ['--user-data-dir=/tmp/custom-profile', '--enable-logging', '--remote-debugging-port=9222'],
  });
  writeDevelopmentEnvironment(content, { file });
  const written = JSON.parse(readFileSync(file, 'utf8'));
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

test('escapes regex metacharacters so a path is matched literally', () => {
  // pkill/pgrep -f take an extended regex. A repo under "~/Dropbox (Personal)"
  // would otherwise match nothing, leaving the app impossible to stop.
  assert.equal(
    toProcessMatchPattern('/Users/x/Dropbox (Personal)/Maka Dev.app/Contents/MacOS/Electron'),
    '/Users/x/Dropbox \\(Personal\\)/Maka Dev\\.app/Contents/MacOS/Electron',
  );
  assert.equal(toProcessMatchPattern('/a[b]/c+d'), '/a\\[b\\]/c\\+d');
});

test('defaults target this worktree bundle executable', () => {
  // Every other quit/liveness test injects around the real wiring; this one
  // pins that the un-injected default is the bundle path we mean to match.
  const expected = join(developmentAppPath, 'Contents', 'MacOS', 'Electron');
  let seen;
  isDevelopmentAppRunning({
    probe: (path) => {
      seen = path;
      return false;
    },
  });
  assert.equal(seen, expected);
  let signalled;
  void quitMacosDevelopmentApp({
    platform: 'darwin',
    delay: () => Promise.resolve(),
    signal: (_name, path) => {
      signalled = path;
      return false;
    },
  });
  assert.equal(signalled, expected);
});

test('separates --user-data-dir from switches forwarded to Electron', () => {
  assert.deepEqual(splitDevelopmentCliArgs(['--user-data-dir=/x', '--enable-logging']), {
    userDataDir: '/x',
    electronArgs: ['--enable-logging'],
  });
  assert.deepEqual(splitDevelopmentCliArgs([]), { userDataDir: undefined, electronArgs: [] });
  // Empty value falls back to the bootstrap default rather than setting ''.
  assert.equal(splitDevelopmentCliArgs(['--user-data-dir=']).userDataDir, '');
});

test('claims the app instance before launching or rebuilding', async () => {
  // A leftover app would absorb the new launch via the single-instance lock,
  // leaving the OLD window in front while liveness still reports success.
  let alive = true;
  const quits = [];
  assert.equal(
    await ensureNoRunningDevelopmentApp({
      isRunning: () => alive,
      quit: () => {
        quits.push('quit');
        alive = false;
        return Promise.resolve(true);
      },
      delay: () => Promise.resolve(),
    }),
    true,
  );
  assert.deepEqual(quits, ['quit']);
  // Nothing running: no quit attempt at all.
  assert.equal(
    await ensureNoRunningDevelopmentApp({
      isRunning: () => false,
      quit: () => assert.fail('must not quit when nothing is running'),
    }),
    false,
  );
  // Refuses to proceed rather than launching into a doomed single-instance lock.
  await assert.rejects(
    ensureNoRunningDevelopmentApp({
      isRunning: () => true,
      quit: () => Promise.resolve(true),
      delay: () => Promise.resolve(),
      attempts: 2,
    }),
    /still running and could not be stopped/,
  );
});
