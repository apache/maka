/**
 * Project menu pinning contract.
 *
 * The open project menu keeps `添加项目` / `无项目` against its bottom edge
 * while the catalogue scrolls behind them. Astryx `Selector` has no footer
 * slot, so the pinning is product CSS — and it is the kind of CSS that fails
 * silently: the rows still render, just in the wrong place or over each other,
 * and nothing throws.
 *
 * Two properties carry the whole construction, so this pins those rather than
 * the pixels:
 *
 * 1. The sticky box is the section's `role="group"`, not the option rows. The
 *    group's height is whatever it contains, so a search that matches one
 *    action pins one row. An earlier version stuck the rows and declared the
 *    block's height in CSS; a search that filtered one action out then left an
 *    opaque backdrop 29px taller than the rows, covering the catalogue rows
 *    behind it and swallowing their clicks.
 * 2. The background sits on the group, never on the option rows. Astryx paints
 *    hover and keyboard-highlight as `background-color` on the row, and this
 *    file's `components` layer outranks `astryx-components` — so an opaque
 *    colour on a row would win the cascade and silently kill both states.
 *
 * The lifetime and placement of the trigger are pinned separately, in
 * packages/ui/src/__tests__/composer-workspace-picker.test.tsx.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

const SCOPE = '.maka-composer-workspace [role="listbox"]';

/** Rule bodies whose selector starts with `prefix`, in source order. */
function ruleBodiesForPrefix(css: string, prefix: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf('{', index);
    if (open < 0) break;
    const selectorStart = Math.max(css.lastIndexOf('}', open), css.lastIndexOf('{', open - 1)) + 1;
    const selector = css.slice(selectorStart, open).trim();
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    if (selector.startsWith(prefix)) out.push({ selector, body: css.slice(open + 1, i - 1) });
    index = i;
  }
  return out;
}

describe('project menu pinning contract', () => {
  it('sticks the actions as one group box, not as individual rows', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const scoped = ruleBodiesForPrefix(css, SCOPE);

    const sticky = scoped.filter((rule) => /position:\s*sticky/.test(rule.body));
    assert.equal(
      sticky.length,
      1,
      `exactly one rule under ${SCOPE} may stick; got ${sticky.length}: ${JSON.stringify(sticky.map((r) => r.selector))}`,
    );
    assert.match(
      sticky[0]?.selector ?? '',
      /\[role="group"\]/,
      'the sticky box must be the section group, whose height follows its contents',
    );
    // A row-level offset is the shape the group formulation replaced: it can
    // only be written against a height the CSS has to assume.
    assert.doesNotMatch(
      sticky[0]?.body ?? '',
      /calc\(/,
      'the group pins to the list edge; a computed offset means a hardcoded row height is back',
    );
  });

  it('paints the backdrop on the group, leaving the rows to Astryx', async () => {
    const css = stripCssComments(await readAllRendererCss());

    for (const rule of ruleBodiesForPrefix(css, SCOPE)) {
      if (!/background(-color)?:/.test(rule.body)) continue;
      assert.match(
        rule.selector,
        /\[role="group"\]/,
        `${rule.selector} paints a background on an option row; that wins over Astryx's hover and keyboard-highlight tints`,
      );
    }
  });

  it('caps the open menu at the window', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const capped = ruleBodiesForPrefix(css, SCOPE).some((rule) => /max-width:\s*min\(/.test(rule.body));

    assert.ok(
      capped,
      'the popover has no ceiling of its own, so one long project name grows it past a narrow window edge',
    );
  });
});
