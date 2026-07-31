/**
 * PR-BORDER-WIDTH-CONVERGE-0 (issue #520 PR4 item 14, 2026-07-05):
 * lock the border-stroke width vocabulary so individual PRs can't drift
 * back to bare Npx in `border:` / `border-{side}:` shorthand.
 *
 * Border COLOR was already tokenized (--border / --border-strong); the
 * WIDTH was bare px in every `border: 1px solid var(--border)` shorthand
 * plus a handful of `border-left: 3px solid …` status strips. Three
 * semantic weights cover the whole app:
 *
 *   --border-width-hairline  1px  the universal divider (210+ sites)
 *   --border-width-thick     2px  a heavier divider / selected outline
 *   --border-width-accent    3px  a status / decorative strip (toast
 *                                 variant color bars, avatar rings)
 *
 * The rare 1.5px hairlines snap to hairline; the one 4px avatar ring snaps
 * to accent. Border-STYLE (solid / dashed) stays a literal keyword — it is
 * a named value, not a magic number, so tokenizing it adds indirection
 * with no governance benefit. CSS-triangle carets (`border-width: 4px 0
 * 4px 5px`) are multi-value geometry, not border strokes, so the contract
 * allows them only on allowlisted caret selectors (TRIANGLE_CARET_SELECTORS)
 * and flags any bare px — single OR multi-value — elsewhere.
 *
 * Four invariants:
 *
 * 1. `border:` / `border-{side}:` shorthand must reference a
 *    `--border-width-*` token for its width (the only bare-px slot in a
 *    border shorthand — color is in var()/oklch(), style is a keyword).
 *    Bare `Npx` drifts visually and bypasses the scale.
 *
 * 2. `border-width:` / `border-{side}-width:` longhand must not carry a
 *    bare px value (single OR multi-value like `1px 2px`) unless the
 *    current selector is a known triangle/caret (allowlisted in
 *    TRIANGLE_CARET_SELECTORS) whose multi-value is geometry, not a
 *    stroke. A value-shape heuristic that spared ALL multi-value would
 *    miss a `1px 2px` stroke drift; the selector allowlist is precise.
 *
 * 3. `border-style:` / `border-{side}-style:` must be a literal keyword
 *    (solid / dashed / dotted / double / groove / ridge / inset / outset
 *    / none / hidden / inherit / initial / revert / unset). No bare px
 *    belongs in a style declaration.
 *
 * 4. TSX has no arbitrary `border-[Npx]` / `border-{side}-[Npx]` widths —
 *    use the Tailwind border-width scale (`border` = 1px = hairline,
 *    `border-2` = thick, `border-4`) so TSX and CSS share the same weights.
 *    Tailwind `border` defaults to 1px, which matches the pinned hairline;
 *    the CSS token and the Tailwind utility agree on the value.
 */

import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  REPO_ROOT,
  TOKENS_FILE,
  readAllRendererCss,
  stripCssComments,
  assertCustomPropPinnedOnce,
} from './css-test-helpers.js';

// --- helpers ---------------------------------------------------------------

/** Remove balanced fn(...) substrings for color/calc/token functions so a
 *  bare-px scan only sees px that are NOT inside var()/calc()/oklch()/
 *  color-mix()/rgb()/rgba()/hsl()/hsla(). Repeats so nested calls collapse. */
function stripFnValues(value: string): string {
  const FN_RE = /\b(?:oklch|var|calc|color-mix|rgb|rgba|hsl|hsla|env|clamp|min|max)\s*\((?:[^()]+|\([^()]*\))*\)/g;
  let prev = value;
  let cur = value.replace(FN_RE, '');
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(FN_RE, '');
  }
  return cur;
}

const BARE_PX_RE = /(?<![\w-])-?\d+(?:\.\d+)?px(?![\w-])/;

/** Selectors whose `border-width:` longhand is CSS-triangle caret geometry
 *  (a disclosure arrow / a checkbox checkmark), not a border stroke. They
 *  are allowlisted by SELECTOR so a new `border-width: 1px 2px` drift on
 *  any other selector is still caught — add a new caret here only after
 *  confirming it is geometry, not a stroke. */
const TRIANGLE_CARET_SELECTORS = new Set([
  '.maka-turn-thinking [data-slot="collapsible-trigger"]::before',
]);

const BORDER_STYLE_KEYWORDS = new Set([
  'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset',
  'none', 'hidden', 'inherit', 'initial', 'revert', 'unset',
]);

// Properties the contract scopes to.
const BORDER_SHORTHAND_RE = /^\s*border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?\s*:/i;
const BORDER_WIDTH_LONGHAND_RE = /^\s*border(?:-(?:top|right|bottom|left|inline-start|inline-end|block-start|block-end|inline|block))?-width\s*:/i;
const BORDER_STYLE_LONGHAND_RE = /^\s*border(?:-(?:top|right|bottom|left|inline-start|inline-end|block-start|block-end|inline|block))?-style\s*:/i;

function findCssOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  // Track the current selector (text before `{` on the most recent line that
  // opens a rule) so `border-width:` longhand can be allowlisted by selector
  // for the known triangle/caret geometries. Flat enough for maka's CSS;
  // nested @media update currentSelector to the inner selector.
  let currentSelector = '';
  for (const line of stripped.split('\n')) {
    const braceIdx = line.indexOf('{');
    if (braceIdx !== -1) {
      currentSelector = line.slice(0, braceIdx).trim().replace(/\s+/g, ' ');
    }
    if (BORDER_SHORTHAND_RE.test(line)) {
      // border / border-{side} shorthand: width is the only bare-px slot.
      const decl = line.replace(BORDER_SHORTHAND_RE, '').trim().replace(/!\s*important$/, '').replace(/[;}]+$/, '').trim();
      const cleaned = stripFnValues(decl);
      if (BARE_PX_RE.test(cleaned)) {
        offenders.push(`${label}: ${line.trim()} [bare px width — use var(--border-width-*)]`);
      }
      continue;
    }
    if (BORDER_WIDTH_LONGHAND_RE.test(line)) {
      // border-{side}-width longhand: ANY bare px is a stroke drift (single
      // OR multi-value like `1px 2px`), UNLESS the current selector is a
      // known triangle/caret (allowlisted above) whose multi-value is
      // geometry, not a stroke.
      const decl = line.replace(BORDER_WIDTH_LONGHAND_RE, '').trim().replace(/!\s*important$/, '').replace(/[;}]+$/, '').trim();
      const cleaned = stripFnValues(decl).trim();
      if (BARE_PX_RE.test(cleaned) && !TRIANGLE_CARET_SELECTORS.has(currentSelector)) {
        offenders.push(`${label}: ${line.trim()} [bare px border-width — use var(--border-width-*), or add the selector to TRIANGLE_CARET_SELECTORS if it is caret geometry]`);
      }
      continue;
    }
    if (BORDER_STYLE_LONGHAND_RE.test(line)) {
      const decl = line.replace(BORDER_STYLE_LONGHAND_RE, '').trim().replace(/!\s*important$/, '').replace(/[;}]+$/, '').trim();
      const kw = decl.split(/\s+/)[0] ?? '';
      if (!BORDER_STYLE_KEYWORDS.has(kw.toLowerCase())) {
        offenders.push(`${label}: ${line.trim()} [border-style must be a keyword literal, got ${kw}]`);
      }
      continue;
    }
  }
  return offenders;
}

// --- TSX scanning ----------------------------------------------------------

const TSX_BORDER_ARBITRARY_RE = /\bborder(?:-(?:top|right|bottom|left|inline-start|inline-end|block-start|block-end|inline|block))?-\[-?\d+(?:\.\d+)?px\]/g;

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
      for (const m of src.matchAll(TSX_BORDER_ARBITRARY_RE)) {
        offenders.push(`${label}: ${m[0]}`);
      }
    }
  }
  await walk(resolve(REPO_ROOT, 'packages/ui/src'));
  await walk(resolve(REPO_ROOT, 'apps/desktop/src/renderer'));
  return offenders;
}

// === tests =================================================================

describe('PR-BORDER-WIDTH-CONVERGE-0 contract', () => {
  it('--border-width-* tokens are pinned exactly-once (hairline=1px, thick=2px, accent=3px)', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--border-width-hairline', '1px', 'maka-tokens.css');
    assertCustomPropPinnedOnce(tokens, '--border-width-thick', '2px', 'maka-tokens.css');
    assertCustomPropPinnedOnce(tokens, '--border-width-accent', '3px', 'maka-tokens.css');
  });

  it('CSS border: / border-{side}: shorthand references --border-width-* (no bare px width)', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('TSX has no arbitrary border-[Npx] / border-{side}-[Npx] widths (use the Tailwind border scale)', async () => {
    const offenders = await collectTsxOffenders();
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });
});
