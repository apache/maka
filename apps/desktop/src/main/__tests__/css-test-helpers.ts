import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import postcss, { type AtRule, type ChildNode, type Container, type Document as CssDocument, type Rule } from 'postcss';

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

/** Strip CSS comments without eating a comment delimiter that sits in a string.
 *
 * Quote-aware because the naive regex form is a silent-DELETION bug, not a
 * cosmetic one: a rule whose `content` value holds an open-comment delimiter
 * and whose last declaration holds the closing one makes the regex delete the
 * real declarations between them as if they were comment text, and every scan
 * built on the result goes green on a rule it never saw. Nothing in this tree
 * writes that today, which is exactly when it is cheapest to close. */
export function stripCssComments(src: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += src[i + 1] ?? ''; i += 1; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    out += ch;
  }
  return out;
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
 * chosen together — so a rule names a role and nothing else. Four things have
 * to hold for that to be true, and all four are text:
 *
 *   1. no rule declares font-size, line-height, font-weight or font-family.
 *      Four independent properties are four independent choices; the previous
 *      two convergences (#1857 sizes, #1878 leadings) removed the divergence
 *      that existed without removing the ability to diverge again, because the
 *      properties stayed separate.
 *   2. every `font:` value is a role token or a whole-inheritance literal.
 *      `font: 600 12px/1.4 sans-serif` is the same four choices written on
 *      one line, and it is what the shorthand is normally banned for.
 *   3. every role named is a role defined. A `var()` that resolves to
 *      nothing makes the whole `font:` declaration invalid at computed-value
 *      time, so the element silently keeps whatever it inherits — measured,
 *      `--maka-text-display-1` was referenced by the hero and defined
 *      nowhere, and every other check in this file stayed green.
 *   4. the type vocabulary itself is composed only from other tokens. This is
 *      the bypass the first three cannot see, and it reopens all four axes in
 *      one line: `--maka-text-heading-1: 700 44px/1.05 Impact` at any rule,
 *      followed by `font: var(--maka-text-heading-1)`, names one role and
 *      re-chooses everything. Rebinding is legal and used deliberately (the
 *      transcript rebinds `--text-supporting-leading` to `--maka-line-body`),
 *      so the rule is not "never rebind" — it is "rebind to a token, never to
 *      a value". Astryx's atoms are covered by the same arm, which is where
 *      `calc(2.5)` and `max(24px, 1rem)` used to walk through a ban that only
 *      looked for a leading digit.
 *
 * Scope is every renderer stylesheet INCLUDING maka-tokens.css. An earlier
 * shape of this scan excluded that whole file because the role table has to
 * write one family longhand, and the file is 1400 lines of which ~40 rules are
 * ordinary call sites — so the exclusion silently exempted them from the only
 * remaining guard. The exemption is now the one declaration that actually
 * needs it. */
const FONT_LONGHANDS = ['font-size', 'line-height', 'font-weight', 'font-family'] as const;
const FONT_LITERAL_OK = /^(?:inherit|initial|unset|revert)$/i;
const ROLE_TOKEN_RE = /^var\(\s*(--maka-text-[\w-]+)\s*\)$/;
/** Custom properties that ARE the type vocabulary: role tokens, the family
 * axis the shorthand's mandatory family slot reads, and Astryx's own atoms. */
const TYPE_CUSTOM_PROP_RE =
  /^(?:--maka-text-[\w-]+|--maka-font-family|--text-[\w-]+-(?:size|weight|leading))$/;
/** The only rule in the renderer that may write a font longhand, and the only
 * property it may write. Astryx's reset hardcodes a UA monospace stack on this
 * same element group, and inheritance passes computed values rather than
 * variables, so a bare <code> inside migrated prose cannot be reached by
 * rebinding the axis — it needs the longhand. See maka-tokens.css. */
const FAMILY_ANCHOR = { selector: ':where(code, kbd, samp, pre)', prop: 'font-family' } as const;

export function findTextRoleOffenders(css: string, tokensCss: string, label: string): string[] {
  const defined = new Set(parseCssCustomProps(tokensCss).keys());
  const offenders: string[] = [];
  /** Selectors that have already been given a role in this cascade context. */
  const roled = new Set<string>();
  for (const { selector, rule, conditions, decls } of parseCssBlocks(css)) {
    for (const prop of FONT_LONGHANDS) {
      const value = lastDecl(decls, prop);
      if (value === undefined) continue;
      if (rule === FAMILY_ANCHOR.selector && prop === FAMILY_ANCHOR.prop) continue;
      offenders.push(`${label}: ${selector} declares ${prop}: ${value} — name a text role instead`);
    }
    for (const { prop, value } of decls) {
      if (!TYPE_CUSTOM_PROP_RE.test(prop)) continue;
      const residue = stripVarRefs(value);
      if (residue !== '') {
        offenders.push(`${label}: ${selector} binds ${prop} to ${value} — a type token may be rebound to another token, never to a value`);
      }
    }
    // Count before reading: `lastDecl` reports what the browser uses, so a
    // block that declares a role and then `font: inherit` after it reads as
    // legal while the role line is dead. Measured, `.maka-session-rename-input`
    // was exactly that — it declared `font: inherit` before its longhands, and
    // migrating the longhands to a role left the reset winning.
    const declared = decls.filter((d) => d.prop === 'font').length;
    if (declared > 1) {
      offenders.push(`${label}: ${selector} declares font ${declared} times — a role is not a base to override`);
      continue;
    }
    const font = lastDecl(decls, 'font');
    if (font === undefined) continue;
    if (FONT_LITERAL_OK.test(font)) continue;
    const token = ROLE_TOKEN_RE.exec(font)?.[1];
    if (!token) {
      offenders.push(`${label}: ${selector} declares font: ${font} — only var(--maka-text-*) or inherit/initial/unset/revert`);
      continue;
    }
    if (!defined.has(token)) {
      offenders.push(`${label}: ${selector} names ${token}, which the role table does not define`);
      continue;
    }
    // The same shape as the two-fonts-in-one-rule arm, one level out: a
    // selector handed a role by a grouped rule and then another by its own
    // leaves the grouped one dead, and a later retune of the group moves
    // every OTHER member of it while this site silently stays put. Measured,
    // `.plan-proposal-kicker` was exactly that and had moved a size tier.
    // Keyed on the cascade context, so a `@media` or `@layer` variant of the
    // same selector — a legitimate responsive role swap — is not a duplicate.
    for (const one of splitSelectorList(rule)) {
      const key = `${conditions.join(' ')}|${one}`;
      if (roled.has(key)) {
        offenders.push(`${label}: ${one} is given a text role by more than one rule — a role is not a base to override`);
      }
      roled.add(key);
    }
  }
  return offenders;
}

/** Split a selector list on top-level commas, ignoring those inside `:is()`,
 * `:where()`, `:not()` and attribute strings. */
function splitSelectorList(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = '';
  for (const ch of selector) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** What is left of a value once every `var()` reference is removed. Empty
 * means the value is composed of tokens and separators only. Iterated so a
 * nested fallback (`var(--a, var(--b))`) collapses from the inside out. */
function stripVarRefs(value: string): string {
  let residue = value;
  for (let prev = ''; residue !== prev; ) {
    prev = residue;
    residue = residue.replace(/var\(\s*--[\w-]+\s*(?:,[^()]*)?\)/g, '');
  }
  return residue.replace(/[\s/]/g, '');
}

// --- block + declaration parsing -------------------------------------------

export type CssBlock = {
  /** The declaring context, e.g. `.a` or `.a @media (pointer: coarse)`. */
  selector: string;
  /** The selector of the nearest enclosing style rule. */
  rule: string;
  /** The enclosing at-rule conditions, outermost first — the cascade context
   * a selector's declarations compete in. Two rules for the same selector
   * under different conditions do not override each other. */
  conditions: string[];
  /** That context's OWN declarations, in source order, property lower-cased. */
  decls: { prop: string; value: string }[];
};

/** Every declaring context in a stylesheet, and only its own declarations.
 *
 * PostCSS rather than a hand-rolled brace walk. The hand-rolled one this
 * replaced treated every `{`/`}` as structural regardless of quoting, and —
 * worse — dropped the body of any at-rule outright. That second hole made
 * `.p { font: var(--maka-text-body); @media (pointer: coarse) { font-size: 16px } }`
 * invisible to every scan built on it, which is not a hypothetical shape: it
 * is the one Astryx itself uses for coarse pointers (see the note in
 * e2e/type-scale.spec.ts). Keeping half a CSS parser in a test helper is a
 * second authority on what CSS means; postcss is already what Vite parses this
 * same CSS with.
 *
 * A nested at-rule is emitted as its own block because it is its own cascade
 * context: a role declared in `@media` legitimately replaces the base one, and
 * counting both against one rule would report a false "declares font twice".
 *
 * Top-level at-rules that hold declarations rather than rules (`@font-face`,
 * `@property`, `@page`) are NOT call sites — they are definitions, and
 * `@font-face` exists to declare a font-family. They are skipped, and the tree
 * contains none today. */
export function parseCssBlocks(css: string): CssBlock[] {
  const out: CssBlock[] = [];
  const root = postcss.parse(css);
  root.walk((node) => {
    if (node.type !== 'rule' && node.type !== 'atrule') return;
    const decls = (node.nodes ?? []).flatMap((child) =>
      child.type === 'decl' ? [{ prop: child.prop.toLowerCase(), value: child.value.trim() }] : [],
    );
    if (decls.length === 0) return;

    const rule = nearestRuleSelector(node);
    const conditions = enclosingConditions(node);
    if (node.type === 'rule') {
      const selector = normalizeSelector(node.selector);
      out.push({ selector, rule: selector, conditions, decls });
    } else if (rule !== null) {
      out.push({ selector: `${rule} @${node.name} ${node.params}`.trim(), rule, conditions, decls });
    }
  });
  return out;
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim();
}

/** Every enclosing at-rule's `@name params`, outermost first. `@layer` counts:
 * two rules in different layers are in different cascade contexts too. */
function enclosingConditions(node: ChildNode): string[] {
  const out: string[] = [];
  let up: Container | CssDocument | undefined = node.parent;
  while (up) {
    if (up.type === 'atrule') {
      const at = up as AtRule;
      out.unshift(`@${at.name} ${at.params}`.trim());
    }
    up = up.parent;
  }
  if (node.type === 'atrule') out.push(`@${node.name} ${node.params}`.trim());
  return out;
}

/** The selector of the nearest enclosing style rule, or null at the top level. */
function nearestRuleSelector(node: ChildNode): string | null {
  let up: Container | CssDocument | undefined = node.parent;
  while (up) {
    if (up.type === 'rule') return normalizeSelector((up as Rule).selector);
    up = up.parent;
  }
  return null;
}

/** Last-declared value of `prop` in a block, or undefined.
 *
 * Last, not first: within one block CSS takes the later declaration, so a
 * scanner that reads the first match reports the value the browser discards.
 * `assertCustomPropPinnedOnce` below documents that same false-green at length
 * for custom properties; this is the longhand case of it. */
function lastDecl(decls: CssBlock['decls'], prop: string): string | undefined {
  return decls.filter((d) => d.prop === prop).at(-1)?.value;
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
