import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  readSessionWorkbarWidth,
  SESSION_WORKBAR_DEFAULT_WIDTH,
} from '../../renderer/session-workbar-layout.js';

// This is the only thing that decides how wide the workbar comes back after a
// restart (#1861), and the only width the app reads without having produced it.
// `useResizable` clamps what it is handed but never rounds, so whatever this
// lets through reaches the panel, storage and `aria-valuenow` unchanged.
function storedWidth(value: string | null): void {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => (key === 'maka-session-workbar-width-v1' ? value : null),
  };
}

describe('readSessionWorkbarWidth', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('rounds a fractional stored width', () => {
    storedWidth('400.5');
    assert.equal(readSessionWorkbarWidth(), 401);
  });

  it('leaves out-of-range widths for useResizable to clamp', () => {
    storedWidth('9999');
    assert.equal(readSessionWorkbarWidth(), 9999);
  });

  it('falls back to the default for missing, unparseable and non-positive widths', () => {
    for (const value of [null, '', 'wide', '0', '-10']) {
      storedWidth(value);
      assert.equal(readSessionWorkbarWidth(), SESSION_WORKBAR_DEFAULT_WIDTH, `stored: ${value}`);
    }
  });
});
