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

/** Pure embedded-browser logic (controller.ts's testable core). */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  browserActionAllowed,
  deriveBrowserState,
  parseNavigable,
  safeExternalUrl,
  viewportBounds,
} from '../browser/logic.js';

describe('browser logic', () => {
  it('parseNavigable accepts only http(s) and normalizes', () => {
    assert.equal(parseNavigable('https://example.com'), 'https://example.com/');
    assert.equal(parseNavigable('http://a.test/x?y=1'), 'http://a.test/x?y=1');
    assert.equal(parseNavigable('example.com'), 'https://example.com/');
    assert.equal(parseNavigable('file:///etc/passwd'), null);
    assert.equal(parseNavigable('javascript:alert(1)'), null);
    assert.equal(parseNavigable('about:blank'), null);
    assert.equal(parseNavigable('not a url'), null);
    assert.equal(parseNavigable('http://'), null);
  });

  it('safeExternalUrl passes only mailto/tel', () => {
    assert.equal(safeExternalUrl('mailto:a@b.com'), 'mailto:a@b.com');
    assert.equal(safeExternalUrl('tel:+123'), 'tel:+123');
    assert.equal(safeExternalUrl('file:///x'), null);
    assert.equal(safeExternalUrl('https://x.com'), null);
  });

  it('viewportBounds rounds, clamps, and hides on empty', () => {
    assert.deepEqual(viewportBounds({ x: 1.4, y: 2.6, width: 100.5, height: 50.4 }), {
      x: 1,
      y: 3,
      width: 101,
      height: 50,
    });
    assert.equal(viewportBounds(null), null);
    assert.equal(viewportBounds({ x: 0, y: 0, width: 0, height: 100 }), null);
    assert.equal(viewportBounds({ x: 0, y: 0, width: 100, height: -5 }), null);
    // Negative origin clamps to 0 (matches the non-negative-rect contract).
    assert.deepEqual(viewportBounds({ x: -3, y: -10.6, width: 80, height: 40 }), { x: 0, y: 0, width: 80, height: 40 });
    // Non-finite / non-number fields (untyped IPC) hide rather than reach setBounds.
    assert.equal(viewportBounds({ x: 0, y: 0, width: NaN, height: 100 }), null);
    assert.equal(viewportBounds({ x: 0, y: 0, width: Infinity, height: 100 }), null);
    assert.equal(viewportBounds({ x: NaN, y: 0, width: 100, height: 100 }), null);
    assert.equal(viewportBounds({ x: 0, y: 0, width: '100' as unknown as number, height: 100 }), null);
  });

  it('browserActionAllowed enforces the visible lease', () => {
    // observe reads the page — now gated like the rest: only the conversation on
    // screen (reading a logged-in page off screen would leak its content). No
    // viewport needed — reading doesn't require a composited frame.
    assert.equal(browserActionAllowed('observe', { shown: true, hasViewport: false }), true);
    assert.equal(browserActionAllowed('observe', { shown: false, hasViewport: false }), false);
    assert.equal(browserActionAllowed('observe', { shown: false, hasViewport: true }), false);
    // navigate creates/loads the panel — only the conversation on screen, no viewport needed yet.
    assert.equal(browserActionAllowed('navigate', { shown: true, hasViewport: false }), true);
    assert.equal(browserActionAllowed('navigate', { shown: false, hasViewport: true }), false);
    // mutate acts on the page — on screen AND with real on-screen bounds (composited frame).
    assert.equal(browserActionAllowed('mutate', { shown: true, hasViewport: true }), true);
    assert.equal(browserActionAllowed('mutate', { shown: true, hasViewport: false }), false);
    assert.equal(browserActionAllowed('mutate', { shown: false, hasViewport: true }), false);
  });

  it('deriveBrowserState computes hasPage and secure', () => {
    const base = { title: '', canGoBack: false, canGoForward: false, loading: false };
    assert.equal(deriveBrowserState({ ...base, url: '' }).hasPage, false);
    assert.equal(deriveBrowserState({ ...base, url: 'about:blank' }).hasPage, false);
    const loaded = deriveBrowserState({ ...base, url: 'https://x.com/' });
    assert.equal(loaded.hasPage, true);
    assert.equal(loaded.secure, true);
    assert.equal(deriveBrowserState({ ...base, url: 'http://x.com/' }).secure, false);
  });
});
