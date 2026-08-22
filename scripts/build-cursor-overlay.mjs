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

// Build the cursor overlay renderer bundle + preload into apps/desktop/dist/overlay.
// - cursor-overlay.js: the Canvas engine host (IIFE, browser). The `js→ts` resolve
//   shim lets us bundle the engine's NodeNext `./x.js` imports straight from source.
// - cursor-overlay-preload.cjs: receive-only main→renderer bridge (CJS, electron external).
// - cursor-overlay.html: copied verbatim.
import * as esbuild from 'esbuild';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, copyFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..', 'apps', 'desktop');
const srcOverlay = join(desktop, 'src', 'overlay');
const outDir = join(desktop, 'dist', 'overlay');

const jsToTs = {
  name: 'js-to-ts',
  setup(build) {
    build.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts')),
    }));
  },
};

/** Build the overlay renderer bundle + preload + html into dist/overlay. */
export async function buildCursorOverlay({ logLevel = 'info' } = {}) {
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [join(srcOverlay, 'cursor-overlay.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    outfile: join(outDir, 'cursor-overlay.js'),
    plugins: [jsToTs],
    logLevel,
  });
  await esbuild.build({
    entryPoints: [join(srcOverlay, 'cursor-overlay-preload.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['electron'],
    outfile: join(outDir, 'cursor-overlay-preload.cjs'),
    logLevel,
  });
  await copyFile(join(srcOverlay, 'cursor-overlay.html'), join(outDir, 'cursor-overlay.html'));
  await buildPermissionOverlay({ logLevel });
  await buildComputerUsePip({ logLevel });
  return outDir;
}

/**
 * The Computer Use picture-in-picture mirror. Same shape as the cursor overlay
 * — module page bundle + CJS preload + verbatim html — sharing `dist/overlay`
 * so one `build:overlay` step covers all three panels.
 *
 * Its preload is receive-only and narrower than the cursor overlay's: the
 * mirror displays frames main hands it and has nothing to report back.
 */
export async function buildComputerUsePip({ logLevel = 'info' } = {}) {
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [join(srcOverlay, 'pip.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    outfile: join(outDir, 'pip.js'),
    plugins: [jsToTs],
    logLevel,
  });
  await esbuild.build({
    entryPoints: [join(srcOverlay, 'pip-preload.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['electron'],
    outfile: join(outDir, 'pip-preload.cjs'),
    logLevel,
  });
  await copyFile(join(srcOverlay, 'pip.html'), join(outDir, 'pip.html'));
  return outDir;
}

/**
 * The drag-to-grant permission card. Same shape as the cursor overlay —
 * IIFE page bundle + CJS preload + verbatim html — and it shares
 * `dist/overlay`, so one `build:overlay` step covers both panels.
 *
 * Unlike the cursor overlay this page IS interactive (the user grabs the
 * row out of it), so its preload is send-capable; see the preload source
 * for what it is allowed to say.
 */
export async function buildPermissionOverlay({ logLevel = 'info' } = {}) {
  await mkdir(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [join(srcOverlay, 'permission-overlay.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    outfile: join(outDir, 'permission-overlay.js'),
    plugins: [jsToTs],
    logLevel,
  });
  await esbuild.build({
    entryPoints: [join(srcOverlay, 'permission-overlay-preload.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['electron'],
    outfile: join(outDir, 'permission-overlay-preload.cjs'),
    logLevel,
  });
  await copyFile(
    join(srcOverlay, 'permission-overlay.html'),
    join(outDir, 'permission-overlay.html'),
  );
  return outDir;
}

// Run directly (npm run build:overlay) or import buildCursorOverlay (dev.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = await buildCursorOverlay();
  console.log('overlays built →', dir);
}
