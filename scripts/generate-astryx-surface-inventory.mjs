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
 * Enumerates every product UI surface file and emits a file-level Astryx-fit
 * inventory (markdown + machine-readable path list).
 *
 * Run: node scripts/generate-astryx-surface-inventory.mjs
 * Writes: docs/astryx-surface-file-inventory.md
 *         docs/astryx-surface-file-inventory.paths
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));

const TREES = [join(root, 'apps/desktop/src/renderer'), join(root, 'packages/ui/src')];

const EXCLUDE_DIR = new Set([
  '__tests__',
  'stories',
  'node_modules',
  'dist',
  'astryx-theme',
  'locales',
  'computer-use-overlay', // engine + palette, not product chrome inventory
]);

/** Basename patterns excluded with explicit reason (coverage gate uses same list). */
export const EXCLUDE_BASENAME = [
  { re: /-copy\.tsx?$/, reason: 'locale/copy helper, not a surface' },
  { re: /\.test\.tsx?$/, reason: 'unit test' },
  { re: /\.spec\.tsx?$/, reason: 'spec' },
  { re: /\.d\.ts$/, reason: 'types only' },
  { re: /^index\.tsx?$/, reason: 'barrel re-export' },
  { re: /^main\.tsx$/, reason: 'bundle entry, not a surface' },
  { re: /-model\.ts$/, reason: 'view-model/logic without UI' },
  { re: /-filter\.ts$/, reason: 'pure filter logic' },
  { re: /-lifecycle\.ts$/, reason: 'lifecycle helper' },
  { re: /-helpers?\.ts$/, reason: 'helpers without UI' },
  { re: /^use-.*\.ts$/, reason: 'hook implementation (UI is in consumer tsx)' },
];

/** Canonical Astryx component names we care about for inventory. */
const ASTRYX_COMPONENTS = new Set([
  'Button',
  'IconButton',
  'TextInput',
  'Selector',
  'List',
  'ListItem',
  'Item',
  'EmptyState',
  'Spinner',
  'Banner',
  'Dialog',
  'DialogHeader',
  'Layout',
  'LayoutContent',
  'LayoutHeader',
  'LayoutPanel',
  'Card',
  'Section',
  'Collapsible',
  'ToggleButton',
  'SegmentedControl',
  'SegmentedControlItem',
  'Heading',
  'Text',
  'HStack',
  'VStack',
  'Toolbar',
  'Badge',
  'Tooltip',
  'CheckboxInput',
  'Switch',
  'Breadcrumbs',
  'BreadcrumbItem',
  'SideNav',
  'AppShell',
  'Token',
  'Lightbox',
  'ChatComposer',
  'ChatLayout',
  'ChatToolCalls',
  'Divider',
  'MetadataList',
  'MetadataListItem',
  'TabList',
  'Tab',
  'ContextMenu',
  'ResizeHandle',
]);

/**
 * @maka/ui barrel names that re-export Astryx (not lucide icons, not product-only).
 * Keep narrow — icons.tsx is lucide-only and must stay astryx=none.
 */
const MAKA_UI_ASTRYX_REEXPORTS = new Set([
  'Badge',
  'Selector',
  'Card',
  'Button',
  'IconButton',
  'Spinner',
  'EmptyState',
  'Tooltip',
  'Banner',
]);
const RAW_BUTTON_RE = /<\s*button\b/;
const RAW_INPUT_RE = /<\s*input\b/;
const RAW_SELECT_RE = /<\s*select\b/;
const RAW_TEXTAREA_RE = /<\s*textarea\b/;
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const OFF_HEIGHT_RE = /(?:min-)?height:\s*(\d+)px/g;
const ALLOWED_H = new Set([28, 32, 36]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (EXCLUDE_DIR.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

export function listProductSurfaceFiles(repoRoot = root) {
  const files = [];
  const excluded = [];
  for (const tree of [
    join(repoRoot, 'apps/desktop/src/renderer'),
    join(repoRoot, 'packages/ui/src'),
  ]) {
    for (const full of walk(tree)) {
      const rel = relative(repoRoot, full).replaceAll('\\', '/');
      const base = full.split(/[/\\]/).pop();
      const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
      if (ext !== '.tsx' && ext !== '.css') continue;
      // packages/ui only inventory CSS at styles.css + non-test; desktop styles/**
      if (ext === '.css') {
        if (rel.includes('/styles/') || base === 'styles.css' || rel.includes('/styles.css')) {
          // ok
        } else if (!rel.includes('/styles/')) {
          // e.g. packages/ui/src/foo.css if any
        }
      }
      let skip = null;
      for (const rule of EXCLUDE_BASENAME) {
        if (rule.re.test(base)) {
          skip = rule.reason;
          break;
        }
      }
      if (skip) {
        excluded.push({ path: rel, reason: skip });
        continue;
      }
      // Pure .ts hooks already excluded by basename; also skip non-surface tsx that are clearly non-UI
      if (ext === '.tsx') {
        // keep all remaining tsx under the trees
      }
      files.push(rel);
    }
  }
  files.sort();
  excluded.sort((a, b) => a.path.localeCompare(b.path));
  return { files, excluded };
}

function roleFor(rel) {
  if (rel.includes('/settings/') && /-(page|modal)\.tsx$/.test(rel)) return 'settings-page';
  if (rel.includes('/settings/')) return 'settings-module';
  if (/mcp-page|skills-panel|scheduled-task|daily-review/.test(rel)) return 'module-hub';
  if (/dialog|modal|command-palette|keyboard-help|onboarding/.test(rel)) return 'dialog-overlay';
  if (
    /panel|workbar|inspector|terminal|browser|artifact|composer|chat-|app-shell|titlebar|sidebar|session-/.test(
      rel,
    )
  ) {
    return 'shell-chrome-or-panel';
  }
  if (rel.includes('/primitives/')) return 'primitive';
  if (rel.startsWith('packages/ui/')) return 'ui-composition';
  if (rel.endsWith('.css')) return 'styles';
  return 'other';
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Collect Astryx component names from real imports + JSX only (never comments).
 * - import { Button as UiButton } from '@astryxdesign/core' → Button (canonical)
 * - import { Badge } from '@maka/ui' when Badge is a known Astryx re-export
 * - <Button / <UiButton only counts if bound from those imports
 */
function collectAstryxUsage(code) {
  const localToCanonical = new Map(); // local binding → canonical name
  const used = new Set();

  // import { A, B as C } from '@astryxdesign/core...'  (and /subdir)
  const importBlockRe =
    /import\s*\{([^}]+)\}\s*from\s*['"](@astryxdesign\/core(?:\/[^'"]+)?|@maka\/ui(?:\/[^'"]+)?)['"]/g;
  let im;
  while ((im = importBlockRe.exec(code)) !== null) {
    const spec = im[1];
    const from = im[2];
    const isAstryxPkg = from.startsWith('@astryxdesign/core');
    const isMakaUiRoot = from === '@maka/ui';
    for (const part of spec.split(',')) {
      const bit = part.trim();
      if (!bit) continue;
      // type imports: type Foo
      const cleaned = bit.replace(/^type\s+/, '').trim();
      if (!cleaned || cleaned === 'type') continue;
      const asMatch = cleaned.match(/^(\w+)\s+as\s+(\w+)$/);
      let original;
      let local;
      if (asMatch) {
        original = asMatch[1];
        local = asMatch[2];
      } else {
        original = cleaned.split(/\s+/)[0];
        local = original;
      }
      if (isAstryxPkg && ASTRYX_COMPONENTS.has(original)) {
        localToCanonical.set(local, original);
        used.add(original); // imported = available; count as used if also JSX or always?
        // Import alone is enough to claim the primitive is in the dependency set;
        // prefer also requiring JSX below for "uses".
      } else if (isMakaUiRoot && MAKA_UI_ASTRYX_REEXPORTS.has(original)) {
        localToCanonical.set(local, original);
      }
    }
  }

  // default/namespace imports: import X from '@astryxdesign/core/Button'
  const defaultRe = /import\s+(\w+)\s+from\s*['"]@astryxdesign\/core(?:\/([^'"]+))?['"]/g;
  let dm;
  while ((dm = defaultRe.exec(code)) !== null) {
    const local = dm[1];
    const sub = (dm[2] || '').split('/')[0];
    if (sub && ASTRYX_COMPONENTS.has(sub)) {
      localToCanonical.set(local, sub);
    }
  }

  // JSX: <LocalName or <LocalName.
  const jsxUsed = new Set();
  const jsxRe = /<([A-Z][A-Za-z0-9]*)\b/g;
  let jx;
  while ((jx = jsxRe.exec(code)) !== null) {
    const local = jx[1];
    if (localToCanonical.has(local)) {
      jsxUsed.add(localToCanonical.get(local));
    }
  }

  // "Uses" = appeared in JSX with a binding from Astryx (or maka re-export).
  // Import-only without JSX does not count (avoids unused import noise).
  return jsxUsed;
}

function analyzeTsx(rel, text) {
  const code = stripComments(text);
  const named = collectAstryxUsage(code);
  const rawButton = RAW_BUTTON_RE.test(code);
  const rawInput = RAW_INPUT_RE.test(code);
  const rawSelect = RAW_SELECT_RE.test(code);
  const rawTextarea = RAW_TEXTAREA_RE.test(code);
  const gaps = [];
  if (rawButton) gaps.push('raw `<button` (API Use-the-System)');
  if (rawInput) gaps.push('raw `<input` (API Use-the-System)');
  if (rawSelect) gaps.push('raw `<select` (API Use-the-System)');
  if (rawTextarea) gaps.push('raw `<textarea` (API Use-the-System)');
  if (named.size === 0 && (rawButton || rawInput || rawSelect)) {
    gaps.push('no Astryx import/JSX with raw controls (API Use-the-System)');
  }
  let severity = 'aligned';
  if (rawButton || rawInput || rawSelect) severity = 'blocker';
  else if (rawTextarea) severity = 'polish';

  const note =
    gaps.length > 0
      ? gaps.join('; ')
      : named.size > 0
        ? `aligned — uses Astryx (${[...named].sort().slice(0, 8).join(', ')})`
        : 'aligned — no raw controls; no Astryx JSX usage';
  return {
    astryx: named.size > 0 ? [...named].sort().join(', ') : 'none',
    gaps: note,
    severity,
  };
}

function analyzeCss(rel, text) {
  const gaps = [];
  let m;
  const re = new RegExp(OFF_HEIGHT_RE.source, 'g');
  const bad = [];
  while ((m = re.exec(text)) !== null) {
    const h = Number(m[1]);
    // ignore 0, 1, 2, max-height large, icon sizes under 20, etc. for severity
    if (
      h >= 24 &&
      h <= 48 &&
      !ALLOWED_H.has(h) &&
      !/max-height/.test(text.slice(Math.max(0, m.index - 20), m.index))
    ) {
      // only flag if line is min-height or height for controls-ish
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const line = text.slice(lineStart, text.indexOf('\n', m.index));
      if (/min-height|^\s*height:/.test(line) && !/max-height|line-height/.test(line)) {
        if ([30, 34, 40, 42, 44].includes(h)) bad.push(`${h}px`);
      }
    }
  }
  if (bad.length) {
    gaps.push(`off-rhythm control height ${[...new Set(bad)].join(', ')} (Design size)`);
  }
  const hex = HEX_RE.test(text) && !/oklch|color-mix/.test(text.slice(0, 200));
  // hex in comments often false positive — only if many
  const hexCount = (text.match(HEX_RE) || []).length;
  if (hexCount > 3 && /#[0-9a-fA-F]{6}/.test(text)) {
    // soft polish signal
  }
  const severity = gaps.length ? 'polish' : 'aligned';
  return {
    astryx: 'n/a (css)',
    gaps: gaps.length ? gaps.join('; ') : 'aligned — no off-rhythm control heights flagged',
    severity,
  };
}

function analyze(repoRoot, rel) {
  const full = join(repoRoot, rel);
  const text = readFileSync(full, 'utf8');
  const role = roleFor(rel);
  if (rel.endsWith('.css')) {
    const a = analyzeCss(rel, text);
    return { path: rel, role, ...a };
  }
  const a = analyzeTsx(rel, text);
  return { path: rel, role, ...a };
}

export function renderAstryxSurfaceInventory(repoRoot = root) {
  const { files, excluded } = listProductSurfaceFiles(repoRoot);
  const rows = files.map((rel) => analyze(repoRoot, rel));

  const bySev = { blocker: 0, polish: 0, aligned: 0 };
  for (const r of rows) bySev[r.severity] = (bySev[r.severity] || 0) + 1;

  const lines = [];
  lines.push('# Astryx surface file inventory (file-level)');
  lines.push('');
  lines.push('Generated by `scripts/generate-astryx-surface-inventory.mjs`.');
  lines.push(
    'Each row is one on-disk product surface file. Regenerated inventory must stay in sync with disk (coverage gate).',
  );
  lines.push('');
  lines.push('Wiki bar: Design Conventions · API Use-the-System · Theming · Container Padding.');
  lines.push('');
  lines.push(
    `**Totals:** ${rows.length} files — blocker ${bySev.blocker}, polish ${bySev.polish}, aligned ${bySev.aligned}.`,
  );
  lines.push('');
  lines.push('## Exclusions (explicit)');
  lines.push('');
  lines.push('### Universe rules');
  lines.push('');
  lines.push('- Trees: `apps/desktop/src/renderer/**`, `packages/ui/src/**`.');
  lines.push(
    '- Included extensions: `.tsx` (components/pages) and product `.css` under those trees.',
  );
  lines.push(
    '- Directories skipped: `__tests__`, `stories`, `locales`, `astryx-theme`, `computer-use-overlay` (engine).',
  );
  lines.push(
    '- Basename rules below; pure `.ts` hooks/helpers are outside the universe (UI is inventoried at consumer `.tsx`).',
  );
  lines.push('');
  lines.push('### Excluded paths');
  lines.push('');
  lines.push('| Path | Why |');
  lines.push('|------|-----|');
  for (const e of excluded) {
    lines.push(`| \`${e.path}\` | ${e.reason} |`);
  }
  if (excluded.length === 0) lines.push('| — | — |');
  lines.push('');

  lines.push('## Files');
  lines.push('');
  lines.push('| Path | Role | Astryx used | Gap / note | Severity |');
  lines.push('|------|------|-------------|------------|----------|');
  for (const r of rows) {
    const gap = r.gaps.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const astryx = (r.astryx || 'none').replace(/\|/g, '\\|');
    lines.push(`| \`${r.path}\` | ${r.role} | ${astryx} | ${gap} | ${r.severity} |`);
  }
  lines.push('');
  lines.push('## Severity legend');
  lines.push('');
  lines.push(
    '- **blocker** — raw interactive control with an Astryx twin available (`button`/`input`/`select`).',
  );
  lines.push(
    '- **polish** — off-rhythm control heights or softer smells; not wrong primitive choice.',
  );
  lines.push('- **aligned** — no blocker smell found; Astryx usage noted when present.');
  lines.push('');

  const markdown = lines.join('\n');
  return {
    markdown: markdown.endsWith('\n') ? markdown : `${markdown}\n`,
    paths: `${files.join('\n')}\n`,
    files,
    excluded,
    totals: bySev,
  };
}

function main() {
  const rendered = renderAstryxSurfaceInventory(root);
  const mdPath = join(root, 'docs/astryx-surface-file-inventory.md');
  const pathsPath = join(root, 'docs/astryx-surface-file-inventory.paths');
  writeFileSync(mdPath, rendered.markdown);
  writeFileSync(pathsPath, rendered.paths);
  console.log(`wrote ${relative(root, mdPath)} (${rendered.files.length} files)`);
  console.log(`wrote ${relative(root, pathsPath)}`);
  console.log(
    `severity: blocker=${rendered.totals.blocker} polish=${rendered.totals.polish} aligned=${rendered.totals.aligned}`,
  );
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect || process.argv[1]?.endsWith('generate-astryx-surface-inventory.mjs')) {
  main();
}
