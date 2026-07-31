import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/**
 * Regression guard for #546 (form-control font reset).
 *
 * Tailwind preflight already ships `button, input, select, optgroup,
 * textarea { font: inherit }` inside `@layer base`. base.css used to carry an
 * UNLAYERED duplicate of that reset; because unlayered author CSS outranks
 * every `@layer` rule, the duplicate silently killed all font utilities
 * (text-*, font-*, leading-*, tracking-*) on every form control in the app —
 * e.g. the Button cva's `text-sm font-medium` never rendered anywhere.
 *
 * Invariant: renderer-authored CSS never declares font properties on bare
 * form-element type selectors — layered or not. Font inheritance for form
 * controls is preflight's job; per-surface font styling belongs on classes.
 * A layered duplicate is banned too: it is dead weight at best and one
 * un-layering edit away from the original bug, and dropping the exemption
 * keeps this detector selector-level (no block/layer parsing).
 */

/** A form-element type name appearing as a complete selector-list item:
 * at the list start, after a comma, or directly inside `:where(...)`/
 * `:is(...)` (zero-specificity wrappers still outrank layered utilities
 * when the rule is unlayered). Compound selectors that scope the type
 * (`.composer textarea`, `button.chip`, `input[type=checkbox]`) do not
 * match — those are deliberate per-surface styling, not a reset. */
const BARE_FORM_ITEM_RE = /(?:^|,|:(?:where|is)\()\s*(?:button|input|textarea|select|optgroup)\s*(?=$|[,)])/i;
const FONT_PROP_RE = /(?:^|[;\s])(font|font-size|font-weight|font-family|line-height|letter-spacing)\s*:/;

interface Violation {
  selector: string;
  declaration: string;
}

/** Scans CSS for style rules matching BARE_FORM_ITEM_RE that declare font
 * properties. Rules are matched innermost-first (`prelude { flat-body }`),
 * so at-rule wrappers (`@media`/`@layer`) and CSS nesting fall away; text
 * left of a `;` (prior statements/declarations) is discarded and at-rule
 * preludes are skipped. */
function findFormFontDeclarations(css: string): Violation[] {
  const violations: Violation[] = [];
  for (const rule of stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = rule[1].replace(/^[\s\S]*;/, '').trim();
    if (!prelude || prelude.startsWith('@')) continue;
    if (!BARE_FORM_ITEM_RE.test(prelude)) continue;
    const decl = rule[2].match(FONT_PROP_RE);
    if (decl) violations.push({ selector: prelude.replace(/\s+/g, ' '), declaration: decl[1] });
  }
  return violations;
}

describe('renderer form font reset contract', () => {
  it('declares no font properties on bare form-element type selectors', async () => {
    const violations = findFormFontDeclarations(await readAllRendererCss());
    assert.deepEqual(
      violations,
      [],
      'Font declarations on bare button/input/textarea/select type selectors ' +
        'outrank Tailwind layers when unlayered and disable every font utility ' +
        'on form controls. Preflight (@layer base) already provides `font: inherit`; ' +
        'style form-control fonts via classes instead. See #546.',
    );
  });


});
