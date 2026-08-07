import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  readSessionBottomPanelHeight,
  SESSION_BOTTOM_PANEL_DEFAULT_HEIGHT,
  readSessionWorkbarWidth,
  SESSION_WORKBAR_DEFAULT_WIDTH,
} from '../../renderer/session-workbar-layout.js';
import { readRendererContractCss } from './contract-css-helpers.js';

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

describe('readSessionBottomPanelHeight', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('rounds stored height and falls back for invalid values', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) =>
        key === 'maka-session-bottom-panel-height-v1' ? '344.6' : null,
    };
    assert.equal(readSessionBottomPanelHeight(), 345);

    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => 'invalid',
    };
    assert.equal(
      readSessionBottomPanelHeight(),
      SESSION_BOTTOM_PANEL_DEFAULT_HEIGHT,
    );
  });
});

describe('workbar panel topology CSS contract', () => {
  it('allocates independent right and bottom grid areas', async () => {
    const css = await readRendererContractCss();
    assert.match(
      css,
      /\.maka-detail-with-artifacts\s*\{[^}]*grid-template-areas:\s*"main right-handle right"\s*"bottom-handle right-handle right"\s*"bottom right-handle right"/,
    );
    assert.match(css, /\.maka-session-workbar\[data-placement="right"\]\s*\{[^}]*grid-area:\s*right/);
    assert.match(css, /\.maka-session-workbar\[data-placement="bottom"\]\s*\{[^}]*grid-area:\s*bottom/);
    assert.match(css, /\.maka-workbar-layout-vars,[^{]*\{[^}]*display:\s*contents/);
  });

  it('keeps the frame a frame rather than a scrollport', async () => {
    const css = await readRendererContractCss();
    // The frame is not a scroll container, and nothing inside it reaches
    // outside its own box. Both halves of the same lesson: the column used to
    // hang above the frame's padding box to meet its top edge, and to an
    // `overflow: hidden` frame that overhang was scrollable overflow — the
    // first focus anywhere inside, and the resize handle is one Tab away,
    // scrolled the whole frame up by the clearance and left it there.
    assert.match(css, /\.maka-panel-detail\s*\{[^}]*overflow:\s*clip/);
    assert.doesNotMatch(
      css,
      /margin-top:\s*calc\(\s*-1\s*\*\s*var\(--maka-plate-titlebar-clearance\)/,
      'a plate is hanging above the frame again instead of padding itself',
    );
    // Each plate pays for its own clearance, which is what puts their top
    // edges on one line without anyone overhanging.
    assert.match(
      css,
      /\.maka-session-workbar\s*\{[^}]*padding-top:\s*var\(--maka-plate-titlebar-clearance\)/,
    );
  });

  it('keeps tab surfaces in the same grid topology as their panel chrome', async () => {
    const css = await readRendererContractCss();
    assert.match(
      css,
      /\.maka-session-workbar-panel\[data-overlay\]\[data-placement="right"\]\s*\{[^}]*grid-area:\s*right/,
    );
    assert.match(
      css,
      /\.maka-session-workbar-panel\[data-overlay\]\[data-placement="bottom"\]\s*\{[^}]*grid-area:\s*bottom/,
    );
    assert.match(css, /--maka-session-bottom-panel-height,\s*300px/);
  });
});
