import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(DESKTOP_DIR, '..', '..');
const DEV_RUNTIME_DIR = join(DESKTOP_DIR, '.maka-dev');
const DEV_APP = join(DEV_RUNTIME_DIR, 'Maka Dev.app');
const DEV_EXECUTABLE = join(DEV_APP, 'Contents', 'MacOS', 'Electron');
const MARKER = join(DEV_RUNTIME_DIR, 'runtime.json');
const ELECTRON_PACKAGE = join(REPO_ROOT, 'node_modules', 'electron', 'package.json');
const SOURCE_APP = join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');

const DEV_BUNDLE_ID = 'com.maka.dev';
const RUNTIME_SCHEMA_VERSION = 1;

export function resolveMacosDevelopmentLaunch(appArgs, env = {}) {
  if (process.platform !== 'darwin') return null;
  const appPath = prepareDevelopmentApp();
  return createMacosDevelopmentLaunch(appPath, appArgs, env);
}

export function createMacosDevelopmentLaunch(appPath, appArgs, env = {}) {
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
      ...appArgs,
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

  rmSync(DEV_RUNTIME_DIR, { recursive: true, force: true });
  run('mkdir', ['-p', DEV_RUNTIME_DIR]);
  run('ditto', [SOURCE_APP, DEV_APP]);

  const plist = join(DEV_APP, 'Contents', 'Info.plist');
  replacePlistValue(plist, 'CFBundleIdentifier', DEV_BUNDLE_ID);
  replacePlistValue(plist, 'CFBundleName', 'Maka Dev');
  replacePlistValue(plist, 'CFBundleDisplayName', 'Maka Dev');
  // `ditto` does not copy quarantine metadata by default. Clear any root-level
  // attribute without relying on the newer recursive `xattr -r` flag, which
  // is unavailable on older supported macOS releases.
  run('xattr', ['-c', DEV_APP]);
  run('codesign', ['--force', '--deep', '--sign', '-', '--identifier', DEV_BUNDLE_ID, DEV_APP]);
  run('codesign', ['--verify', '--deep', '--strict', DEV_APP]);

  writeFileSync(
    MARKER,
    `${JSON.stringify({ schemaVersion: RUNTIME_SCHEMA_VERSION, electronVersion, bundleId: DEV_BUNDLE_ID }, null, 2)}\n`,
  );
  return DEV_APP;
}

function isCurrentRuntime(electronVersion) {
  if (!existsSync(DEV_EXECUTABLE) || !existsSync(MARKER)) return false;
  try {
    const marker = JSON.parse(readFileSync(MARKER, 'utf8'));
    if (
      (marker.schemaVersion ?? 1) !== RUNTIME_SCHEMA_VERSION ||
      marker.electronVersion !== electronVersion ||
      marker.bundleId !== DEV_BUNDLE_ID
    ) {
      return false;
    }
    return spawnSync('codesign', ['--verify', '--deep', '--strict', DEV_APP]).status === 0;
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
