import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  convertOpenAIComputerAction,
  isOpenAIComputerActionSafeByDefault,
} from '../openai-computer-actions.js';

describe('convertOpenAIComputerAction', () => {
  test('defaults to observation-only actions under the physical-input safety policy', () => {
    assert.equal(isOpenAIComputerActionSafeByDefault({ type: 'screenshot' }), true);
    assert.equal(isOpenAIComputerActionSafeByDefault({ type: 'wait' }), true);
    assert.equal(isOpenAIComputerActionSafeByDefault({ type: 'move', x: 1, y: 2 }), false);
    assert.equal(
      isOpenAIComputerActionSafeByDefault({
        type: 'click',
        button: 'left',
        x: 1,
        y: 2,
      }),
      false,
    );
    assert.equal(isOpenAIComputerActionSafeByDefault({ type: 'type', text: 'x' }), false);
    assert.equal(
      isOpenAIComputerActionSafeByDefault({
        type: 'keypress',
        keys: ['ENTER'],
      }),
      false,
    );
  });

  test('converts only a two-point drag path', () => {
    assert.deepEqual(
      convertOpenAIComputerAction({
        type: 'drag',
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      }),
      {
        ok: true,
        actions: [
          {
            type: 'left_click_drag',
            startCoordinate: { x: 1, y: 2 },
            coordinate: { x: 3, y: 4 },
          },
        ],
      },
    );
    const result = convertOpenAIComputerAction({
      type: 'drag',
      path: [
        { x: 1, y: 2 },
        { x: 2, y: 3 },
        { x: 3, y: 4 },
      ],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'unsupported_drag_path');
  });

  test('fails closed for pixel scroll deltas, held modifiers, and navigation buttons', () => {
    const scroll = convertOpenAIComputerAction({
      type: 'scroll',
      x: 1,
      y: 2,
      scroll_x: 0,
      scroll_y: 300,
    });
    assert.equal(scroll.ok, false);
    if (!scroll.ok) assert.equal(scroll.code, 'unsupported_scroll_delta');

    const modified = convertOpenAIComputerAction({
      type: 'click',
      button: 'left',
      x: 1,
      y: 2,
      keys: ['SHIFT'],
    });
    assert.equal(modified.ok, false);
    if (!modified.ok) assert.equal(modified.code, 'unsupported_modifier_keys');

    const back = convertOpenAIComputerAction({
      type: 'click',
      button: 'back',
      x: 1,
      y: 2,
    });
    assert.equal(back.ok, false);
    if (!back.ok) assert.equal(back.code, 'unsupported_button');

    const chord = convertOpenAIComputerAction({
      type: 'keypress',
      keys: ['CTRL', 'L'],
    });
    assert.equal(chord.ok, false);
    if (!chord.ok) assert.equal(chord.code, 'unsupported_keypress_chord');
  });
});
