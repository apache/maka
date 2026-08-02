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

// --- size ↔ leading pairing ------------------------------------------------

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

/**
 * Report blocks whose `font-size` and `line-height` name different tiers.
 *
 * The rule is not "leading must be token X": Astryx's leading is a pure
 * function of size (`expandTypeScale.ts` snaps each tier to the 4px grid), so
 * several role names share one value at one size and the choice between them
 * is a readability one. What must hold is that the role whose leading a block
 * names is the role sized like the size the block declares — checked by
 * resolving both through the generated theme rather than against a hand-copied
 * table, so an Astryx scale change moves this contract with it instead of
 * failing it.
 *
 * Bidirectional. An earlier revision checked only size→leading and deferred
 * leading-without-size to the e2e sweep — but that sweep measures one window,
 * and measured, none of the three leading-only blocks in the tree rendered in
 * it, so the class had no coverage anywhere. It is also the exact shape
 * maka-tokens.css bans in prose ("leading belongs on the element that sets the
 * size, never on a container above it"), and one of the three
 * (`.maka-stat-tile-value`) was dead code overridden by both of its own
 * variants. A rule that declares only a leading is either redundant with what
 * it inherits or a ratio waiting to meet a size it was not chosen for.
 *
 * `inherit`/`unset`/`revert` are a legal pair when BOTH sides use them: the
 * block is deferring the whole pairing upward, not splitting it.
 */
export function findLeadingPairingOffenders(
  css: string,
  themeCss: string,
  tokensCss: string,
): string[] {
  const theme = parseCssCustomProps(themeCss);
  const tokens = parseCssCustomProps(tokensCss);
  const first = (map: Map<string, string[]>, name: string) => map.get(name)?.[0];

  // Raw size token → length. Product aliases resolve through one hop.
  const sizeOf = (token: string): string | undefined => {
    const direct = first(theme, token);
    if (direct && !direct.startsWith('var(')) return direct;
    const alias = first(tokens, token) ?? direct;
    const inner = alias?.match(/var\((--[\w-]+)\)/)?.[1];
    return inner ? first(theme, inner) : undefined;
  };
  // Role leading token → the length of the tier that role is sized at.
  const leadingTierOf = (token: string): string | undefined => {
    if (token === '--maka-line-body') return sizeOf('--text-body-size');
    const role = token.match(/^--text-(.+)-leading$/)?.[1];
    if (!role) return undefined;
    const sized = first(theme, `--text-${role}-size`)?.match(/var\((--[\w-]+)\)/)?.[1];
    return sized ? sizeOf(sized) : undefined;
  };

  const DEFER = /^(?:inherit|unset|revert)$/;
  const offenders: string[] = [];
  for (const { selector, body } of parseCssBlocks(css)) {
    const size = lastDecl(body, 'font-size');
    const leading = lastDecl(body, 'line-height');
    if (!size && !leading) continue;
    if (size && leading && DEFER.test(size) && DEFER.test(leading)) continue;
    if (!leading) {
      offenders.push(`${selector}: declares font-size ${size} and no line-height`);
      continue;
    }
    if (!size) {
      offenders.push(`${selector}: declares line-height ${leading} and no font-size`);
      continue;
    }
    // Naming a token is the whole mechanism: a literal is a copy of what the
    // tier happened to compute before the last scale change. `18px` typed out
    // is how `.maka-onboarding-setup header h1` drifted in the first place,
    // and the em/rem ban alone never saw it.
    const sizeToken = /^var\((--[\w-]+)/.exec(size)?.[1];
    const leadingToken = /^var\((--[\w-]+)/.exec(leading)?.[1];
    if (!sizeToken || !leadingToken) {
      offenders.push(
        `${selector}: font-size ${size} / line-height ${leading} — both must name a scale token`,
      );
      continue;
    }
    const want = sizeOf(sizeToken);
    const got = leadingTierOf(leadingToken);
    if (want && got && want === got) continue;
    offenders.push(
      `${selector}: font-size ${sizeToken} (${want}) paired with ${leadingToken} (${got})`,
    );
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
