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
  positionedMarkdownImages,
  markdownImageSources,
  parseMarkdownImageDestination,
} from '../image-markdown.js';
import { IMAGE_MARKDOWN_MAX_LENGTH } from '../image-delivery.js';

test('canonical destinations retain document order, references and explicit attachments', () => {
  assert.deepEqual(
    markdownImageSources(
      [
        '![space](</tmp/a (1).png> "Title")',
        '![reference][pic]',
        '![duplicate](</tmp/a (1).png>)',
        '![attachment](maka://runtime/attachments/image-1 "Preview")',
        String.raw`![escaped](/tmp/a\(1\).png)`,
        '',
        '[pic]: </tmp/my "image".png>',
        '`![code](/tmp/secret.png)`',
        '```md',
        '![fenced](/tmp/secret2.png)',
        '```',
        '<img src="/tmp/html.png">',
        '![incomplete](</tmp/partial.png>',
      ].join('\n'),
    ),
    [
      '/tmp/a (1).png',
      '/tmp/my "image".png',
      'maka://runtime/attachments/image-1',
      '/tmp/a(1).png',
    ],
  );
});

test('document budget is measured in UTF-16 code units and accepts the boundary', () => {
  const image = '![x](/tmp/a.png)';
  const text = image + '\n\n' + '中'.repeat(IMAGE_MARKDOWN_MAX_LENGTH - image.length - 2);
  assert.equal(text.length, IMAGE_MARKDOWN_MAX_LENGTH);
  assert.deepEqual(markdownImageSources(text), ['/tmp/a.png']);
  assert.deepEqual(markdownImageSources(text + '中'), []);
});

test('inline destinations require one complete image token with no trailing syntax', () => {
  assert.equal(parseMarkdownImageDestination('</tmp/my image.png> "Title"'), '/tmp/my image.png');
  assert.equal(parseMarkdownImageDestination(String.raw`/tmp/a\(1\).png`), '/tmp/a(1).png');
  for (const source of [
    '</tmp/incomplete.png',
    '/tmp/a.png) trailing',
    '/tmp/a.png) ![b](/tmp/b.png',
  ])
    assert.equal(parseMarkdownImageDestination(source), undefined);
});

test('canonical image ranges address exact occurrences without touching shared definitions or examples', () => {
  const text =
    '`![code][p]`\n\n> ![one][p]\n\n![two][p]\n\n[p]: <https://example.com/a.png?token=secret>\n';
  const refs = positionedMarkdownImages(text);
  assert.deepEqual(
    refs.map((ref) => ref.raw),
    ['![one][p]', '![two][p]'],
  );
  assert.deepEqual(
    refs.map((ref) => text.slice(ref.start, ref.end)),
    refs.map((ref) => ref.raw),
  );
  assert.deepEqual(
    refs.map((ref) => ref.alt),
    ['one', 'two'],
  );
  assert.ok(refs.every((ref) => ref.source === 'https://example.com/a.png?token=secret'));
});

test('position adapters preserve existing GFM exclusions and archived entity identities', () => {
  for (const text of ['https://example.com/![x](/tmp/a.png)', 'www.example.com/![x](/tmp/a.png)']) {
    assert.deepEqual(markdownImageSources(text), []);
    assert.deepEqual(positionedMarkdownImages(text), []);
  }
  const text = '![x](https://example.com/a?token=secret&amp;v=1)';
  assert.deepEqual(markdownImageSources(text), ['https://example.com/a?token=secret&amp;v=1']);
  assert.equal(positionedMarkdownImages(text)[0]?.source, markdownImageSources(text)[0]);
});
