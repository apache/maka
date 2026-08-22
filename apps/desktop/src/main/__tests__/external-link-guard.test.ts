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

/**
 * Tests for the URL-scheme whitelist used by main's external-link guard.
 *
 * `mainWindow.webContents.setWindowOpenHandler` + `will-navigate` ask this
 * helper which URLs should be handed off to the OS via `shell.openExternal`
 * vs which should be ignored. Until this guard landed, clicking an assistant
 * markdown link could either replace the renderer view (breaking the app) or
 * open a new BrowserWindow with full Node integration — both bad.
 *
 * These tests pin the whitelist boundary so future relaxations (e.g. allowing
 * file:// for local docs) are an explicit, reviewed decision.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isExternalUrl } from '../external-link-guard.js';

describe('isExternalUrl', () => {
  it('allows http and https', () => {
    assert.equal(isExternalUrl('https://github.com/anthropics'), true);
    assert.equal(isExternalUrl('http://example.com/path'), true);
    assert.equal(isExternalUrl('https://api.z.ai/api/coding/paas/v4'), true);
  });

  it('allows mailto', () => {
    assert.equal(isExternalUrl('mailto:hello@example.com'), true);
    assert.equal(isExternalUrl('mailto:hello@example.com?subject=hi'), true);
  });

  it('rejects file:// — would let untrusted markdown reach local FS', () => {
    assert.equal(isExternalUrl('file:///etc/passwd'), false);
    assert.equal(isExternalUrl('file://localhost/Users/foo'), false);
  });

  it('rejects javascript: — XSS vector', () => {
    assert.equal(isExternalUrl('javascript:alert(1)'), false);
    assert.equal(isExternalUrl('JaVaScRiPt:alert(1)'), false);
  });

  it('rejects internal schemes', () => {
    assert.equal(isExternalUrl('electron://app'), false);
    assert.equal(isExternalUrl('chrome-extension://abc/popup.html'), false);
    assert.equal(isExternalUrl('about:blank'), false);
    assert.equal(isExternalUrl('data:text/html,<h1>x</h1>'), false);
  });

  it('rejects non-URL input safely', () => {
    assert.equal(isExternalUrl('not a url'), false);
    assert.equal(isExternalUrl(''), false);
    assert.equal(isExternalUrl('/local/path'), false);
  });
});
