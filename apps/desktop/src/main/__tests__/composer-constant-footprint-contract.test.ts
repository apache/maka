/**
 * PR-COMPOSER-CONSTANT-FOOTPRINT-0 (issue #740):
 * lock the Composer's constant vertical footprint so the empty composer can't
 * drift back to the ~200px that ate a quarter of an 820px window.
 *
 * The cut is static — no `[data-compact]` state machine, no idle/active mode.
 * The Composer is the highest-frequency surface and sits at the bottom of the
 * chat column; an idle↔active height switch would push the chat viewport
 * boundary and jump the conversation. Stability takes priority over peak space
 * savings, so the footprint is tightened once via static CSS and stays put. The
 * textarea already auto-resizes as content arrives (capped at
 * COMPOSER_MAX_HEIGHT in @maka/ui), so content-driven "expand" is the textarea's
 * own growth — no enter/leave transition, no reduced-motion special-casing.
 *
 * Stability is locked at two layers:
 *   (a) FORM GEOMETRY — five rest levers pinned exactly-once, plus the <form>'s
 *       second class .maka-composer must NOT re-add padding (single source).
 *   (b) TOOLBAR GEOMETRY — the send button (size="icon-sm", h-8/32px) and the
 *       stop button (size="sm", h-8/32px) share the same height, so swapping
 *       send→stop on streaming does NOT change the toolbar height (a prior 4px
 *       jump from stop defaulting to md/h-9 is now fixed).
 *
 * This contract does NOT attempt to lock "no state selector can ever change
 * the footprint" via a property blacklist — CSS selectors are unbounded (compound
 * aliases, pseudo-elements, display/border-width changes), so such a guard is
 * fail-open and dishonest. #740's "no mode switch" is upheld by product code
 * (no [data-compact] state is introduced) + the two stability layers above;
 * a future state rule that re-introduces a footprint switch is a review
 * responsibility, not a static-scan one.
 *
 * Six invariants (820px window baseline: composer outer 200px, inner 128px,
 * textarea 56px → 200/128/56 tightened to ~164/104/44):
 *   1. --h-composer-min is 44px.
 *   2. .composer padding is var(--space-2) var(--space-6) var(--space-2);
 *      .maka-composer (the form's other class) declares NO padding.
 *   3. .maka-composer-inner padding is var(--space-2) var(--space-3)
 *      var(--space-1-5); gap is var(--space-1-5).
 *   4. .composerActions margin-top is var(--space-1).
 *   5. .maka-composer-textarea min-height is var(--h-composer-min) (CSS) and
 *      its className carries no Tailwind min-h-* (TSX).
 *   6. send + stop buttons both use an h-8 size (icon-sm or sm, 32px).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  REPO_ROOT,
  TOKENS_FILE,
  readAllRendererCss,
  stripCssComments,
  assertCustomPropPinnedOnce,
} from './css-test-helpers.js';

const COMPOSER_TSX = join(REPO_ROOT, 'packages/ui/src/composer.tsx');

function styleRules(css: string): Array<[string, string]> {
  const stripped = stripCssComments(css);
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const prelude = m[1].replace(/^[\s\S]*;/, '').trim();
    return [prelude, m[2]] as [string, string];
  });
}

function declarationsIn(body: string, prop: string): string[] {
  const re = new RegExp(`(?:^|[\\n;])\\s*${prop}\\s*:\\s*([^;}]*)`, 'ig');
  return [...body.matchAll(re)].map((m) => m[1].trim().replace(/\s+/g, ' '));
}

/** The subject of a selector — the last simple-selector sequence after any
 *  combinator (descendant ` `, child `>`, sibling `+`/`~`). `.composer .inner`
 *  → `.inner`; `.maka-composer.composer` → `.maka-composer.composer`. */
function subjectOf(sel: string): string {
  const parts = sel.split(/\s(?:[>+~]\s)?\s|\s/).filter(Boolean);
  return parts[parts.length - 1] ?? sel;
}

/** Classes on the subject (`.foo.bar` → [`.foo`, `.bar`]). Hyphenated names
 *  stay one class (`.maka-composer` ≠ `.maka` + `.composer`). */
function subjectClasses(sel: string): string[] {
  return [...subjectOf(sel).matchAll(/\.([\w-]+)/g)].map((m) => `.${m[1]}`);
}

/** Rest blocks whose subject carries `subjectClass` and has no state pseudo /
 *  attribute. Matching by SUBJECT (not whole-selector equality) catches a
 *  compound alias like `.maka-composer.composer { padding }` that a strict
 *  `.composer` equality would miss, while excluding descendant selectors whose
 *  subject is a different element (`.composer .maka-composer-inner`). */
function restBlocks(css: string, subjectClass: string): string[] {
  const blocks: string[] = [];
  for (const [prelude, body] of styleRules(css)) {
    if (!prelude || prelude.startsWith('@')) continue;
    const selectors = prelude.split(',').map((s) => s.trim());
    if (selectors.some((sel) => subjectClasses(sel).includes(subjectClass) && !/[:[]/.test(subjectOf(sel)))) {
      blocks.push(body);
    }
  }
  return blocks;
}

function assertExactlyOnce(css: string, subjectClass: string, prop: string, expected: string, label: string): void {
  const decls = restBlocks(css, subjectClass).flatMap((b) => declarationsIn(b, prop));
  assert.equal(decls.length, 1, `${label}: ${prop} must be declared exactly once on a rest block whose subject carries ${subjectClass} (a later rest block, a selector-list companion, a compound alias, OR a same-block duplicate would all win the cascade); got ${decls.length}: ${JSON.stringify(decls)}`);
  assert.equal(decls[0], expected, `${label}: ${prop} must be ${expected}; got ${decls[0]}`);
}

describe('PR-COMPOSER-CONSTANT-FOOTPRINT-0 contract (issue #740)', () => {
  it('--h-composer-min is pinned to 44px (single-line natural, not 56px)', async () => {
    const tokens = await readFile(TOKENS_FILE, 'utf8');
    assertCustomPropPinnedOnce(tokens, '--h-composer-min', '44px', 'maka-tokens.css');
  });

  it('.composer rest padding is var(--space-2) var(--space-6) var(--space-2) AND .maka-composer (form alias) declares no padding (single source)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.composer', 'padding', 'var(--space-2) var(--space-6) var(--space-2)', '.composer padding');
    const makaPadding = restBlocks(css, '.maka-composer').flatMap((b) => declarationsIn(b, 'padding'));
    assert.equal(makaPadding.length, 0, `.maka-composer must not declare padding (the <form> carries .maka-composer + .composer; .composer is the single source); got ${JSON.stringify(makaPadding)}`);
  });

  it('.maka-composer-inner rest padding + gap are the constant footprint', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-composer-inner', 'padding', 'var(--space-2) var(--space-3) var(--space-1-5)', '.maka-composer-inner padding');
    assertExactlyOnce(css, '.maka-composer-inner', 'gap', 'var(--space-1-5)', '.maka-composer-inner gap');
  });

  it('.composerActions rest margin-top is var(--space-1) (4px)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.composerActions', 'margin-top', 'var(--space-1)', '.composerActions margin-top');
  });

  it('.maka-composer-textarea min-height is var(--h-composer-min) (CSS) AND its className carries no Tailwind min-h-* (TSX single source)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-composer-textarea', 'min-height', 'var(--h-composer-min)', '.maka-composer-textarea min-height');
    const source = await readFile(COMPOSER_TSX, 'utf8');
    const textareaLine = source.split('\n').find((l) => l.includes('maka-composer-textarea'));
    assert.ok(textareaLine, 'maka-composer-textarea className line not found in composer.tsx');
    assert.doesNotMatch(textareaLine!, /min-h-[a-z0-9]+/i, '.maka-composer-textarea className must not carry a Tailwind min-h-* utility (CSS min-height: var(--h-composer-min) is the single source)');
  });

  it('stop and send use the governed 32px tier so streaming does not change toolbar height', async () => {
    const source = await readFile(COMPOSER_TSX, 'utf8');
    // #1565 PR 3: Astryx Button's default `md` tier is 32px
    // (--size-element-md). Stop (streaming) and send (rest) both stay on that
    // default, so neither may carry a size override that would change the
    // toolbar height when streaming toggles.
    const stopBlock = source.match(/props\.streaming \? \(\s*<UiButton[\s\S]*?\/>/);
    assert.ok(stopBlock, 'stop button block (streaming branch) not found');
    assert.doesNotMatch(stopBlock[0], /size="/, 'stop button must stay on the default 32px md tier');
    const sendBlock = source.match(
      /<IconButton\s+variant="primary"[\s\S]*?icon=\{<ArrowUp/,
    );
    assert.ok(sendBlock, 'send button block (rest branch) not found');
    assert.doesNotMatch(sendBlock[0], /size="/, 'send button must stay on the default 32px md tier');
    assert.match(
      source,
      /<IconButton\s+variant="primary"\s+type="submit"[\s\S]*?label=\{copy\.sendLabel\}/,
    );
  });

  it('negative cases: same-block duplicate, selector-list companion, compound .maka-composer.composer padding return, .maka-composer padding return, textarea min-h-* return, stop off-tier return', () => {
    const sameBlock = '.composer { padding: var(--space-2) var(--space-6) var(--space-2); padding: var(--space-3) var(--space-6) var(--space-4); }';
    assert.throws(
      () => assertExactlyOnce(sameBlock, '.composer', 'padding', 'var(--space-2) var(--space-6) var(--space-2)', '.composer padding'),
      /got 2/,
      'a same-block padding duplicate must be caught',
    );
    const selectorList = '.other, .composer { padding: var(--space-3) var(--space-6) var(--space-4); }';
    assert.throws(
      () => assertExactlyOnce(selectorList, '.composer', 'padding', 'var(--space-2) var(--space-6) var(--space-2)', '.composer padding'),
      /var\(--space-3\)/,
      'a selector-list companion setting padding must be caught',
    );
    const compound = '.maka-composer.composer { padding: var(--space-3) var(--space-6) var(--space-4); }';
    assert.throws(
      () => assertExactlyOnce(compound, '.composer', 'padding', 'var(--space-2) var(--space-6) var(--space-2)', '.composer padding'),
      /var\(--space-3\)/,
      'a compound alias .maka-composer.composer setting padding must be caught (subject carries .composer)',
    );
    const makaReturn = '.maka-composer { padding: var(--space-4) var(--space-6); }';
    assert.equal(restBlocks(makaReturn, '.maka-composer').flatMap((b) => declarationsIn(b, 'padding')).length, 1, 'a .maka-composer padding return must be caught (form alias)');
    const tsxReturn = '          className="maka-composer-textarea min-h-11 resize-none"';
    assert.match(tsxReturn, /min-h-[a-z0-9]+/i, 'a returned textarea min-h-* utility must be caught');
    // #1565 PR 3: with Astryx the governed 32px tier is the md default, so the
    // regression to catch is a size override leaving the tier.
    const stopOffTierReturn = 'props.streaming ? (\n  <UiButton\n    variant="primary"\n    size="lg"\n    label="停止"\n  />\n)';
    const stopOffTierBlock = stopOffTierReturn.match(/props\.streaming \? \(\s*<UiButton[\s\S]*?\/>/);
    assert.ok(stopOffTierBlock, 'stop block extraction must work on the fixture');
    assert.throws(() => assert.doesNotMatch(stopOffTierBlock[0]!, /size="/), 'a stop button leaving the default md tier (size override) must be caught end-to-end (lg 36px ≠ md 32px)');
  });
});
