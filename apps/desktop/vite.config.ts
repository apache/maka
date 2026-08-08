import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import react from '@vitejs/plugin-react';

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
const PATCHES_DIR = resolve(REPO_ROOT, 'patches');
const patchesHash = createHash('sha256');
for (const file of readdirSync(PATCHES_DIR).filter(file => file.endsWith('.patch')).sort()) {
  patchesHash.update(file).update('\0').update(readFileSync(resolve(PATCHES_DIR, file)));
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  // Vite hashes plugin names into its dependency-cache key. patch-package does
  // not change package-lock.json, so carry the patch contents in that key while
  // keeping every Astryx entry in one optimized module graph.
  plugins: [react(), { name: `maka-dependency-patches-${patchesHash.digest('hex')}` }],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@maka/ui/icons', replacement: resolve(UI_SRC, 'icons.tsx') },
      { find: '@maka/ui/artifact-preview-registry', replacement: resolve(UI_SRC, 'artifact-preview-registry.ts') },
      { find: '@maka/ui/assistant-stream', replacement: resolve(UI_SRC, 'assistant-stream.ts') },
      { find: '@maka/ui/maka-uri', replacement: resolve(UI_SRC, 'maka-uri.ts') },
      { find: /^@maka\/ui$/, replacement: resolve(UI_SRC, 'index.ts') },
    ],
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
