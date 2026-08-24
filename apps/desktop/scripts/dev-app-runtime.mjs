/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * macOS development app for OS-permission work.
 *
 * macOS TCC will not keep an Accessibility or Screen Recording grant for an
 * unsigned executable launched from a terminal. It needs a stable bundle
 * identity, a verifiable signature, and a responsible process that is the app
 * bundle itself. That is what this module builds: an ad-hoc-signed
 * `Maka Dev.app` launched through LaunchServices.
 *
 * The bundle is a copy of the npm Electron app with its identity rewritten and
 * a small bootstrap injected. Everything the bootstrap needs is a build-time
 * constant, so a launch with no arguments and no environment — the Dock,
 * Spotlight, or the system's Screen Recording "Quit & Reopen" — reproduces a
 * correct app. The launcher's one-shot result file reports only the Electron
 * lock verdict; it does not supervise the app or carry application state. The
 * app instance and the dev session remain separate lifecycles: stopping the
 * launcher never terminates the TCC app.
 *
 * `app.isPackaged` is native and computed as
 * `basename(process.execPath) !== 'electron'`, so the invariant that keeps
 * every dev-mode gate alive is simply that the inner executable stays named
 * `Electron` — NOT the payload's location. (It is not derived from
 * `process.defaultApp`; that flag is set by the stock default_app this module
 * replaces, and is therefore undefined here.)
 *
 * The payload occupies `default_app.asar` rather than `Resources/app` so it
 * cannot shadow a real packaged app laid down at the standard location.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(DESKTOP_DIR, '..', '..');
const DEV_RUNTIME_DIR = join(DESKTOP_DIR, '.maka-dev');
const STAGING_DIR = join(DESKTOP_DIR, '.maka-dev.staging');
const DEV_APP = join(DEV_RUNTIME_DIR, 'Maka Dev.app');
const STAGING_APP = join(STAGING_DIR, 'Maka Dev.app');
const DEV_EXECUTABLE = join(DEV_APP, 'Contents', 'MacOS', 'Electron');
const DEV_ENV_FILE = join(DEV_RUNTIME_DIR, 'dev-env.json');
const MARKER = join(DEV_RUNTIME_DIR, 'runtime.json');
const ELECTRON_PACKAGE = join(REPO_ROOT, 'node_modules', 'electron', 'package.json');
const SOURCE_APP = join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
const WORKTREE_ID = createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12);
// Deliberately NOT worktree-scoped, unlike the bundle identifier above: plain
// Electron and the TCC bundle must share the same single-instance authority.
export const DEV_USER_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Maka Dev');
const DEV_ENV_SCHEMA_VERSION = 1;
/**
 * Per-worktree, and deliberately so. An ad-hoc signature designates a bare
 * `cdhash`, and TCC keys its rows on the bundle identifier — so a shared
 * identifier would make every worktree overwrite the previous one's stored
 * requirement and silently break it. Scoping the identifier gives each worktree
 * its own durable, independently revocable grant.
 *
 * There is no explicit `designated => identifier` requirement here. It would
 * survive rebuilds, but it is forgeable by construction: `codesign --sign -` is
 * available to every unprivileged process, so any binary anywhere on the disk
 * can claim this identifier and satisfy the requirement. TCC rows outlive the
 * code they were granted to, so that would leave a permanently redeemable
 * Accessibility and Screen Recording token behind even after this repository is
 * deleted. The cdhash requirement costs a re-grant when the bundle is rebuilt —
 * which happens only on an Electron bump or a repository move, not on an
 * ordinary `npm run dev` — and that is the cheaper side of the trade.
 */
const DEV_BUNDLE_ID = `com.maka.dev.${WORKTREE_ID}`;
const RUNTIME_SCHEMA_VERSION = 7;

export const developmentAppPath = DEV_APP;

async function prepareMacosDevelopmentLaunch(env = process.env) {
  if (!shouldUseMacosDevelopmentApp(process.platform, env)) return null;
  const appPath = await prepareDevelopmentApp();
  const resultFileArgPrefix = (await devSingleInstanceConstants())
    ?.DEV_LAUNCH_RESULT_FILE_ARG_PREFIX;
  if (!resultFileArgPrefix) {
    throw new Error('Maka Dev launch-result contract is unavailable; rebuild @maka/core and retry.');
  }
  return { appPath, resultFileArgPrefix };
}

/**
 * The TCC bundle previously wrote per-worktree userData roots
 * (`Maka Dev-<WORKTREE_ID>`); sharing the profile means this launch reads the
 * common `Maka Dev` root, so sessions and settings that lived in the legacy
 * directory are no longer read. They are NOT deleted — say where they are.
 */
export function warnAboutLegacyTccDataRoot(options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') return;
  const effectiveUserDataDir = options.effectiveUserDataDir ?? DEV_USER_DATA_DIR;
  const legacy = options.legacyUserDataDir ??
    join(homedir(), 'Library', 'Application Support', `Maka Dev-${WORKTREE_ID}`);
  const exists = options.exists ?? existsSync;
  const warn = options.warn ?? console.warn;
  if (effectiveUserDataDir !== DEV_USER_DATA_DIR || legacy === DEV_USER_DATA_DIR || !exists(legacy)) {
    return;
  }
  warn(
    `[maka-dev] shared profile: your earlier TCC data (sessions, settings) lives in ${legacy} ` +
      'and is no longer read. It is not deleted — copy it back if needed, or remove it.',
  );
}

/**
 * The signed-bundle workflow exists only so TCC grants survive development.
 * It costs a codesign rebuild and a LaunchServices handoff that detaches the
 * app from the terminal's stdio, so `npm run dev` no longer prints main-process
 * logs. Developers who are not working on OS permissions should not pay that,
 * so it stays opt-in.
 */
export function shouldUseMacosDevelopmentApp(platform, env = process.env) {
  if (platform !== 'darwin') return false;
  const optIn = env.MAKA_DEV_TCC?.trim().toLowerCase();
  return optIn === '1' || optIn === 'true';
}

export function createMacosDevelopmentLaunch(
  appPath,
  logFile,
  resultFile,
  resultFileArgPrefix,
) {
  // LaunchServices must own the launch so macOS TCC attributes the running
  // executable to Maka Dev rather than to its parent terminal.
  const args = ['-n', '-a', appPath];
  // Without this the detached app's output only reaches Console.app, which is
  // also where a bootstrap or boot failure would go silent.
  if (logFile) args.push('--stdout', logFile, '--stderr', logFile);
  // The private result path must come LAST: everything after `open --args` is
  // passed to the app, and the last launcher-owned value wins over any
  // user-supplied lookalike argument.
  if (resultFile && resultFileArgPrefix) {
    args.push('--args', `${resultFileArgPrefix}${resultFile}`);
  }
  return { command: 'open', args };
}

export function createDevelopmentLaunchFiles(options = {}) {
  const directory = options.directory ?? join(tmpdir(), 'maka-dev-launches');
  const id = options.id ?? randomUUID();
  const logFile = join(directory, `${id}.log`);
  const resultFile = join(directory, `${id}.result.json`);
  const mkdir = options.mkdir ?? mkdirSync;
  const write = options.write ?? ((target) => writeFileSync(target, '', { mode: 0o600 }));
  mkdir(directory, { recursive: true, mode: 0o700 });
  write(logFile);
  return { logFile, resultFile };
}

/**
 * `pkill -f` / `pgrep -f` match an EXTENDED REGEX against the whole command
 * line, so a path is not a literal. A repository under `~/Dropbox (Personal)`
 * would otherwise match nothing — leaving the app un-killable — and an
 * unbalanced `[` makes the pattern fail to compile entirely.
 */
export function toProcessMatchPattern(executable) {
  return executable.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&');
}

/**
 * Electron's lock is authoritative. The plain launcher owns its child directly
 * and reads its exit code, while the detached TCC launcher consumes a private,
 * one-shot winner/loser result without taking ownership of the app process.
 * Constants are imported lazily so this module loads before libs are built.
 */
export async function devSingleInstanceConstants(loader = () => import('@maka/core/dev-single-instance')) {
  // Explicit failure contract: the import can fail on a fresh clone before
  // libs are built. Every consumer must handle undefined explicitly — a
  // throw here would crash the plain launcher. One warning, then undefined.
  try {
    return await loader();
  } catch (error) {
    console.warn(`[maka-dev] dev single-instance constants unavailable: ${String(error)}`);
    return undefined;
  }
}

export async function readDevelopmentLaunchResult(resultFile, loader) {
  const constants = await devSingleInstanceConstants(loader);
  if (!constants) return undefined;
  try {
    return constants.parseDevelopmentLaunchResult(readFileSync(resultFile, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Exit-code check for the plain child (child is the app process). */
export async function plainLoserExitCode(code, loader) {
  const constants = await devSingleInstanceConstants(loader);
  if (!constants) return false; // cannot attribute; do not invent a loser
  return code === constants.DEV_LOSER_EXIT_CODE;
}

export function isDevelopmentAppRunning(options = {}) {
  const bundle = options.executable ?? DEV_EXECUTABLE;
  const probe = options.probe ?? defaultLivenessProbe;
  return probe(bundle);
}

function defaultLivenessProbe(executable) {
  if (process.platform === 'win32') return false;
  const status = spawnSync('pgrep', ['-f', toProcessMatchPattern(executable)]).status;
  if (status !== 0 && status !== 1) {
    throw new Error(`pgrep failed for ${executable} (exit ${status})`);
  }
  return status === 0;
}

export function assertDevelopmentAppNotRunning(options = {}) {
  const isRunning = options.isRunning ?? isDevelopmentAppRunning;
  if (!isRunning(options)) return;
  throw new Error('Maka Dev.app is running. Quit it (Cmd-Q) and retry the rebuild.');
}

/**
 * Application-control variables to persist for the app.
 *
 * `open` itself does forward the parent environment, so this file is not what
 * makes `npm run dev` work. It exists for the launches that have no parent
 * shell at all — Dock, Spotlight, and Screen Recording's "Quit & Reopen" —
 * which is exactly the path the whole design has to survive.
 *
 * That is also why the list is curated rather than a copy of `process.env`:
 * this content is written to disk and outlives the session. PATH is excluded
 * because a recorded PATH goes stale, and `shell-env.ts` resolves the
 * login-shell PATH in the main process for precisely the GUI-launch case.
 */
export function selectDevelopmentEnvironment(env, viteUrl) {
  const selected = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (isForwardedEnvironmentKey(key)) selected[key] = value;
  }
  if (viteUrl) selected.VITE_DEV_SERVER_URL = viteUrl;
  return selected;
}

function isForwardedEnvironmentKey(key) {
  return (
    key.startsWith('MAKA_') ||
    key.startsWith('CUA_') ||
    [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'TAVILY_API_KEY',
      'COPILOT_GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'RIVE_BIN',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'PYTHONPATH',
      'NODE_ENV',
      'NO_COLOR',
    ].includes(key)
  );
}

/**
 * `--user-data-dir` cannot ride along in `electronArgs`: the bootstrap calls
 * `app.setPath('userData', …)`, which overrides the switch. It has to be
 * separated so the bootstrap can honour it as a value.
 */
export function splitDevelopmentCliArgs(argv = []) {
  const flag = '--user-data-dir=';
  return {
    userDataDir: argv.find((argument) => argument.startsWith(flag))?.slice(flag.length),
    electronArgs: argv.filter((argument) => !argument.startsWith(flag)),
  };
}

export function createDevelopmentEnvironmentFile(input) {
  const { userDataDir, electronArgs } = splitDevelopmentCliArgs(input.argv);
  return {
    schemaVersion: DEV_ENV_SCHEMA_VERSION,
    env: selectDevelopmentEnvironment(input.env, input.viteUrl),
    userDataDir,
    electronArgs,
  };
}

/**
 * Publishes the environment the app should adopt. This is plain data with no
 * owning process: a relaunch minutes later reads the same file and is just as
 * correct, which is what removes the need for session supervision.
 */
export function writeDevelopmentEnvironment(content, options = {}) {
  const file = options.file ?? DEV_ENV_FILE;
  mkdirSync(join(file, '..'), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * The Vite URL a previous launcher published, if any.
 *
 * `npm start` does not run a dev server, but it may reuse the URL published by
 * the previous `npm run dev`. Republishing without the URL would drop the app to the
 * prebuilt renderer on disk — stale, or absent entirely on a fresh checkout.
 */
export function readPublishedViteUrl(file = DEV_ENV_FILE) {
  try {
    const published = JSON.parse(readFileSync(file, 'utf8'));
    if (published.schemaVersion !== DEV_ENV_SCHEMA_VERSION) return undefined;
    return published.env?.VITE_DEV_SERVER_URL;
  } catch {
    return undefined;
  }
}

function resolveElectronBinary() {
  for (let dir = DESKTOP_DIR; ; dir = dirname(dir)) {
    const executable =
      process.platform === 'win32'
        ? join(dir, 'node_modules', 'electron', 'dist', 'electron.exe')
        : join(dir, 'node_modules', '.bin', 'electron');
    if (existsSync(executable)) return executable;
    if (dirname(dir) === dir) return 'electron';
  }
}

/**
 * The single way to start the app, on every platform and both entry points.
 *
 * `npm run dev` and `npm start` previously each carried their own copy of
 * this — publish the environment, launch, follow the log, shut down — and the
 * copies drifted into different bugs rather than different behaviour.
 *
 * Returns a handle rather than a child process because the two paths are not
 * comparable: on the macOS bundle path `open` exits at the LaunchServices
 * handoff, so its exit code says nothing about the app.
 *
 * All asynchronous preparation finishes before launch artifacts or processes
 * are created. Once `signal` is aborted, this attempt cannot publish either.
 */
export async function startDevelopmentApp(options = {}) {
  const prepareMacosLaunch = options.prepareMacosDevelopmentLaunch ?? prepareMacosDevelopmentLaunch;
  const loadSingleInstanceConstants = options.devSingleInstanceConstants ?? devSingleInstanceConstants;
  const createLaunchFiles = options.createDevelopmentLaunchFiles ?? createDevelopmentLaunchFiles;
  const spawnProcess = options.spawn ?? spawn;
  const signal = options.signal;
  signal?.throwIfAborted();
  const argv = options.argv ?? [];
  const { userDataDir } = splitDevelopmentCliArgs(argv);
  warnAboutLegacyTccDataRoot({ effectiveUserDataDir: userDataDir ?? DEV_USER_DATA_DIR });
  // Read before preparing: a rebuild republishes the runtime directory and
  // takes the previous environment file with it.
  const viteUrl = options.viteUrl ?? readPublishedViteUrl();
  const preparedLaunch = await prepareMacosLaunch();
  signal?.throwIfAborted();
  if (!preparedLaunch) {
    const launcherFlag = (await loadSingleInstanceConstants())?.DEV_CONFLICT_HANDLED_BY_LAUNCHER_FLAG;
    signal?.throwIfAborted();
    const child = spawnProcess(resolveElectronBinary(), [DESKTOP_DIR, ...argv, ...(launcherFlag ? [launcherFlag] : [])], {
      cwd: DESKTOP_DIR,
      stdio: 'inherit',
      env: viteUrl ? { ...process.env, VITE_DEV_SERVER_URL: viteUrl } : process.env,
    });
    child.once('exit', (code) => {
      void plainLoserExitCode(code).then((loser) => {
        if (!loser) return;
        console.error(
          'Maka Dev could not start: another instance holds the shared profile lock ' +
            `(loser exit code ${code}). Quit it (Cmd-Q) and retry.`,
        );
      });
    });
    return { child, isMacosBundle: false, stop: () => terminateProcessTree(child) };
  }

  const files = createLaunchFiles();
  const launch = {
    ...createMacosDevelopmentLaunch(
      preparedLaunch.appPath,
      files.logFile,
      files.resultFile,
      preparedLaunch.resultFileArgPrefix,
    ),
    ...files,
  };
  writeDevelopmentEnvironment(
    createDevelopmentEnvironmentFile({ argv, env: process.env, viteUrl }),
  );
  // LaunchServices detaches the app from this terminal's stdio, so `open`
  // redirects its output here and we follow it. Logs are observation only;
  // the lock verdict travels through launch.resultFile instead.
  const logStream = spawnProcess('tail', ['-n', '+1', '-F', launch.logFile], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const child = spawnProcess(launch.command, launch.args, {
    cwd: DESKTOP_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  return {
    child,
    isMacosBundle: true,
    logFile: launch.logFile,
    resultFile: launch.resultFile,
    stop: () => cleanupDevelopmentLaunch({
      logStream,
      logFile: launch.logFile,
      resultFile: launch.resultFile,
    }),
  };
}

/**
 * Owns the dev launch from process signal through final resource cleanup.
 * Keeping this coupling here makes the cancellation wire itself testable: a
 * signal aborts the same attempt `start()` created, then joins and stops any
 * handle that attempt was already publishing.
 */
export function createDevelopmentLaunchSession(options = {}) {
  const startApp = options.startDevelopmentApp ?? startDevelopmentApp;
  const signals = options.signals ?? process;
  const close = options.close ?? (() => {});
  const exit = options.exit ?? ((code) => process.exit(code));
  const controller = new AbortController();
  let launchPromise = null;
  let stopPromise = null;

  const stop = (code = 0) => {
    if (stopPromise) return stopPromise;
    controller.abort();
    stopPromise = (async () => {
      const app = await launchPromise?.catch(() => null);
      await app?.stop();
      try {
        await close();
      } catch {
        // Shutdown is best-effort; the process must still reach its exit path.
      }
      exit(code);
    })();
    return stopPromise;
  };

  signals.on('SIGINT', () => stop(0));
  signals.on('SIGTERM', () => stop(0));
  signals.on('SIGHUP', () => stop(0));

  return {
    start(startOptions = {}) {
      launchPromise = Promise.resolve(startApp({
        ...startOptions,
        signal: controller.signal,
      }));
      return launchPromise.catch((error) => {
        if (controller.signal.aborted && error === controller.signal.reason) return null;
        throw error;
      });
    },
    stop,
    isStopping: () => stopPromise !== null,
  };
}

export function cleanupDevelopmentLaunch({ logStream, logFile, resultFile }) {
  logStream.kill();
  rmSync(logFile, { force: true });
  rmSync(resultFile, { force: true });
}

function terminateProcessTree(child) {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  if (process.platform === 'win32' && child.pid) {
    return new Promise((done) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      killer.on('exit', () => done());
      killer.on('error', () => done());
    });
  }
  child.kill('SIGTERM');
  return Promise.resolve();
}

/**
 * Waits only for Electron's lock verdict. After a winner is known, the detached
 * TCC app owns its own lifecycle; the launcher neither polls nor terminates it.
 */
export async function waitForDevelopmentLaunchVerdict(options = {}) {
  const readLaunchResult = options.readLaunchResult ??
    (() => readDevelopmentLaunchResult(options.resultFile));
  const delay = options.delay ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const stopped = options.stopped ?? (() => false);
  const pollMs = options.pollMs ?? 250;
  const startupAttempts = options.startupAttempts ?? 120;
  for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
    const result = await readLaunchResult();
    if (result?.status === 'loser') return 'absorbed';
    if (result?.status === 'winner') return 'started';
    if (stopped()) return 'stopped';
    await delay(pollMs);
  }
  return 'never-started';
}

/**
 * Launch-outcome decision, fully contained: absorbed/never-started are failures,
 * stopped is a normal launcher exit, and started deliberately leaves the
 * launcher's own dev resources running without supervising Electron.
 */
export function handleDevelopmentLaunchOutcome(outcome, effects = {}) {
  const log = effects.log ?? console.error;
  const exit = effects.exit ?? ((code) => { process.exitCode = code; });
  switch (outcome) {
    case 'started':
      return;
    case 'absorbed':
      log('Maka Dev was absorbed by another instance holding the profile lock; quitting.');
      exit(1);
      return;
    case 'never-started':
      log('Maka Dev did not start within the startup window.');
      exit(1);
      return;
    case 'stopped':
      exit(0);
      return;
    default:
      log(`Unknown Maka Dev monitor outcome: ${String(outcome)}`);
      exit(1);
  }
}

export async function prepareDevelopmentApp() {
  if (process.platform !== 'darwin') {
    throw new Error('Maka Dev.app is only available on macOS');
  }
  if (!existsSync(SOURCE_APP)) {
    throw new Error(`Electron.app is missing at ${SOURCE_APP}; run npm install first`);
  }

  const electronVersion = JSON.parse(readFileSync(ELECTRON_PACKAGE, 'utf8')).version;
  if (isCurrentRuntime(electronVersion)) return DEV_APP;

  // Rebuilding unlinks the bundle an already-running app was launched from.
  // Refuse rather than terminating a process the launcher did not create.
  assertDevelopmentAppNotRunning();

  try {
    await rebuildDevelopmentRuntime({
      reset: () => {
        rmSync(STAGING_DIR, { recursive: true, force: true });
        mkdirSync(STAGING_DIR, { recursive: true });
      },
      build: () => {
        run('ditto', [SOURCE_APP, STAGING_APP]);
        const plist = join(STAGING_APP, 'Contents', 'Info.plist');
        setPlistString(plist, 'CFBundleIdentifier', DEV_BUNDLE_ID);
        setPlistString(plist, 'CFBundleName', 'Maka Dev');
        setPlistString(plist, 'CFBundleDisplayName', 'Maka Dev');
        // Stock Electron seals a SHA256 of its own default_app.asar here. We
        // replace that payload, so the record would describe a file that no
        // longer exists — inert today only because the integrity fuse is off.
        spawnSync('plutil', ['-remove', 'ElectronAsarIntegrity', plist]);
        installBootstrap(STAGING_APP);
        // `ditto` preserves quarantine by default (`--qtn`), so clear it from
        // the whole tree rather than the bundle root alone.
        run('xattr', ['-cr', STAGING_APP]);
        // No --identifier: `plutil` already set CFBundleIdentifier, and
        // codesign derives it per bundle. Passing it with --deep would stamp
        // the outer app's identifier onto all four nested helper bundles,
        // whose own identifier is com.github.Electron.helper.
        //
        // `--deep` is load-bearing rather than gratuitous here: the npm source
        // is linker-signed with no bundle seal, so without it the result does
        // not verify at all. Apple's deprecation concerns distribution
        // signing, where --deep discards per-target entitlements; this build
        // has none.
        run('codesign', ['--force', '--deep', '--sign', '-', STAGING_APP]);
        run('codesign', ['--verify', '--deep', '--strict', STAGING_APP]);
        // Publish by rename so a launcher never observes a partial bundle.
        // This does not make concurrent *builders* safe — they share one
        // staging path — but two rebuilds in one worktree is not a case worth
        // locking for.
        rmSync(DEV_RUNTIME_DIR, { recursive: true, force: true });
        renameSync(STAGING_DIR, DEV_RUNTIME_DIR);
      },
      writeMarker: () => {
        writeFileSync(
          MARKER,
          `${JSON.stringify(createRuntimeMarker(electronVersion), null, 2)}\n`,
        );
      },
    });
  } finally {
    // A failed build otherwise leaves a ~250 MB copy of Electron.app behind
    // with no message. Publishing already moved the directory away.
    rmSync(STAGING_DIR, { recursive: true, force: true });
  }
  return DEV_APP;
}

/**
 * The cache key this build commits, and the one `isDevelopmentRuntimeCurrent`
 * validates. Both sides must read from here: a field renamed on one side alone
 * would silently force a rebuild on every launch, churning the very bundle the
 * TCC grant is anchored to.
 */
export function createRuntimeMarker(electronVersion) {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    electronVersion,
    bundleId: DEV_BUNDLE_ID,
    desktopDir: DESKTOP_DIR,
    // Burned into the generated bootstrap, so a change here must invalidate
    // the cached bundle (isDevelopmentRuntimeCurrent compares every field).
    userDataDir: DEV_USER_DATA_DIR,
  };
}

/**
 * Writes the payload as a plain directory named `default_app.asar`. Node
 * resolves it as an ordinary directory, so no archive step or asar dependency
 * is needed to occupy the path Electron looks for.
 */
export function installBootstrap(appPath = DEV_APP) {
  const payload = join(appPath, 'Contents', 'Resources', 'default_app.asar');
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  writeFileSync(
    join(payload, 'package.json'),
    `${JSON.stringify({ name: 'maka-dev', main: 'main.cjs', private: true }, null, 2)}\n`,
  );
  writeFileSync(
    join(payload, 'main.cjs'),
    createBootstrapSource(DESKTOP_DIR, DEV_USER_DATA_DIR, DEV_ENV_FILE),
  );
}

/**
 * Every value here is fixed at build time, which keeps the bundle's cdhash
 * stable across rebuilds — a rebuild does not invalidate an existing TCC grant.
 * The environment file is read opportunistically: if it is missing or stale the
 * app still starts, just without a dev server URL.
 */
export function createBootstrapSource(desktopDir, defaultUserDataDir, envFile) {
  return [
    "const { app } = require('electron');",
    "const { join } = require('node:path');",
    "const { pathToFileURL } = require('node:url');",
    `const desktopDir = ${JSON.stringify(desktopDir)};`,
    'let devEnv = null;',
    'try {',
    `  const candidate = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(envFile)}, 'utf8'));`,
    `  if (candidate.schemaVersion === ${DEV_ENV_SCHEMA_VERSION}) devEnv = candidate;`,
    '} catch {}',
    'if (devEnv?.env) Object.assign(process.env, devEnv.env);',
    'for (const argument of devEnv?.electronArgs || []) {',
    '  const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);',
    '  if (match) app.commandLine.appendSwitch(match[1], match[2]);',
    '}',
    'app.setAppPath(desktopDir);',
    `app.setPath('userData', devEnv?.userDataDir || ${JSON.stringify(defaultUserDataDir)});`,
    'process.chdir(desktopDir);',
    "import(pathToFileURL(join(desktopDir, 'dist/main/main.js')).href).catch((error) => {",
    "  console.error('[maka-dev] bootstrap failed', error);",
    '  app.exit(1);',
    '});',
    '',
  ].join('\n');
}

function isCurrentRuntime(electronVersion) {
  if (!existsSync(DEV_EXECUTABLE) || !existsSync(MARKER)) return false;
  try {
    const marker = JSON.parse(readFileSync(MARKER, 'utf8'));
    // Compare the cheap marker before paying for a full bundle verification.
    if (!isDevelopmentRuntimeCurrent(marker, createRuntimeMarker(electronVersion))) return false;
    return spawnSync('codesign', ['--verify', '--deep', '--strict', DEV_APP]).status === 0;
  } catch {
    return false;
  }
}

/**
 * Every field the build committed must still hold. Comparing against a marker
 * built by `createRuntimeMarker` rather than against a hand-listed set means a
 * new cache input is covered the moment it is added there.
 */
export function isDevelopmentRuntimeCurrent(marker, expected) {
  if (marker === null || typeof marker !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => marker[key] === value);
}

export async function rebuildDevelopmentRuntime(deps) {
  await deps.reset();
  await deps.build();
  // The marker is the cache commit point. Never write it until copying,
  // bootstrap generation, signing, and strict verification all succeed.
  await deps.writeMarker();
}

function setPlistString(plist, key, value) {
  if (spawnSync('plutil', ['-replace', key, '-string', value, plist]).status === 0) return;
  run('plutil', ['-insert', key, '-string', value, plist]);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.status === 0) return;
  const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
  throw new Error(`${command} failed: ${detail}`);
}
