/**
 * PR-BOX-SHADOW-CONVERGE-0 (issue #520 PR4 item 13, 2026-07-05):
 * box-shadow color must derive from --foreground,
 * not pure black. A pure-black rgba()/oklch() shadow on maka's warm shell
 * reads as a dirty smudge — the design system's shadow recipe comments spell
 * the rule: "blur layers were pure-black rgba — on a light warm-gray shell
 * a pure black shadow reads as a dirty smudge. Every layer now derives from
 * the warm foreground so shadow, border ring, and ink share one light
 * source."
 *
 * Item 13 converges the bare pure-black box-shadow usages onto the
 * foreground-derived form (keeping each shadow's geometry — offset, blur,
 * spread — intact, only swapping the color). This is the safe P-SHADOW win:
 * it warms the dirty black shadows without adding the design-system
 * recipe's 1px border ring to every surface (a broader recipe-converge that
 * would change the visual weight of ~20 already-compliant foreground-
 * derived elevation shadows, deferred as a separate design review).
 *
 * The dark-mode shadow recipe overrides in maka-tokens.css (--shadow-medium
 * / --shadow-modal for dark mode) intentionally use pure-black
 * oklch(0 0 0 / 0.5|0.6) — on a dark canvas a pure-black shadow is correct
 * (the comment: "dark mode shadows collapse to a single ring; modal keeps
 * one deep drop"). Those are TOKEN DEFINITIONS (--shadow-*:), not box-shadow
 * usages, so this contract scopes to `box-shadow:` declarations and does not
 * flag them. Recipe var refs (var(--shadow-*)) carry no literal pure-black,
 * so they are not flagged either.
 *
 * ring shadows (0 0 0 Npx color) and inset shadows are out of scope — they
 * are the focus-ring / inset-highlight track (PR2 / a future ring token), not
 * elevation. A pure-black RING would still be caught here (the contract
 * checks the whole box-shadow value for a pure-black color, regardless of
 * the layer shape), which is desirable — a pure-black ring on the warm
 * shell has the same smudge problem.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  TOKENS_FILE,
  readAllRendererCss,
  stripCssComments,
} from './css-test-helpers.js';

/** Pure-black color in a box-shadow value — the P-SHADOW violation. Matches
 *  oklch(0 0 0 / <alpha>) and rgba(0, 0, 0, <alpha>) with a NON-ZERO alpha
 *  (the rgba(0,0,0,0) transparent placeholder in the recipe definitions is
 *  alpha 0 and not a shadow color), plus solid #000 / black. */
const PURE_BLACK_RE = /(?:oklch\(\s*0\s+0\s+0\s*\/\s*0?\.\d+|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.\d+|#000(?:000)?\b|\bblack\b)/i;

/** A box-shadow declaration value, spanning newlines up to ; or }. The
 *  char class [^;}] matches newlines, so multi-line box-shadow layers are
 *  captured as one value. Token definitions (--shadow-*:) are NOT
 *  `box-shadow:` so they are not matched. */
const BOX_SHADOW_DECL_RE = /box-shadow\s*:\s*([^;}\n]+(?:\n[^;}\n]+)*)/gi;

function findCssOffenders(css: string, label: string): string[] {
  const stripped = stripCssComments(css);
  const offenders: string[] = [];
  for (const m of stripped.matchAll(BOX_SHADOW_DECL_RE)) {
    const value = m[1];
    if (value.trim() === 'none') continue;
    if (PURE_BLACK_RE.test(value)) {
      offenders.push(`${label}: box-shadow: ${value.trim().replace(/\s+/g, ' ').slice(0, 100)} [pure-black color — derive from var(--foreground) per P-SHADOW, or use a var(--shadow-*) recipe]`);
    }
  }
  return offenders;
}

// === tests =================================================================

describe('PR-BOX-SHADOW-CONVERGE-0 contract', () => {
  it('box-shadow color derives from --foreground (no pure-black oklch/rgba/#000/black)', async () => {
    const css = await readAllRendererCss();
    const offenders = findCssOffenders(css, 'renderer CSS');
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('the shadow recipes are defined in maka-tokens.css (--shadow-minimal/medium/modal, --card-shadow, --card-highlight)', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    for (const token of ['--shadow-minimal', '--shadow-medium', '--shadow-modal', '--card-shadow', '--card-highlight']) {
      assert.match(tokens, new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`), `${token} must be defined in maka-tokens.css`);
    }
  });
});
