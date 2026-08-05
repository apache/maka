/**
 * Disclosure chevron sizing contract.
 *
 * The Thinking row and the tool row draw the same Astryx registry chevron —
 * that half is locked in packages/ui/src/__tests__/processing-block.test.tsx.
 * A registry icon renders as `span > svg`, and chat-message.css is what pulls
 * both halves down to 10x10 inside the 14px box. Miss either half on either
 * row and the two chevrons stop matching: sizing only the svg leaves the
 * wrapper at its own 0.75rem, and dropping a row from the selector list leaves
 * that row's chevron at the icon's natural size.
 *
 * So this pins the outcome, not the wording: each row's chevron svg AND its
 * wrapper are declared 10x10. Splitting the shared rule in two, reordering the
 * selector list, or moving the arms between `:is()` and a plain list all stay
 * green — restating one row at another size, or letting a row fall out
 * entirely, does not.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseCssBlocks, readAllRendererCss, splitSelectorList, stripCssComments } from './css-test-helpers.js';

/** The chevron sits last in the trigger; `svg` is the glyph, `> *` its wrapper. */
const CHEVRON_PARTS = [
  { name: 'svg', endsWith: 'span:last-child svg' },
  { name: 'wrapper', endsWith: 'span:last-child > *' },
] as const;

const ROWS = ['.astryx-chat-reasoning', '.astryx-chat-tool-calls'] as const;

/** Every selector declaring exactly a 10x10 box, `:is()` arms left intact —
 *  a row inside `:is(a, b)` is covered by that selector just as a row named in
 *  a comma list is, so membership is read off the selector text either way. */
function tenBySelector(css: string): string[] {
  const out: string[] = [];
  for (const block of parseCssBlocks(css)) {
    const last = (prop: string) =>
      block.decls.filter((decl) => decl.prop === prop).at(-1)?.value;
    if (last('width') !== '10px' || last('height') !== '10px') continue;
    out.push(...splitSelectorList(block.rule));
  }
  return out;
}

describe('disclosure chevron sizing contract', () => {
  it('sizes both the chevron svg and its wrapper to 10x10 on every disclosure row', async () => {
    const selectors = tenBySelector(stripCssComments(await readAllRendererCss()));
    assert.ok(selectors.length > 0, 'expected at least one 10x10 chevron rule');

    for (const row of ROWS) {
      for (const part of CHEVRON_PARTS) {
        assert.ok(
          selectors.some((selector) => selector.includes(row) && selector.endsWith(part.endsWith)),
          `${row} must declare its chevron ${part.name} 10x10`,
        );
      }
    }
  });
});
