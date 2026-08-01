import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
export const RENDERER_STYLES_ENTRY = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

export async function readCssTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Generated Astryx theme output (#1565 PR 3) — see the note on
      // expandCssImports below.
      if (entry.name === 'astryx-theme') return [];
      return readCssTree(path);
    }
    return entry.name.endsWith('.css') ? [path] : [];
  }));
  return files.flat().sort();
}

const CSS_IMPORT_RE = /@import\s+"([^"]+\.css)"(?:\s+layer\([^)]+\))?\s*;/g;

// Generated Astryx theme output (#1565 PR 3). The converge contracts govern
// Maka's hand-written CSS vocabulary; astryx-theme/maka.css is an
// `astryx theme build` artifact with Astryx's own token system, excluded here
// for the same reason node_modules sheets never entered the scan (bare
// imports are skipped below).
export async function expandCssImports(file: string, seen: Set<string>): Promise<string> {
  const source = await readFile(file, 'utf8');
  let expanded = source;

  for (const match of source.matchAll(CSS_IMPORT_RE)) {
    const importPath = match[1];
    if (!importPath.startsWith('.')) continue;
    if (importPath.includes('astryx-theme/')) continue;

    const resolvedPath = resolve(dirname(file), importPath);
    if (seen.has(resolvedPath)) continue;

    seen.add(resolvedPath);
    expanded += `\n${await expandCssImports(resolvedPath, seen)}`;
  }

  return expanded;
}

export async function readAllRendererCss(): Promise<string> {
  // Fail closed: if import expansion breaks (missing file, bad @import path),
  // surface the error so converge contracts catch it instead of silently
  // degrading to only the styles.css entry and skipping styles/*.
  return expandCssImports(RENDERER_STYLES_ENTRY, new Set([RENDERER_STYLES_ENTRY]));
}

export function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Ban non-literal `font:` shorthand in renderer CSS.
 *
 * `font:` shorthand can hide bare font-weight (`font: 600 12px sans-serif`),
 * bare line-height (`font: 12px/1.4 sans-serif`), or token-bypassing sizes
 * (`font: 600 var(--font-size-ui) var(--font-sans)`). Per-property converge
 * contracts only scan longhand declarations, so any `font:` shorthand that
 * isn't a literal (`inherit` / `initial` / `unset` / `revert`) is a bypass
 * vector. Renderer CSS today only uses `font: inherit`, so the whitelist is
 * literals-only — no regex arms race over which shorthand component is bare.
 *
 * The value is extracted and checked against the literal set rather than
 * using a negative lookahead: `\s*` backtracking lets a lookahead succeed at
 * the `:` position and would match `font: inherit` as an offender. */
const FONT_SHORTHAND_RE = /\bfont:\s*[^;}\n]+/gi;
const FONT_LITERAL_OK = /^(?:inherit|initial|unset|revert)$/i;

export function findFontShorthandOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  for (const m of stripped.matchAll(FONT_SHORTHAND_RE)) {
    const decl = m[0].trim();
    const value = decl.replace(/^font:\s*/i, '').trim();
    if (FONT_LITERAL_OK.test(value)) continue;
    offenders.push(`${label}: ${decl} (non-literal font: shorthand — use longhand + tokens)`);
  }
  return offenders;
}

// --- token pin (exact-once) -----------------------------------------------

/** Parse all custom property declarations (`--token: value;`) from CSS.
 * Returns token name → array of declared values, one entry per occurrence
 * (so duplicates are visible). Comments are stripped first; values trimmed. */
export function parseCssCustomProps(css: string): Map<string, string[]> {
  const stripped = stripCssComments(css);
  const map = new Map<string, string[]>();
  for (const m of stripped.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+?)\s*;/g)) {
    const name = m[1];
    const value = m[2].trim();
    const list = map.get(name);
    if (list) list.push(value);
    else map.set(name, [value]);
  }
  return map;
}

/** Assert a custom property is declared exactly once with the expected value.
 *
 * Works for token definitions in maka-tokens.css and other stylesheets (e.g.
 * `--font-weight-normal: 400`). Stronger
 * than `assert.match(css, /--prop:\s*value\s*;/)`: that only proves a correct
 * declaration exists somewhere — a later overriding declaration (e.g.
 * `--font-weight-normal: 400; --font-weight-normal: 450;`, or
 * `--leading-normal: var(--leading-normal); --leading-normal: 1.55;`) still
 * passes because the first match satisfies `assert.match`. This helper fails
 * on duplicate declarations and on a single declaration with a drifted value. */
export function assertCustomPropPinnedOnce(
  css: string,
  prop: string,
  expected: string,
  label = 'maka-tokens.css',
): void {
  const values = parseCssCustomProps(css).get(prop) ?? [];
  assert.equal(values.length, 1, `${label}: ${prop} must be declared exactly once with ${expected}; got ${values.length} declaration(s): ${JSON.stringify(values)}`);
  assert.equal(values[0], expected, `${label}: ${prop} must be ${expected}; got ${values[0]}`);
}
