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
 * Both the known Astryx component set and the `@maka/ui` re-export map are
 * derived from source at generation time (never hand-maintained), and the
 * derivation is fail-closed: any unresolved barrel target, a version that does
 * not match the pinned dependency, or a suspiciously small parse aborts the run
 * rather than emitting a partial inventory (see #3868).
 *
 * Run: node scripts/generate-astryx-surface-inventory.mjs
 * Writes: docs/astryx-surface-file-inventory.md
 *         docs/astryx-surface-file-inventory.paths
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
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

const NAMED_COMPONENT_RE = /^[A-Z][A-Za-z0-9]*$/;

/**
 * Sanity floor for the derived Astryx set plus a few components that must be
 * present. If the declaration parse regresses to a partial result, these
 * assertions turn it into a hard failure instead of a quietly shrunk inventory.
 */
const MIN_ASTRYX_COMPONENTS = 150;
const KEY_ASTRYX_COMPONENTS = [
  'Button',
  'TextInput',
  'Selector',
  'Text',
  'Card',
  'EmptyState',
  'Dialog',
  'Timestamp',
  'ChatMessage',
  'Thumbnail',
];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Add PascalCase value exports from one `.d.ts` block to `into`. */
function collectDeclaredComponents(block, into) {
  // export { A, B as C, type D } → A, C (skip type-only, *Props, *Context)
  for (const m of block.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part || /^type\s/.test(part)) continue;
      const asMatch = part.match(/\bas\s+([A-Za-z0-9_]+)$/);
      const name = asMatch ? asMatch[1] : part.split(/\s+/)[0];
      if (NAMED_COMPONENT_RE.test(name) && !name.endsWith('Props') && !name.endsWith('Context')) {
        into.add(name);
      }
    }
  }
  // export declare const|function|class Name
  for (const m of block.matchAll(
    /export\s+declare\s+(?:const|function|class)\s+([A-Za-z0-9_]+)/g,
  )) {
    if (NAMED_COMPONENT_RE.test(m[1])) into.add(m[1]);
  }
}

/** The exact `@astryxdesign/core` version pinned in the repo's root manifest. */
function pinnedAstryxVersion(repoRoot) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const pin = deps['@astryxdesign/core'];
  return pin ? pin.replace(/^[\^~=]/, '') : null;
}

let astryxComponentsCache = null;

/**
 * Read one declaration file, fold its PascalCase component exports into `set`,
 * then recurse through every `export * from './rel'` it declares. Barrel targets
 * resolve relative to the file's own directory, so a nested
 * `dist/Group/index.d.ts` → `export * from './Sub'` reads `dist/Group/Sub/…` —
 * the full barrel graph, not just the first layer. Fail-closed: an unreadable
 * file or an unresolved relative target throws rather than silently shrinking
 * the set. `seen` guards import cycles and repeated reads.
 */
function collectDistBarrel(file, set, seen) {
  if (seen.has(file)) return;
  seen.add(file);
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `cannot derive Astryx component set: ${relative(root, file)} is unreadable — reinstall @astryxdesign/core`,
    );
  }
  collectDeclaredComponents(src, set);
  const dir = dirname(file);
  for (const m of src.matchAll(/export\s*\*\s*from\s*['"](\.[^'"]*)['"]/g)) {
    const spec = m[1]; // any relative barrel: './Dir', '../Sibling', …
    const base = resolve(dir, spec);
    const dirIndex = join(base, 'index.d.ts');
    const flat = `${base}.d.ts`;
    if (existsSync(dirIndex)) collectDistBarrel(dirIndex, set, seen);
    else if (existsSync(flat)) collectDistBarrel(flat, set, seen);
    else
      throw new Error(
        `cannot derive Astryx component set: unresolved \`export * from '${spec}'\` in ${relative(root, file)} — reinstall @astryxdesign/core`,
      );
  }
}

/**
 * Parse an `@astryxdesign/core` `dist` directory into its set of PascalCase
 * component exports: `dist/index.d.ts` plus every per-dir `index.d.ts` (or flat
 * `Dir.d.ts`) reachable through the `export * from './Dir'` barrel graph,
 * traversed recursively so a future multi-level barrel cannot silently drop
 * components. Fail-closed — an unresolved barrel target throws rather than
 * quietly shrinking the set. Pure (no memo, no version check) so it is
 * unit-testable against fixture declaration dirs.
 */
export function parseAstryxDistComponents(distDir) {
  const set = new Set();
  collectDistBarrel(join(distDir, 'index.d.ts'), set, new Set());
  return set;
}

/**
 * Reject a suspiciously small or key-component-missing parse. Turns a partial
 * declaration read into a hard failure instead of a quietly shrunk inventory.
 */
export function assertAstryxComponentSet(set, version) {
  if (set.size < MIN_ASTRYX_COMPONENTS) {
    throw new Error(
      `Astryx component parse looks incomplete: derived ${set.size} components (< ${MIN_ASTRYX_COMPONENTS}) from @astryxdesign/core@${version}`,
    );
  }
  const missing = KEY_ASTRYX_COMPONENTS.filter((name) => !set.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Astryx component parse is missing expected components: ${missing.join(', ')} — the declaration format may have changed`,
    );
  }
}

/**
 * Resolve `@astryxdesign/core`, parse its shipped `.d.ts`, and return the
 * installed version alongside the sorted set of exported component names. We
 * parse the declarations rather than importing the ESM, because the runtime
 * has StyleX/CSS side effects a plain `node` import cannot evaluate.
 *
 * Fail-closed: an unresolved barrel target, a version that disagrees with the
 * pinned dependency, or a parse that yields fewer than `MIN_ASTRYX_COMPONENTS`
 * (or is missing a key component) throws rather than returning a partial set —
 * a silently incomplete set is exactly the drift #3868 removes. Memoized.
 */
export function loadAstryxComponents() {
  if (astryxComponentsCache) return astryxComponentsCache;
  const require = createRequire(import.meta.url);
  let distDir;
  try {
    distDir = dirname(require.resolve('@astryxdesign/core'));
  } catch {
    throw new Error(
      'cannot derive Astryx component set: @astryxdesign/core did not resolve — run `npm install` (deps are required to generate the inventory)',
    );
  }
  const pkgPath = join(dirname(distDir), 'package.json');
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  const pinned = pinnedAstryxVersion(root);
  if (pinned && pinned !== version) {
    throw new Error(
      `Astryx version drift: resolved @astryxdesign/core@${version} but the root package.json pins ${pinned} — regenerate after \`npm ci\``,
    );
  }
  const set = parseAstryxDistComponents(distDir);
  assertAstryxComponentSet(set, version);
  astryxComponentsCache = { version, components: new Set([...set].sort()) };
  return astryxComponentsCache;
}

/**
 * Resolve a TypeScript source module referenced by a `.js` import specifier
 * (Node16 style) to its on-disk `.ts`/`.tsx` (or directory `index`).
 */
function resolveSourceModule(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ''));
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the exported names of a source module to their origin:
 *   { kind: 'astryx', canonical } — (transitively) re-exported from @astryxdesign/core
 *   { kind: 'local', file }       — defined in `file`
 *   { kind: 'external' }          — re-exported from a third-party package
 * Recurses through relative `export *` / `export { … } from './x'` chains and
 * throws on any unresolved relative target (fail-closed). `memo`/`seen` bound
 * work and guard import cycles.
 */
function collectModuleExports(file, components, memo, seen) {
  if (memo.has(file)) return memo.get(file);
  if (seen.has(file)) return new Map();
  seen.add(file);
  const out = new Map();
  const code = stripComments(readFileSync(file, 'utf8'));

  // Local bindings imported from Astryx, so a bare `export { X }` can be classified.
  const astryxLocalToOrig = new Map();
  for (const m of code.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*['"]@astryxdesign\/core[^'"]*['"]/g,
  )) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      if (!part) continue;
      const asMatch = part.match(/^(\w+)\s+as\s+(\w+)$/);
      const orig = asMatch ? asMatch[1] : part.split(/\s+/)[0];
      const local = asMatch ? asMatch[2] : orig;
      if (local) astryxLocalToOrig.set(local, orig);
    }
  }

  // export * from '<spec>'
  for (const m of code.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('@astryxdesign/core')) {
      for (const canonical of components) out.set(canonical, { kind: 'astryx', canonical });
    } else if (spec.startsWith('.')) {
      const target = resolveSourceModule(file, spec);
      if (!target) {
        throw new Error(
          `cannot resolve @maka/ui exports: unresolved \`export * from '${spec}'\` in ${relative(root, file)}`,
        );
      }
      for (const [name, origin] of collectModuleExports(target, components, memo, seen)) {
        out.set(name, origin);
      }
    }
    // A non-relative `export *` (e.g. from 'react') re-exports unknowable names;
    // none is an Astryx twin or a local component, so it cannot shadow one.
  }

  // export { A, B as C, type D } [from '<spec>']
  for (const m of code.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g)) {
    const spec = m[2];
    let relExports = null;
    if (spec && spec.startsWith('.')) {
      const target = resolveSourceModule(file, spec);
      if (!target) {
        throw new Error(
          `cannot resolve @maka/ui exports: unresolved \`export { … } from '${spec}'\` in ${relative(root, file)}`,
        );
      }
      relExports = collectModuleExports(target, components, memo, seen);
    }
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part || /^type\s/.test(part)) continue;
      const asMatch = part.match(/^([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]+)$/);
      const orig = asMatch ? asMatch[1] : part.split(/\s+/)[0];
      const pub = asMatch ? asMatch[2] : orig;
      if (spec && spec.startsWith('@astryxdesign/core')) {
        out.set(pub, { kind: 'astryx', canonical: orig });
      } else if (relExports) {
        out.set(pub, relExports.get(orig) || { kind: 'local', file });
      } else if (spec) {
        out.set(pub, { kind: 'external' });
      } else {
        out.set(
          pub,
          astryxLocalToOrig.has(orig)
            ? { kind: 'astryx', canonical: astryxLocalToOrig.get(orig) }
            : { kind: 'local', file },
        );
      }
    }
  }

  // export const/function/class Name (a local definition)
  for (const m of code.matchAll(
    /export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z0-9_]+)/g,
  )) {
    out.set(m[1], { kind: 'local', file });
  }

  memo.set(file, out);
  return out;
}

const makaUiBarrelCache = new Map();

/**
 * Resolve the public `@maka/ui` surface (`packages/ui/src/index.ts`) into:
 *   - `reexports`: Map<publicName, canonicalAstryxName> — every name the barrel
 *     re-exports (transitively) from @astryxdesign/core. Replaces a hand-written
 *     list; the "Astryx used" column and the shadow check share this one fact.
 *   - `shadowsByFile`: Map<repoRelFile, Set<name>> — public exports whose name
 *     matches a shipped Astryx component but which are defined locally (not a
 *     re-export). This is the only "reimplementation" signal we assert on: a
 *     name collision is not proof of a semantic re-implementation, but a public
 *     API that shadows an Astryx component is worth surfacing in review.
 * Memoized per repo root; fail-closed via `collectModuleExports`.
 */
export function loadMakaUiBarrel(repoRoot = root) {
  if (makaUiBarrelCache.has(repoRoot)) return makaUiBarrelCache.get(repoRoot);
  const { components } = loadAstryxComponents();
  const indexFile = join(repoRoot, 'packages/ui/src/index.ts');
  if (!existsSync(indexFile)) {
    throw new Error(`cannot resolve @maka/ui exports: ${relative(repoRoot, indexFile)} not found`);
  }
  const exportsMap = collectModuleExports(indexFile, components, new Map(), new Set());
  const reexports = new Map();
  const shadowsByFile = new Map();
  for (const [name, origin] of exportsMap) {
    if (origin.kind === 'astryx') {
      reexports.set(name, origin.canonical);
    } else if (origin.kind === 'local' && origin.file && components.has(name)) {
      const rel = relative(repoRoot, origin.file).replaceAll('\\', '/');
      if (!shadowsByFile.has(rel)) shadowsByFile.set(rel, new Set());
      shadowsByFile.get(rel).add(name);
    }
  }
  const result = { reexports, shadowsByFile };
  makaUiBarrelCache.set(repoRoot, result);
  return result;
}

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

/**
 * Collect Astryx component names used in a file from real imports + JSX only.
 * - import { Button as UiButton } from '@astryxdesign/core' → Button (canonical)
 * - import { Badge } from '@maka/ui' when Badge is a derived Astryx re-export
 * - <Button / <UiButton only counts if bound from those imports
 */
function collectAstryxUsage(code, astryxComponents, makaUiReexports) {
  const localToCanonical = new Map(); // local binding → canonical Astryx name

  // import { A, B as C } from '@astryxdesign/core...'  or from the '@maka/ui' root barrel
  const importBlockRe =
    /import\s*\{([^}]+)\}\s*from\s*['"](@astryxdesign\/core(?:\/[^'"]+)?|@maka\/ui)['"]/g;
  let im;
  while ((im = importBlockRe.exec(code)) !== null) {
    const spec = im[1];
    const from = im[2];
    const isAstryxPkg = from.startsWith('@astryxdesign/core');
    for (const part of spec.split(',')) {
      const bit = part.trim();
      if (!bit) continue;
      const cleaned = bit.replace(/^type\s+/, '').trim();
      if (!cleaned || cleaned === 'type') continue;
      const asMatch = cleaned.match(/^(\w+)\s+as\s+(\w+)$/);
      const original = asMatch ? asMatch[1] : cleaned.split(/\s+/)[0];
      const local = asMatch ? asMatch[2] : original;
      if (isAstryxPkg && astryxComponents.has(original)) {
        localToCanonical.set(local, original);
      } else if (!isAstryxPkg && makaUiReexports.has(original)) {
        localToCanonical.set(local, makaUiReexports.get(original));
      }
    }
  }

  // default/namespace imports: import X from '@astryxdesign/core/Button'
  const defaultRe = /import\s+(\w+)\s+from\s*['"]@astryxdesign\/core(?:\/([^'"]+))?['"]/g;
  let dm;
  while ((dm = defaultRe.exec(code)) !== null) {
    const local = dm[1];
    const sub = (dm[2] || '').split('/')[0];
    if (sub && astryxComponents.has(sub)) localToCanonical.set(local, sub);
  }

  // JSX: <LocalName or <LocalName.
  const jsxUsed = new Set();
  const jsxRe = /<([A-Z][A-Za-z0-9]*)\b/g;
  let jx;
  while ((jx = jsxRe.exec(code)) !== null) {
    const local = jx[1];
    if (localToCanonical.has(local)) jsxUsed.add(localToCanonical.get(local));
  }
  return jsxUsed;
}

export function analyzeTsx(rel, text, ctx) {
  const { astryxComponents, makaUiReexports, shadowNames } = ctx;
  const code = stripComments(text);
  const named = collectAstryxUsage(code, astryxComponents, makaUiReexports);
  const shadows = shadowNames ? [...shadowNames].sort() : [];
  const rawButton = RAW_BUTTON_RE.test(code);
  const rawInput = RAW_INPUT_RE.test(code);
  const rawSelect = RAW_SELECT_RE.test(code);
  const rawTextarea = RAW_TEXTAREA_RE.test(code);
  const gaps = [];
  if (rawButton) gaps.push('raw `<button` (API Use-the-System)');
  if (rawInput) gaps.push('raw `<input` (API Use-the-System)');
  if (rawSelect) gaps.push('raw `<select` (API Use-the-System)');
  if (rawTextarea) gaps.push('raw `<textarea` (API Use-the-System)');
  for (const name of shadows) {
    gaps.push(`public export \`${name}\` shadows Astryx component (not a re-export)`);
  }
  if (named.size === 0 && (rawButton || rawInput || rawSelect)) {
    gaps.push('no Astryx import/JSX with raw controls (API Use-the-System)');
  }
  let severity = 'aligned';
  if (rawButton || rawInput || rawSelect) severity = 'blocker';
  else if (shadows.length > 0) severity = 'reimplementation';
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

function analyze(repoRoot, rel, ctx) {
  const full = join(repoRoot, rel);
  const text = readFileSync(full, 'utf8');
  const role = roleFor(rel);
  if (rel.endsWith('.css')) {
    const a = analyzeCss(rel, text);
    return { path: rel, role, ...a };
  }
  const a = analyzeTsx(rel, text, {
    astryxComponents: ctx.astryxComponents,
    makaUiReexports: ctx.makaUiReexports,
    shadowNames: ctx.shadowsByFile.get(rel) || null,
  });
  return { path: rel, role, ...a };
}

export function renderAstryxSurfaceInventory(repoRoot = root) {
  const { version, components } = loadAstryxComponents();
  const { reexports, shadowsByFile } = loadMakaUiBarrel(repoRoot);
  const ctx = { astryxComponents: components, makaUiReexports: reexports, shadowsByFile };

  const { files, excluded } = listProductSurfaceFiles(repoRoot);
  const rows = files.map((rel) => analyze(repoRoot, rel, ctx));

  const bySev = { blocker: 0, reimplementation: 0, polish: 0, aligned: 0 };
  for (const r of rows) bySev[r.severity] = (bySev[r.severity] || 0) + 1;

  const lines = [];
  lines.push('# Astryx surface file inventory (file-level)');
  lines.push('');
  lines.push('Generated by `scripts/generate-astryx-surface-inventory.mjs`.');
  lines.push(
    'Each row is one on-disk product surface file. Regenerated inventory must stay in sync with disk (coverage gate).',
  );
  lines.push(
    `Generated against \`@astryxdesign/core@${version}\` (${components.size} component exports).`,
  );
  lines.push('');
  lines.push('Wiki bar: Design Conventions · API Use-the-System · Theming · Container Padding.');
  lines.push('');
  lines.push(
    `**Totals:** ${rows.length} files — blocker ${bySev.blocker}, reimplementation ${bySev.reimplementation}, polish ${bySev.polish}, aligned ${bySev.aligned}.`,
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
    '- **reimplementation** — a public `@maka/ui` export shadows a shipped Astryx component (same name, not a re-export). A neutral signal for review, not proof of a semantic re-implementation.',
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
    version,
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
    `astryx @${rendered.version}: blocker=${rendered.totals.blocker} reimplementation=${rendered.totals.reimplementation} polish=${rendered.totals.polish} aligned=${rendered.totals.aligned}`,
  );
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect || process.argv[1]?.endsWith('generate-astryx-surface-inventory.mjs')) {
  main();
}
