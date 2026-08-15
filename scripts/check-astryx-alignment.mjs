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
  'apps/desktop/src/renderer/settings/import-tasks-settings-page.tsx',
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
    // Strip line comments so prose like "renders a real <button>" does not fail.
    const codeLine = line.replace(/\/\/.*$/, '');
    if (!/<\s*button\b/.test(codeLine)) return;
    const window = lines.slice(Math.max(0, i - 3), i + 3).join('\n');
    if (ALLOW_COMMENT_RE.test(window)) return;
    // Workbar tab strip is intentional custom chrome (dnd-kit + role=tab).
    if (rel.endsWith('session-workbar.tsx') && /role=["']tab["']/.test(window)) return;
    failures.push(
      `${rel}:${i + 1}: raw <button> — use Astryx Button/Item/ToggleButton/Collapsible`,
    );
  });
}

const controlBlocks = [
  [/\.maka-task-ledger-row\b[\s\S]{0,220}?min-height:\s*(\d+)px/, 'task-ledger-row'],
  [
    /\.maka-task-ledger-terminal-trigger\b[\s\S]{0,220}?min-height:\s*(\d+)px/,
    'task-ledger-terminal',
  ],
  [/\.maka-task-ledger-message\b[\s\S]{0,220}?min-height:\s*(\d+)px/, 'task-ledger-message'],
  [
    /\.maka-module-list-skeleton-row\b[\s\S]{0,220}?min-height:\s*(\d+)px/,
    'module-list-skeleton-row',
  ],
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
  ['apps/desktop/src/renderer/settings/import-tasks-settings-page.tsx', /ListItem/],
  ['apps/desktop/src/renderer/plan-mode-panel.tsx', /Collapsible/],
];
for (const [rel, re] of REQUIRED_IMPORTS) {
  const text = readFileSync(join(root, rel), 'utf8');
  if (!re.test(text)) {
    failures.push(`${rel}: missing required Astryx import matching ${re}`);
  }
}

// The import dialog's Item-row guards are gone with the dialog (#2984). They
// checked that a SELECTED row stayed keyboard-reachable: no listitem/option
// parent role stealing Item's native button, no `tabIndex={selectedId ...}`
// trapping focus when nothing is selected, and a selected-state selector on
// aria-selected rather than aria-pressed. 设置 › 活动 › 导入任务 has no
// selection at all — 导入 sits on each row the way 恢复 does on the archived
// page — so there is no selected row to keep reachable. Guarding the new page
// for the same smells would assert a shape it does not have.

const invText = readFileSync(join(root, 'docs/astryx-alignment-inventory.md'), 'utf8');
if (/module shell toolbar|module-page-bar.*42|Module shell toolbar CSS/.test(invText)) {
  failures.push(
    'docs/astryx-alignment-inventory.md: must not claim module-page-bar height fix (skeleton-row only)',
  );
}
if (!/module list skeleton|module-list-skeleton-row|Module list skeleton/.test(invText)) {
  failures.push('docs/astryx-alignment-inventory.md: document skeleton-row height fix accurately');
}

if (failures.length) {
  console.error(`astryx alignment check failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('astryx alignment check: ok');
