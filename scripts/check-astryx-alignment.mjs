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
  ['apps/desktop/src/renderer/external-session-import-dialog.tsx', /SegmentedControl/],
  ['apps/desktop/src/renderer/external-session-import-dialog.tsx', /Item/],
  ['apps/desktop/src/renderer/plan-mode-panel.tsx', /Collapsible/],
];
for (const [rel, re] of REQUIRED_IMPORTS) {
  const text = readFileSync(join(root, rel), 'utf8');
  if (!re.test(text)) {
    failures.push(`${rel}: missing required Astryx import matching ${re}`);
  }
}

const importTsx = readFileSync(
  join(root, 'apps/desktop/src/renderer/external-session-import-dialog.tsx'),
  'utf8',
);
// Parent-role paths (listitem/option/menuitem) put onClick on the root and
// suppress Item's native button — easy to ship a -1-only tabIndex trap.
if (/role=["']listitem["']/.test(importTsx)) {
  failures.push('external-session-import-dialog.tsx: Item role=listitem drops keyboard button');
}
if (/role=["']option["']/.test(importTsx) || /role=["']listbox["']/.test(importTsx)) {
  failures.push(
    'external-session-import-dialog.tsx: avoid listbox/option parent-role path; leave Item without role so it supplies a focusable button',
  );
}
// Every session Item must use onClick (button path) and must not pin tabIndex=-1.
const sessionItemBlocks = [
  ...importTsx.matchAll(/className="maka-external-session-import-row"[\s\S]{0,400}?\/>/g),
];
if (sessionItemBlocks.length === 0) {
  failures.push('external-session-import-dialog.tsx: missing session Item rows');
}
for (const block of sessionItemBlocks) {
  const body = block[0];
  if (!/onClick=/.test(body)) {
    failures.push(
      'external-session-import-dialog.tsx: session Item missing onClick (no button path)',
    );
  }
  if (/tabIndex=\{-1\}|tabIndex=\{selectedId/.test(body)) {
    failures.push(
      'external-session-import-dialog.tsx: session Item must not use selected-only tabIndex (null selectedId traps keyboard)',
    );
  }
}

const importCss = readFileSync(
  join(root, 'apps/desktop/src/renderer/styles/external-session-import.css'),
  'utf8',
);
if (
  /\.maka-external-session-import-row\[aria-pressed/.test(importCss) &&
  !/\.maka-external-session-import-row\[aria-selected/.test(importCss)
) {
  failures.push(
    'external-session-import.css: selected rows must target aria-selected/aria-current, not aria-pressed',
  );
}
if (
  !/\.maka-external-session-import-row\[aria-selected/.test(importCss) &&
  !/\.maka-external-session-import-row\[aria-current/.test(importCss)
) {
  failures.push('external-session-import.css: missing selected-state selector for Item');
}

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
