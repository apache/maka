/**
 * PR-SPACING-CONVERGE-0 (issue #430 PR3, 2026-07-03):
 * lock the spacing vocabulary so individual PRs can't silently drift
 * back to ad-hoc padding/gap/margin px values.
 *
 * Three invariants:
 *
 * 1. CSS padding/margin/gap must reference a whitelisted --space-* token,
 *    use calc(var(--spacing) * N), or be a literal (0 / auto / inherit /
 *    initial / 1px hairline). Bare Npx drifts visually and bypasses the
 *    scale. Responsive clamp()/max()/min() bounds are allowed to contain
 *    bare px — they are viewport parameters, not spacing beats.
 *
 * 2. --space-* and --spacing tokens are defined in maka-tokens.css with
 *    pinned values. A rename or value change gets flagged at the test
 *    layer before any style site drifts.
 *
 * 3. The @theme inline bridge in styles.css exports --spacing: 4px so
 *    Tailwind's p-N/gap-N/m-N utilities share the same ruler as
 *    hand-written var(--space-N). Without this, Tailwind's default
 *    0.25rem (3.75px under 15px root) would re-split the two scales.
 *
 * Spacing has no single-property anchor like border-radius (adversarial
 * review in #430), so the contract scopes to padding/margin/gap only —
 * not width/height/inset/grid-template, which have their own semantics.
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, STYLES_FILE, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

// --- token whitelist --------------------------------------------------------

const SPACE_TOKEN_WHITELIST = new Set([
  '--spacing',
  '--space-0',
  '--space-0-5',
  '--space-1',
  '--space-1-5',
  '--space-2',
  '--space-2-5',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-8',
  '--space-10',
  '--space-12',
  '--space-16',
]);

// Literals that are always allowed (not spacing beats).
const LITERAL_OK = /^(?:0(?:px)?|auto|inherit|initial|unset|revert)$/;
// 1px and -1px are hairline borders, not spacing beats.
const HAIRLINE_OK = /^-?1px$/;

// Properties the contract scopes to (no single anchor like radius).
const SPACING_PROP_RE = /^(padding|padding-(?:top|right|bottom|left|inline|inline-start|inline-end|block|block-start|block-end)|margin|margin-(?:top|right|bottom|left|inline|inline-start|inline-end|block|block-start|block-block)|gap|row-gap|column-gap)$/i;

function extractSpaceToken(expr: string): string | null {
  const m = expr.trim().match(/^var\(\s*(--space-[\w-]+|--spacing)\s*\)$/);
  return m ? m[1] : null;
}

function isWhitelistedVar(expr: string): boolean {
  const tok = extractSpaceToken(expr);
  return tok !== null && SPACE_TOKEN_WHITELIST.has(tok);
}

/**
 * calc() must reference var(--spacing) or a whitelisted --space-* token,
 * optionally negated (for negative margins). Forms like
 * `calc(var(--space-2) * -1)` and `calc(var(--spacing) * 2)` are OK.
 */
const CALC_RE = /^calc\(\s*var\(\s*(--spacing|--space-[\w-]+)\s*\)\s*(?:\*\s*-?\d+(?:\.\d+)?)?\s*\)$/;

function isWhitelistedCalc(expr: string): boolean {
  const m = expr.match(CALC_RE);
  if (!m) return false;
  return SPACE_TOKEN_WHITELIST.has(m[1]);
}

function isAllowedValue(val: string): boolean {
  const v = val.trim();
  if (LITERAL_OK.test(v)) return true;
  if (HAIRLINE_OK.test(v)) return true;
  if (isWhitelistedVar(v)) return true;
  if (isWhitelistedCalc(v)) return true;
  return false;
}

// --- CSS scanning -----------------------------------------------------------

/**
 * Split a declaration value into its space-separated components and check
 * each. For multi-value shorthand like `padding: var(--space-2) var(--space-3)`,
 * each component must independently pass isAllowedValue. calc() and var()
 * expressions are treated as single components (no internal spaces unless
 * inside parens).
 */
function splitValues(val: string): string[] {
  // Split on spaces not inside parentheses.
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of val) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) {
      if (cur) parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * Check if a bare px value sits inside a clamp()/max()/min() call —
 * those are responsive viewport parameters, not spacing beats.
 * Walks backwards from the px position tracking paren depth, continuing
 * through intermediate calc() nesting to find the outermost function.
 */
function isInsideResponsiveFunction(decl: string, pxIndex: number): boolean {
  let depth = 0;
  for (let i = pxIndex - 1; i >= 0; i--) {
    const ch = decl[i];
    if (ch === ')') depth++;
    if (ch === '(') {
      if (depth === 0) {
        const before = decl.slice(0, i);
        if (before.match(/(clamp|max|min)\s*$/)) return true;
        if (before.match(/calc\s*(?:\(\s*)?$/)) continue;
        return false;
      }
      depth--;
    }
  }
  return false;
}

function findCssOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];

  // Match spacing property declarations (with or without trailing ;}).
  const declRe = /([\w-]+)\s*:\s*([^;}\n]+?)\s*(?:[;}|\n]|$)/gi;
  for (const m of stripped.matchAll(declRe)) {
    const prop = m[1]!;
    const rawVal = m[2]!.trim();
    if (!SPACING_PROP_RE.test(prop)) continue;

    // Check for bare px outside of var()/calc()/clamp()/max()/min().
    const barePxRe = /(?<![\w-])-?\d+(?:\.\d+)?px(?![\w-])/g;
    let pxMatch: RegExpExecArray | null;
    while ((pxMatch = barePxRe.exec(rawVal)) !== null) {
      const px = pxMatch[0];
      // 1px / -1px hairline is allowed.
      if (HAIRLINE_OK.test(px)) continue;
      // Inside clamp/max/min — responsive param, allowed.
      if (isInsideResponsiveFunction(rawVal, pxMatch.index ?? 0)) continue;
      offenders.push(`${label}: ${prop}: ${rawVal} [bare ${px}]`);
    }

    // Also verify each split component is allowed (catches unknown tokens).
    const parts = splitValues(rawVal);
    for (const part of parts) {
      if (isAllowedValue(part)) continue;
      // Unknown var(--space-*) token (not in whitelist).
      const tok = extractSpaceToken(part);
      if (tok && !SPACE_TOKEN_WHITELIST.has(tok)) {
        offenders.push(`${label}: ${prop}: ${rawVal} [unknown token ${tok}]`);
        continue;
      }
      // Complex expressions (calc, clamp, max, min) — checked by bare px scan.
      if (part.includes('calc(') || part.includes('clamp(') || part.includes('max(') || part.includes('min(')) continue;
      // Non-spacing literals (em, %, vh, vw) — not spacing beats, allow.
    }
  }

  return offenders;
}

// --- TSX scanning -----------------------------------------------------------

const TSX_SPACING_RE = /\b(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-\[-?(\d+(?:\.\d+)?)px\]/g;

async function collectTsxOffenders(): Promise<string[]> {
  const offenders: string[] = [];
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
      const src = await readFile(full, 'utf8');
      const label = full.replace(REPO_ROOT + '/', '');
      for (const m of src.matchAll(TSX_SPACING_RE)) {
        const px = m[2]!;
        // 1px hairline is allowed.
        if (px === '1') continue;
        offenders.push(`${label}: ${m[0]}`);
      }
    }
  }
  await walk(resolve(REPO_ROOT, 'packages/ui/src'));
  await walk(resolve(REPO_ROOT, 'apps/desktop/src/renderer'));
  return offenders;
}

// === tests ==================================================================

describe('PR-SPACING-CONVERGE-0 contract', () => {
  it('CSS padding/margin/gap uses only --space-* tokens, calc, or literals (no bare Npx)', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('maka-tokens.css uses only --space-* tokens or literals in spacing props', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    // Strip the token declaration lines themselves (they legitimately spell px).
    const stripped = tokens
      .replace(/^\s*--spacing:\s*4px\s*;?\s*$/gm, '')
      .replace(/^\s*--space-[\w-]+:\s*[^;]+\s*;?\s*$/gm, '');
    const offenders = findCssOffenders(stripped, 'maka-tokens.css');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--spacing is defined as 4px (absolute, not 0.25rem)', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--spacing:\s*4px/, '--spacing must be absolute 4px (not 0.25rem which is 3.75px under 15px root)');
    assert.doesNotMatch(tokens, /--spacing:\s*0\.25rem/, '--spacing must not be 0.25rem');
  });

  it('--space-* tokens are defined with correct calc(var(--spacing) * N) values', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    const pins: Array<[string, string]> = [
      ['--space-0', '0'],
      ['--space-0-5', 'calc(var(--spacing) * 0.5)'],
      ['--space-1', 'calc(var(--spacing) * 1)'],
      ['--space-1-5', 'calc(var(--spacing) * 1.5)'],
      ['--space-2', 'calc(var(--spacing) * 2)'],
      ['--space-2-5', 'calc(var(--spacing) * 2.5)'],
      ['--space-3', 'calc(var(--spacing) * 3)'],
      ['--space-4', 'calc(var(--spacing) * 4)'],
      ['--space-5', 'calc(var(--spacing) * 5)'],
      ['--space-6', 'calc(var(--spacing) * 6)'],
      ['--space-8', 'calc(var(--spacing) * 8)'],
      ['--space-10', 'calc(var(--spacing) * 10)'],
      ['--space-12', 'calc(var(--spacing) * 12)'],
      ['--space-16', 'calc(var(--spacing) * 16)'],
    ];
    for (const [name, val] of pins) {
      const valEsc = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(tokens, new RegExp(`${name}:\\s*${valEsc}`), `${name} must be ${val}`);
    }
  });

  it('Tailwind @theme inline exports --spacing: 4px so p-N/gap-N share the ruler', async () => {
    const styles = await readFile(STYLES_FILE, 'utf8');
    assert.match(styles, /@theme inline \{[\s\S]*--spacing:\s*4px/, 'styles.css @theme inline must export --spacing: 4px');
  });

  it('TSX has no arbitrary p-[Npx]/gap-[Npx]/m-[Npx] utilities (except 1px hairline)', async () => {
    const offenders = await collectTsxOffenders();
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });
});
