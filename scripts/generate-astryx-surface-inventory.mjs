#!/usr/bin/env node
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

const TREES = [
  join(root, 'apps/desktop/src/renderer'),
  join(root, 'packages/ui/src'),
];

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

const ASTRYX_IMPORT_RE =
  /from\s+['"]@astryxdesign\/core(?:\/[^'"]+)?['"]|from\s+['"]@astryxdesign\/core['"]/g;
const ASTRYX_NAMED_RE =
  /\b(Button|IconButton|TextInput|Selector|List|ListItem|Item|EmptyState|Spinner|Banner|Dialog|Layout|LayoutContent|LayoutHeader|LayoutPanel|Card|Section|Collapsible|ToggleButton|SegmentedControl|Heading|Text|HStack|VStack|Toolbar|Badge|Tooltip|CheckboxInput|Switch|Breadcrumbs|SideNav|AppShell|Token|Lightbox|ChatComposer|ChatLayout|ChatToolCalls|Divider|MetadataList|TabList|Tab)\b/g;
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
  if (/mcp-page|skills-panel|plan-reminder|daily-review/.test(rel)) return 'module-hub';
  if (/dialog|modal|command-palette|keyboard-help|onboarding/.test(rel)) return 'dialog-overlay';
  if (/panel|workbar|inspector|terminal|browser|artifact|composer|chat-|app-shell|titlebar|sidebar|session-/.test(rel)) {
    return 'shell-chrome-or-panel';
  }
  if (rel.includes('/primitives/')) return 'primitive';
  if (rel.startsWith('packages/ui/')) return 'ui-composition';
  if (rel.endsWith('.css')) return 'styles';
  return 'other';
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function analyzeTsx(rel, text) {
  const code = stripComments(text);
  const astryxImports = [...text.matchAll(ASTRYX_IMPORT_RE)].length > 0;
  const named = new Set();
  let m;
  const re = new RegExp(ASTRYX_NAMED_RE.source, 'g');
  while ((m = re.exec(text)) !== null) named.add(m[1]);
  // Only count names that appear near astryx usage roughly — keep simple: all matches in file
  const rawButton = RAW_BUTTON_RE.test(code);
  const rawInput = RAW_INPUT_RE.test(code);
  const rawSelect = RAW_SELECT_RE.test(code);
  const rawTextarea = RAW_TEXTAREA_RE.test(code);
  const gaps = [];
  if (rawButton) gaps.push('raw `<button` (API Use-the-System)');
  if (rawInput) gaps.push('raw `<input` (API Use-the-System)');
  if (rawSelect) gaps.push('raw `<select` (API Use-the-System)');
  if (rawTextarea) gaps.push('raw `<textarea` (API Use-the-System)');
  if (!astryxImports && named.size === 0 && (rawButton || rawInput || rawSelect)) {
    gaps.push('no Astryx import with raw controls (API Use-the-System)');
  }
  let severity = 'aligned';
  if (rawButton || rawInput || rawSelect) severity = 'blocker';
  else if (rawTextarea) severity = 'polish';
  else if (!astryxImports && roleFor(rel) !== 'other') {
    // pure composition without astryx may still be ok (wrappers)
    severity = 'aligned';
  }
  const note =
    gaps.length > 0
      ? gaps.join('; ')
      : astryxImports || named.size
        ? `aligned — uses Astryx (${[...named].slice(0, 8).join(', ') || 'import'})`
        : 'aligned — no raw controls; no Astryx import required or pure layout/helper UI';
  return {
    astryx: astryxImports || named.size > 0 ? [...named].sort().join(', ') || 'import' : 'none',
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
    if (h >= 24 && h <= 48 && !ALLOWED_H.has(h) && !/max-height/.test(text.slice(Math.max(0, m.index - 20), m.index))) {
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

function analyze(rel) {
  const full = join(root, rel);
  const text = readFileSync(full, 'utf8');
  const role = roleFor(rel);
  if (rel.endsWith('.css')) {
    const a = analyzeCss(rel, text);
    return { path: rel, role, ...a };
  }
  const a = analyzeTsx(rel, text);
  return { path: rel, role, ...a };
}

function main() {
  const { files, excluded } = listProductSurfaceFiles(root);
  const rows = files.map(analyze);

  const bySev = { blocker: 0, polish: 0, aligned: 0 };
  for (const r of rows) bySev[r.severity] = (bySev[r.severity] || 0) + 1;

  const lines = [];
  lines.push('# Astryx surface file inventory (file-level)');
  lines.push('');
  lines.push('Generated by `scripts/generate-astryx-surface-inventory.mjs`.');
  lines.push('Each row is one on-disk product surface file. Regenerated inventory must stay in sync with disk (coverage gate).');
  lines.push('');
  lines.push('Wiki bar: Design Conventions · API Use-the-System · Theming · Container Padding.');
  lines.push('');
  lines.push(`**Totals:** ${rows.length} files — blocker ${bySev.blocker}, polish ${bySev.polish}, aligned ${bySev.aligned}.`);
  lines.push('');
  lines.push('## Exclusions (explicit)');
  lines.push('');
  lines.push('### Universe rules');
  lines.push('');
  lines.push('- Trees: `apps/desktop/src/renderer/**`, `packages/ui/src/**`.');
  lines.push('- Included extensions: `.tsx` (components/pages) and product `.css` under those trees.');
  lines.push('- Directories skipped: `__tests__`, `stories`, `locales`, `astryx-theme`, `computer-use-overlay` (engine).');
  lines.push('- Basename rules below; pure `.ts` hooks/helpers are outside the universe (UI is inventoried at consumer `.tsx`).');
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
  lines.push('- **blocker** — raw interactive control with an Astryx twin available (`button`/`input`/`select`).');
  lines.push('- **polish** — off-rhythm control heights or softer smells; not wrong primitive choice.');
  lines.push('- **aligned** — no blocker smell found; Astryx usage noted when present.');
  lines.push('');

  const mdPath = join(root, 'docs/astryx-surface-file-inventory.md');
  const pathsPath = join(root, 'docs/astryx-surface-file-inventory.paths');
  writeFileSync(mdPath, lines.join('\n'));
  writeFileSync(pathsPath, `${files.join('\n')}\n`);
  console.log(`wrote ${relative(root, mdPath)} (${rows.length} files)`);
  console.log(`wrote ${relative(root, pathsPath)}`);
  console.log(`severity: blocker=${bySev.blocker} polish=${bySev.polish} aligned=${bySev.aligned}`);
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect || process.argv[1]?.endsWith('generate-astryx-surface-inventory.mjs')) {
  main();
}
