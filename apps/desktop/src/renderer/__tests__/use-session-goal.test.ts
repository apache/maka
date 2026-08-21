import assert from 'node:assert/strict';
import test from 'node:test';
import { isGoalArmedAwaitingFirstTurn } from '../use-session-goal.js';

test('an armed Goal stops awaiting its first Turn once that Turn is active', () => {
  assert.equal(isGoalArmedAwaitingFirstTurn({ armedAt: 1 }, false), true);
  assert.equal(isGoalArmedAwaitingFirstTurn({ armedAt: 1 }, true), false);
  assert.equal(isGoalArmedAwaitingFirstTurn({}, false), false);
});
