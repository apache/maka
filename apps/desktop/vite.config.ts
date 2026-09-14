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

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { dependencyPatchesCachePlugin } from './vite-dependency-patches.js';
import { bundledNpmPackagesPlugin } from './vite-bundled-packages.js';
import { rendererEntryContractPlugin } from './scripts/vite-renderer-entry-contract.js';
import { workspacePackagesPlugin } from './vite-workspace-packages.js';

/**
 * PR-ICONS-FULL-REPLACE-0 (WAWQAQ msg `60064e2d` 2026-06-24): point the
 * renderer at `@maka/ui` SOURCE, not its prebuilt dist. Before this,
 * Node resolution sent `@maka/ui` to `packages/ui/dist/index.js`; if
 * that dist was stale (built before an icon-library swap), the home
 * page would still render the old icon set even though source had
 * migrated. Aliasing to src makes the renderer source-of-truth single
 * — no more "rebuilt source but UI still old" foot-gun.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const UI_SRC = resolve(REPO_ROOT, 'packages/ui/src');

export default defineConfig({
  root: 'src/renderer',
  base: './',
  // Vite hashes plugin names into its dependency-cache key. patch-package does
  // not change package-lock.json, so carry the patch contents in that key while
  // keeping every Astryx entry in one optimized module graph.
  plugins: [
    react(),
    dependencyPatchesCachePlugin(REPO_ROOT),
    workspacePackagesPlugin(REPO_ROOT),
    bundledNpmPackagesPlugin(),
    rendererEntryContractPlugin(resolve(import.meta.dirname, 'src/renderer')),
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      // Web-only: the full-client boot (`platform/web/web-boot.ts`) executes
      // the real preload bridge source in the browser, where `electron`
      // resolves to a WebSocket-backed shim. The Electron renderer never
      // imports `electron` (verified: no other importer), so this alias is
      // inert there — it only fires inside the lazily-loaded web chunk.
      { find: /^electron$/, replacement: resolve(REPO_ROOT, 'apps/desktop/src/renderer/platform/web/electron-shim.ts') },
      { find: '@maka/ui/icons', replacement: resolve(UI_SRC, 'icons.tsx') },
      { find: '@maka/ui/artifact-preview-registry', replacement: resolve(UI_SRC, 'artifact-preview-registry.ts') },
      { find: '@maka/ui/assistant-stream', replacement: resolve(UI_SRC, 'assistant-stream.ts') },
      { find: '@maka/ui/maka-uri', replacement: resolve(UI_SRC, 'maka-uri.ts') },
      { find: /^@maka\/ui$/, replacement: resolve(UI_SRC, 'index.ts') },
    ],
  },
  server: {
    // Tailscale Serve forwards `Host: *.ts.net` to loopback Vite. Allow that
    // without binding 0.0.0.0 — Maka stays on 127.0.0.1.
    allowedHosts: ['.ts.net', 'localhost'],
    // `maka-web` (Chrome/Brave): the local directory API (scripts/maka-web-api.mjs,
    // default 127.0.0.1:5174) is proxied same-origin so the browser page needs
    // no extra CSP origin and no CORS preflight. Applies to both `dev.mjs` and
    // `dev-web.mjs` servers since they share this config — GUI and web can run
    // side by side on one renderer URL.
    proxy: {
      '/api': { target: 'http://127.0.0.1:5174', changeOrigin: true },
      // `/bridge` is owned by attachWebGateway (session cookie → disk token).
      // Do not proxy it here or the upgrade handler never wins.
    },
  },
  build: {
    // Renderer bundle lives in dist-renderer (sibling of dist), separate from
    // dist/renderer. dist/renderer holds tsc side-files that build:main emits
    // for helpers imported by main/__tests__; emptyOutDir:true clears only
    // dist-renderer, leaving those side-files intact. See check-stale-dist.mjs.
    outDir: '../../dist-renderer',
    emptyOutDir: true,
    // Electron 43 embeds Chromium 150. Preserve native light-dark() so Astryx
    // tokens resolve against the nearest Theme color-scheme; downleveling the
    // function computes both branches at :root before that scope is known.
    cssTarget: 'chrome150',
  },
});
