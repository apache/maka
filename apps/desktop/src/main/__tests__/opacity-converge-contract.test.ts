/**
 * PR-OPACITY-CONVERGE-0 (issue #520 PR2):
 * lock the opacity vocabulary so individual PRs can't silently drift
 * back to ad-hoc opacity values.
 *
 * Three invariants:
 *
 * 1. CSS `opacity` must reference a whitelisted `--opacity-*` token, or be a
 *    literal (`0` / `1` / `inherit` / `initial` / `unset` / `revert`). Bare
 *    numbers (0.5, 0.65, 0.8) drift visually and bypass the semantic scale.
 *    `0` and `1` are literals, not tokens: 1 is opacity's default (= no
 *    opacity effect), 0 is the absolute hidden boundary — neither carries
 *    semantic info a token would add.
 *
 * 2. `--opacity-{disabled,muted,pending,overlay}` tokens are declared in
 *    `maka-tokens.css` with pinned values (0.5 / 0.65 / 0.8 / 0.04).
 *    `--opacity-overlay` is declared twice (light 0.04 + dark 0.06 theme
 *    override), so it's checked for both occurrences rather than exactly-once.
 *
 * 3. `opacity` inside `@keyframes` is EXCLUDED — animation in/out tracks are
 *    animation intent, not element state, and tokenizing them would force
 *    semantic tiers onto continuous animation values.
 *
 * No `@theme inline` bridge: Tailwind opacity utilities are numeric
 * (opacity-50), not semantic names, so `--opacity-*` is CSS-only; TSX uses
 * Tailwind opacity-* directly (out of CSS contract scope).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments, stripKeyframes, assertCustomPropPinnedOnce, parseCssCustomProps } from './css-test-helpers.js';

// --- token whitelist --------------------------------------------------------

const OPACITY_TOKEN_WHITELIST = new Set([
  '--opacity-disabled',
  '--opacity-muted',
  '--opacity-pending',
  '--opacity-overlay',
]);

const LITERAL_OK = /^(?:0|1|inherit|initial|unset|revert)$/;

function extractOpacityValue(decl: string): string {
  return decl.replace(/^opacity:\s*/i, '').replace(/;$/, '').trim();
}

// --- CSS scanning -----------------------------------------------------------

function findOpacityOffenders(css: string, label: string): string[] {
  const stripped = stripKeyframes(stripCssComments(css));
  const offenders: string[] = [];

  for (const m of stripped.matchAll(/(?<![-\w])opacity:\s*[^;}\n]+/gi)) {
    const raw = m[0].trim();
    const value = extractOpacityValue(raw);

    if (/^var\(\s*--opacity-[\w-]+\s*\)$/.test(value)) {
      const tok = value.match(/^var\(\s*(--opacity-[\w-]+)\s*\)$/)?.[1];
      if (tok && OPACITY_TOKEN_WHITELIST.has(tok)) continue;
      offenders.push(`${label}: ${raw} (unknown token)`);
      continue;
    }

    if (LITERAL_OK.test(value)) continue;

    offenders.push(`${label}: ${raw}`);
  }

  return offenders;
}

// === tests ==================================================================

describe('PR-OPACITY-CONVERGE-0 contract', () => {
  it('renderer CSS uses only whitelisted --opacity-* tokens or 0/1/literals (no bare numbers, keyframes excluded)', async () => {
    const css = await readAllRendererCss();
    const offenders = findOpacityOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--opacity-{disabled,muted,pending} tokens are declared exactly once with pinned values', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--opacity-disabled', '0.5');
    assertCustomPropPinnedOnce(tokens, '--opacity-muted', '0.65');
    assertCustomPropPinnedOnce(tokens, '--opacity-pending', '0.8');
  });

  it('--opacity-overlay is declared twice (light 0.04 + dark 0.06 theme override)', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    const values = parseCssCustomProps(tokens).get('--opacity-overlay') ?? [];
    assert.equal(values.length, 2, `--opacity-overlay must be declared twice (light + dark); got ${values.length}: ${JSON.stringify(values)}`);
    assert.ok(values.includes('0.04'), `light --opacity-overlay must include 0.04; got ${JSON.stringify(values)}`);
    assert.ok(values.includes('0.06'), `dark --opacity-overlay must include 0.06; got ${JSON.stringify(values)}`);
  });
});
