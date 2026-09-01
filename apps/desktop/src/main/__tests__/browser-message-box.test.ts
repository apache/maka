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
import { test } from 'node:test';
import {
  buildBrowserMessageBoxHtml,
  centeredBounds,
  normalizeBrowserMessageBoxPresentation,
  parseBrowserMessageBoxResponse,
} from '../browser-message-box.js';

test('accepts only an in-range response URL produced by the dialog', () => {
  assert.equal(parseBrowserMessageBoxResponse('maka-dialog://response/1', 3), 1);
  for (const value of [
    'https://response/1',
    'maka-dialog://other/1',
    'maka-dialog://user@response/1',
    'maka-dialog://response:123/1',
    'maka-dialog://response/01',
    'maka-dialog://response/1?',
    'maka-dialog://response/1#',
    'maka-dialog://response/1?again=true',
    'maka-dialog://response/3',
    'not a url',
  ]) {
    assert.equal(parseBrowserMessageBoxResponse(value, 3), undefined, value);
  }
});

test('centers against the parent while keeping the whole dialog on-screen', () => {
  assert.deepEqual(
    centeredBounds(
      { x: 900, y: 700, width: 200, height: 100 },
      { x: 0, y: 0, width: 1_000, height: 800 },
      520,
      300,
    ),
    { x: 480, y: 500, width: 520, height: 300 },
  );
  assert.deepEqual(
    centeredBounds(undefined, { x: -1_000, y: 40, width: 800, height: 600 }, 400, 280),
    { x: -800, y: 200, width: 400, height: 280 },
  );
});

test('renders escaped content with Maka dialog tokens and safe action ordering', () => {
  const html = buildBrowserMessageBoxHtml(
    normalizeBrowserMessageBoxPresentation(
      {
        type: 'warning',
        title: '<img src=x onerror=alert(1)>',
        message: 'Maka & Runtime Host',
        detail: '</div><script>globalThis.pwned = true</script>',
        buttons: ['Replace <Host>', 'Cancel', 'Copy & Diagnostics'],
        defaultId: 0,
        cancelId: 1,
      },
      true,
    ),
  );

  assert.match(html, /data-theme="dark"/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(html, /Maka &amp; Runtime Host/u);
  assert.match(html, /&lt;\/div&gt;&lt;script&gt;globalThis\.pwned = true&lt;\/script&gt;/u);
  assert.match(html, /Replace &lt;Host&gt;/u);
  assert.doesNotMatch(html, /<img src=x/u);
  assert.doesNotMatch(html, /<script>globalThis\.pwned/u);

  const cancelPosition = html.indexOf('>Cancel</button>');
  const copyPosition = html.indexOf('>Copy &amp; Diagnostics</button>');
  const actionPosition = html.indexOf('>Replace &lt;Host&gt;</button>');
  assert.ok(cancelPosition >= 0 && cancelPosition < copyPosition);
  assert.ok(copyPosition < actionPosition);
  assert.match(html, /data-response="0" autofocus/u);
  assert.match(html, /default-src 'none'/u);
});

test('normalizes fallback buttons and out-of-range action indexes once', () => {
  const presentation = normalizeBrowserMessageBoxPresentation(
    {
      type: 'none',
      title: '',
      message: '',
      buttons: [],
      defaultId: 4,
      cancelId: -1,
    },
    false,
  );

  assert.deepEqual(presentation, {
    type: 'none',
    title: 'Maka',
    message: 'Maka',
    detail: '',
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
    dark: false,
    isChinese: false,
  });
  const html = buildBrowserMessageBoxHtml(presentation);
  assert.match(html, /data-response="0" autofocus/u);
  assert.match(html, /data-theme="light"/u);
});
