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
 * The injected payload replaces `default_app.asar` rather than the standard
 * `Resources/app` location. Electron derives `app.isPackaged` from
 * `!process.defaultApp`, so using the packaged-app location would flip
 * `isPackaged` to true and silently disable every dev-mode gate. For the same
 * reason the inner executable keeps the name `Electron`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(DESKTOP_DIR, '..', '..');
const DEV_RUNTIME_DIR = join(DESKTOP_DIR, '.maka-dev');
const DEV_APP = join(DEV_RUNTIME_DIR, 'Maka Dev.app');
const DEV_EXECUTABLE = join(DEV_APP, 'Contents', 'MacOS', 'Electron');
const DEV_ENV_FILE = join(DEV_RUNTIME_DIR, 'dev-env.json');
const MARKER = join(DEV_RUNTIME_DIR, 'runtime.json');
const ELECTRON_PACKAGE = join(REPO_ROOT, 'node_modules', 'electron', 'package.json');
const SOURCE_APP = join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
const WORKTREE_ID = createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12);
const DEV_USER_DATA_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  `Maka Dev-${WORKTREE_ID}`,
);

const DEV_BUNDLE_ID = 'com.maka.dev';
const RUNTIME_SCHEMA_VERSION = 5;
const DEV_ENV_SCHEMA_VERSION = 1;

export const developmentAppPath = DEV_APP;

export async function resolveMacosDevelopmentLaunch(env = process.env) {
  if (!shouldUseMacosDevelopmentApp(process.platform, env)) return null;
  const appPath = await prepareDevelopmentApp();
  return createMacosDevelopmentLaunch(appPath);
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

export function createMacosDevelopmentLaunch(appPath) {
  // LaunchServices must own the launch so macOS TCC attributes the running
  // executable to Maka Dev rather than to its parent terminal.
  return { command: 'open', args: ['-n', '-a', appPath] };
}

/**
 * Terminates this worktree's development app. The bundle path is unique per
 * worktree, so matching on it is precise without tracking a pid: concurrent
 * worktrees own different bundles and are unaffected.
 */
export async function quitMacosDevelopmentApp(options = {}) {
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? DEV_EXECUTABLE;
  const graceMs = options.graceMs ?? 3_000;
  const signal = options.signal ?? sendSignalToExecutable;
  const delay = options.delay ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  if (platform !== 'darwin') return false;
  if (!signal('TERM', executable)) return false;
  // Main-process cleanup runs on before-quit and can outlive a plain SIGTERM.
  await delay(graceMs);
  signal('KILL', executable);
  return true;
}

function sendSignalToExecutable(name, executable) {
  return spawnSync('pkill', [`-${name}`, '-f', executable]).status === 0;
}

export function isDevelopmentAppRunning(options = {}) {
  const executable = options.executable ?? DEV_EXECUTABLE;
  const probe = options.probe ?? ((path) => spawnSync('pgrep', ['-f', path]).status === 0);
  return probe(executable);
}

/**
 * Application-control variables for the launched app. LaunchServices does not
 * inherit the shell environment, and these must not travel on a command line.
 *
 * PATH is deliberately absent: `shell-env.ts` already resolves the login-shell
 * PATH in the main process precisely because GUI-launched apps lack it. Passing
 * PATH here would also mean passing TERM/COLORTERM, which that module reads as
 * "this process was started from a terminal and already has a full
 * environment" — making it skip resolution and leave the app with a worse PATH
 * than it derives on its own.
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

export function createDevelopmentEnvironmentFile(input) {
  return {
    schemaVersion: DEV_ENV_SCHEMA_VERSION,
    env: selectDevelopmentEnvironment(input.env, input.viteUrl),
    userDataDir: input.userDataDir,
    electronArgs: input.electronArgs ?? [],
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

export async function prepareDevelopmentApp() {
  if (process.platform !== 'darwin') {
    throw new Error('Maka Dev.app is only available on macOS');
  }
  if (!existsSync(SOURCE_APP)) {
    throw new Error(`Electron.app is missing at ${SOURCE_APP}; run npm install first`);
  }

  const electronVersion = JSON.parse(readFileSync(ELECTRON_PACKAGE, 'utf8')).version;
  if (isCurrentRuntime(electronVersion)) return DEV_APP;

  await rebuildDevelopmentRuntime({
    reset: () => {
      rmSync(DEV_RUNTIME_DIR, { recursive: true, force: true });
      mkdirSync(DEV_RUNTIME_DIR, { recursive: true });
    },
    build: () => {
      run('ditto', [SOURCE_APP, DEV_APP]);
      const plist = join(DEV_APP, 'Contents', 'Info.plist');
      setPlistString(plist, 'CFBundleIdentifier', DEV_BUNDLE_ID);
      setPlistString(plist, 'CFBundleName', 'Maka Dev');
      setPlistString(plist, 'CFBundleDisplayName', 'Maka Dev');
      installBootstrap();
      // `ditto` does not copy quarantine metadata by default. Clear any
      // root-level attribute without the newer recursive `xattr -r` flag,
      // which is unavailable on older supported macOS releases.
      run('xattr', ['-c', DEV_APP]);
      run('codesign', ['--force', '--deep', '--sign', '-', '--identifier', DEV_BUNDLE_ID, DEV_APP]);
      run('codesign', ['--verify', '--deep', '--strict', DEV_APP]);
    },
    writeMarker: () => {
      writeFileSync(
        MARKER,
        `${JSON.stringify(
          {
            schemaVersion: RUNTIME_SCHEMA_VERSION,
            electronVersion,
            bundleId: DEV_BUNDLE_ID,
            desktopDir: DESKTOP_DIR,
          },
          null,
          2,
        )}\n`,
      );
    },
  });
  return DEV_APP;
}

/**
 * Writes the payload as a plain directory named `default_app.asar`. Node
 * resolves it as an ordinary directory, so no archive step or asar dependency
 * is needed to occupy the path Electron looks for.
 */
function installBootstrap() {
  const payload = join(DEV_APP, 'Contents', 'Resources', 'default_app.asar');
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
    return isDevelopmentRuntimeCurrent({
      marker: JSON.parse(readFileSync(MARKER, 'utf8')),
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      electronVersion,
      bundleId: DEV_BUNDLE_ID,
      desktopDir: DESKTOP_DIR,
      signatureValid:
        spawnSync('codesign', ['--verify', '--deep', '--strict', DEV_APP]).status === 0,
    });
  } catch {
    return false;
  }
}

export function isDevelopmentRuntimeCurrent(input) {
  const marker = input.marker;
  return (
    marker !== null &&
    typeof marker === 'object' &&
    marker.schemaVersion === input.schemaVersion &&
    marker.electronVersion === input.electronVersion &&
    marker.bundleId === input.bundleId &&
    marker.desktopDir === input.desktopDir &&
    input.signatureValid
  );
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
