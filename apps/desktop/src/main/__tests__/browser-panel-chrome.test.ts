/**
 * Source contract for BrowserPanel renderer chrome invariants (#819).
 *
 * Symmetric to `artifact-pane-layout.test.ts` (regex over the component's
 * source). The e2e-fixture `browser-empty` fixture renders the chrome
 * layout; this test locks the declarative wirings that produce the
 * chrome's state-dependent DOM — the invariants the issue lists as not
 * needing a dedicated fixture render:
 *
 *  - back / forward buttons `:disabled` track `canGoBack` / `canGoForward`;
 *  - reload / stop icon swaps with `loading` (+ accessible label + onClick branch);
 *  - address bar snaps to the live URL on blur when not editing;
 *  - empty state present when `!hasPage`.
 *
 * These are declarative (`disabled={expr}`, `cond ? <X/> : <Y/>`,
 * `onBlur={...}`, `!hasPage && <Empty>`) — the wiring IS the rendered DOM,
 * so a source contract is a reliable proxy without a render harness. The
 * repo has no jsdom/testing-library, and `BrowserPanel` is IPC-driven via
 * `window.maka.browser`, so a render test would need heavy mocking for no
 * extra guarantee over the declarative wiring. Cascade-effective CSS
 * (overlapping rules, `all:initial`) is out of scope here and belongs to
 * the #819 computed-style fixture layer.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { before, describe, it } from 'node:test';
import { CONTRACT_RENDERER_ROOT } from './contract-css-helpers.js';

const BROWSER_PANEL_SOURCE = resolve(CONTRACT_RENDERER_ROOT, 'browser-panel.tsx');

describe('BrowserPanel renderer chrome source contract (#819)', () => {
  let source!: string;

  before(async () => {
    source = await readFile(BROWSER_PANEL_SOURCE, 'utf8');
    assert.ok(source.length > 0, 'browser-panel.tsx source must be non-empty');
  });

  it('back button :disabled tracks canGoBack', () => {
    // The back nav button must bind Astryx's public disabled prop to
    // `!canGoBack` so the DOM disabled attribute reflects browser history.
    // `!state.canGoBack` is unique to the back button, so the expression
    // match locks the binding without depending on attribute order/adjacency
    // (innocent JSX reformatting / attribute insertion must not false-positive).
    assert.match(source, /isDisabled=\{!state\.canGoBack\}/, 'back button disabled must track !state.canGoBack');
  });

  it('forward button :disabled tracks canGoForward', () => {
    // `!state.canGoForward` is unique to the forward button.
    assert.match(source, /isDisabled=\{!state\.canGoForward\}/, 'forward button disabled must track !state.canGoForward');
  });

  it('reload/stop icon swaps with loading (+ accessible label + onClick branch)', () => {
    // The third nav button swaps its icon (X stop vs RotateCw reload), its
    // accessible label, and its onClick target between stop/reload based on
    // state.loading — all three must branch on the same flag.
    assert.match(
      source,
      /label=\{state\.loading\s*\?\s*copy\.stopAria\s*:\s*copy\.refreshAria\}/,
      'reload/stop accessible label must swap with state.loading',
    );
    assert.match(
      source,
      /\{state\.loading\s*\?\s*<X[^>]*\/>\s*:\s*<RotateCw[^>]*\/>\}/,
      'reload/stop icon must swap X (stop) / RotateCw (reload) with state.loading',
    );
    assert.match(
      source,
      /state\.loading\s*\?\s*void window\.maka\.browser\.stop\(sessionId\)\s*:\s*void window\.maka\.browser\.reload\(sessionId\)/,
      'reload/stop onClick must branch stop vs reload on state.loading',
    );
  });

  it('address bar snaps to the live URL on blur when not editing', () => {
    // The address input is editable (onChange updates local `address`);
    // onFocus marks editing so a mid-edit state push doesn't clobber typing;
    // onBlur clears editing + snaps back to the live URL.
    assert.match(
      source,
      /value=\{address\}/,
      'address input value must bind to the editable local `address`',
    );
    assert.match(
      source,
      /onFocus=\{\(\)\s*=>\s*\{\s*editingRef\.current\s*=\s*true;\s*\}\}/,
      'onFocus must mark editingRef true so state pushes do not clobber typing',
    );
    assert.match(
      source,
      /onBlur=\{\(\)\s*=>\s*\{\s*editingRef\.current\s*=\s*false;\s*setAddress\(state\.url\);\s*\}\}/,
      'onBlur must clear editingRef + snap address back to the live state.url',
    );
  });

  it('empty state present when !hasPage', () => {
    // The strip renders the Empty chrome only when no page is loaded.
    assert.match(
      source,
      /\{!state\.hasPage\s*&&\s*\(\s*<Empty className="maka-browser-empty/,
      'empty state must render when !state.hasPage',
    );
  });
});
