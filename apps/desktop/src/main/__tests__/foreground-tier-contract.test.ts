/**
 * PR-FOREGROUND-TIER-CONVERGE-0 (issue #430 PR4, 2026-07-03):
 * lock the text-color vocabulary so individual PRs can't silently drift
 * back to the old multi-step ladder. Text call sites must use the 3
 * semantic aliases:
 *
 *   var(--foreground)            — primary text (100% ink)
 *   var(--foreground-secondary)  — secondary text (80% ink)
 *   var(--muted-foreground)      — muted text (50% ink)
 *
 * --foreground-40..95 are deleted and must not be re-introduced.
 * Surface wash stops (-2/-3/-5/-8/-10) exist for backgrounds, borders,
 * and other non-text surfaces; they must NOT be used as text color.
 *
 * Invariants:
 *
 * 1. CSS text-color props (color/fill/stroke/caret-color/...) must not
 *    reference --foreground-2..95. Only --foreground, --foreground-
 *    secondary, --muted-foreground are allowed as text color.
 *
 * 2. TS/TSX files must not reference --foreground-40..95 at all (any
 *    syntax form). Tailwind utility classes text-foreground-2..95 are
 *    also banned as text color.
 *
 * 3. @theme must not export --color-foreground-40..95 as Tailwind
 *    color utilities.
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, STYLES_FILE, TOKENS_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

// --- banned foreground numbers ----------------------------------------------

/** All foreground mix-stop numbers that must never be used as text color. */
const BANNED_TEXT_NUMS = ['40', '50', '60', '70', '80', '90', '95'];

/** Surface-wash numbers — allowed in bg/border context, banned in text context. */
const SURFACE_WASH_NUMS = ['2', '3', '5', '8', '10'];

// Properties that set TEXT color (not background/border/shadow).
const TEXT_PROP_RE = /^(color|fill|stroke|caret-color|text-decoration-color|column-rule-color)$/i;

// CSS foreground token reference — matches both --foreground-N and
// --color-foreground-N (the @theme mirror form). Does NOT require
// var() to be closed — catches `var(--foreground-5, currentColor)`.
const FOREGROUND_TOKEN_RE = /--(?:color-)?foreground-(\d+)\b/g;

// --- CSS scanning -----------------------------------------------------------

/**
 * Extract color property declarations and check they don't reference
 * any banned foreground stop as text color. Text props must only use
 * the 3 semantic aliases (--foreground, --foreground-secondary,
 * --muted-foreground). Surface wash stops are banned in text context
 * but allowed in bg/border context.
 *
 * Declaration values may span multiple lines (e.g. color-mix() with
 * line breaks). The value regex matches [^;}]+ so newlines are
 * included.
 *
 * Also scans @apply utility lists via findCssApplyOffenders.
 */
function findCssTextOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  const bannedNumsSet = new Set(BANNED_TEXT_NUMS.concat(SURFACE_WASH_NUMS));

  // Value may span multiple lines — stop at ; or } (or EOF).
  const declRe = /([\w-]+)\s*:\s*([^;}]+?)\s*(?:[;}]|$)/gi;
  for (const m of stripped.matchAll(declRe)) {
    const prop = m[1]!;
    const rawVal = m[2]!.trim();
    if (!TEXT_PROP_RE.test(prop)) continue;

    for (const vm of rawVal.matchAll(FOREGROUND_TOKEN_RE)) {
      const num = vm[1]!;
      if (bannedNumsSet.has(num)) {
        offenders.push(`${label}: ${prop}: ${rawVal} [banned --foreground-${num}]`);
      }
    }
  }

  return offenders;
}

/**
 * Scan @apply utility lists for text-like foreground classes.
 * Reuses the TSX token classifier (isTextLikeClass / isBareTextProperty)
 * to determine context. Surface utilities (bg-/border-/ring-) pass.
 */
function findCssApplyOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  const applyRe = /@apply\s+([^;]+);/gi;
  for (const m of stripped.matchAll(applyRe)) {
    const utilityList = m[1]!;
    for (const tm of utilityList.matchAll(TOKEN_RE)) {
      const tok = tm[0];
      if (!tok.includes('foreground')) continue;
      if (!isTextLikeClass(tok) && !isBareTextProperty(tok)) continue;
      const um = stripVariant(tok).match(UTILITY_CLASS_RE);
      if (um) {
        offenders.push(`${label}: @apply text-foreground-${um[1]}`);
      }
      for (const fm of tok.matchAll(FG_IN_TOKEN_RE)) {
        const num = fm[1]!;
        if (SURFACE_WASH_NUMS.includes(num)) {
          offenders.push(`${label}: @apply text-context --foreground-${num}`);
        }
      }
    }
  }
  return offenders;
}

// --- TSX scanning -----------------------------------------------------------

/**
 * Two-layer scan strategy:
 *
 * 1. RAW_STOP_THEME_RE: --foreground-40..95 and --color-foreground-40..95
 *    (the @theme mirror form) are deleted; ban them from TS/TSX entirely
 *    (any syntax form, any context).
 *
 * 2. Token-based context scan: split source into class-like tokens, then
 *    classify each token as text-like or surface-like by its prefix.
 *    Text-like tokens (text/fill/stroke/caret/decoration prefix, or bare
 *    [color:...] arbitrary property) trigger a search for
 *    --(?:color-)?foreground-N anywhere inside the token — not just right
 *    after the prefix. This catches complex arbitrary values like
 *    text-[color:color-mix(in_oklch,var(--foreground-5),...)].
 *
 * 3. Text-property value scan: inline-style declarations
 *    (style={{ color: "..." }}) and JSX attributes (fill="...", stroke={...})
 *    are scanned by locating the property name, then extracting the full
 *    value (quoted or bare) and searching for foreground tokens inside.
 *    Covers camelCase props (caretColor, textDecorationColor) and complex
 *    values (color-mix(...)).
 *
 *    Surface-context prefixes (bg-, border-, ring-, from-, to-, via-,
 *    [background:, [border-color:) are NOT matched — surface wash stops
 *    remain addressable there.
 */
const RAW_STOP_THEME_RE = /--(?:color-)?foreground-(40|50|60|70|80|90|95)\b/g;

/** Utility prefixes that set TEXT color. */
const TEXT_PREFIXES = new Set(['text', 'fill', 'stroke', 'caret', 'decoration']);

/**
 * Strip Tailwind variant prefixes (hover:, sm:, disabled:, group-hover:,
 * data-[...]:, [&...]:, named-group /name, etc.) from a class token.
 *
 * Strategy: scan from right to left, tracking bracket/paren depth, and
 * cut at the last `:` that is outside any `[]`/`()` nesting. This
 * uniformly handles arbitrary variants like `data-[state=open]:` and
 * `[&.is-dragging]:` without hand-writing a regex per variant form.
 */
function stripVariant(cls: string): string {
  let depth = 0;
  for (let i = cls.length - 1; i >= 0; i--) {
    const c = cls[i];
    if (c === ']' || c === ')') depth++;
    else if (c === '[' || c === '(') depth--;
    else if (c === ':' && depth === 0) return cls.slice(i + 1);
  }
  return cls;
}

/** Does this class token have a text-like utility prefix? */
function isTextLikeClass(cls: string): boolean {
  const m = stripVariant(cls).match(/^([a-z]+)/);
  return m !== null && TEXT_PREFIXES.has(m[1]!);
}

/** Bare arbitrary property setting text color: [color:...], [fill:...],
 *  [stroke:...], [caret-color:...], etc. */
const BARE_TEXT_PROP_RE = /^\[(color|fill|stroke|caret-color|text-decoration-color|column-rule-color):/i;

function isBareTextProperty(cls: string): boolean {
  return BARE_TEXT_PROP_RE.test(stripVariant(cls));
}

/** Utility class form: text-foreground-N (no --). Captures N. */
const UTILITY_CLASS_RE = /^(?:text|fill|stroke|caret|decoration)-foreground-(\d+)/;

/** Splits source into class-like tokens (non-whitespace, non-quote, non-brace). */
const TOKEN_RE = /[^\s"'`;{}=]+/g;

/** Find --(?:color-)?foreground-N (any N) inside a token string. */
const FG_IN_TOKEN_RE = /--(?:color-)?foreground-(\d+)\b/g;

/** Text-like property names (kebab-case CSS + camelCase JS + SVG attrs).
 *  Shared by scanTextPropValue and BARE_TEXT_PROP_RE to avoid drift. */
const TEXT_PROP_NAMES = [
  'color', 'fill', 'stroke',
  'caret-color', 'text-decoration-color', 'column-rule-color',
  'caretColor', 'textDecorationColor', 'columnRuleColor',
];

/**
 * Scan inline-style declarations and JSX attributes for text-like
 * properties whose value references a foreground stop.
 *
 * Locates the property name (preceded by `{`, `,`, `<`, or whitespace
 * to avoid matching inside Tailwind class tokens), then extracts the
 * full value via readExpressionValue — a bracket/quote-depth-aware
 * reader that stops at the real end of the current property/attribute,
 * not at the first comma or newline.
 */
function scanTextPropValue(src: string): string[] {
  const offenders: string[] = [];
  const namesAlt = TEXT_PROP_NAMES.join('|');
  const propRe = new RegExp(`(?:[{,]\\s*|^\\s*|\\s)(${namesAlt})\\s*[:=]\\s*`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = propRe.exec(src)) !== null) {
    const val = readExpressionValue(src, m.index + m[0].length);
    for (const fm of val.matchAll(FG_IN_TOKEN_RE)) {
      const num = fm[1]!;
      offenders.push(`text-prop --foreground-${num}`);
    }
  }
  return offenders;
}

/**
 * Read a single JS/CSS expression value starting at `start`, tracking
 * quote, parenthesis, bracket, and brace depth. Stops at:
 *  - Closing quote (if the value starts with one)
 *  - Depth-0 comma (next property in an object/style declaration)
 *  - Depth-0 semicolon (CSS declaration end)
 *  - Depth-0 opening brace (function/class body — not part of the value)
 *  - Depth-0 closing brace (style object end, or JSX expression end)
 *
 * Characters inside quotes do not affect depth, so commas/braces in
 * string literals are ignored. Handles multi-line expressions.
 * If the value starts with `{` (JSX expression), it is treated as a
 * nested expression — the opening brace increments depth so the
 * matching closing brace terminates the value.
 */
function readExpressionValue(src: string, start: number): string {
  let i = start;
  // Skip leading whitespace.
  while (i < src.length && /\s/.test(src[i]!)) i++;
  // Quoted value: read to closing quote.
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === '`') {
    const end = src.indexOf(ch, i + 1);
    return end < 0 ? src.slice(i) : src.slice(i, end + 1);
  }
  // Unquoted: track ()[]{} depth, stop at depth-0 , ; { }
  const out: string[] = [];
  let depth = 0;
  // JSX expression {value}: opening brace is part of the value.
  if (ch === '{') { depth = 1; out.push(ch); i++; }
  while (i < src.length) {
    const c = src[i]!;
    // Skip over string literals so their contents don't affect depth.
    if (c === '"' || c === "'" || c === '`') {
      const close = src.indexOf(c, i + 1);
      const segEnd = close < 0 ? src.length : close + 1;
      out.push(src.slice(i, segEnd));
      i = segEnd;
      continue;
    }
    if (c === '(' || c === '[') { depth++; out.push(c); i++; continue; }
    if (c === ')' || c === ']') { depth--; out.push(c); i++; continue; }
    if (c === '{' && depth <= 0) break; // function/class body boundary
    if (c === '{') { depth++; out.push(c); i++; continue; }
    if (c === '}') { depth--; out.push(c); i++; if (depth <= 0) break; continue; }
    if ((c === ',' || c === ';') && depth <= 0) break;
    out.push(c); i++;
  }
  return out.join('');
}

async function collectTsxOffenders(dirs: string[]): Promise<string[]> {
  const offenders: string[] = [];
  const surfaceSet = new Set(SURFACE_WASH_NUMS);
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(tsx|ts)$/.test(entry.name)) continue;
      if (entry.name.includes('.test.')) continue;
      const src = await readFile(full, 'utf8');
      const label = full.replace(REPO_ROOT + '/', '');
      offenders.push(...scanTsx(src).map((o) => `${label}: ${o}`));
    }
  }
  for (const dir of dirs) {
    await walk(resolve(REPO_ROOT, dir));
  }
  return offenders;
}

/** Scan TS/TSX source for banned foreground references. Returns offender strings. */
function scanTsx(src: string): string[] {
  const offenders: string[] = [];
  const surfaceSet = new Set(SURFACE_WASH_NUMS);

  // 1. Deleted stops (incl. --color-foreground-N mirror): banned anywhere.
  for (const m of src.matchAll(RAW_STOP_THEME_RE)) {
    offenders.push(`--foreground-${m[1]}`);
  }

  // 2. Class-like tokens: check if text-like context, then search for
  //    --(?:color-)?foreground-N anywhere inside (handles complex
  //    arbitrary values like color-mix() wrapping).
  for (const m of src.matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (!tok.includes('foreground')) continue;
    if (!isTextLikeClass(tok) && !isBareTextProperty(tok)) continue;

    // Utility class form: text-foreground-N (no -- prefix) — ban all N.
    const um = stripVariant(tok).match(UTILITY_CLASS_RE);
    if (um) {
      offenders.push(`text-foreground-${um[1]}`);
    }

    // CSS var form: --(?:color-)?foreground-N anywhere in token — ban surface wash.
    for (const fm of tok.matchAll(FG_IN_TOKEN_RE)) {
      const num = fm[1]!;
      if (surfaceSet.has(num)) {
        offenders.push(`text-context --foreground-${num}`);
      }
    }
  }

  // 3. Text-property values: inline style (style={{ color: "..." }})
  //    and JSX attributes (fill="...", stroke={...}). Scans the full
  //    value for foreground tokens, handles camelCase + complex values.
  offenders.push(...scanTextPropValue(src));

  return offenders;
}

// === tests ==================================================================

/** Scan a TSX source snippet for banned foreground references. */
function scanTsxSnippet(src: string): string[] {
  return scanTsx(src);
}

describe('PR-FOREGROUND-TIER-CONVERGE-0 contract', () => {
  it('CSS text-color props use semantic aliases, not raw --foreground-40..80', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssTextOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('maka-tokens.css text-color props use semantic aliases', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    // Strip alias definition lines and @theme mirror lines — they
    // legitimately reference --foreground (no number suffix).
    const stripped = tokens
      .replace(/^\s*--muted-foreground:\s*color-mix.*$/gm, '')
      .replace(/^\s*--foreground-secondary:\s*color-mix.*$/gm, '')
      .replace(/^\s*--color-foreground-secondary:.*$/gm, '')
      .replace(/^\s*--color-muted-foreground:.*$/gm, '');
    const offenders = findCssTextOffenders(stripped, 'maka-tokens.css');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('renderer CSS has no deleted raw --foreground-40..95 (any context)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const offenders: string[] = [];
    for (const m of css.matchAll(RAW_STOP_THEME_RE)) {
      offenders.push(`renderer CSS: --foreground-${m[1]}`);
    }
    assert.deepEqual(offenders, [], `Deleted raw stops must not appear:\n  ${offenders.join('\n  ')}`);
  });

  it('maka-tokens.css has no deleted raw --foreground-40..95 (any context)', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    const offenders: string[] = [];
    for (const m of tokens.matchAll(RAW_STOP_THEME_RE)) {
      offenders.push(`maka-tokens.css: --foreground-${m[1]}`);
    }
    assert.deepEqual(offenders, [], `Deleted raw stops must not appear:\n  ${offenders.join('\n  ')}`);
  });

  it('TSX text-color uses semantic aliases, not raw --foreground-40..80', async () => {
    const offenders = await collectTsxOffenders([
      'packages/ui/src',
      'packages/ui/stories',
      'apps/desktop/src/renderer',
    ]);
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('renderer CSS @apply does not use text-like foreground utilities', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssApplyOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--muted-foreground is defined as 50% foreground mix', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--muted-foreground:\s*color-mix\(in oklch,\s*var\(--foreground\)\s*50%,\s*var\(--background\)\)/, '--muted-foreground must be 50% foreground mix');
  });

  it('--foreground-secondary is defined as 80% foreground mix', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--foreground-secondary:\s*color-mix\(in oklch,\s*var\(--foreground\)\s*80%,\s*var\(--background\)\)/, '--foreground-secondary must be 80% foreground mix');
  });

  it('raw text mix stops --foreground-40..95 are not defined', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    for (const num of BANNED_TEXT_NUMS) {
      const re = new RegExp(`^\\s*--foreground-${num}:`, 'm');
      assert.doesNotMatch(tokens, re, `--foreground-${num} must not be defined`);
    }
  });

  it('@theme inline exports the semantic aliases', async () => {
    const styles = await readFile(STYLES_FILE, 'utf8');
    assert.match(styles, /--color-foreground-secondary:\s*var\(--foreground-secondary\)/, '@theme must export --color-foreground-secondary');
    assert.match(styles, /--color-muted-foreground:\s*var\(--muted-foreground\)/, '@theme must export --color-muted-foreground');
  });

  it('@theme inline does not export raw text stops --foreground-40..95', async () => {
    const styles = stripCssComments(await readFile(STYLES_FILE, 'utf8'));
    for (const num of BANNED_TEXT_NUMS) {
      const re = new RegExp(`--color-foreground-${num}\\s*:`);
      assert.doesNotMatch(styles, re, `@theme must not export --color-foreground-${num}`);
    }
  });
});

describe('foreground-tier negative cases', () => {


















  // P2: CSS 90/95 must be banned in text props too


  // P2: surface wash stops banned in text context




  // P2: surface wash stops allowed in non-text context




  // P2: arbitrary property, type-hint shorthand, fill/stroke/caret/decoration utility







  // P2: var() with fallback — must not depend on closing paren


  // P2: surface context still allowed


  // P3: surface arbitrary property must not be误杀




  // P2: CSS var() fallback — text context must fail even with fallback



  // P2: @theme 90/95 export banned
  it('@theme must not export --color-foreground-90/95', async () => {
    const styles = stripCssComments(await readFile(STYLES_FILE, 'utf8'));
    for (const num of ['90', '95']) {
      const re = new RegExp(`--color-foreground-${num}\\s*:`);
      assert.doesNotMatch(styles, re, `@theme must not export --color-foreground-${num}`);
    }
  });

  // P3-a: surface utility with [color:] type hint must pass



  // P2-b: complex arbitrary value — token must be found anywhere in payload


  // P2-b: CSS multi-line declaration value


  // P2-a: global raw stop ban in CSS (non-text context)


  // P2: complex Tailwind variants must be stripped correctly





  // P2: quoted inline style — surface wash as text color




  // P2-a: --color-foreground-N theme mirror must be caught as text color





  // P2-b: @apply with text-like foreground utility




  // P2-c: complex inline style value + camelCase + SVG attrs




  // P2: bare arbitrary property [fill:] / [stroke:] must be caught





  // P2: unquoted complex expression in inline style / JSX attr



  // P2: multi-line expression + depth-aware property boundary


  // P3: TypeScript type annotation must not scan into function body
});
