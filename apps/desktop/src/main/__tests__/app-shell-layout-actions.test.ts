import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createAppShellLayoutActions } from '../../renderer/app-shell-layout-actions.js';

function keyboardEvent(key: string, shiftKey = false) {
  let prevented = false;
  return {
    event: {
      key,
      shiftKey,
      preventDefault() {
        prevented = true;
      },
    },
    prevented: () => prevented,
  };
}

describe('app shell layout actions', () => {
  it('ArrowLeft gives more width to the right workbar', () => {
    let width = 400;
    const actions = createAppShellLayoutActions({
      workbarCollapsed: false,
      workbarWidth: width,
      setWorkbarWidth: (next: number) => {
        width = next;
      },
    });
    const input = keyboardEvent('ArrowLeft');

    actions.onWorkbarResizeHandleKeyDown(input.event as never);

    assert.equal(width, 410);
    assert.equal(input.prevented(), true);
  });
});
