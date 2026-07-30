/**
 * PR-RADIUS-NESTING-0 (issue #520 PR4 item 12, 2026-07-05):
 * pin the concentric-radius nesting convention.
 *
 * Concentric nesting: inner radius = outer radius − inset, so the two
 * curves share a center and read as one machined shell.
 *
 * THE PRECONDITION IS ADJACENCY. The inner corner must actually sit in
 * the outer corner, with an equal inset on BOTH edges meeting there.
 * A child floating in the middle of its parent has no outer curve to be
 * concentric with; a child whose horizontal and vertical insets differ
 * cannot share a center with anything.
 *
 * This contract used to assert the opposite of its own rule. It pinned
 * `.maka-search-modal-input-row` to `calc(var(--radius-modal) - 8px)`
 * = 4px, described as "an input inside a 12px modal shell with an 8px
 * inset", and warned that dropping it to a tier "would read as too
 * round against the shell corners". Measured in the live renderer, that
 * row is the middle of a 3-row grid — 57px below the shell's top edge,
 * 12px in from its sides, adjacent to no shell corner at all. The 8px
 * was the vertical margin to the header band, an axis that has nothing
 * to do with the corner. Its structural twin in the command palette
 * (.maka-palette-input-wrap, same primitive, same position, same 12px
 * shell) used the control tier the whole time, so the two searches
 * differed by 50% in roundness. The assertion did not protect a
 * convention; it froze a defect and made the fix fail CI.
 *
 * The genuinely concentric site in this codebase is the segmented
 * control: a track on --radius-surface with a uniform 2px pad, whose
 * first and last buttons hug its corners — 8 − 2 = 6 = --radius-control.
 * Adjacent, uniform on both axes, and it lands on a tier, so it is
 * spelled as a tier rather than a calc. That is what this file pins now.
 *
 * The other legitimate form is the 1px border inset — a ::before overlay
 * at inset-0 hugging the inner edge of a 1px border, spelled
 * `calc(var(--radius-*) - 1px)` (primitives/menu.tsx, primitives/empty.tsx).
 * Those live in Tailwind class strings, not renderer CSS, so they are
 * governed by the radius-converge contract's calc allowlist instead.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/** Extract the body of a CSS rule for an exact selector (first match),
 *  matching the radius-converge SELECTOR_TIER block extraction. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\s/g, '\\s+');
  const normalized = css.replace(/\{/g, '{\n').replace(/\}/g, '\n}');
  const re = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const m = re.exec(normalized);
  return m ? m[1] : null;
}

describe('PR-RADIUS-NESTING-0 contract', () => {
  it('the segmented track and its buttons stay concentric (8px surface − 2px pad = 6px control)', async () => {
    const css = stripCssComments(await readAllRendererCss());

    const track = ruleBody(css, '.maka-segmented');
    assert.ok(track, '.maka-segmented rule must exist (styles/segmented.css)');
    assert.match(
      track,
      /border-radius:\s*var\(--radius-surface\)/,
      '.maka-segmented track must sit on --radius-surface — the button radius below is derived from it',
    );
    assert.match(
      track,
      /padding:\s*var\(--space-0-5\)/,
      '.maka-segmented pad must stay uniform on both axes (var(--space-0-5) = 2px); an asymmetric pad has no concentric solution',
    );

    const button = ruleBody(css, '.maka-segmented button');
    assert.ok(button, '.maka-segmented button rule must exist (styles/segmented.css)');
    assert.match(
      button,
      /border-radius:\s*var\(--radius-control\)/,
      '.maka-segmented button must be --radius-control: it hugs the track corners under a uniform 2px pad, and 8 − 2 = 6 lands exactly on the control tier',
    );
  });

  it('a concentric shrink is spelled as a tier when it lands on one', async () => {
    // 8 − 2 = 6 IS --radius-control, so the segmented button says so directly
    // rather than calc(var(--radius-surface) - 2px). Two spellings for one
    // value is the ambiguity this rule exists to prevent; the tier also
    // survives a token revalue, where a hardcoded 2px shrink would not.
    //
    // (The old segmented.css comment justified this by saying the calc form
    // was unspellable — the converge contract split values on whitespace, so
    // the only accepted spelling was invalid CSS. #1514 fixed that splitter,
    // so the calc form is now spellable; the tier is still preferred, but for
    // this reason rather than that one.)
    const css = stripCssComments(await readAllRendererCss());
    const shrinkToTier = [...css.matchAll(/calc\(var\(--radius-surface\)\s+-\s+2px\)/g)];
    assert.equal(
      shrinkToTier.length,
      0,
      `calc(var(--radius-surface) - 2px) resolves to 6px, which is --radius-control — say the tier instead. Found ${shrinkToTier.length} site(s).`,
    );
  });

  it('the nesting calc uses the shrink form only (the radius-converge calc allowlist enforces this, restated here for the nesting sites)', async () => {
    // No site should ADD to the modal radius (that would break concentricity).
    const css = stripCssComments(await readAllRendererCss());
    const additionSites = [...css.matchAll(/calc\(var\(--radius-[\w-]+\)\s*\+\s*\d+px\)/g)];
    assert.equal(
      additionSites.length,
      0,
      `radius nesting must only SHRINK (calc(var(--radius-*) - Npx)); addition breaks concentricity. Found ${additionSites.length} addition site(s): ${additionSites.map((m) => m[0]).join(', ')}`,
    );
  });
});
