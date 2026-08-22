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
 * correct app. That is why there is no session protocol, pid file, or
 * supervisor here: the app instance and the dev session are separate
 * lifecycles, and nothing about the app's correctness depends on who started
 * it.
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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { DEV_USER_DATA_DIR, holdsProfile, isOwnDevApp } from './dev-app-profile.mjs';
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
// Deliberately NOT worktree-scoped, unlike the bundle identifier above: the
// profile is what `app.setName('Maka Dev')` already yields on the plain
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
const DEV_ENV_SCHEMA_VERSION = 1;

export const developmentAppPath = DEV_APP;
const developmentExecutablePath = DEV_EXECUTABLE;

export async function resolveMacosDevelopmentLaunch(env = process.env, argv = []) {
  if (!shouldUseMacosDevelopmentApp(process.platform, env)) return null;
  // Judge by profile: an explicit --user-data-dir already moves this launch
  // off the shared lock, so owners of that other profile are unrelated.
  const targetProfile = splitDevelopmentCliArgs(argv).userDataDir;
  const appPath = await prepareDevelopmentApp();
  warnAboutLegacyTccDataRoot();
  // The shared "Maka Dev" userData root makes Electron's single-instance lock
  // cross-worktree: another worktree's app would absorb this launch through
  // it. Fail fast with the owner instead of silently being absorbed (#3359).
  assertNoCrossWorktreeOwner({ targetProfile });
  // A leftover app would absorb this launch through the single-instance lock.
  await ensureNoRunningDevelopmentApp();
  return createMacosDevelopmentLaunch(appPath, developmentLogFile);
}

/**
 * The TCC bundle previously wrote per-worktree userData roots
 * (`Maka Dev-<WORKTREE_ID>`); sharing the profile means this launch reads the
 * common `Maka Dev` root, so sessions and settings that lived in the legacy
 * directory are no longer read. They are NOT deleted — say where they are.
 */
function warnAboutLegacyTccDataRoot() {
  const legacy = join(homedir(), 'Library', 'Application Support', `Maka Dev-${WORKTREE_ID}`);
  if (legacy === DEV_USER_DATA_DIR || !existsSync(legacy)) return;
  console.warn(
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

export function createMacosDevelopmentLaunch(appPath, logFile) {
  // LaunchServices must own the launch so macOS TCC attributes the running
  // executable to Maka Dev rather than to its parent terminal.
  const args = ['-n', '-a', appPath];
  // Without this the detached app's output only reaches Console.app, which is
  // also where a bootstrap or boot failure would go silent.
  if (logFile) args.push('--stdout', logFile, '--stderr', logFile);
  return { command: 'open', args };
}

export const developmentLogFile = join(DEV_RUNTIME_DIR, 'app.log');

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
 * Command lines of every running "Maka Dev" app — any worktree's. The
 * packaged app is `Maka.app` and never matches; each dev bundle carries the
 * `Maka Dev.app/Contents/MacOS/Electron` suffix on its command line.
 */
export function sharedDevelopmentAppCommandLines(options = {}) {
  const probe = options.probe ?? defaultSharedAppProbe;
  return probe();
}

/** Injectable probe factory; tests substitute a fake spawn to exercise the chain. */
export function createSharedAppProbe(spawnImpl = spawnSync) {
  return function sharedAppProbe() {
    return probeWithSpawn(spawnImpl);
  };
}

function defaultSharedAppProbe() {
  // pgrep does not exist on Windows; the owner gate is a macOS/Posix dev
  // concept (no pgrep, and the shared-lock shape differs). Windows dev keeps
  // running without the gate — documented limitation, not an error.
  if (process.platform === 'win32') return [];
  return probeWithSpawn(spawnSync);
}

export function devAppProcessPattern() {
  // Rough filter over every shape that can hold the shared "Maka Dev" lock:
  // the TCC bundle, the plain dev npm shim, and the resolved Electron binary
  // it spawns. Each shape is regex-escaped; pgrep -f matches the whole line.
  const bundle = toProcessMatchPattern(join('Maka Dev.app', 'Contents', 'MacOS', 'Electron'));
  const shim = toProcessMatchPattern(join('node_modules', '.bin', 'electron'));
  const resolved = toProcessMatchPattern(join('Electron.app', 'Contents', 'MacOS', 'Electron'));
  return `${bundle}|${shim}|${resolved}`;
}

function probeWithSpawn(spawnImpl) {
  // pgrep's command-line flag semantics are OPPOSITE on the two platforms —
  // Linux -a = full command line; BSD (macOS) -a = include ancestors, -l =
  // full command line. Avoid the flag: pgrep -f yields PIDs, and ps -o
  // command= prints the full argv on both. (`command=` strips the header.)
  const pattern = devAppProcessPattern();
  const pids = spawnImpl('pgrep', ['-f', pattern]);
  // 0 = matches, 1 = no match. Anything else is a usage or pattern error and
  // must not be read as "nothing was running".
  if (pids.status !== 0 && pids.status !== 1) {
    throw new Error(`pgrep failed for the shared Maka Dev app (exit ${pids.status})`);
  }
  if (pids.status === 1) return [];
  const ids = String(pids.stdout).trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) return [];
  const ps = spawnImpl('ps', ['-p', ids.join(','), '-o', 'command=']);
  // ps exits 1 when none of the requested PIDs exist — e.g. the app quit
  // between pgrep and ps. That is "nothing running" here, same as pgrep 1.
  if (ps.status !== 0 && ps.status !== 1) {
    throw new Error(`ps failed for Maka app pids ${ids.join(',')} (exit ${ps.status})`);
  }
  return ps.status === 1 ? [] : String(ps.stdout).split('\n').filter(Boolean);
}

/**
 * The first running `Maka Dev` app that is NOT this worktree's own bundle, or
 * undefined when every running dev app is ours. Electron's single-instance
 * lock is keyed on the shared userData root, so an app from another worktree
 * holds the lock for this profile too — and this script must not dispose of
 * another worktree's window (data root sharing does not confer disposal
 * rights). Returns the owner's command line for the error message.
 */
export function sharedDevelopmentAppOwner(options = {}) {
  const ownRoot = options.ownRoot ?? REPO_ROOT;
  const targetProfile = options.targetProfile; // undefined = shared default
  const commandLines = options.commandLines ?? sharedDevelopmentAppCommandLines(options);
  return commandLines.find((line) => {
    // Own process first; the expensive failure direction is MISSING another
    // worktree's holder (our launch is absorbed), not misjudging our own
    // (one blocked launch). Same principle as dev-app-profile.mjs.
    if (isOwnDevApp(line, ownRoot)) return false;
    return holdsProfile(line, targetProfile);
  });
}

/**
 * Fail fast when another worktree's dev app holds the shared profile's
 * single-instance lock. The absorbed-launch failure mode is exit-0 plus a
 * `never-started` report from the local monitor — indistinguishable from a
 * normal launch unless the owner is named (#3359).
 */
export function assertNoCrossWorktreeOwner(options = {}) {
  const owner = options.owner ?? sharedDevelopmentAppOwner(options);
  if (owner === undefined) return;
  throw new Error(
    `Another worktree's Maka Dev app is running and holds the shared "Maka Dev" profile: ${owner}. ` +
      'Quit it (Cmd-Q) or stop it before launching this worktree. ' +
      'If the named process does not look like Maka, it may be another project with an ' +
      'apps/desktop layout running Electron without an explicit --user-data-dir — the ' +
      'judgment errs toward blocking (see dev-app-profile.mjs).',
  );
}

/**
 * Terminates this worktree's development app. All three process shapes — the
 * TCC bundle, the npm shim, and the resolved Electron it spawns — are
 * anchored under this worktree's path (REPO_ROOT/node_modules for the plain
 * shapes), so matching each shape precisely needs no pid tracking and never
 * touches a concurrent worktree's processes.
 */
export async function quitMacosDevelopmentApp(options = {}) {
  const platform = options.platform ?? process.platform;
  const bundle = options.executable ?? DEV_EXECUTABLE;
  const shim = options.plainExecutable ?? resolveElectronBinary();
  const real = options.realPlainExecutable ?? realElectronBinary();
  const graceMs = options.graceMs ?? 3_000;
  const signal = options.signal ?? sendSignalToExecutable;
  const delay = options.delay ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  if (platform !== 'darwin') return false;
  const stoppedBundle = signal('TERM', bundle);
  // Plain dev is two live processes (shim + the Electron it spawned); signal
  // both or the orphaned Electron keeps the profile lock.
  const stoppedShim = signal('TERM', shim);
  const stoppedReal = signal('TERM', real);
  if (!stoppedBundle && !stoppedShim && !stoppedReal) return false;
  // Main-process cleanup runs on before-quit and can outlive a plain SIGTERM.
  await delay(graceMs);
  if (stoppedBundle) signal('KILL', bundle);
  if (stoppedShim) signal('KILL', shim);
  if (stoppedReal) signal('KILL', real);
  return true;
}

function sendSignalToExecutable(name, executable) {
  const status = spawnSync('pkill', [`-${name}`, '-f', toProcessMatchPattern(executable)]).status;
  // 0 = signalled, 1 = no match. Anything else is a usage or pattern error and
  // must not be read as "nothing was running".
  if (status !== 0 && status !== 1) {
    throw new Error(`pkill -${name} failed for ${executable} (exit ${status})`);
  }
  return status === 0;
}

export function isDevelopmentAppRunning(options = {}) {
  const bundle = options.executable ?? DEV_EXECUTABLE;
  const shim = options.plainExecutable ?? resolveElectronBinary();
  const real = options.realPlainExecutable ?? realElectronBinary();
  const probe = options.probe ?? defaultLivenessProbe;
  // The shared-profile lock is a macOS concept (plain dev and the TCC bundle
  // both reach it only there). On other platforms keep main's behavior: only
  // the bundle is probed — the bundle never exists off macOS, so liveness is
  // false and the launch proceeds to the single-instance lock. Probing the
  // shim/Electron shapes off-darwin would hard-fail a plain `npm run dev`
  // that main allowed (the shim exists on Linux; quit is darwin-only).
  if ((options.platform ?? process.platform) !== 'darwin') return probe(bundle);
  return probe(bundle) || probe(shim) || probe(real);
}

/** The resolved native binary a plain dev actually runs (the npm shim's child). */
function realElectronBinary() {
  return join(
    REPO_ROOT,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'MacOS',
    'Electron',
  );
}

function defaultLivenessProbe(executable) {
  if (process.platform === 'win32') return false;
  const status = spawnSync('pgrep', ['-f', toProcessMatchPattern(executable)]).status;
  if (status !== 0 && status !== 1) {
    throw new Error(`pgrep failed for ${executable} (exit ${status})`);
  }
  return status === 0;
}

/**
 * Takes ownership of this worktree's app instance before launching or
 * rebuilding. Electron's single-instance lock is keyed on userData, so an app
 * left over from a hard-killed session would absorb the new launch: the new
 * process exits 0, the OLD window is raised, and it stays pointed at a dead
 * Vite URL while a liveness probe still reports success.
 */
export async function ensureNoRunningDevelopmentApp(options = {}) {
  const running = options.isRunning ?? isDevelopmentAppRunning;
  const quit = options.quit ?? quitMacosDevelopmentApp;
  const delay = options.delay ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const attempts = options.attempts ?? 10;
  const pollMs = options.pollMs ?? 200;
  // Forward each callee only what it accepts. Passing this whole object through
  // would make `delay` double as the SIGTERM grace period, and would let a
  // caller that stubs `probe` still fall through to a real `pkill`.
  const liveness = { executable: options.executable, probe: options.probe };
  const shutdown = {
    platform: options.platform,
    executable: options.executable,
    graceMs: options.graceMs,
    signal: options.signal,
  };
  if (!running(liveness)) return false;
  await quit(shutdown);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!running(liveness)) return true;
    await delay(pollMs);
  }
  throw new Error(
    'A previous Maka Dev.app is still running and could not be stopped; quit it manually (Cmd-Q) and retry',
  );
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
 * `npm start` does not run a dev server, but it may be reclaiming an app from a
 * live `npm run dev`. Republishing without the URL would drop the app to the
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
 */
export async function startDevelopmentApp(options = {}) {
  const argv = options.argv ?? [];
  // Read before preparing: a rebuild republishes the runtime directory and
  // takes the previous environment file with it.
  const viteUrl = options.viteUrl ?? readPublishedViteUrl();
  const launch = await resolveMacosDevelopmentLaunch(process.env, argv);
  if (!launch) {
    // The plain shape uses the same shared profile, so the same owner gate
    // applies before we spawn — otherwise another worktree's app (TCC or
    // plain) would absorb this launch through the single-instance lock.
    const targetProfile = splitDevelopmentCliArgs(argv).userDataDir;
    assertNoCrossWorktreeOwner({ targetProfile });
    // A leftover own dev app would absorb this launch through the lock.
    await ensureNoRunningDevelopmentApp();
    const child = spawn(resolveElectronBinary(), [DESKTOP_DIR, ...argv], {
      cwd: DESKTOP_DIR,
      stdio: 'inherit',
      env: viteUrl ? { ...process.env, VITE_DEV_SERVER_URL: viteUrl } : process.env,
    });
    return { child, isMacosBundle: false, stop: () => terminateProcessTree(child) };
  }

  writeDevelopmentEnvironment(
    createDevelopmentEnvironmentFile({ argv, env: process.env, viteUrl }),
  );
  // LaunchServices detaches the app from this terminal's stdio, so `open`
  // redirects its output here and we follow it. The log carries whatever the
  // app prints, so it gets the same mode as the environment file beside it.
  writeFileSync(developmentLogFile, '', { mode: 0o600 });
  const logStream = spawn('tail', ['-n', '+1', '-F', developmentLogFile], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const child = spawn(launch.command, launch.args, {
    cwd: DESKTOP_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  return {
    child,
    isMacosBundle: true,
    stop: async () => {
      logStream.kill();
      await quitMacosDevelopmentApp();
    },
  };
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
 * Watches the detached bundle for the whole session, because `open` exits 0 at
 * the handoff and reports nothing afterwards.
 *
 * Waiting a fixed interval and checking once cannot work in either direction: a
 * first launch of the freshly signed bundle can still be starting, and quitting
 * the app is a normal thing to do at any moment. So this waits for the app to
 * appear, then reports the eventual disappearance as an ordinary session end.
 */
export async function monitorDevelopmentApp(options = {}) {
  const isRunning = options.isRunning ?? isDevelopmentAppRunning;
  const delay = options.delay ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const stopped = options.stopped ?? (() => false);
  const pollMs = options.pollMs ?? 250;
  const startupAttempts = options.startupAttempts ?? 120;
  let appeared = false;
  for (let attempt = 0; attempt < startupAttempts && !appeared; attempt += 1) {
    if (stopped()) return 'stopped';
    if (isRunning()) appeared = true;
    else await delay(pollMs);
  }
  if (!appeared) return 'never-started';
  while (!stopped()) {
    await delay(pollMs);
    if (stopped()) break;
    if (!isRunning()) return 'exited';
  }
  return 'stopped';
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

  // Rebuilding unlinks the bundle an already-running app was launched from,
  // and deletes the environment file it would read on relaunch.
  await ensureNoRunningDevelopmentApp();

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
