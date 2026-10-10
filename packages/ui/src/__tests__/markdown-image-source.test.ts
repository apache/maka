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
import { createMarkdownImageSourceResolver } from '../markdown-image-source.js';

test('normalizes only complete image destinations present in canonical Markdown', () => {
  const resolve = createMarkdownImageSourceResolver([
    '![space](</tmp/my image.png>)',
    '![title](https://example.com/image.png "Screenshot title")',
    String.raw`![escaped](/tmp/a\(1\).png)`,
    '![attachment](maka://runtime/attachments/image-1 "Preview")',
  ].join('\n\n'));
  assert.equal(resolve('</tmp/my image.png>'), '/tmp/my image.png');
  assert.equal(resolve('https://example.com/image.png "Screenshot title"'), 'https://example.com/image.png');
  assert.equal(resolve(String.raw`/tmp/a\(1\).png`), '/tmp/a(1).png');
  assert.equal(resolve('maka://runtime/attachments/image-1 "Preview"'), 'maka://runtime/attachments/image-1');
  assert.equal(resolve('/tmp/plain.png'), '/tmp/plain.png');
});

test('preserves literal title-like filenames resolved from image references', () => {
  const source = '/tmp/my "image".png';
  const resolve = createMarkdownImageSourceResolver(`![reference][picture]\n\n[picture]: <${source}>`);
  assert.equal(resolve(source), source);
});

test('code, raw HTML, incomplete syntax and unrelated destinations do not become image grants', () => {
  for (const text of [
    '`![code](</tmp/my image.png>)`',
    '```md\n![code](</tmp/my image.png>)\n```',
    '<img src="/tmp/my image.png">',
    '![incomplete](</tmp/my image.png>',
    '![different](</tmp/other image.png>)',
  ]) {
    assert.equal(createMarkdownImageSourceResolver(text)('</tmp/my image.png>'), '</tmp/my image.png>');
  }
});
