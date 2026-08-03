import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPackage } from '@electron/asar';

const DESKTOP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(DESKTOP_DIR, '..', '..');
const DEV_RUNTIME_DIR = join(DESKTOP_DIR, '.maka-dev');
const DEV_APP = join(DEV_RUNTIME_DIR, 'Maka Dev.app');
const DEV_EXECUTABLE = join(DEV_APP, 'Contents', 'MacOS', 'Electron');
const DEV_USER_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Maka Dev');
const MARKER = join(DEV_RUNTIME_DIR, 'runtime.json');
const SESSION_FILE = join(DEV_RUNTIME_DIR, 'session.json');
const APP_PID_FILE = join(DEV_RUNTIME_DIR, 'app.pid');
const RUNTIME_LOCK = `${DEV_RUNTIME_DIR}.lock`;
const ELECTRON_PACKAGE = join(REPO_ROOT, 'node_modules', 'electron', 'package.json');
const SOURCE_APP = join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');

const DEV_BUNDLE_ID = 'com.maka.dev';
const RUNTIME_SCHEMA_VERSION = 4;
const SESSION_SCHEMA_VERSION = 1;

export async function resolveMacosDevelopmentLaunch() {
  if (!shouldUseMacosDevelopmentApp(process.platform)) return null;
  const appPath = await prepareDevelopmentApp();
  return createMacosDevelopmentLaunch(appPath);
}

export function shouldUseMacosDevelopmentApp(platform) {
  return platform === 'darwin';
}

export function createMacosDevelopmentLaunch(appPath) {
  return {
    command: 'open',
    // LaunchServices must own process launch so macOS TCC attributes the
    // running executable to Maka Dev rather than to its parent terminal.
    args: [
      '-n',
      '-a',
      appPath,
    ],
  };
}

export async function quitMacosDevelopmentApp() {
  if (process.platform !== 'darwin' || !existsSync(APP_PID_FILE)) return false;
  let appProcess;
  try {
    appProcess = JSON.parse(readFileSync(APP_PID_FILE, 'utf8'));
  } catch {
    return false;
  }
  if (appProcess.supervisorPid !== process.pid) return false;
  const pid = appProcess.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  await new Promise((resolve_) => setTimeout(resolve_, 500));
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Exited between the liveness check and fallback signal.
    }
  }
  return true;
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
  const releaseLock = acquirePidLock(RUNTIME_LOCK);

  try {
    // Another process may have completed preparation before this lock landed.
    if (isCurrentRuntime(electronVersion)) return DEV_APP;
    await rebuildDevelopmentRuntime({
      reset: () => {
        rmSync(DEV_RUNTIME_DIR, { recursive: true, force: true });
        run('mkdir', ['-p', DEV_RUNTIME_DIR]);
      },
      build: async () => {
        run('ditto', [SOURCE_APP, DEV_APP]);
        const plist = join(DEV_APP, 'Contents', 'Info.plist');
        replacePlistValue(plist, 'CFBundleIdentifier', DEV_BUNDLE_ID);
        replacePlistValue(plist, 'CFBundleName', 'Maka Dev');
        replacePlistValue(plist, 'CFBundleDisplayName', 'Maka Dev');
        await installRelaunchBootstrap();
        // `ditto` does not copy quarantine metadata by default. Clear any root-level
        // attribute without relying on the newer recursive `xattr -r` flag, which
        // is unavailable on older supported macOS releases.
        run('xattr', ['-c', DEV_APP]);
        run('codesign', [
          '--force',
          '--deep',
          '--sign',
          '-',
          '--identifier',
          DEV_BUNDLE_ID,
          DEV_APP,
        ]);
        run('codesign', ['--verify', '--deep', '--strict', DEV_APP]);
      },
      writeMarker: () => {
        writeFileSync(
          MARKER,
          `${JSON.stringify({ schemaVersion: RUNTIME_SCHEMA_VERSION, electronVersion, bundleId: DEV_BUNDLE_ID }, null, 2)}\n`,
        );
      },
    });
  } finally {
    releaseLock();
  }
  return DEV_APP;
}

async function installRelaunchBootstrap() {
  const bootstrapDir = join(DEV_RUNTIME_DIR, 'relaunch-bootstrap');
  mkdirSync(bootstrapDir, { recursive: true });
  writeFileSync(
    join(bootstrapDir, 'package.json'),
    `${JSON.stringify({ name: 'maka-dev-relaunch', main: 'main.cjs', private: true })}\n`,
  );
  writeFileSync(
    join(bootstrapDir, 'main.cjs'),
    createRelaunchBootstrapSource(
      DESKTOP_DIR,
      DEV_USER_DATA_DIR,
      SESSION_FILE,
      APP_PID_FILE,
    ),
  );
  await createPackage(
    bootstrapDir,
    join(DEV_APP, 'Contents', 'Resources', 'default_app.asar'),
  );
  rmSync(bootstrapDir, { recursive: true, force: true });
}

export function createRelaunchBootstrapSource(
  desktopDir,
  defaultUserDataDir,
  sessionFile = SESSION_FILE,
  appPidFile = APP_PID_FILE,
) {
  return [
    "const { app } = require('electron');",
    "const { join } = require('node:path');",
    "const { pathToFileURL } = require('node:url');",
    `const desktopDir = ${JSON.stringify(desktopDir)};`,
    `const defaultUserDataDir = ${JSON.stringify(defaultUserDataDir)};`,
    `const sessionFile = ${JSON.stringify(sessionFile)};`,
    `const appPidFile = ${JSON.stringify(appPidFile)};`,
    "let session = null;",
    "try {",
    "  const candidate = JSON.parse(require('node:fs').readFileSync(sessionFile, 'utf8'));",
    "  process.kill(candidate.supervisorPid, 0);",
    `  if (candidate.schemaVersion === ${SESSION_SCHEMA_VERSION}) session = candidate;`,
    "} catch {}",
    "if (session?.env) Object.assign(process.env, session.env);",
    "const userDataDir = session?.userDataDir || defaultUserDataDir;",
    'app.setAppPath(desktopDir);',
    "app.setPath('userData', userDataDir);",
    "require('node:fs').writeFileSync(appPidFile, `${JSON.stringify({ pid: process.pid, supervisorPid: session?.supervisorPid })}\n`, { mode: 0o600 });",
    'process.chdir(desktopDir);',
    "import(pathToFileURL(join(desktopDir, 'dist/main/main.js')).href).catch((error) => {",
    "  console.error('[maka-dev] relaunch bootstrap failed', error);",
    '  app.exit(1);',
    '});',
    '',
  ].join('\n');
}

export function createDevelopmentSession(input) {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    supervisorPid: input.supervisorPid,
    userDataDir: input.userDataDir ?? DEV_USER_DATA_DIR,
    env: selectDevelopmentEnvironment(input.env, input.viteUrl),
  };
}

export function selectDevelopmentEnvironment(env, viteUrl) {
  const selected = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (isAllowedDevelopmentEnvironmentKey(key)) selected[key] = value;
  }
  if (viteUrl) selected.VITE_DEV_SERVER_URL = viteUrl;
  return selected;
}

export function writeDevelopmentSession(session) {
  mkdirSync(DEV_RUNTIME_DIR, { recursive: true });
  if (existsSync(SESSION_FILE)) {
    try {
      const current = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
      if (current.supervisorPid !== process.pid && isProcessAlive(current.supervisorPid)) {
        throw new Error(`Maka Dev session is already supervised by PID ${current.supervisorPid}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('already supervised')) throw error;
      // Corrupt or stale sessions are replaced atomically below.
    }
  }
  const temporary = `${SESSION_FILE}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, SESSION_FILE);
}

export function clearDevelopmentSession(supervisorPid = process.pid) {
  try {
    const current = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
    if (current.supervisorPid === supervisorPid) unlinkSync(SESSION_FILE);
  } catch {}
}

function isAllowedDevelopmentEnvironmentKey(key) {
  return (
    key.startsWith('MAKA_') ||
    key.startsWith('CUA_') ||
    [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'TAVILY_API_KEY',
      'COPILOT_GITHUB_TOKEN',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'PATH',
      'PYTHONPATH',
      'SHELL',
      'NODE_ENV',
      'NO_COLOR',
      'COLORTERM',
      'TERM',
    ].includes(key)
  );
}

function isCurrentRuntime(electronVersion) {
  if (!existsSync(DEV_EXECUTABLE) || !existsSync(MARKER)) return false;
  try {
    const marker = JSON.parse(readFileSync(MARKER, 'utf8'));
    return isDevelopmentRuntimeCurrent({
      marker,
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      electronVersion,
      bundleId: DEV_BUNDLE_ID,
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
    input.signatureValid
  );
}

export async function rebuildDevelopmentRuntime(deps) {
  await deps.reset();
  await deps.build();
  // The marker is the cache commit point. Never write it until copying,
  // bootstrap generation, signing, and strict signature verification succeed.
  await deps.writeMarker();
}

function acquirePidLock(path) {
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = 0;
    try {
      owner = Number(readFileSync(path, 'utf8').trim());
    } catch {}
    if (Number.isSafeInteger(owner) && owner > 0 && isProcessAlive(owner)) {
      throw new Error(`Maka Dev runtime preparation is already running in PID ${owner}`);
    }
    rmSync(path, { force: true });
    return acquirePidLock(path);
  }
  return () => rmSync(path, { force: true });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function replacePlistValue(plist, key, value) {
  const result = spawnSync('plutil', ['-replace', key, '-string', value, plist], {
    encoding: 'utf8',
  });
  if (result.status === 0) return;
  run('plutil', ['-insert', key, '-string', value, plist]);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.status === 0) return;
  const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
  throw new Error(`${command} failed: ${detail}`);
}

export const developmentAppPath = DEV_APP;
