/**
 * Deep-thinking body wrap contract.
 *
 * Astryx's ejected ChatReasoning (packages/ui/src/astryx-chat-reasoning.tsx)
 * owns no white-space on its content shell — the component assumes children
 * are pre-rendered content, and its StyleX atoms declare nothing, so the
 * inherited `white-space: normal` collapses every newline in the thinking
 * text ("深度思考换行被吞"). The product restores the reading contract with a
 * product class on the reasoning body + one CSS rule in @maka/ui styles.css.
 *
 * This pins the CSS half of that seam: the rule must exist, must restore
 * pre-wrap (and the long-token break the pre-Astryx body had), and must be
 * the ONLY declaration on that class — a second rule re-declaring white-space
 * would silently re-break wrap. The renderer half (the class actually landing
 * on the content div) is locked by the deep-thinking disclosure test in
 * packages/ui/src/__tests__/processing-block.test.tsx.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { assertCssRuleDecls, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

describe('deep-thinking body wrap contract', () => {
  it('renders the reasoning body with pre-wrap, as the only declaration on it', async () => {
    const css = stripCssComments(await readAllRendererCss());

    assertCssRuleDecls(
      css,
      '.maka-chat-reasoning-content',
      [
        /white-space:\s*pre-wrap/,
        /word-break:\s*break-word/,
      ],
    );

    const mentions = css.match(/maka-chat-reasoning-content/g) ?? [];
    assert.equal(
      mentions.length,
      1,
      'maka-chat-reasoning-content must be declared exactly once; a second rule would re-break newline wrapping',
    );
  });
});
