#!/usr/bin/env node
/**
 * Coverage gate: every product surface file on disk appears in
 * docs/astryx-surface-file-inventory.paths (and vice versa).
 * Uses the same enumeration as generate-astryx-surface-inventory.mjs.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const pathsFile = join(root, 'docs/astryx-surface-file-inventory.paths');
const mdFile = join(root, 'docs/astryx-surface-file-inventory.md');

// Import shared enumerator by running generate's export via dynamic import
const genUrl = pathToFileURL(join(root, 'scripts/generate-astryx-surface-inventory.mjs')).href;

async function main() {
  if (!existsSync(pathsFile) || !existsSync(mdFile)) {
    console.error(
      'missing inventory artifacts — run: node scripts/generate-astryx-surface-inventory.mjs',
    );
    process.exit(1);
  }

  // Re-run generator's list logic without rewriting: dynamic import of module
  // that calls main() on load — so import the file by reading list from a
  // subprocess that only prints paths, OR re-implement via spawning generate
  // and comparing. Safest: import after making generate not auto-main.
  const { listProductSurfaceFiles } = await import(genUrl);
  if (typeof listProductSurfaceFiles !== 'function') {
    console.error('generate-astryx-surface-inventory.mjs must export listProductSurfaceFiles');
    process.exit(1);
  }

  const { files: diskFiles, excluded } = listProductSurfaceFiles(root);
  const listed = readFileSync(pathsFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const diskSet = new Set(diskFiles);
  const listSet = new Set(listed);

  const missing = diskFiles.filter((f) => !listSet.has(f));
  const extra = listed.filter((f) => !diskSet.has(f));

  const md = readFileSync(mdFile, 'utf8');
  const mdMissing = [];
  for (const f of diskFiles) {
    if (!md.includes(`\`${f}\``)) mdMissing.push(f);
  }

  // Required dedicated entries (acceptance)
  const required = [
    'apps/desktop/src/renderer/settings/general-settings-page.tsx',
    'apps/desktop/src/renderer/settings/settings-modal.tsx',
    'packages/ui/src/skills-panel.tsx',
    'apps/desktop/src/renderer/mcp-page.tsx',
    'packages/ui/src/scheduled-task-panel.tsx',
    'packages/ui/src/daily-review-panel.tsx',
    'packages/ui/src/primitives/module-page.tsx',
  ];
  const requiredMissing = required.filter((f) => !listSet.has(f) || !md.includes(`\`${f}\``));

  // No family-batch claim without per-file rows: inventory must not use old batch prose
  if (
    /General, Appearance, Data, Providers/.test(md) &&
    !md.includes('general-settings-page.tsx')
  ) {
    console.error('inventory still uses family-batch claims without per-file rows');
    process.exit(1);
  }

  const failures = [];
  if (missing.length)
    failures.push(
      `on disk but not in .paths (${missing.length}):\n  ${missing.slice(0, 20).join('\n  ')}`,
    );
  if (extra.length)
    failures.push(
      `in .paths but not on disk (${extra.length}):\n  ${extra.slice(0, 20).join('\n  ')}`,
    );
  if (mdMissing.length) {
    failures.push(
      `on disk but not a markdown row (${mdMissing.length}):\n  ${mdMissing.slice(0, 20).join('\n  ')}`,
    );
  }
  if (requiredMissing.length) {
    failures.push(`required surfaces missing:\n  ${requiredMissing.join('\n  ')}`);
  }

  if (failures.length) {
    console.error(
      `astryx surface inventory coverage failed:\n${failures.map((f) => `- ${f}`).join('\n')}`,
    );
    process.exit(1);
  }

  console.log(
    `astryx surface inventory coverage: ok (${listed.length} files, ${excluded.length} exclusions)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
