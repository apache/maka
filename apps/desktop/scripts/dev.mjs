#!/usr/bin/env node
/**
 * Dev launcher with PARALLEL + INCREMENTAL builds.
 *
 * Uses `tsc --build` for library packages so the compiler skips
 * unchanged sub-projects via .tsbuildinfo (incremental).
 *
 * Dependency graph (→ compiles after):
 *   core ─┬→ storage
 *         ├→ runtime
 *         └→ ui
 *
 *   libs (tsc --build tsconfig.lib.json) ─── covers core+storage+runtime+ui
 *     ├─→ preload (esbuild)
 *     └─→ filesystem worker (esbuild)
 *   cursor overlay (esbuild)              ─── independent
 *   main (esbuild)                        ─── fast app bundle for Electron
 *   Vite dev server + Electron            ─── fork
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { build as esbuildBuild } from 'esbuild';
import { buildCursorOverlay } from '../../../scripts/build-cursor-overlay.mjs';
import {
  clearDevelopmentSession,
  createDevelopmentSession,
  quitMacosDevelopmentApp,
  recoverStaleDevelopmentSession,
  resolveMacosDevelopmentLaunch,
  waitForMacosDevelopmentApp,
  writeDevelopmentSession,
} from './dev-app-runtime.mjs';

const DESKTOP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT    = resolve(DESKTOP_DIR, '..', '..');
const ON_WINDOWS   = process.platform === 'win32';
const TSC_CLI      = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const RUNTIME_WORKER_BUILD = join(REPO_ROOT, 'packages', 'runtime', 'scripts', 'build-filesystem-worker.mjs');

// ── helpers ──────────────────────────────────────────────────────────────────

function log(label, msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}][${label}] ${msg}`);
}

function runNodeTool(dir, script, args) {
  return new Promise((resolve_, reject_) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: dir,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => {
      if (code === 0) resolve_();
      else reject_(new Error(`"${script} ${args.join(' ')}" exited with code ${code}`));
    });
    child.on('error', reject_);
  });
}

function resolveElectronBin() {
  for (let dir = DESKTOP_DIR; ; dir = dirname(dir)) {
    const exe = ON_WINDOWS
      ? join(dir, 'node_modules', 'electron', 'dist', 'electron.exe')
      : join(dir, 'node_modules', '.bin', 'electron');
    if (existsSync(exe)) return exe;
    if (dirname(dir) === dir) return 'electron';
  }
}

// ── build phases ─────────────────────────────────────────────────────────────

const TIMER_START = Date.now();

// Phase 1: all library packages via `tsc --build` (single process, shared
// .tsbuildinfo, sub-project incremental detection). The preload bundle imports
// workspace package dist files, so it starts only after that build is ready.
log('build', 'libraries — starting (tsc --build)');
const librariesBuild = runNodeTool(REPO_ROOT, TSC_CLI, ['--build', 'tsconfig.lib.json']).then(
  () => log('build', 'libraries (all) — done'),
  (e) => {
    log('build', `libraries — FAILED: ${e.message}`);
    throw e;
  },
);
await Promise.all([
  librariesBuild,
  librariesBuild.then(() => runNodeTool(REPO_ROOT, RUNTIME_WORKER_BUILD, [])).then(
    () => log('build', 'filesystem worker bundle — done'),
    (e) => { log('build', `filesystem worker bundle — FAILED: ${e.message}`); throw e; },
  ),
  // esbuild via its JS API — NOT `node node_modules/esbuild/bin/esbuild`:
  // esbuild's postinstall swaps that file for a platform-native binary,
  // and executing a Mach-O file with node throws SyntaxError (broke
  // `npm run dev` on any machine where postinstall ran).
  librariesBuild.then(() => esbuildBuild({
    absWorkingDir: DESKTOP_DIR,
    entryPoints: ['src/preload/preload.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'dist/preload/preload.cjs',
    external: ['electron'],
    logLevel: 'warning',
  })).then(
    () => log('build', 'preload — done'),
    (e) => { log('build', `preload — FAILED: ${e.message}`); throw e; },
  ),
  buildCursorOverlay({ logLevel: 'warning' }).then(
    () => log('build', 'cursor overlay — done'),
    (e) => { log('build', `cursor overlay — FAILED: ${e.message}`); throw e; },
  ),
]);

// Phase 2: main — esbuild bundle for dev startup. The full
// tsconfig.main.json still compiles tests for `npm test` and typechecks
// main-process code in verification commands.
log('build', 'main — starting');
await esbuildBuild({
  absWorkingDir: DESKTOP_DIR,
  entryPoints: ['src/main/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: 'dist/main/main.js',
  external: ['electron'],
  logLevel: 'warning',
});
log('build', 'main — done');

const BUILD_MS = Date.now() - TIMER_START;
log('build', `all builds finished in ${(BUILD_MS / 1000).toFixed(1)}s`);

// ── Vite dev server + Electron ───────────────────────────────────────────────

process.chdir(DESKTOP_DIR);
log('vite', 'starting dev server...');
const server = await createServer();
await server.listen();
server.printUrls();

const devUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '');
if (!devUrl) {
  console.error('[dev] vite did not report a local URL; aborting.');
  await server.close();
  process.exit(1);
}

log('electron', `launching against ${devUrl} (renderer HMR live)`);
const appArgs = [DESKTOP_DIR, ...process.argv.slice(2)];
const macosLaunch = await resolveMacosDevelopmentLaunch();
if (macosLaunch) {
  await recoverStaleDevelopmentSession();
  const userDataArg = process.argv.slice(2).find((arg) => arg.startsWith('--user-data-dir='));
  writeDevelopmentSession(createDevelopmentSession({
    supervisorPid: process.pid,
    viteUrl: devUrl,
    env: process.env,
    userDataDir: userDataArg?.slice('--user-data-dir='.length),
    electronArgs: process.argv.slice(2).filter((arg) => !arg.startsWith('--user-data-dir=')),
  }));
}
const electron = spawn(macosLaunch?.command ?? resolveElectronBin(), macosLaunch?.args ?? appArgs, {
  cwd: DESKTOP_DIR,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
});

let shuttingDown = false;
async function shutdown(code, options = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (macosLaunch) {
    await quitMacosDevelopmentApp();
    clearDevelopmentSession();
  }
  if (options.killElectron !== false) {
    await terminateProcessTree(electron);
  }
  await server.close().catch(() => {});
  process.exit(code);
}

function terminateProcessTree(child) {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  if (ON_WINDOWS && child.pid) {
    return new Promise((resolve_) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      killer.on('exit', () => resolve_());
      killer.on('error', () => resolve_());
    });
  }
  child.kill('SIGTERM');
  return Promise.resolve();
}

if (!macosLaunch) {
  electron.on('exit', (code) => shutdown(code ?? 0, { killElectron: false }));
} else {
  electron.on('exit', (code) => {
    if (code && code !== 0) shutdown(code, { killElectron: false });
  });
}
electron.on('error', (err) => {
  console.error(`[dev] failed to start Electron: ${err.message}`);
  shutdown(1);
});
if (macosLaunch) {
  void waitForMacosDevelopmentApp().then(
    () => log('electron', 'Maka Dev startup handshake complete'),
    (error) => {
      console.error(`[dev] ${error.message}`);
      shutdown(1);
    },
  );
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
