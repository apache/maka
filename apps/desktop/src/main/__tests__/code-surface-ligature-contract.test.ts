/**
 * Code surfaces must not get their ligatures back through a `font` shorthand.
 *
 * A code well turns ligatures off so `===` stays three glyphs and `=>` stays
 * two. The `font` shorthand resets every longhand it does not name, including
 * `font-variant-ligatures` — so a later rule that re-declares `font:` for the
 * same element silently undoes it, and the declaration it undoes is in a
 * different rule, several lines away, that still reads correct.
 *
 * That is exactly how `.maka-tool-output-panel .maka-tool-diff-body` shipped:
 * it set `font: var(--maka-text-code)` to move the chat diff onto the code
 * tier, outranked the `none` on `.maka-tool-diff-body`, and made the tool
 * diff the one surface in the app rendering `===` as `⩶`.
 *
 * Stated over the cascade rather than over one class: for every class some
 * rule turns ligatures off for, the LAST unconditional rule touching either
 * property on that class must be the one that declares
 * `font-variant-ligatures`. That is the same "last declaration wins" reading
 * the reasoning-wrap contract uses, and the same approximation — it orders by
 * source position and not by specificity, which is exact for the shapes this
 * sheet has (a shared base rule plus later refinements) and would miss a
 * lower-specificity rule placed after a higher-specificity one. `@media`
 * blocks are their own cascade context and are left out.
 *
 * Adding a code surface costs nothing here; re-styling one without carrying
 * the setting forward fails.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseCssBlocks, splitSelectorList, stripCssComments } from './css-test-helpers.js';
import { readRendererContractCss } from './contract-css-helpers.js';

/** Class names a selector carries, e.g. `.a .b:hover` → `a`, `b`. */
function classesIn(selector: string): string[] {
  return Array.from(selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g), (match) => match[1]!);
}

describe('code surface ligature contract', () => {
  it('never lets a `font` shorthand be the last word on a ligature-free class', async () => {
    const blocks = parseCssBlocks(stripCssComments(await readRendererContractCss()))
      .filter((block) => block.conditions.length === 0);

    // Per class, the last rule in source order that declared either property,
    // and whether that rule kept ligatures off.
    const lastWord = new Map<string, boolean>();
    const ligatureFree = new Set<string>();
    for (const block of blocks) {
      const declaresLigatures = block.decls.some((decl) => decl.prop === 'font-variant-ligatures');
      if (!declaresLigatures && !block.decls.some((decl) => decl.prop === 'font')) continue;
      for (const selector of splitSelectorList(block.selector)) {
        for (const className of classesIn(selector)) {
          if (declaresLigatures) ligatureFree.add(className);
          lastWord.set(className, declaresLigatures);
        }
      }
    }

    assert.ok(ligatureFree.size > 0, 'the sheet must declare font-variant-ligatures somewhere');
    const offenders = [...ligatureFree].filter((className) => lastWord.get(className) !== true).sort();
    assert.deepEqual(
      offenders,
      [],
      `a \`font\` shorthand resets font-variant-ligatures for: ${offenders.join(', ')}`,
    );
  });
});
