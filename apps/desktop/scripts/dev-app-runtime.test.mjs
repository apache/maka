import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  createBootstrapSource,
  createDevelopmentEnvironmentFile,
  createMacosDevelopmentLaunch,
  createRuntimeMarker,
  developmentAppPath,
  developmentExecutablePath,
  ensureNoRunningDevelopmentApp,
  installBootstrap,
  isDevelopmentAppRunning,
  isDevelopmentRuntimeCurrent,
  monitorDevelopmentApp,
  quitMacosDevelopmentApp,
  readPublishedViteUrl,
  rebuildDevelopmentRuntime,
  resolveMacosDevelopmentLaunch,
  selectDevelopmentEnvironment,
  shouldUseMacosDevelopmentApp,
  splitDevelopmentCliArgs,
  toProcessMatchPattern,
  writeDevelopmentEnvironment,
} from './dev-app-runtime.mjs';

test('launches the signed development bundle through LaunchServices', () => {
  assert.deepEqual(createMacosDevelopmentLaunch('/repo/Maka Dev.app'), {
    command: 'open',
    args: ['-n', '-a', '/repo/Maka Dev.app'],
  });
  // The branch production always takes: LaunchServices detaches the app from
  // this terminal's stdio, so without the redirect the log has nothing to
  // follow and startup failures go only to Console.app.
  assert.deepEqual(createMacosDevelopmentLaunch('/repo/Maka Dev.app', '/repo/app.log').args, [
    '-n',
    '-a',
    '/repo/Maka Dev.app',
    '--stdout',
    '/repo/app.log',
    '--stderr',
    '/repo/app.log',
  ]);
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

test('the opt-out path returns before preparing anything', async () => {
  // The gate is only worth testing where it is actually consulted: this is the
  // sole entry point, and inverting the check must not leave the suite green.
  for (const env of [{}, { MAKA_DEV_TCC: '0' }, { MAKA_DEV_TCC: 'false' }, { MAKA_DEV_TCC: '' }]) {
    assert.equal(await resolveMacosDevelopmentLaunch(env), null);
  }
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
  // This content is persisted, so a recorded PATH would go stale. Worse, a
  // recorded TERM would make shell-env.ts short-circuit on a Dock launch and
  // leave launchd's minimal PATH in place — the exact case it exists for.
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
async function runBootstrap({ envFileContent, omitMainEntry } = {}) {
  // realpath: macOS resolves /var to /private/var, which process.cwd() reports.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'maka-boot-')));
  const desktopDir = join(root, 'desktop');
  const envFile = join(root, 'dev-env.json');
  const loadedFile = join(root, 'loaded.json');
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
  if (!omitMainEntry) {
    writeFileSync(
      join(desktopDir, 'dist', 'main', 'main.js'),
      `import { writeFileSync } from 'node:fs';
       writeFileSync(${JSON.stringify(loadedFile)}, JSON.stringify({
         cwd: process.cwd(), viteUrl: process.env.VITE_DEV_SERVER_URL ?? null,
         apiKey: process.env.OPENAI_API_KEY ?? null,
       }));`,
    );
  }
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
    // Each run measures what the bootstrap assigns from its published file.
    // Do not mistake the developer shell's forwarded values for that output.
    const publishedEnvironmentKeys = new Set([
      ...Object.keys(selectDevelopmentEnvironment(process.env)),
      'VITE_DEV_SERVER_URL',
    ]);
    for (const key of publishedEnvironmentKeys) delete process.env[key];

    nodeModule(bootstrapFile);
    const cwd = process.cwd();
    // The import settles on the next tick; poll rather than guess a tick count.
    for (let i = 0; i < 200 && !existsSync(loadedFile) && !calls.some(([k]) => k === 'exit'); i += 1) {
      await new Promise((done) => setImmediate(done));
    }
    const loaded = existsSync(loadedFile) ? JSON.parse(readFileSync(loadedFile, 'utf8')) : null;
    return { root, desktopDir, calls, cwd, loaded };
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
    delete globalThis.__makaCalls;
    rmSync(root, { recursive: true, force: true });
  }
}

test('boots the repository app from constants alone, with no env file present', async () => {
  const { desktopDir, calls, loaded, root, cwd } = await runBootstrap();
  // The central claim of the design: nothing but build-time constants.
  assert.deepEqual(calls, [
    ['setAppPath', desktopDir],
    ['setPath', 'userData', join(root, 'default-user-data')],
  ]);
  assert.equal(cwd, desktopDir);
  assert.equal(loaded.cwd, desktopDir);
  assert.equal(loaded.viteUrl, null);
});

test('adopts a published environment file: env, userData override, switches', async () => {
  const { calls, loaded } = await runBootstrap({
    envFileContent: JSON.stringify(
      createDevelopmentEnvironmentFile({
        argv: ['--enable-logging', '--user-data-dir=/tmp/override-profile'],
        env: { OPENAI_API_KEY: 'secret' },
        viteUrl: 'http://localhost:5173',
      }),
    ),
  });
  assert.deepEqual(
    calls.filter(([kind]) => kind === 'switch'),
    [['switch', 'enable-logging', null]],
  );
  assert.deepEqual(calls.find(([kind]) => kind === 'setPath'), [
    'setPath',
    'userData',
    '/tmp/override-profile',
  ]);
  assert.equal(loaded.viteUrl, 'http://localhost:5173');
  assert.equal(loaded.apiKey, 'secret');
});

test('ignores an unreadable or wrong-schema environment file instead of failing to boot', async () => {
  const wrongSchema = JSON.stringify({ schemaVersion: 999, env: { OPENAI_API_KEY: 'leak' } });
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousViteUrl = process.env.VITE_DEV_SERVER_URL;
  process.env.OPENAI_API_KEY = 'ambient-openai-key';
  process.env.VITE_DEV_SERVER_URL = 'http://ambient.invalid';
  try {
    for (const content of ['not json at all', wrongSchema]) {
      const { calls, loaded, root } = await runBootstrap({ envFileContent: content });
      assert.deepEqual(calls.find(([kind]) => kind === 'setPath'), [
        'setPath',
        'userData',
        join(root, 'default-user-data'),
      ]);
      assert.equal(loaded.apiKey, null);
      assert.equal(loaded.viteUrl, null);
    }
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousViteUrl === undefined) delete process.env.VITE_DEV_SERVER_URL;
    else process.env.VITE_DEV_SERVER_URL = previousViteUrl;
  }
});

test('an empty --user-data-dir falls back to the per-worktree default', async () => {
  const { calls, root } = await runBootstrap({
    envFileContent: JSON.stringify(
      createDevelopmentEnvironmentFile({ argv: ['--user-data-dir='], env: {} }),
    ),
  });
  assert.deepEqual(calls.find(([kind]) => kind === 'setPath'), [
    'setPath',
    'userData',
    join(root, 'default-user-data'),
  ]);
});

test('exits instead of hanging a windowless app when the main entry is missing', async () => {
  // The most common developer state: dist/main/main.js not built yet.
  const { calls } = await runBootstrap({ omitMainEntry: true });
  assert.deepEqual(
    calls.filter(([kind]) => kind === 'exit'),
    [['exit', 1]],
  );
});

test('installs the payload where Electron will actually load it', () => {
  const bundle = mkdtempSync(join(tmpdir(), 'maka-bundle-'));
  const payload = join(bundle, 'Contents', 'Resources', 'default_app.asar');
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, 'stale-from-an-older-build.js'), 'x');
  try {
    installBootstrap(bundle);
    // A plain directory, not an archive: that is what lets the payload occupy
    // the path Electron searches without any asar tooling.
    assert.equal(statSync(payload).isDirectory(), true);
    const manifest = JSON.parse(readFileSync(join(payload, 'package.json'), 'utf8'));
    assert.equal(existsSync(join(payload, manifest.main)), true);
    assert.equal(existsSync(join(payload, 'stale-from-an-older-build.js')), false);
    // Production constants, not test doubles, are what reach the bootstrap.
    const source = readFileSync(join(payload, manifest.main), 'utf8');
    assert.match(source, /apps[/\\]desktop/);
    assert.match(source, /Maka Dev-[0-9a-f]{12}/);
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
});

test('keeps the inner executable named Electron so app.isPackaged stays false', () => {
  // isPackaged is native and computed as basename(execPath) !== 'electron'.
  // Every dev-mode gate in the product hangs off it.
  assert.equal(basename(developmentExecutablePath), 'Electron');
});

test('publishes the environment file atomically and privately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maka-dev-env-'));
  const file = join(dir, 'dev-env.json');
  const content = createDevelopmentEnvironmentFile({
    env: { OPENAI_API_KEY: 'secret' },
    viteUrl: 'http://localhost:5173',
    argv: ['--user-data-dir=/tmp/custom-profile', '--enable-logging', '--remote-debugging-port=9222'],
  });
  try {
    writeDevelopmentEnvironment(content, { file });
    const written = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(written.env.OPENAI_API_KEY, 'secret');
    assert.equal(written.env.VITE_DEV_SERVER_URL, 'http://localhost:5173');
    assert.equal(written.userDataDir, '/tmp/custom-profile');
    assert.deepEqual(written.electronArgs, ['--enable-logging', '--remote-debugging-port=9222']);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    // Rewriting must not require any prior ownership handshake, must leave no
    // temporary behind, and must not widen the mode.
    writeDevelopmentEnvironment({ ...content, env: {} }, { file });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).env, {});
    assert.deepEqual(readdirSync(dir), ['dev-env.json']);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('carries a live dev server URL across a reclaiming launch', () => {
  // `npm start` publishes no URL of its own. Without this, reclaiming an app
  // from a running `npm run dev` would drop it to the prebuilt renderer.
  const dir = mkdtempSync(join(tmpdir(), 'maka-dev-env-'));
  const file = join(dir, 'dev-env.json');
  try {
    assert.equal(readPublishedViteUrl(file), undefined);
    writeDevelopmentEnvironment(
      createDevelopmentEnvironmentFile({ argv: [], env: {}, viteUrl: 'http://localhost:5173' }),
      { file },
    );
    assert.equal(readPublishedViteUrl(file), 'http://localhost:5173');
    writeFileSync(file, JSON.stringify({ schemaVersion: 999, env: { VITE_DEV_SERVER_URL: 'x' } }));
    assert.equal(readPublishedViteUrl(file), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reuses only a marker that matches every committed cache input', () => {
  const expected = createRuntimeMarker('43.1.1');
  assert.equal(isDevelopmentRuntimeCurrent({ ...expected }, expected), true);
  for (const [key, value] of Object.entries({
    schemaVersion: 999,
    electronVersion: '44.0.0',
    bundleId: 'com.other',
    // A moved repo must rebuild: the bootstrap embeds the old absolute path.
    desktopDir: '/moved',
  })) {
    assert.equal(isDevelopmentRuntimeCurrent({ ...expected, [key]: value }, expected), false, key);
  }
  const { schemaVersion: _omitted, ...markerWithoutSchema } = expected;
  assert.equal(isDevelopmentRuntimeCurrent(markerWithoutSchema, expected), false);
  assert.equal(isDevelopmentRuntimeCurrent(null, expected), false);
});

test('the marker this build writes is the marker the cache check accepts', () => {
  // Writer and checker are separate code paths. A field renamed on one side
  // alone would silently rebuild — and re-sign — on every single launch,
  // churning the bundle the TCC grant is anchored to.
  assert.equal(
    isDevelopmentRuntimeCurrent(createRuntimeMarker('43.1.1'), createRuntimeMarker('43.1.1')),
    true,
  );
  assert.equal(
    isDevelopmentRuntimeCurrent(createRuntimeMarker('43.1.1'), createRuntimeMarker('44.0.0')),
    false,
  );
  // Ad-hoc signatures designate a bare cdhash and TCC keys its rows on the
  // identifier, so a shared identifier would make worktrees overwrite each
  // other's grant.
  assert.match(createRuntimeMarker('43.1.1').bundleId, /^com\.maka\.dev\.[0-9a-f]{12}$/);
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

test('escapes regex metacharacters so a path is matched literally', () => {
  // pkill/pgrep -f take an extended regex. A repo under "~/Dropbox (Personal)"
  // would otherwise match nothing, leaving the app impossible to stop.
  assert.equal(
    toProcessMatchPattern('/Users/x/Dropbox (Personal)/Maka Dev.app/Contents/MacOS/Electron'),
    '/Users/x/Dropbox \\(Personal\\)/Maka Dev\\.app/Contents/MacOS/Electron',
  );
  assert.equal(toProcessMatchPattern('/a[b]/c+d'), '/a\\[b\\]/c\\+d');
});

test('the real probe survives a hostile bundle path', () => {
  // Against the actual matcher, not a copy of the escaping regex: unescaped,
  // the unbalanced '[' makes pgrep exit 2, which the probe turns into a throw.
  assert.equal(
    isDevelopmentAppRunning({
      executable: '/Users/x/Dropbox (Personal)/a[b/Maka Dev.app/Contents/MacOS/Electron',
    }),
    false,
  );
  // Real pgrep against the real default executable path.
  assert.equal(typeof isDevelopmentAppRunning({}), 'boolean');
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
  return quitMacosDevelopmentApp({
    platform: 'darwin',
    delay: () => Promise.resolve(),
    signal: (_name, path) => {
      signalled = path;
      return false;
    },
  }).then(() => {
    assert.equal(signalled, expected);
  });
});

test('separates --user-data-dir from switches forwarded to Electron', () => {
  assert.deepEqual(splitDevelopmentCliArgs(['--user-data-dir=/x', '--enable-logging']), {
    userDataDir: '/x',
    electronArgs: ['--enable-logging'],
  });
  assert.deepEqual(splitDevelopmentCliArgs([]), { userDataDir: undefined, electronArgs: [] });
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

test('liveness and shutdown compose through their own option shapes', async () => {
  // One options object reaches two callees that accept different keys. Stubbing
  // only the probe must not leave a real pkill wired up underneath, and the
  // poll delay must not double as the SIGTERM grace period.
  const executable = '/repo-a/.maka-dev/Maka Dev.app/Contents/MacOS/Electron';
  const probed = [];
  const signals = [];
  let alive = true;
  assert.equal(
    await ensureNoRunningDevelopmentApp({
      platform: 'darwin',
      executable,
      graceMs: 0,
      probe: (path) => {
        probed.push(path);
        return alive;
      },
      signal: (name, path) => {
        signals.push([name, path]);
        alive = false;
        return true;
      },
      delay: () => Promise.resolve(),
    }),
    true,
  );
  assert.deepEqual([...new Set(probed)], [executable]);
  assert.deepEqual(signals, [
    ['TERM', executable],
    ['KILL', executable],
  ]);

  // Pin what each callee is handed, not just the resulting behaviour: passing
  // the whole object through happens to produce the same signals here, so only
  // the forwarded shape itself can catch the regression.
  let forwardedToQuit;
  let running = true;
  await ensureNoRunningDevelopmentApp({
    platform: 'darwin',
    executable,
    graceMs: 7,
    isRunning: () => running,
    delay: () => Promise.resolve(),
    quit: (received) => {
      forwardedToQuit = received;
      running = false;
      return Promise.resolve(true);
    },
  });
  assert.deepEqual(Object.keys(forwardedToQuit).sort(), [
    'executable',
    'graceMs',
    'platform',
    'signal',
  ]);
  assert.equal(forwardedToQuit.graceMs, 7);
});

test('distinguishes a failed launch, a slow launch, and an ordinary quit', async () => {
  const delay = () => Promise.resolve();
  // `open` exits 0 at the handoff, so never appearing is the only real failure.
  assert.equal(
    await monitorDevelopmentApp({ isRunning: () => false, delay, startupAttempts: 3 }),
    'never-started',
  );
  // A first launch of the freshly signed bundle is slow; it must be waited for
  // rather than reported as a failure and killed by the shutdown that follows.
  let attempts = 0;
  assert.equal(
    await monitorDevelopmentApp({
      isRunning: () => (attempts += 1) > 5,
      delay,
      startupAttempts: 20,
      stopped: () => attempts > 6,
    }),
    'stopped',
  );
  // Appeared, then quit: an ordinary session end at any moment, not a failure.
  let remaining = 3;
  assert.equal(
    await monitorDevelopmentApp({ isRunning: () => (remaining -= 1) > 0, delay }),
    'exited',
  );
  assert.equal(
    await monitorDevelopmentApp({ isRunning: () => true, delay, stopped: () => true }),
    'stopped',
  );
});
