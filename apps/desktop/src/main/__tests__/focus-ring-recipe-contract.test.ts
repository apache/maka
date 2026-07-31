/**
 * PR-FOCUS-RING-RECIPE-0 (issue #520 PR2):
 * lock the focus-ring recipe so outline width/offset and box-shadow ring
 * width can't drift back to hand-written px values.
 *
 * Three invariants:
 *
 * 1. `outline:` width must be `var(--focus-ring-width)` (or `none` / `0` to
 *    disable focus). Color stays free: `--focus-ring` (strong accent) or
 *    `--ring` (subtle foreground) for two focus strengths, plus alpha
 *    variants (`oklch(from var(--focus-ring) l c h / 0.42)`). One geometric
 *    recipe, two color strengths.
 * 2. `outline-offset:` must be `var(--focus-ring-offset)`.
 * 3. `box-shadow: 0 0 0 <px> var(--ring)` (global *:focus-visible ring) must
 *    use `var(--focus-ring-width)` for the ring width.
 *
 * `--focus-ring-width: 2px` + `--focus-ring-offset: 2px` + `--focus-glow-width: 4px`
 * are declared in maka-tokens.css. The search-highlight marker
 * (.maka-turn[data-search-highlight="true"]) uses a 1px link-color outline +
 * 6px non-focus offset on purpose — it's a visual highlight, not the keyboard
 * focus-ring recipe, and is whitelisted by selector (not by bare value).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments, assertCustomPropPinnedOnce } from './css-test-helpers.js';

// --- scanning --------------------------------------------------------------

/** Walk back from a declaration index to its enclosing selector — the text
 *  between the previous `}` (or start) and the `{` that opens the rule. */
function enclosingSelector(css: string, idx: number): string {
  const before = css.slice(0, idx);
  const openBrace = before.lastIndexOf('{');
  if (openBrace < 0) return '';
  let selStart = before.lastIndexOf('}', openBrace);
  if (selStart < 0) selStart = 0;
  return css.slice(selStart, openBrace);
}

function findFocusRingOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];

  // outline: <width> solid <color> — width must be var(--focus-ring-width), or none/0
  for (const m of stripped.matchAll(/(?<![-\w])outline:\s*([^;}\n]+)/gi)) {
    const decl = m[0].trim();
    const value = m[1].trim();

    // outline: none / 0 / 0px — literal disable, OK
    if (/^(?:none|0(?:px)?)\b/i.test(value)) continue;
    // outline: var(--focus-ring-width) solid … — recipe, OK
    if (/^var\(--focus-ring-width\)\s+solid\b/i.test(value)) continue;
    // search-highlight one-off: 1px link-color outline (non-focus visual marker)
    const selector = enclosingSelector(stripped, m.index!);
    if (/\.maka-turn\[data-search-highlight="true"\]/.test(selector) && /^1px\s+solid\s+oklch\(from\s+var\(--link\)/i.test(value)) continue;

    // any other outline with a bare px width — offender
    if (/^\d+px\s+solid\b/i.test(value)) {
      offenders.push(`${label}: ${decl} (bare outline width — use var(--focus-ring-width))`);
    }
  }

  // outline-offset: must be var(--focus-ring-offset). The search-highlight
  // marker .maka-turn[data-search-highlight="true"] uses a 6px non-focus offset
  // on purpose (visual highlight, link color) — whitelisted by selector, not
  // by bare value, so a bare 6px in any other focus selector still fails.
  for (const m of stripped.matchAll(/(?<![-\w])outline-offset:\s*([^;}\n]+)/gi)) {
    const decl = m[0].trim();
    const value = m[1].trim();
    if (/^var\(--focus-ring-offset\)/i.test(value)) continue;
    const selector = enclosingSelector(stripped, m.index!);
    if (/\.maka-turn\[data-search-highlight="true"\]/.test(selector)) continue;
    offenders.push(`${label}: ${decl} (bare outline-offset — use var(--focus-ring-offset))`);
  }

  // box-shadow ring/glow width: scan every comma-separated layer inside focus
  // selectors (:focus / :focus-visible / :focus-within). Non-focus highlights
  // (drag-active, status, info, accent rings) reuse the focus-ring color but
  // are NOT the keyboard focus-ring recipe — their box-shadow width convergence
  // is PR4 scope. Walk back from each layer to its enclosing selector and skip
  // non-focus rules. Bare ring width -> var(--focus-ring-width); bare glow halo
  // width (the low-alpha 4px outer ring) -> var(--focus-glow-width).
  for (const m of stripped.matchAll(/(?:box-shadow:\s*|,\s*)(?:inset\s+)?0\s+0\s+0\s+(\d+px)\s+(var\(--ring\)|oklch\(from\s+var\(--focus-ring\)[^)]*\))/gi)) {
    const selector = enclosingSelector(stripped, m.index!);
    if (!/:focus(?:-visible|-within)?\b/i.test(selector)) continue; // non-focus, PR4 scope
    const layer = m[0].replace(/^(?:box-shadow:\s*|,\s*)/, '').trim();
    offenders.push(`${label}: ${layer} (bare ring/glow width in box-shadow — use var(--focus-ring-width) or var(--focus-glow-width))`);
  }

  return offenders;
}

// === tests ==================================================================

describe('PR-FOCUS-RING-RECIPE-0 contract', () => {
  it('renderer CSS uses var(--focus-ring-width/--offset) for outline width/offset + box-shadow ring (no bare px)', async () => {
    const css = await readAllRendererCss();
    const offenders = findFocusRingOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--focus-ring-width / --focus-ring-offset / --focus-glow-width are declared exactly once with pinned values', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--focus-ring-width', '2px');
    assertCustomPropPinnedOnce(tokens, '--focus-ring-offset', '2px');
    assertCustomPropPinnedOnce(tokens, '--focus-glow-width', '4px');
  });
});
