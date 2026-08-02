import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(DESKTOP_DIR, '..', '..');
const DEV_RUNTIME_DIR = join(DESKTOP_DIR, '.maka-dev');
const DEV_APP = join(DEV_RUNTIME_DIR, 'Maka Dev.app');
const DEV_EXECUTABLE = join(DEV_APP, 'Contents', 'MacOS', 'Electron');
const DEV_USER_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Maka Dev');
const MARKER = join(DEV_RUNTIME_DIR, 'runtime.json');
const ELECTRON_PACKAGE = join(REPO_ROOT, 'node_modules', 'electron', 'package.json');
const SOURCE_APP = join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');

const DEV_BUNDLE_ID = 'com.maka.dev';
const RUNTIME_SCHEMA_VERSION = 3;

export function resolveMacosDevelopmentLaunch(appArgs, env = {}) {
  if (process.platform !== 'darwin') return null;
  const appPath = prepareDevelopmentApp();
  return createMacosDevelopmentLaunch(appPath, appArgs, env);
}

export function createMacosDevelopmentLaunch(
  appPath,
  appArgs,
  env = {},
  userDataDir = DEV_USER_DATA_DIR,
) {
  const launchEnvironment = [];
  if (env.VITE_DEV_SERVER_URL) {
    launchEnvironment.push('--env', `VITE_DEV_SERVER_URL=${env.VITE_DEV_SERVER_URL}`);
  }
  return {
    command: 'open',
    // LaunchServices must own process launch so macOS TCC attributes the
    // running executable to Maka Dev rather than to its parent terminal.
    args: [
      '-n',
      '-W',
      ...launchEnvironment,
      '-a',
      appPath,
      '--args',
      ...withDevelopmentUserData(appArgs, userDataDir),
    ],
  };
}

export function quitMacosDevelopmentApp() {
  if (process.platform !== 'darwin') return;
  spawnSync('osascript', ['-e', `tell application id "${DEV_BUNDLE_ID}" to quit`], {
    stdio: 'ignore',
  });
}

export function prepareDevelopmentApp() {
  if (process.platform !== 'darwin') {
    throw new Error('Maka Dev.app is only available on macOS');
  }
  if (!existsSync(SOURCE_APP)) {
    throw new Error(`Electron.app is missing at ${SOURCE_APP}; run npm install first`);
  }

  const electronVersion = JSON.parse(readFileSync(ELECTRON_PACKAGE, 'utf8')).version;
  if (isCurrentRuntime(electronVersion)) return DEV_APP;

  rebuildDevelopmentRuntime({
    reset: () => {
      rmSync(DEV_RUNTIME_DIR, { recursive: true, force: true });
      run('mkdir', ['-p', DEV_RUNTIME_DIR]);
    },
    build: () => {
      run('ditto', [SOURCE_APP, DEV_APP]);
      const plist = join(DEV_APP, 'Contents', 'Info.plist');
      replacePlistValue(plist, 'CFBundleIdentifier', DEV_BUNDLE_ID);
      replacePlistValue(plist, 'CFBundleName', 'Maka Dev');
      replacePlistValue(plist, 'CFBundleDisplayName', 'Maka Dev');
      installRelaunchBootstrap();
      // `ditto` does not copy quarantine metadata by default. Clear any root-level
      // attribute without relying on the newer recursive `xattr -r` flag, which
      // is unavailable on older supported macOS releases.
      run('xattr', ['-c', DEV_APP]);
      run('codesign', ['--force', '--deep', '--sign', '-', '--identifier', DEV_BUNDLE_ID, DEV_APP]);
      run('codesign', ['--verify', '--deep', '--strict', DEV_APP]);
    },
    writeMarker: () => {
      writeFileSync(
        MARKER,
        `${JSON.stringify({ schemaVersion: RUNTIME_SCHEMA_VERSION, electronVersion, bundleId: DEV_BUNDLE_ID }, null, 2)}\n`,
      );
    },
  });
  return DEV_APP;
}

function installRelaunchBootstrap() {
  const bootstrapDir = join(DEV_RUNTIME_DIR, 'relaunch-bootstrap');
  mkdirSync(bootstrapDir, { recursive: true });
  writeFileSync(
    join(bootstrapDir, 'package.json'),
    `${JSON.stringify({ name: 'maka-dev-relaunch', main: 'main.cjs', private: true })}\n`,
  );
  writeFileSync(
    join(bootstrapDir, 'main.cjs'),
    createRelaunchBootstrapSource(DESKTOP_DIR, DEV_USER_DATA_DIR),
  );
  const asarCli = join(REPO_ROOT, 'node_modules', '.bin', 'asar');
  run(asarCli, [
    'pack',
    bootstrapDir,
    join(DEV_APP, 'Contents', 'Resources', 'default_app.asar'),
  ]);
  rmSync(bootstrapDir, { recursive: true, force: true });
}

export function createRelaunchBootstrapSource(desktopDir, userDataDir) {
  return [
    "const { app } = require('electron');",
    "const { join } = require('node:path');",
    "const { pathToFileURL } = require('node:url');",
    `const desktopDir = ${JSON.stringify(desktopDir)};`,
    `const userDataDir = ${JSON.stringify(userDataDir)};`,
    'app.setAppPath(desktopDir);',
    "app.setPath('userData', userDataDir);",
    'process.chdir(desktopDir);',
    "import(pathToFileURL(join(desktopDir, 'dist/main/main.js')).href).catch((error) => {",
    "  console.error('[maka-dev] relaunch bootstrap failed', error);",
    '  app.exit(1);',
    '});',
    '',
  ].join('\n');
}

function withDevelopmentUserData(appArgs, userDataDir) {
  if (appArgs.some((arg) => arg.startsWith('--user-data-dir='))) return appArgs;
  return [...appArgs, `--user-data-dir=${userDataDir}`];
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

export function rebuildDevelopmentRuntime(deps) {
  deps.reset();
  deps.build();
  // The marker is the cache commit point. Never write it until copying,
  // bootstrap generation, signing, and strict signature verification succeed.
  deps.writeMarker();
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
