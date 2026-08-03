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
 * This pins the CSS half of that seam: the final effective cascade value of
 * `white-space`/`word-break` for `.maka-chat-reasoning-content` must be
 * pre-wrap/break-word. Within the components layer, the last rule declaring a
 * property wins, so the assertion walks every matching rule body in source
 * order and checks the last declaration of each property — a later rule that
 * re-declares `white-space: normal` fails here even while an earlier rule
 * still says pre-wrap, and a harmless addition (a focus outline, a media
 * variant that leaves white-space alone) stays green. The renderer half (the
 * class actually landing on the content div) is locked by the deep-thinking
 * disclosure test in packages/ui/src/__tests__/processing-block.test.tsx.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/** Every rule body whose selector matches `selector`, in source order. */
function cssRuleBodies(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[\\{\\}])\\s*${escaped}\\s*\\{`, 'g');
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    bodies.push(css.slice(open + 1, i - 1));
  }
  return bodies;
}

/** Last value declared for `prop` across all bodies, in cascade (source) order. */
function lastEffective(bodies: string[], prop: string): string | undefined {
  let value: string | undefined;
  for (const body of bodies) {
    for (const match of body.matchAll(new RegExp(`${prop}\\s*:\\s*([^;}]+)`, 'g'))) {
      value = match[1]!.trim();
    }
  }
  return value;
}

describe('deep-thinking body wrap contract', () => {
  it('renders the reasoning body with pre-wrap, as the final effective declaration', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const bodies = cssRuleBodies(css, '.maka-chat-reasoning-content');

    assert.ok(bodies.length > 0, '.maka-chat-reasoning-content rule must exist');
    assert.equal(
      lastEffective(bodies, 'white-space'),
      'pre-wrap',
      'the final effective white-space for the reasoning body must be pre-wrap',
    );
    assert.equal(
      lastEffective(bodies, 'word-break'),
      'break-word',
      'the final effective word-break for the reasoning body must be break-word',
    );
  });
});
