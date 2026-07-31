/**
 * PR-TYPOGRAPHY-CONVERGE-0 (issue #430 PR2, 2026-07-03):
 * lock the typography vocabulary so individual PRs can't silently drift
 * back to ad-hoc font-size values.
 *
 * Three invariants:
 *
 * 1. CSS `font-size` must reference a whitelisted `--font-size-*` token,
 *    use `em` (relative scaling off the 13px root), or be a literal
 *    (`inherit` / `initial` / `0`). Bare `Npx` and `Nrem` drift visually
 *    and bypass the tier scale.
 *
 * 2. `--font-size-{heading,base,ui,caption}` tokens are defined in
 *    `maka-tokens.css` with pinned values (#546 re-tier: heading 15 /
 *    body 13 / caption 11; ui aliases base). A rename or value change
 *    gets flagged at the test layer before any styles site drifts.
 *
 * 3. Tailwind `--text-{xs,sm,base}` aliases in `styles.css` `@theme inline`
 *    map to the token scale so TSX `text-*` utilities stay single-sourced
 *    with hand-written CSS.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, readAllRendererCss, readRendererTsxFiles, stripCssComments } from './css-test-helpers.js';

// --- token whitelist --------------------------------------------------------

const FONT_SIZE_TOKEN_WHITELIST = new Set([
  '--font-size-heading',
  '--font-size-base',
  '--font-size-ui',
  '--font-size-caption',
]);

const LITERAL_OK = /^(?:inherit|initial|0)$/;

function extractFontSizeValue(decl: string): string {
  return decl.replace(/^font-size:\s*/i, '').replace(/;$/, '').trim();
}

/** Bare px/rem inside `font:` shorthand, e.g. `font: 12px/1.4 var(--font-sans)`.
 *  Catches the shorthand bypass that `font-size:` scanning misses. */
const FONT_SHORTHAND_PX_RE = /\bfont:\s*[^;}\n]*\d+(?:\.\d+)?px\b/gi;
const FONT_SHORTHAND_REM_RE = /\bfont:\s*[^;}\n]*\d+(?:\.\d+)?rem\b/gi;

// --- CSS scanning -----------------------------------------------------------

function findCssOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];

  // Find every font-size declaration
  const decls = [...stripped.matchAll(/font-size:\s*[^;}\n]+/gi)];
  for (const m of decls) {
    const raw = m[0].trim();
    const value = extractFontSizeValue(raw);

    // Allowed: var(--font-size-*)
    if (/^var\(\s*--font-size-[\w-]+\s*\)$/.test(value)) {
      const tok = value.match(/^var\(\s*(--font-size-[\w-]+)\s*\)$/)?.[1];
      if (tok && FONT_SIZE_TOKEN_WHITELIST.has(tok)) continue;
      offenders.push(`${label}: ${raw} (unknown token)`);
      continue;
    }

    // Allowed: em values (relative scaling)
    if (/^\d+(?:\.\d+)?em$/.test(value)) continue;

    // Allowed: literals
    if (LITERAL_OK.test(value)) continue;

    // Everything else is a violation
    offenders.push(`${label}: ${raw}`);
  }

  // Catch `font:` shorthand with bare px/rem size — bypasses font-size scanning
  for (const re of [FONT_SHORTHAND_PX_RE, FONT_SHORTHAND_REM_RE]) {
    for (const m of stripped.matchAll(re)) {
      offenders.push(`${label}: ${m[0].trim()}`);
    }
  }

  return offenders;
}

// === tests ==================================================================

describe('PR-TYPOGRAPHY-CONVERGE-0 contract', () => {
  it('CSS uses only whitelisted --font-size-* tokens, em, or literals (no bare Npx/Nrem)', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('maka-tokens.css uses only whitelisted --font-size-* tokens, em, or literals', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    // Strip the token declaration lines themselves (they legitimately spell px)
    const stripped = tokens
      .replace(/^\s*--font-size-heading:\s*15px\s*;?\s*$/gm, '')
      .replace(/^\s*--font-size-base:\s*13px\s*;?\s*$/gm, '')
      .replace(/^\s*--font-size-ui:\s*var\(--font-size-base\)\s*;?\s*$/gm, '')
      .replace(/^\s*--font-size-caption:\s*11px\s*;?\s*$/gm, '');
    const offenders = findCssOffenders(stripped, 'maka-tokens.css');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('--font-size-{heading,base,ui,caption} tokens are defined with pinned values', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assert.match(tokens, /--font-size-heading:\s*15px/, '--font-size-heading must be 15px');
    assert.match(tokens, /--font-size-base:\s*13px/, '--font-size-base must be 13px (#546 re-tier)');
    assert.match(
      tokens,
      /--font-size-ui:\s*var\(--font-size-base\)/,
      '--font-size-ui must alias --font-size-base (#546 re-tier: body == chrome)'
    );
    assert.match(tokens, /--font-size-caption:\s*11px/, '--font-size-caption must be 11px');
  });

  it('Tailwind --text-{xs,sm,base} aliases map to --font-size-* tokens in @theme inline', async () => {
    const styles = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8');
    assert.match(styles, /--text-xs:\s*var\(--font-size-caption\)/, '--text-xs must alias --font-size-caption');
    assert.match(styles, /--text-sm:\s*var\(--font-size-ui\)/, '--text-sm must alias --font-size-ui');
    assert.match(styles, /--text-base:\s*var\(--font-size-base\)/, '--text-base must alias --font-size-base');
  });

  // Closes the CSS-only blind spot (#546 PR0): arbitrary font-size utilities in
  // className strings bypass the token scale the CSS scanner locks. The regex
  // catches numeric arbitrary (text-[12px], text-[0.7rem]) and length-typed
  // calc (text-[length:calc(12px)]) — forms that emit font-size off the scale.
  // Named scales (text-xs/sm/base), token var refs (text-[var(--font-size-*)]),
  // and color arbitraries (text-[oklch(...)], text-[color:...]) don't match:
  // var pointing is governed by the CSS token-whitelist contract, and color is
  // not font-size. NOTE: literal className text only — clsx/cva maps, template
  // strings, and inline `style={{ fontSize }}` are NOT caught (honest scope,
  // see css-test-helpers readRendererTsxFiles).
  it('TSX className strings use no arbitrary text-[..] font-size utilities', async () => {
    const re = /text-\[(?:length:)?(?:\d|\.\d|calc\()[^\]]*\]/g;
    const offenders: string[] = [];
    for (const { relPath, source } of await readRendererTsxFiles()) {
      for (const m of source.matchAll(re)) offenders.push(`${relPath}: ${m[0]}`);
    }
    assert.deepEqual(offenders, [], `Arbitrary text-[..] font-size offenders (use text-xs/sm/base or text-[var(--font-size-*)]):\n  ${offenders.join('\n  ')}`);
  });
});
