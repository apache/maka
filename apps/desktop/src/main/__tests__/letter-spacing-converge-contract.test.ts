/**
 * PR-TRACKING-CONVERGE-0 (issue #520 PR1):
 * lock the letter-spacing vocabulary so individual PRs can't silently drift
 * back to ad-hoc letter-spacing values.
 *
 * Three invariants:
 *
 * 1. CSS `letter-spacing` must reference a whitelisted `--tracking-*` token
 *    or be the literal `0` (or `inherit`/`initial`/`unset`/`revert`). Bare
 *    numbers (0.02em, 0.04em, …), `px`, and `normal` are banned. `normal` is
 *    banned because it is an alias for 0 that hides which tier is in use.
 *
 * 2. `--tracking-{normal,wide,wider,widest}` tokens are defined in
 *    `maka-tokens.css` with pinned values (0 / 0.025em / 0.05em / 0.1em).
 *
 * 3. Tailwind `--tracking-*` aliases in `styles.css` `@theme inline` map to
 *    `var(--tracking-*)` so TSX `tracking-*` utilities stay single-sourced.
 *
 * No --tracking-tight: Maka is a CJK-first app and avoids
 * tightening CJK letter-spacing, so all negative values snap to normal (0).
 * ALL-CAPS short labels use wider/widest (+5–10% tracking).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, stripCssComments, assertCustomPropPinnedOnce } from './css-test-helpers.js';

const STYLES_FILE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

// --- token whitelist --------------------------------------------------------

const TRACKING_TOKEN_WHITELIST = new Set([
  '--tracking-normal',
  '--tracking-wide',
  '--tracking-wider',
  '--tracking-widest',
]);

const LITERAL_OK = /^(?:0|inherit|initial|unset|revert)$/;

function extractLetterSpacingValue(decl: string): string {
  return decl.replace(/^letter-spacing:\s*/i, '').replace(/;$/, '').trim();
}

// --- CSS scanning -----------------------------------------------------------

function findCssOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];

  const decls = [...stripped.matchAll(/letter-spacing:\s*[^;}\n]+/gi)];
  for (const m of decls) {
    const raw = m[0].trim();
    const value = extractLetterSpacingValue(raw);

    // Allowed: var(--tracking-*)
    if (/^var\(\s*--tracking-[\w-]+\s*\)$/.test(value)) {
      const tok = value.match(/^var\(\s*(--tracking-[\w-]+)\s*\)$/)?.[1];
      if (tok && TRACKING_TOKEN_WHITELIST.has(tok)) continue;
      offenders.push(`${label}: ${raw} (unknown token)`);
      continue;
    }

    // Allowed: literals (0, inherit, initial, unset, revert)
    if (LITERAL_OK.test(value)) continue;

    // Everything else is a violation (bare em/px/normal/negative, etc.)
    offenders.push(`${label}: ${raw}`);
  }

  return offenders;
}

// === tests ==================================================================

describe('PR-TRACKING-CONVERGE-0 contract', () => {
  it('CSS uses only whitelisted --tracking-* tokens or 0/literals (no bare em/px/normal/negative)', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('maka-tokens.css uses only whitelisted --tracking-* tokens or literals', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    const stripped = tokens
      .replace(/^\s*--tracking-normal:\s*0\s*;.*$/gm, '')
      .replace(/^\s*--tracking-wide:\s*0\.025em\s*;.*$/gm, '')
      .replace(/^\s*--tracking-wider:\s*0\.05em\s*;.*$/gm, '')
      .replace(/^\s*--tracking-widest:\s*0\.1em\s*;.*$/gm, '');
    const offenders = findCssOffenders(stripped, 'maka-tokens.css');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--tracking-{normal,wide,wider,widest} tokens are declared exactly once with pinned values', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--tracking-normal', '0');
    assertCustomPropPinnedOnce(tokens, '--tracking-wide', '0.025em');
    assertCustomPropPinnedOnce(tokens, '--tracking-wider', '0.05em');
    assertCustomPropPinnedOnce(tokens, '--tracking-widest', '0.1em');
  });

  it('Tailwind --tracking-* aliases are declared exactly once mapping to var(--tracking-*) in @theme inline', async () => {
    const styles = await readFile(STYLES_FILE, 'utf8');
    assertCustomPropPinnedOnce(styles, '--tracking-normal', 'var(--tracking-normal)', 'styles.css');
    assertCustomPropPinnedOnce(styles, '--tracking-wide', 'var(--tracking-wide)', 'styles.css');
    assertCustomPropPinnedOnce(styles, '--tracking-wider', 'var(--tracking-wider)', 'styles.css');
    assertCustomPropPinnedOnce(styles, '--tracking-widest', 'var(--tracking-widest)', 'styles.css');
  });
});
