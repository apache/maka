#!/usr/bin/env node
/**
 * Structural gate for Astryx alignment (docs/astryx-alignment-inventory.md).
 * Fails when high-severity smells reappear on product paths already moved onto
 * published Astryx primitives.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));

/** Files that must not reintroduce raw buttons after the Astryx pass. */
const BUTTON_GUARD_FILES = [
  'packages/ui/src/composer.tsx',
  'apps/desktop/src/renderer/session-inspector-panel.tsx',
  'apps/desktop/src/renderer/external-session-import-dialog.tsx',
  'apps/desktop/src/renderer/plan-mode-panel.tsx',
  'apps/desktop/src/renderer/session-workbar.tsx',
];

const HEIGHT_GUARD_FILES = [
  'apps/desktop/src/renderer/styles/task-ledger.css',
  'apps/desktop/src/renderer/styles/module-pages/module-shell.css',
  'apps/desktop/src/renderer/styles/chat-detail.css',
];

const ALLOWED_HEIGHTS = new Set([28, 32, 36]);
const RAW_BUTTON_RE = /<button\b/;
const ALLOW_COMMENT_RE = /astryx-allow:\s*raw-button/;

const failures = [];

for (const rel of BUTTON_GUARD_FILES) {
  const text = readFileSync(join(root, rel), 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!RAW_BUTTON_RE.test(line)) return;
    const window = lines.slice(Math.max(0, i - 3), i + 3).join('\n');
    if (ALLOW_COMMENT_RE.test(window)) return;
    // Workbar tab strip is intentional custom chrome (dnd-kit + role=tab).
    if (rel.endsWith('session-workbar.tsx') && /role=["']tab["']/.test(window)) return;
    failures.push(`${rel}:${i + 1}: raw <button> — use Astryx Button/Item/ToggleButton/Collapsible`);
  });
}

const controlBlocks = [
  [/\.maka-task-ledger-row\b[\s\S]{0,220}?min-height:\s*(\d+)px/, 'task-ledger-row'],
  [/\.maka-task-ledger-terminal-trigger\b[\s\S]{0,220}?min-height:\s*(\d+)px/, 'task-ledger-terminal'],
  [/\.maka-task-ledger-message\b[\s\S]{0,220}?min-height:\s*(\d+)px/, 'task-ledger-message'],
  [/\.maka-module-page-bar\b[\s\S]{0,500}?min-height:\s*(\d+)px/, 'module-page-bar'],
  [/\.maka-workbar-launcher-row\b[\s\S]{0,220}?min-height:\s*(\d+)px/, 'workbar-launcher-row'],
];

for (const rel of HEIGHT_GUARD_FILES) {
  const text = readFileSync(join(root, rel), 'utf8');
  for (const [re, name] of controlBlocks) {
    const m = text.match(re);
    if (!m) continue;
    const h = Number(m[1]);
    if (!ALLOWED_HEIGHTS.has(h)) {
      failures.push(`${rel}: ${name} min-height ${h}px is off 28/32/36 rhythm`);
    }
  }
}

try {
  const inv = readFileSync(join(root, 'docs/astryx-alignment-inventory.md'), 'utf8');
  for (const needle of [
    'Design · spacing',
    'API · Use the System',
    'Settings shell',
    'Module hubs',
    'Fixed in this pass',
  ]) {
    if (!inv.includes(needle)) {
      failures.push(`docs/astryx-alignment-inventory.md: missing section "${needle}"`);
    }
  }
} catch {
  failures.push('docs/astryx-alignment-inventory.md: missing');
}

// Guarded TSX files must actually import the Astryx primitives they claim.
const REQUIRED_IMPORTS = [
  ['packages/ui/src/composer.tsx', /Button as UiButton|from '@astryxdesign\/core'/],
  ['apps/desktop/src/renderer/session-inspector-panel.tsx', /ToggleButton/],
  ['apps/desktop/src/renderer/external-session-import-dialog.tsx', /SegmentedControl/],
  ['apps/desktop/src/renderer/external-session-import-dialog.tsx', /Item/],
  ['apps/desktop/src/renderer/plan-mode-panel.tsx', /Collapsible/],
  ['apps/desktop/src/renderer/session-workbar.tsx', /from '@astryxdesign\/core\/Item'/],
];
for (const [rel, re] of REQUIRED_IMPORTS) {
  const text = readFileSync(join(root, rel), 'utf8');
  if (!re.test(text)) {
    failures.push(`${rel}: missing required Astryx import matching ${re}`);
  }
}

if (failures.length) {
  console.error(`astryx alignment check failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('astryx alignment check: ok');
