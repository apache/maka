import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import postcss, { type AtRule, type ChildNode, type Container, type Document as CssDocument, type Rule } from 'postcss';

export const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
export const RENDERER_STYLES_ENTRY = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

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

/** Split a selector list on top-level commas, ignoring those inside `:is()`,
 * `:where()`, `:not()` and attribute strings. */
export function splitSelectorList(selector: string): string[] {
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
 * is the one Astryx itself uses for coarse pointers. Keeping a second CSS
 * parser in test code would create another authority on what CSS means;
 * postcss is already what Vite parses this same CSS with.
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
      const selector = resolveNesting(normalizeSelector(node.selector), rule);
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

/**
 * A nested rule's selector rewritten against its nearest style-rule ancestor.
 *
 * Without this, `.a { & { height: auto } }` is emitted under the literal key
 * `&` — so it neither reaches `.a` (a false green) nor stays distinct from
 * every OTHER nested rule in the tree, which all collide on that one key.
 * Nothing in this tree nests today; that is exactly when it is cheapest to
 * close, because the first nested rule someone writes would otherwise walk
 * through every scan built on these blocks.
 */
function resolveNesting(selector: string, parent: string | null): string {
  if (parent === null) return selector;
  return splitSelectorList(selector)
    .map((one) => (one.includes('&') ? one.replaceAll('&', parent) : `${parent} ${one}`))
    .join(', ');
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
