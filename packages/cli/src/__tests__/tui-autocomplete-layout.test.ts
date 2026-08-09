import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fitAutocompleteLines } from '../tui-autocomplete-layout.js';

describe('fitAutocompleteLines', () => {
  test('keeps the selected item visible and reports the full command count', () => {
    const commands = Array.from(
      { length: 18 },
      (_, index) => `${index === 0 ? '→' : ' '} /command-${index + 1}`,
    );

    assert.deepEqual(fitAutocompleteLines(commands, 16), [...commands.slice(0, 15), '  (1/18)']);
  });

  test('moves the fitted window with a selection near the end', () => {
    const commands = Array.from(
      { length: 18 },
      (_, index) => `${index === 17 ? '→' : ' '} /command-${index + 1}`,
    );

    assert.deepEqual(fitAutocompleteLines(commands, 6), [...commands.slice(13), '  (18/18)']);
  });

  test('preserves an upstream picker position when fitting an already-windowed list', () => {
    const window = [
      '  /command-18',
      '  /command-19',
      '→ /command-20',
      '  /command-21',
      '  /command-22',
      '  (20/30)',
    ];

    assert.deepEqual(fitAutocompleteLines(window, 4), [
      '  /command-19',
      '→ /command-20',
      '  /command-21',
      '  (20/30)',
    ]);
  });

  test('uses the selected row when only one autocomplete row fits', () => {
    assert.deepEqual(fitAutocompleteLines(['  /one', '→ /two', '  /three'], 1), ['→ /two']);
  });
});
