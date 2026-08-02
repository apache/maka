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
// First-party workspace stylesheets reached through a bare specifier. These
// are product CSS in the same cascade layer as styles/*, so they belong in the
// scan; the bare-import skip below exists to keep node_modules sheets out, and
// once read as "skip anything not starting with ." it silently exempted the
// one first-party sheet imported that way. Resolved from the package's own
// `exports` map rather than guessed, so a moved file fails loudly.
const WORKSPACE_CSS_EXPORTS: Record<string, string> = {
  '@maka/ui/styles.css': 'packages/ui/src/styles.css',
};

export async function expandCssImports(file: string, seen: Set<string>): Promise<string> {
  const source = await readFile(file, 'utf8');
  let expanded = source;

  for (const match of source.matchAll(CSS_IMPORT_RE)) {
    const importPath = match[1];
    const workspaceCss = WORKSPACE_CSS_EXPORTS[importPath];
    if (!workspaceCss && !importPath.startsWith('.')) continue;
    if (importPath.includes('astryx-theme/')) continue;

    const resolvedPath = workspaceCss
      ? resolve(REPO_ROOT, workspaceCss)
      : resolve(dirname(file), importPath);
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

export const RENDERER_TOKENS = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'maka-tokens.css');

/** Every renderer stylesheet EXCEPT the role table.
 *
 * Pre-seeding `seen` is the same mechanism the import walk already uses for
 * cycles, so there is no second traversal to keep in step with the first.
 * maka-tokens.css is where the roles are composed and where the family axis
 * is pinned, so it is the one file that must write font longhands; every
 * other sheet is a call site. */
export async function readCallSiteCss(): Promise<string> {
  return expandCssImports(RENDERER_STYLES_ENTRY, new Set([RENDERER_STYLES_ENTRY, RENDERER_TOKENS]));
}

export function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Escape a CSS selector for a RegExp, allowing flexible whitespace. */
function escapeCssSelector(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

/**
 * Slice the body of a `{ ... }` block starting at `openBraceIndex`.
 * Brace-depth aware so nested blocks (e.g. inside `@media`) stay intact.
 */
function extractBraceBlock(source: string, openBraceIndex: number): string | null {
  if (source[openBraceIndex] !== '{') return null;
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex + 1, i);
    }
  }
  return null;
}

/**
 * Return the declaration body of the first rule whose selector matches,
 * stopping at that rule's own closing `}`.
 *
 * Unlike `/selector\s*\{[\s\S]*?prop:/`, this does not crawl into later
 * sibling rules. Removing a property from the target rule fails even when a
 * child or neighbor rule still declares it — the cross-`}` false-green bug
 * that demoted layout contracts used to have.
 *
 * The selector must start a rule (after `^`, `{`, or `}`), so a right-hand
 * combinator target like `.row + .row` does not satisfy a search for `.row`.
 */
export function cssRuleBody(css: string, selector: string): string | null {
  const stripped = stripCssComments(css);
  const re = new RegExp(`(?:^|[\\{\\}])\\s*${escapeCssSelector(selector)}\\s*\\{`);
  const match = re.exec(stripped);
  if (!match) return null;
  return extractBraceBlock(stripped, match.index + match[0].length - 1);
}

/**
 * Return the body of the first `@media <condition> { ... }` block.
 * `mediaCondition` is the part after `@media`, e.g. `(max-width: 620px)`.
 */
export function cssMediaBody(css: string, mediaCondition: string): string | null {
  const stripped = stripCssComments(css);
  const cond = escapeCssSelector(mediaCondition);
  const re = new RegExp(`@media\\s*${cond}\\s*\\{`);
  const match = re.exec(stripped);
  if (!match) return null;
  return extractBraceBlock(stripped, match.index + match[0].length - 1);
}

/** Assert a selector's own rule body matches each declaration pattern. */
export function assertCssRuleDecls(
  css: string,
  selector: string,
  decls: RegExp[],
  message?: string,
): void {
  const body = cssRuleBody(css, selector);
  assert.ok(body != null, message ?? `rule ${selector} must exist`);
  for (const decl of decls) {
    assert.match(
      body!,
      decl,
      message ?? `${selector} must declare ${decl} in its own rule body`,
    );
  }
}

/** The one text-style vocabulary check.
 *
 * A text style is one indivisible role — size, leading, weight and family
 * chosen together — so the call site names a role and nothing else. Three
 * things have to hold for that to be true, and all three are text:
 *
 *   1. no call site declares font-size, line-height, font-weight or
 *      font-family. Four independent properties are four independent
 *      choices; the previous two convergences (#1857 sizes, #1878 leadings)
 *      removed the divergence that existed without removing the ability to
 *      diverge again, because the properties stayed separate.
 *   2. every `font:` value is a role token or a whole-inheritance literal.
 *      `font: 600 12px/1.4 sans-serif` is the same four choices written on
 *      one line, and it is what the shorthand is normally banned for.
 *   3. every role named is a role defined. A `var()` that resolves to
 *      nothing makes the whole `font:` declaration invalid at computed-value
 *      time, so the element silently keeps whatever it inherits — measured,
 *      `--maka-text-display-1` was referenced by the hero and defined
 *      nowhere, and every other check in this file stayed green.
 *
 * Scoped to the call sites: the role table itself has to write a family
 * longhand (see maka-tokens.css), so the tokens file is excluded from the
 * scan and its shape is asserted separately.
 */
const FONT_LONGHANDS = ['font-size', 'line-height', 'font-weight', 'font-family'] as const;
const FONT_LITERAL_OK = /^(?:inherit|initial|unset|revert)$/i;
const ROLE_TOKEN_RE = /^var\(\s*(--maka-text-[\w-]+)\s*\)$/;

export function findTextRoleOffenders(
  callSiteCss: string,
  tokensCss: string,
  label: string,
): string[] {
  const defined = new Set(parseCssCustomProps(tokensCss).keys());
  const offenders: string[] = [];
  for (const { selector, body } of parseCssBlocks(callSiteCss)) {
    for (const prop of FONT_LONGHANDS) {
      const value = lastDecl(body, prop);
      if (value === undefined) continue;
      offenders.push(`${label}: ${selector} declares ${prop}: ${value} — name a text role instead`);
    }
    const font = lastDecl(body, 'font');
    if (font === undefined) continue;
    if (FONT_LITERAL_OK.test(font)) continue;
    const token = ROLE_TOKEN_RE.exec(font)?.[1];
    if (!token) {
      offenders.push(`${label}: ${selector} declares font: ${font} — only var(--maka-text-*) or inherit/initial/unset/revert`);
      continue;
    }
    if (!defined.has(token)) {
      offenders.push(`${label}: ${selector} names ${token}, which the role table does not define`);
    }
  }
  return offenders;
}

// --- block + declaration parsing -------------------------------------------

/** Every style rule's own declarations, at any nesting depth.
 *
 * Depth-aware rather than `/([^{}]+)\{([^{}]*)\}/g`, which only ever matches
 * the INNERMOST block. That form reads correctly against this repo's CSS today
 * and is wrong the moment anyone writes native nesting: given
 * `.a { font-size: X; & span { … } }` it yields only `& span`, and the
 * declarations on `.a` vanish from every scan built on it — silently
 * disarming the pairing contract for that rule. Nesting is supported by the
 * build (Vite/Lightning CSS) and unused today, which is exactly when a parser
 * bug is cheapest to fix and most likely to go unnoticed.
 *
 * At-rule bodies (`@media`, `@layer`, `@keyframes`) are not themselves rules,
 * so they are not emitted; the style rules nested inside them are.
 */
export function parseCssBlocks(css: string): { selector: string; body: string }[] {
  const src = stripCssComments(css);
  const out: { selector: string; body: string }[] = [];
  const stack: { selector: string; body: string }[] = [];
  let buf = '';

  for (const ch of src) {
    if (ch === '{') {
      // Declarations the enclosing rule made before this nested block opened
      // are everything up to the last `;`; the remainder is the selector.
      const cut = buf.lastIndexOf(';');
      if (stack.length > 0 && cut >= 0) stack[stack.length - 1].body += buf.slice(0, cut + 1);
      stack.push({ selector: (cut >= 0 ? buf.slice(cut + 1) : buf).trim(), body: '' });
      buf = '';
    } else if (ch === '}') {
      const rule = stack.pop();
      if (!rule) continue;
      rule.body += buf;
      buf = '';
      if (!rule.selector.startsWith('@')) {
        out.push({ selector: rule.selector.split('\n').pop()!.trim(), body: rule.body });
      }
    } else {
      buf += ch;
    }
  }
  return out;
}

/** Last-declared value of `prop` in a block body, or undefined.
 *
 * Last, not first: within one block CSS takes the later declaration, so a
 * scanner that reads `body.match(...)` reports the value the browser discards.
 * `assertCustomPropPinnedOnce` below documents that same false-green at length
 * for custom properties; this is the longhand case of it.
 *
 * `\s*` around the colon because nothing normalizes it — biome.jsonc excludes
 * both `apps/desktop/**` and `packages/ui/**` from the formatter, so
 * `font-size : 18px` would otherwise slip every check in this file. */
function lastDecl(body: string, prop: string): string | undefined {
  const matches = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:\\s*([^;}]+)`, 'g'))];
  return matches.at(-1)?.[1].trim();
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
