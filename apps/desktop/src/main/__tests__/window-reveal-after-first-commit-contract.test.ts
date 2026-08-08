import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createWindowRevealGate,
  showWindowOnceReady,
  type FocusableRevealableWindow,
} from '../window-reveal.js';

function makeWindow(): FocusableRevealableWindow & {
  showCount: number;
  focusCount: number;
  maximizeCount: number;
  destroy(): void;
} {
  let visible = false;
  let destroyed = false;
  let showCount = 0;
  let focusCount = 0;
  let maximizeCount = 0;
  return {
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    restore() {},
    show() {
      showCount += 1;
      visible = true;
    },
    focus() {
      focusCount += 1;
    },
    maximize() {
      maximizeCount += 1;
      visible = true;
    },
    destroy() {
      destroyed = true;
    },
    get showCount() {
      return showCount;
    },
    get focusCount() {
      return focusCount;
    },
    get maximizeCount() {
      return maximizeCount;
    },
  };
}

describe('window reveal gate', () => {
  it('defers focus and maximize until ready, then applies later requests immediately', () => {
    const gate = createWindowRevealGate(false);
    const window = makeWindow();

    gate.requestFocus(window);
    gate.requestMaximize(window);
    assert.deepEqual(
      [window.isVisible(), window.showCount, window.focusCount, window.maximizeCount],
      [false, 0, 0, 0],
    );

    gate.markReady(window);
    assert.deepEqual(
      [window.isVisible(), window.showCount, window.focusCount, window.maximizeCount],
      [true, 1, 1, 1],
    );

    gate.requestFocus(window);
    gate.requestMaximize(window);
    assert.deepEqual([window.showCount, window.focusCount, window.maximizeCount], [2, 2, 2]);
  });

  it('keepHidden blocks reveal, focus, and maximize through every gate path', () => {
    const gate = createWindowRevealGate(true);
    const window = makeWindow();

    gate.requestFocus(window);
    gate.requestMaximize(window);
    gate.markReady(window);
    gate.requestFocus(window);
    gate.requestMaximize(window);

    assert.deepEqual(
      [window.isVisible(), window.showCount, window.focusCount, window.maximizeCount],
      [false, 0, 0, 0],
    );
  });

  it('reset re-arms readiness for a recreated window', () => {
    const gate = createWindowRevealGate(false);
    gate.markReady(makeWindow());
    gate.reset();

    const recreated = makeWindow();
    gate.requestFocus(recreated);
    gate.requestMaximize(recreated);
    assert.equal(recreated.isVisible(), false);

    gate.markReady(recreated);
    assert.deepEqual(
      [recreated.isVisible(), recreated.focusCount, recreated.maximizeCount],
      [true, 1, 1],
    );
  });

  it('reveals once and ignores hidden-fixture, null, and destroyed targets', () => {
    const visible = makeWindow();
    showWindowOnceReady(visible, false);
    showWindowOnceReady(visible, false);
    assert.deepEqual([visible.isVisible(), visible.showCount], [true, 1]);

    const fixture = makeWindow();
    showWindowOnceReady(fixture, true);
    assert.deepEqual([fixture.isVisible(), fixture.showCount], [false, 0]);

    assert.doesNotThrow(() => showWindowOnceReady(null, false));
    const destroyed = makeWindow();
    destroyed.destroy();
    showWindowOnceReady(destroyed, false);
    assert.equal(destroyed.showCount, 0);
  });
});
