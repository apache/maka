/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveDockPresentation } from '../dock-presentation.js';
import {
  createWindowRevealGate,
  resolveWindowRevealMode,
  showWindowOnceReady,
  type FocusableRevealableWindow,
} from '../window-reveal.js';

/**
 * Fake BrowserWindow that records every call the reveal gate makes, so
 * "revealed but never activated" can be asserted without an Electron runtime.
 */
function fakeWindow(): FocusableRevealableWindow & {
  calls: string[];
  visible: boolean;
  destroyed: boolean;
  minimized: boolean;
} {
  const win = {
    calls: [] as string[],
    visible: false,
    destroyed: false,
    minimized: false,
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    show() {
      win.calls.push('show');
      win.visible = true;
    },
    showInactive() {
      win.calls.push('showInactive');
      win.visible = true;
    },
    restore() {
      win.calls.push('restore');
      win.minimized = false;
    },
    focus() {
      win.calls.push('focus');
    },
    maximize() {
      win.calls.push('maximize');
      win.visible = true;
    },
  };
  return win;
}

describe('resolveWindowRevealMode', () => {
  it('leaves a product run active', () => {
    assert.equal(resolveWindowRevealMode(false, false, false), 'active');
    // A stray MAKA_E2E_SHOW_WINDOW outside an E2E run changes nothing.
    assert.equal(resolveWindowRevealMode(false, true, false), 'active');
  });

  it('hides an E2E run that did not ask for a window', () => {
    assert.equal(resolveWindowRevealMode(true, false, false), 'hidden');
  });

  it('gives an E2E run that asked for a window pixels, not focus', () => {
    assert.equal(resolveWindowRevealMode(true, true, false), 'inactive');
  });

  it('ignores a stray E2E flag in a packaged build', () => {
    // Both consumers read this one answer, so a packaged build cannot end up
    // with a window that takes focus and a dock that hides its tile.
    assert.equal(resolveWindowRevealMode(true, false, true), 'active');
    assert.equal(resolveWindowRevealMode(true, true, true), 'active');
    assert.equal(
      resolveDockPresentation('darwin', resolveWindowRevealMode(true, true, true)),
      'icon',
    );
  });
});

describe('resolveDockPresentation', () => {
  it('has no dock off macOS', () => {
    for (const mode of ['hidden', 'inactive', 'active'] as const) {
      assert.equal(resolveDockPresentation('win32', mode), 'none');
      assert.equal(resolveDockPresentation('linux', mode), 'none');
    }
  });

  it('shows the brand mark only for a product run', () => {
    assert.equal(resolveDockPresentation('darwin', 'active'), 'icon');
  });

  it('stays an accessory app for every E2E run, visible window included', () => {
    assert.equal(resolveDockPresentation('darwin', 'hidden'), 'hide');
    assert.equal(resolveDockPresentation('darwin', 'inactive'), 'hide');
  });
});

describe('showWindowOnceReady', () => {
  it('reveals an active run with show()', () => {
    const win = fakeWindow();
    showWindowOnceReady(win, 'active');
    assert.deepEqual(win.calls, ['show']);
  });

  it('reveals an inactive run without activating the app', () => {
    const win = fakeWindow();
    showWindowOnceReady(win, 'inactive');
    assert.deepEqual(win.calls, ['showInactive']);
  });

  it('never reveals a hidden run', () => {
    const win = fakeWindow();
    showWindowOnceReady(win, 'hidden');
    assert.deepEqual(win.calls, []);
  });

  it('ignores a destroyed or already visible window', () => {
    const destroyed = fakeWindow();
    destroyed.destroyed = true;
    showWindowOnceReady(destroyed, 'inactive');
    assert.deepEqual(destroyed.calls, []);

    const shown = fakeWindow();
    shown.visible = true;
    showWindowOnceReady(shown, 'inactive');
    assert.deepEqual(shown.calls, []);
  });
});

describe('createWindowRevealGate', () => {
  it('flushes a deferred focus request as a real activation for a product run', () => {
    const gate = createWindowRevealGate('active');
    const win = fakeWindow();
    gate.requestFocus(win);
    assert.deepEqual(win.calls, []);
    gate.markReady(win);
    assert.deepEqual(win.calls, ['show', 'show', 'focus']);
  });

  it('answers a focus request on an inactive run with a reveal and nothing more', () => {
    const gate = createWindowRevealGate('inactive');
    const win = fakeWindow();
    gate.requestFocus(win);
    gate.markReady(win);
    assert.deepEqual(win.calls, ['showInactive']);
    // A focus request after readiness must not raise the app either.
    gate.requestFocus(win);
    assert.deepEqual(win.calls, ['showInactive']);
  });

  it('reveals inactively before maximizing, so the maximize cannot raise the app', () => {
    const gate = createWindowRevealGate('inactive');
    const win = fakeWindow();
    gate.requestMaximize(win);
    gate.markReady(win);
    assert.deepEqual(win.calls, ['showInactive', 'maximize']);
  });

  it('keeps a hidden run hidden on every path', () => {
    const gate = createWindowRevealGate('hidden');
    const win = fakeWindow();
    gate.requestFocus(win);
    gate.requestMaximize(win);
    gate.markReady(win);
    assert.deepEqual(win.calls, []);
  });
});
