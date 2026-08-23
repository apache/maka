#!/usr/bin/env node
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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { build as esbuildBuild } from 'esbuild';
import { buildCursorOverlay } from '../../../scripts/build-cursor-overlay.mjs';
import { monitorDevelopmentApp, startDevelopmentApp } from './dev-app-runtime.mjs';

const DESKTOP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT    = resolve(DESKTOP_DIR, '..', '..');
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

let app = null;
let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await app?.stop();
  await server.close().catch(() => {});
  process.exit(code);
}

// Registered before the launch await: preparing the bundle can take a codesign
// rebuild, and a signal arriving with no handler installed takes the default
// action, leaving the dev server and any app behind.
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
// Closing the terminal window sends SIGHUP; without this the detached bundle
// survives as an orphan holding the single-instance lock.
process.on('SIGHUP', () => shutdown(0));

app = await startDevelopmentApp({ argv: process.argv.slice(2), viteUrl: devUrl });
if (app.isMacosBundle) log('electron', 'launched Maka Dev.app through LaunchServices');

app.child.on('error', (err) => {
  console.error(`[dev] failed to start Electron: ${err.message}`);
  shutdown(1);
});
if (app.isMacosBundle) {
  // `open` exits 0 at the handoff, so only a failure to hand off is news here;
  // the app's own lifetime is what the monitor reports.
  app.child.on('exit', (code) => {
    if (code) shutdown(code);
  });
  monitorDevelopmentApp({ stopped: () => shuttingDown }).then((outcome) => {
    if (outcome === 'never-started') {
      console.error('[dev] Maka Dev.app did not start (see the output above)');
      shutdown(1);
    } else if (outcome === 'exited') {
      log('electron', 'Maka Dev.app quit');
      shutdown(0);
    }
  });
} else {
  app.child.on('exit', (code) => shutdown(code ?? 0));
}
