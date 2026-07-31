/**
 * PR-SIDEBAR-INDICATOR-SIZE-CONVERGE-0 (issue #743, follow-up to #738):
 * session-row indicator sizes converge onto tokens, except the dense-meta
 * status icon which §1.9 keeps as call-site 12–14px (not tokenized):
 *   - streaming-dot/unread 8px → var(--space-2)
 *   - status icon keeps its 14px wrapper layout slot (bare, dense-meta) and
 *     scopes a local 12px SVG override (bare, dense-meta) so the shared action's
 *     [&_svg]:size-[var(--icon-size,1rem)] (16px chrome tier, a cascade leak
 *     from borrowing UiButton) does not grow the <Icon size={12}> glyph
 *   - .maka-list-row-text min-height dropped (row 32px + grid center own it)
 *
 * The contract pins each indicator's width/height/min-height exactly-once
 * across rest blocks AND within each block, and matches selector lists
 * (`.other, .maka-list-row-unread { height: … }` is scanned, not just rules
 * whose whole prelude equals the subject).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

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

/** Rest blocks whose selector list CONTAINS `subjectSelector` as a whole
 *  selector (split on top-level commas, so `.other, .maka-list-row-unread` is
 *  scanned for `.maka-list-row-unread`). State pseudo / attribute variants are
 *  excluded — only the plain subject counts as the rest definition. */
function restBlocks(css: string, subjectSelector: string): string[] {
  const blocks: string[] = [];
  for (const [prelude, body] of styleRules(css)) {
    if (!prelude || prelude.startsWith('@')) continue;
    const selectors = prelude.split(',').map((s) => s.trim());
    if (selectors.some((sel) => sel === subjectSelector && !/[:[]/.test(sel))) {
      blocks.push(body);
    }
  }
  return blocks;
}

/** Assert `prop` is declared exactly once across all rest blocks of `selector`
 *  with `expected` value (a later rest block, a selector-list companion, or a
 *  same-block duplicate each fail). */
function assertExactlyOnce(css: string, selector: string, prop: string, expected: string, label: string): void {
  const decls = restBlocks(css, selector).flatMap((b) => declarationsIn(b, prop));
  assert.equal(decls.length, 1, `${label}: ${prop} must be declared exactly once (a later rest block, a selector-list companion, OR a same-block duplicate would all win the cascade); got ${decls.length}: ${JSON.stringify(decls)}`);
  assert.equal(decls[0], expected, `${label}: ${prop} must be ${expected}; got ${decls[0]}`);
}

describe('PR-SIDEBAR-INDICATOR-SIZE-CONVERGE-0 contract (issue #743)', () => {
  it('.maka-list-row-streaming-dot width and height are each var(--space-2), declared exactly once', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-list-row-streaming-dot', 'width', 'var(--space-2)', 'streaming-dot');
    assertExactlyOnce(css, '.maka-list-row-streaming-dot', 'height', 'var(--space-2)', 'streaming-dot');
  });

  it('.maka-list-row-unread width and height are each var(--space-2), declared exactly once', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-list-row-unread', 'width', 'var(--space-2)', 'unread');
    assertExactlyOnce(css, '.maka-list-row-unread', 'height', 'var(--space-2)', 'unread');
  });

  it('.maka-list-row-text declares no min-height (the row 32px control min-height + grid center own the height)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const decls = restBlocks(css, '.maka-list-row-text').flatMap((b) => declarationsIn(b, 'min-height'));
    assert.equal(decls.length, 0, `.maka-list-row-text must not set min-height (redundant with .maka-list-row's 32px); got ${JSON.stringify(decls)}`);
  });

  it('.maka-list-row-status-icon wrapper is 14px (dense-meta slot) and the SVG is 12px (dense-meta, not tokenized)', async () => {
    const css = stripCssComments(await readAllRendererCss());
    assertExactlyOnce(css, '.maka-list-row-status-icon', 'width', '14px', 'status-icon wrapper');
    assertExactlyOnce(css, '.maka-list-row-status-icon', 'height', '14px', 'status-icon wrapper');
    assertExactlyOnce(css, '.maka-list-row-status-icon svg', 'width', '12px', 'status-icon svg');
    assertExactlyOnce(css, '.maka-list-row-status-icon svg', 'height', '12px', 'status-icon svg');
  });

  it('assertExactlyOnce flags a same-block duplicate AND a selector-list companion (negative cases)', () => {
    const sameBlock = '.maka-list-row-unread { width: var(--space-2); height: var(--space-2); height: var(--space-3); }';
    assert.throws(
      () => assertExactlyOnce(sameBlock, '.maka-list-row-unread', 'height', 'var(--space-2)', 'unread'),
      /got 2/,
      'a same-block height duplicate must be caught',
    );
    // .other, .maka-list-row-unread — the selector-list companion wins the cascade
    const selectorList = '.other, .maka-list-row-unread { height: var(--space-3); }';
    assert.throws(
      () => assertExactlyOnce(selectorList, '.maka-list-row-unread', 'height', 'var(--space-2)', 'unread'),
      /var\(--space-3\)/,
      'a selector-list companion setting height must be caught (the override var(--space-3) won the cascade)',
    );
  });
});
