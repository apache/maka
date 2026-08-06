/**
 * Project menu scroll contract.
 *
 * In the open project menu, only the project catalogue scrolls: `添加项目` /
 * `无项目` sit after it in normal flow, outside the scroller, so they can
 * never be carried along by the wheel. That is product CSS — and it is the
 * kind of CSS that fails silently: the rows still render, just scrolling
 * together with the actions or chaining overscroll into the page behind the
 * popover, and nothing throws.
 *
 * Three properties carry the whole construction, so this pins those rather
 * than the pixels:
 *
 * 1. The only scrollable element under the menu is the catalogue region
 *    (`.maka-workspace-picker-scroll`): it owns `overflow-y: auto` and the
 *    `max-height` budget. The menu panel itself must not scroll — Astryx
 *    caps it at 300px with `overflow-y: auto`, which would scroll the actions
 *    too, so the product rules lift that cap.
 * 2. No `position: sticky` anywhere under the menu. The actions' old pinned
 *    box moved with the panel when overscroll chained to the page; being
 *    outside the scroller is what actually fixes them, and sticky would be a
 *    second authority that can drift.
 * 3. No rule under the menu paints a background on the group or the item
 *    rows. Astryx paints hover and keyboard-highlight as `background-color`
 *    on the row, and this file's `components` layer outranks
 *    `astryx-components` — an opaque colour on a row or on the group would
 *    win the cascade and silently kill both states. Nothing scrolls under the
 *    actions any more, so they need no backdrop of their own.
 *
 * The lifetime and placement of the trigger are pinned separately, in
 * packages/ui/src/__tests__/composer-workspace-picker.test.tsx.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

const SCOPE = '.maka-composer-workspace [role="menu"]';
const SCROLL_SCOPE = '.maka-workspace-picker-scroll';

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

describe('project menu scroll contract', () => {
  it('scrolls only the catalogue region, not the menu panel', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const scoped = ruleBodiesForPrefix(css, SCOPE);

    const scrollers = ruleBodiesForPrefix(css, SCROLL_SCOPE).filter((rule) =>
      /overflow(-y)?:\s*(auto|scroll)/.test(rule.body),
    );
    assert.equal(
      scrollers.length,
      1,
      `exactly one rule may scroll the catalogue region; got ${scrollers.length}: ${JSON.stringify(scrollers.map((r) => r.selector))}`,
    );
    assert.match(
      scrollers[0]?.selector ?? '',
      /^\.maka-workspace-picker-scroll(?:\s|$|:|\[)/,
      'the scroller must be the catalogue region, not the menu panel',
    );
    assert.match(scrollers[0]?.body ?? '', /max-height/, 'the catalogue region owns the height budget');
    // The chaining fix: without `contain`, a wheel past the catalogue's end
    // scrolls the page behind the popover and drags the actions along — the
    // exact bug this construction exists to fix.
    assert.match(
      scrollers[0]?.body ?? '',
      /overscroll-behavior:\s*contain/,
      'the catalogue region must contain its overscroll',
    );

    // The panel rule must LIFT Astryx's 300px cap: the cap comes with
    // `overflow-y: auto` (astryx.css), which would scroll the actions with
    // the panel again even with the region in place.
    const panelRule = scoped.find((rule) => rule.selector === SCOPE);
    assert.ok(panelRule, `a rule on the bare ${SCOPE} selector must lift the cap`);
    assert.match(panelRule.body, /max-height:\s*none/, 'the panel must lift Astryx\'s 300px max-height');
    assert.match(panelRule.body, /overflow:\s*visible/, 'the panel must not scroll itself');

    // No other rule under the menu may scroll.
    for (const rule of scoped) {
      if (!/overflow/.test(rule.body)) continue;
      assert.doesNotMatch(
        rule.body,
        /overflow(-y)?:\s*(auto|scroll)/,
        `${rule.selector} makes the menu panel scroll; the panel must leave scrolling to the catalogue region`,
      );
    }
  });

  it('keeps the catalogue/actions divider only when there is a catalogue', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const divider = ruleBodiesForPrefix(css, SCOPE).filter((rule) => /border-top/.test(rule.body));

    assert.equal(
      divider.length,
      1,
      `exactly one rule may draw the catalogue/actions divider; got ${divider.length}: ${JSON.stringify(divider.map((r) => r.selector))}`,
    );
    assert.match(
      divider[0]?.selector ?? '',
      /:not\(:first-child\)/,
      'first run (no projects) must open with the actions group as the menu\'s first child and no divider above it',
    );
  });

  it('has no sticky positioning anywhere under the menu', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const sticky = ruleBodiesForPrefix(css, SCOPE).filter((rule) => /position:\s*sticky/.test(rule.body));

    assert.equal(
      sticky.length,
      0,
      `sticky pinning is the construction the scroll region replaced; got ${sticky.length}: ${JSON.stringify(sticky.map((r) => r.selector))}`,
    );
  });

  it('paints no backdrop on the group or the rows, leaving Astryx the hover tints', async () => {
    const css = stripCssComments(await readAllRendererCss());

    for (const rule of ruleBodiesForPrefix(css, SCOPE)) {
      assert.doesNotMatch(
        rule.body,
        /background(-color)?:/,
        `${rule.selector} paints a background; that wins over Astryx's hover and keyboard-highlight tints`,
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
