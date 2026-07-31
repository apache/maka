/**
 * PR-FONT-WEIGHT-CONVERGE-0 (issue #520 PR1):
 * lock the font-weight vocabulary so individual PRs can't silently drift
 * back to ad-hoc font-weight values.
 *
 * Three invariants:
 *
 * 1. CSS `font-weight` must reference a whitelisted `--font-weight-*` token
 *    or be a literal (`inherit` / `initial` / `unset` / `revert`). Bare numbers
 *    (400/500/550/600/620/650/680/700) and keyword weights (`normal` / `bold`
 *    / `lighter` / `bolder`) drift visually and bypass the four-tier scale;
 *    `normal`/`bold` are banned too because they are aliases for 400/700 that
 *    hide which tier is in use.
 *
 * 2. `--font-weight-{normal,medium,semibold,bold}` tokens are defined in
 *    `maka-tokens.css` with pinned values (400 / 500 / 600 / 700).
 *
 * 3. Tailwind `--font-weight-*` aliases in `styles.css` `@theme inline` map to
 *    `var(--font-weight-*)` so TSX `font-*` utilities stay single-sourced —
 *    same inline-bridge pattern as `--text-*` / `--leading-*`.
 *
 * Variable-weight Geist + system-ui means 550/620/650/680 are mid-axis picks;
 * they snap to the nearest tier (550/620/650 → semibold 600, 680 → bold 700).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments, findFontShorthandOffenders, assertCustomPropPinnedOnce } from './css-test-helpers.js';

const STYLES_FILE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

// --- token whitelist --------------------------------------------------------

const FONT_WEIGHT_TOKEN_WHITELIST = new Set([
  '--font-weight-normal',
  '--font-weight-medium',
  '--font-weight-semibold',
  '--font-weight-bold',
]);

const LITERAL_OK = /^(?:inherit|initial|unset|revert)$/;

function extractFontWeightValue(decl: string): string {
  return decl.replace(/^font-weight:\s*/i, '').replace(/;$/, '').trim();
}

// --- CSS scanning -----------------------------------------------------------

function findCssOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];

  const decls = [...stripped.matchAll(/font-weight:\s*[^;}\n]+/gi)];
  for (const m of decls) {
    const raw = m[0].trim();
    const value = extractFontWeightValue(raw);

    // Allowed: var(--font-weight-*)
    if (/^var\(\s*--font-weight-[\w-]+\s*\)$/.test(value)) {
      const tok = value.match(/^var\(\s*(--font-weight-[\w-]+)\s*\)$/)?.[1];
      if (tok && FONT_WEIGHT_TOKEN_WHITELIST.has(tok)) continue;
      offenders.push(`${label}: ${raw} (unknown token)`);
      continue;
    }

    // Allowed: literals
    if (LITERAL_OK.test(value)) continue;

    // Everything else is a violation (bare numbers, normal/bold/lighter/bolder, px, etc.)
    offenders.push(`${label}: ${raw}`);
  }

  // Catch non-literal `font:` shorthand — shared helper bans any `font:` that
  // isn't inherit/initial/unset/revert, covering weight/size/line-height bypass.
  offenders.push(...findFontShorthandOffenders(stripped, label));

  return offenders;
}

// === tests ==================================================================

describe('PR-FONT-WEIGHT-CONVERGE-0 contract', () => {
  it('CSS uses only whitelisted --font-weight-* tokens or literals (no bare numbers/normal/bold)', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('maka-tokens.css uses only whitelisted --font-weight-* tokens or literals', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    const stripped = tokens
      .replace(/^\s*--font-weight-normal:\s*400\s*;.*$/gm, '')
      .replace(/^\s*--font-weight-medium:\s*500\s*;.*$/gm, '')
      .replace(/^\s*--font-weight-semibold:\s*600\s*;.*$/gm, '')
      .replace(/^\s*--font-weight-bold:\s*700\s*;.*$/gm, '');
    const offenders = findCssOffenders(stripped, 'maka-tokens.css');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--font-weight-{normal,medium,semibold,bold} tokens are declared exactly once with pinned values', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--font-weight-normal', '400');
    assertCustomPropPinnedOnce(tokens, '--font-weight-medium', '500');
    assertCustomPropPinnedOnce(tokens, '--font-weight-semibold', '600');
    assertCustomPropPinnedOnce(tokens, '--font-weight-bold', '700');
  });

  it('Tailwind --font-weight-* aliases are declared exactly once mapping to var(--font-weight-*) in @theme inline', async () => {
    const styles = await readFile(STYLES_FILE, 'utf8');
    assertCustomPropPinnedOnce(styles, '--font-weight-normal', 'var(--font-weight-normal)', 'styles.css');
    assertCustomPropPinnedOnce(styles, '--font-weight-medium', 'var(--font-weight-medium)', 'styles.css');
    assertCustomPropPinnedOnce(styles, '--font-weight-semibold', 'var(--font-weight-semibold)', 'styles.css');
    assertCustomPropPinnedOnce(styles, '--font-weight-bold', 'var(--font-weight-bold)', 'styles.css');
  });
});
