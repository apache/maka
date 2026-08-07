import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  QUOTE_ACTIONS_MIN_TOP,
  QUOTE_ACTIONS_OFFSET_Y,
  quoteActionsFixedTop,
} from '../quote-actions-geometry.js';

describe('quoteActionsFixedTop', () => {
  it('tracks a selection that stays clear of the top clamp by the same delta', () => {
    const before = 400;
    const delta = -220;
    assert.equal(
      quoteActionsFixedTop(before + delta) - quoteActionsFixedTop(before),
      delta,
      'scroll-follow is only correct when the fixed top moves with the selection',
    );
    assert.equal(quoteActionsFixedTop(before), before - QUOTE_ACTIONS_OFFSET_Y);
  });

  it('clamps to the min top instead of following an off-screen selection into the chrome', () => {
    assert.equal(quoteActionsFixedTop(10), QUOTE_ACTIONS_MIN_TOP);
    assert.equal(quoteActionsFixedTop(QUOTE_ACTIONS_OFFSET_Y + QUOTE_ACTIONS_MIN_TOP), QUOTE_ACTIONS_MIN_TOP);
  });
});
