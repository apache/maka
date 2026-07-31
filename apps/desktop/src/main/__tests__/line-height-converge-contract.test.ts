/**
 * PR-LEADING-CONVERGE-0 (issue #520 PR1):
 * lock the line-height vocabulary so individual PRs can't silently drift
 * back to ad-hoc line-height values.
 *
 * Three invariants:
 *
 * 1. CSS `line-height` must reference a whitelisted `--leading-*` token,
 *    use `em` (relative scaling off the element font-size), or be a literal
 *    (`inherit` / `initial` / `unset` / `revert` / `0`). Bare unitless numbers
 *    (1.4, 1.45) and px/rem drift visually and bypass the four-tier scale.
 *    `normal` is banned too — it is a UA default that varies by font and
 *    bypasses the scale; use `var(--leading-normal)` instead.
 *
 * 2. `--leading-{none,tight,snug,normal}` tokens are defined in
 *    `maka-tokens.css` with pinned values (1 / 1.25 / 1.375 / 1.5). A rename
 *    or value change gets flagged at the test layer before any styles site
 *    drifts.
 *
 * 3. Tailwind `--leading-*` aliases in `styles.css` `@theme inline` map to
 *    `var(--leading-*)` so TSX `leading-*` utilities stay single-sourced
 *    with hand-written CSS — same inline-bridge pattern as `--text-*`.
 *
 * 4. `--text-{xs,sm,base}--line-height` pairs in `styles.css` `@theme inline`
 *    pin the paired line-height of bare `text-*` utilities to the leading
 *    scale (#546). Without the pins, `text-xs`/`text-sm` carry Tailwind's
 *    stock ratios (1.333/1.4286) — off-tier values invariant 1 can't see
 *    because they never appear as a `line-height:` declaration in our CSS.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, readRendererTsxFiles, stripCssComments, findFontShorthandOffenders, assertCustomPropPinnedOnce } from './css-test-helpers.js';

const STYLES_FILE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

// --- token whitelist --------------------------------------------------------

const LEADING_TOKEN_WHITELIST = new Set([
  '--leading-none',
  '--leading-tight',
  '--leading-snug',
  '--leading-normal',
]);

const LITERAL_OK = /^(?:inherit|initial|unset|revert|0)$/;

function extractLineHeightValue(decl: string): string {
  return decl.replace(/^line-height:\s*/i, '').replace(/;$/, '').trim();
}

// --- CSS scanning -----------------------------------------------------------

function findCssOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];

  // Find every line-height declaration
  const decls = [...stripped.matchAll(/line-height:\s*[^;}\n]+/gi)];
  for (const m of decls) {
    const raw = m[0].trim();
    const value = extractLineHeightValue(raw);

    // Allowed: var(--leading-*)
    if (/^var\(\s*--leading-[\w-]+\s*\)$/.test(value)) {
      const tok = value.match(/^var\(\s*(--leading-[\w-]+)\s*\)$/)?.[1];
      if (tok && LEADING_TOKEN_WHITELIST.has(tok)) continue;
      offenders.push(`${label}: ${raw} (unknown token)`);
      continue;
    }

    // Allowed: em values (relative scaling off element font-size)
    if (/^\d+(?:\.\d+)?em$/.test(value)) continue;

    // Allowed: literals
    if (LITERAL_OK.test(value)) continue;

    // Everything else is a violation (bare numbers, px, rem, normal, etc.)
    offenders.push(`${label}: ${raw}`);
  }

  // Catch non-literal `font:` shorthand — shared helper bans any `font:` that
  // isn't inherit/initial/unset/revert, covering line-height/weight/size bypass.
  offenders.push(...findFontShorthandOffenders(stripped, label));

  return offenders;
}

// === tests ==================================================================

describe('PR-LEADING-CONVERGE-0 contract', () => {
  it('CSS uses only whitelisted --leading-* tokens, em, or literals (no bare numbers/px/normal)', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('maka-tokens.css uses only whitelisted --leading-* tokens, em, or literals', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    // Strip the token declaration lines themselves (they legitimately spell numbers)
    const stripped = tokens
      .replace(/^\s*--leading-none:\s*1\s*;.*$/gm, '')
      .replace(/^\s*--leading-tight:\s*1\.25\s*;.*$/gm, '')
      .replace(/^\s*--leading-snug:\s*1\.375\s*;.*$/gm, '')
      .replace(/^\s*--leading-normal:\s*1\.5\s*;.*$/gm, '');
    const offenders = findCssOffenders(stripped, 'maka-tokens.css');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--leading-{none,tight,snug,normal} tokens are declared exactly once with pinned values', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--leading-none', '1');
    assertCustomPropPinnedOnce(tokens, '--leading-tight', '1.25');
    assertCustomPropPinnedOnce(tokens, '--leading-snug', '1.375');
    assertCustomPropPinnedOnce(tokens, '--leading-normal', '1.5');
  });

  it('Tailwind --leading-* aliases are declared exactly once mapping to var(--leading-*) in @theme inline', async () => {
    const styles = await readFile(STYLES_FILE, 'utf8');
    assertCustomPropPinnedOnce(styles, '--leading-none', 'var(--leading-none)', 'styles.css');
    assertCustomPropPinnedOnce(styles, '--leading-tight', 'var(--leading-tight)', 'styles.css');
    assertCustomPropPinnedOnce(styles, '--leading-snug', 'var(--leading-snug)', 'styles.css');
    assertCustomPropPinnedOnce(styles, '--leading-normal', 'var(--leading-normal)', 'styles.css');
  });

  it('--text-*--line-height pairs are declared exactly once pinned to the leading scale in @theme inline', async () => {
    const styles = await readFile(STYLES_FILE, 'utf8');
    assertCustomPropPinnedOnce(styles, '--text-xs--line-height', 'var(--leading-snug)', 'styles.css');
    assertCustomPropPinnedOnce(styles, '--text-sm--line-height', 'var(--leading-snug)', 'styles.css');
    assertCustomPropPinnedOnce(styles, '--text-base--line-height', 'var(--leading-normal)', 'styles.css');
  });

  // Closes the CSS-only blind spot (#546 PR0): arbitrary `leading-[1.45]` /
  // `leading-[1.6]` utilities in className strings bypass the leading token
  // scale the CSS scanner locks. Named scales (leading-none/tight/snug/normal)
  // don't match `leading-[<digit>]` and stay allowed. NOTE: literal className
  // text only — clsx/cva maps, template strings, and inline `style={{}}` are
  // NOT caught (honest scope, see css-test-helpers readRendererTsxFiles).
  // `leading-[1.45]` / `leading-[1.6]` (unitless) and Tailwind's font-size slash
  // modifier (`text-xs/[1.45]` emits line-height: 1.45 with no leading-[..]
  // token) bypass the leading scale. `leading-[12px]` / `leading-[16px]` are
  // deliberate px centering on fixed-height icon buttons (not ratios) — they
  // stay allowed, same exception #546 recorded for the old chat.tsx sites.
  it('TSX className strings use no arbitrary unitless leading-[..] or slash line-height utilities', async () => {
    const re = /leading-\[\d+(?:\.\d+)?\]|text-[^'"\s/]*\/\[[\d.]+\]/g;
    const offenders: string[] = [];
    for (const { relPath, source } of await readRendererTsxFiles()) {
      for (const m of source.matchAll(re)) offenders.push(`${relPath}: ${m[0]}`);
    }
    assert.deepEqual(offenders, [], `Arbitrary leading-[..] line-height offenders (use leading-none/tight/snug/normal or leading-[var(--leading-*)]):\n  ${offenders.join('\n  ')}`);
  });
});
