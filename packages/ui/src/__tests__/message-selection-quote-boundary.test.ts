import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelectionQuoteGestureBoundary } from '../use-message-selection-quote.js';

test('drag selection settles only after its owning pointer is released', () => {
  const effects: string[] = [];
  const boundary = createSelectionQuoteGestureBoundary({
    hideAndCancel: () => effects.push('hide'),
    scheduleSettle: () => effects.push('schedule'),
  });

  boundary.beginPointerSelection(7);
  boundary.selectionChanged();
  boundary.selectionChanged();
  assert.deepEqual(effects, ['hide', 'hide', 'hide']);

  boundary.endPointerSelection(9);
  assert.deepEqual(effects, ['hide', 'hide', 'hide'], 'another pointer cannot commit the drag');

  boundary.endPointerSelection(7);
  assert.deepEqual(effects, ['hide', 'hide', 'hide', 'schedule']);
});

test('pointer events cannot resurrect an unchanged or cancelled selection', () => {
  const effects: string[] = [];
  const boundary = createSelectionQuoteGestureBoundary({
    hideAndCancel: () => effects.push('hide'),
    scheduleSettle: () => effects.push('schedule'),
  });

  boundary.beginPointerSelection(3);
  boundary.endPointerSelection(3);
  boundary.beginPointerSelection(4);
  boundary.selectionChanged();
  boundary.cancelPointerSelection(8);
  boundary.cancelActivePointerSelection();
  assert.deepEqual(effects, ['hide', 'hide', 'hide', 'hide']);

  boundary.beginPointerSelection(5);
  boundary.selectionChanged();
  boundary.cancelPointerSelection(5);
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
