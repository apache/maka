import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  compensateFillScroll,
  DEFAULT_MOUNT_WINDOW,
  fillMountWindow,
  initialMountWindow,
  reconcileMountWindow,
  type MountWindowState,
} from '../progressive-turn-mount.js';

const config = DEFAULT_MOUNT_WINDOW;

function state(key: string | undefined, length: number, start: number): MountWindowState {
  return { key, length, start };
}

describe('initialMountWindow', () => {
  it('starts a long transcript at its tail window', () => {
    assert.equal(initialMountWindow('a', 30, config).start, 30 - config.initialWindow);
  });

  it('starts a short transcript fully mounted', () => {
    assert.equal(initialMountWindow('a', 4, config).start, 0);
    assert.equal(initialMountWindow(undefined, 0, config).start, 0);
  });
});

describe('reconcileMountWindow', () => {
  it('re-windows to the tail on a session switch', () => {
    const next = reconcileMountWindow(state('a', 30, 0), { key: 'b', length: 30 }, config);
    assert.equal(next.start, 30 - config.initialWindow);
    assert.equal(next.key, 'b');
  });

  it('re-windows when the turn count jumps by more than one window at once', () => {
    const next = reconcileMountWindow(state('a', 0, 0), { key: 'a', length: 30 }, config);
    assert.equal(next.start, 30 - config.initialWindow);
  });

  it('keeps the window while streaming appends single turns', () => {
    const current = state('a', 30, 20);
    const next = reconcileMountWindow(current, { key: 'a', length: 31 }, config);
    assert.equal(next.start, 20);
  });

  it('re-windows when the transcript shrinks below the window start', () => {
    const next = reconcileMountWindow(state('a', 30, 20), { key: 'a', length: 5 }, config);
    assert.equal(next.start, 0);
  });

  it('re-windows when the transcript shrinks exactly to the window start', () => {
    // start === length slices to an empty transcript, just as invalid as
    // start past the end (#2191 review).
    const next = reconcileMountWindow(state('a', 30, 20), { key: 'a', length: 20 }, config);
    assert.equal(next.start, 20 - config.initialWindow);
  });

  it('keeps an empty transcript at start zero', () => {
    const current = state('a', 0, 0);
    assert.equal(reconcileMountWindow(current, { key: 'a', length: 0 }, config), current);
  });

  it('widens to include an ensured index', () => {
    const next = reconcileMountWindow(state('a', 30, 20), { key: 'a', length: 30 }, config, 3);
    assert.equal(next.start, 3);
  });

  it('ignores an ensured index that is already mounted or unknown', () => {
    const current = state('a', 30, 20);
    assert.equal(reconcileMountWindow(current, { key: 'a', length: 30 }, config, 25), current);
    assert.equal(reconcileMountWindow(current, { key: 'a', length: 30 }, config, -1), current);
  });

  it('returns the same reference when nothing changes', () => {
    const current = state('a', 30, 20);
    assert.equal(reconcileMountWindow(current, { key: 'a', length: 30 }, config), current);
  });

  it('mounts a short transcript completely from the first commit', () => {
    const next = reconcileMountWindow(state(undefined, 0, 0), { key: 'a', length: 4 }, config);
    assert.equal(next.start, 0);
  });
});

describe('fillMountWindow', () => {
  it('steps the window up by one chunk until it reaches zero', () => {
    let current = state('a', 30, 20);
    const starts: number[] = [];
    while (current.start > 0) {
      current = fillMountWindow(current, config);
      starts.push(current.start);
    }
    assert.deepEqual(starts, [16, 12, 8, 4, 0]);
    assert.equal(fillMountWindow(current, config), current);
  });
});

describe('compensateFillScroll', () => {
  it('preserves the reading position when the user has scrolled up', () => {
    const result = compensateFillScroll(
      { scrollTop: 1000, scrollHeight: 5000, clientHeight: 800 },
      6000,
    );
    assert.equal(result.pin, false);
    assert.equal(result.scrollTop, 2000);
  });

  it('re-pins to the bottom inside the 10px lock threshold', () => {
    const result = compensateFillScroll(
      { scrollTop: 4195, scrollHeight: 5000, clientHeight: 800 },
      6000,
    );
    assert.equal(result.pin, true);
    assert.equal(result.scrollTop, 6000);
  });
});
