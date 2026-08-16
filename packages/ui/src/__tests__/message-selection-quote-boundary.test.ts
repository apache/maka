import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelectionQuoteGestureBoundary } from '../use-message-selection-quote.js';

test('drag selection settles only after its owning pointer is released', () => {
  const effects: string[] = [];
  const boundary = createSelectionQuoteGestureBoundary({
    hideAndCancel: () => effects.push('hide'),
    scheduleSettle: () => effects.push('schedule'),
  });

  assert.equal(boundary.beginPointerSelection(7, 'turn-a'), true);
  boundary.selectionChanged();
  boundary.selectionChanged();
  assert.deepEqual(effects, ['hide', 'hide', 'hide']);

  boundary.finishPointerSelection(9, 'commit');
  assert.deepEqual(effects, ['hide', 'hide', 'hide'], 'another pointer cannot commit the drag');

  assert.equal(boundary.finishPointerSelection(7, 'commit'), 'turn-a');
  assert.deepEqual(effects, ['hide', 'hide', 'hide', 'schedule']);
});

test('pointer events cannot resurrect an unchanged or cancelled selection', () => {
  const effects: string[] = [];
  const boundary = createSelectionQuoteGestureBoundary({
    hideAndCancel: () => effects.push('hide'),
    scheduleSettle: () => effects.push('schedule'),
  });

  boundary.beginPointerSelection(3, 'turn-a');
  boundary.finishPointerSelection(3, 'commit');
  boundary.beginPointerSelection(4, 'turn-a');
  boundary.selectionChanged();
  boundary.finishPointerSelection(8, 'cancel');
  boundary.finishPointerSelection(4, 'cancel');
  assert.deepEqual(effects, ['hide', 'hide', 'hide', 'hide']);

  boundary.beginPointerSelection(5, 'turn-a');
  boundary.selectionChanged();
  boundary.finishPointerSelection(5, 'cancel');
  assert.deepEqual(effects, ['hide', 'hide', 'hide', 'hide', 'hide', 'hide', 'hide']);

  boundary.selectionChanged();
  assert.deepEqual(effects, [
    'hide',
    'hide',
    'hide',
    'hide',
    'hide',
    'hide',
    'hide',
    'hide',
    'schedule',
  ]);
});

test('a second primary pointer cannot replace the active gesture owner', () => {
  const effects: string[] = [];
  const boundary = createSelectionQuoteGestureBoundary({
    hideAndCancel: () => effects.push('hide'),
    scheduleSettle: () => effects.push('schedule'),
  });

  assert.equal(boundary.beginPointerSelection(1, 'mouse-owner'), true);
  assert.equal(boundary.beginPointerSelection(2, 'touch-owner'), false);
  boundary.selectionChanged();
  assert.equal(boundary.finishPointerSelection(2, 'commit'), null);
  assert.equal(boundary.finishPointerSelection(1, 'commit'), 'mouse-owner');
  assert.deepEqual(effects, ['hide', 'hide', 'schedule']);
});

test('capture loss cancels a changed gesture without showing a quote', () => {
  const effects: string[] = [];
  const boundary = createSelectionQuoteGestureBoundary({
    hideAndCancel: () => effects.push('hide'),
    scheduleSettle: () => effects.push('schedule'),
  });

  boundary.beginPointerSelection(1, 'turn-a');
  boundary.selectionChanged();
  assert.equal(boundary.finishPointerSelection(1, 'cancel'), 'turn-a');
  assert.deepEqual(effects, ['hide', 'hide', 'hide']);
});
