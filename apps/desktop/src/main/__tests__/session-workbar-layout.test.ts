import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  readSessionWorkbarTab,
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

/**
 * The persistence whitelist decides which tab survives a restart. A tab that
 * renders but is not listed here silently reverts to Tasks, which looks like
 * the panel forgetting rather than like a missing case.
 */
function storedTab(value: string | null): void {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => (key === 'maka-session-workbar-tab-v1' ? value : null),
  };
}

describe('readSessionWorkbarTab', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('restores every persistable tab, including the Inspector', () => {
    for (const tab of ['browser', 'files', 'inspector'] as const) {
      storedTab(tab);
      assert.equal(readSessionWorkbarTab(), tab);
    }
  });

  it('falls back to tasks for the transient quote tab and for junk', () => {
    // 'quote' only exists while an excerpt is staged, so it is never restored.
    for (const stored of ['quote', 'nonsense', null]) {
      storedTab(stored);
      assert.equal(readSessionWorkbarTab(), 'tasks');
    }
  });
});
