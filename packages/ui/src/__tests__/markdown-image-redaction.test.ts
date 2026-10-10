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
import { markdownImageSources } from '@maka/core/image-markdown';
import { IMAGE_MARKDOWN_MAX_LENGTH } from '@maka/core/image-delivery';
import { redactMarkdownImages } from '../markdown-image-redaction.js';
import { redactSecrets } from '../redact.js';

const signed = 'https://example.com/image.png?token=private-value';
function resolved(text: string) {
  const result = redactMarkdownImages(text);
  return { ...result, destinations: markdownImageSources(result.text).map(source => result.sources.get(source) ?? source) };
}

test('signed URLs and hashed paths retain their exact Host identities without exposing them as text', () => {
  for (const source of [signed, signed + '&expires=123', signed.replace('token=', 'signature='), `/tmp/${'a'.repeat(48)}.png`]) {
    const result = resolved(`![Screenshot](${source})`);
    assert.deepEqual(result.destinations, [source]);
    assert.ok(!result.text.includes(source));
  }
});

test('destinations which redact to the same text retain separate identities', () => {
  const other = signed.replace('private-value', 'another-value');
  const result = resolved(`![one](${signed}) ![two](${other}) ![one again](${signed})`);
  assert.deepEqual(result.destinations, [signed, other]);
  assert.equal(result.sources.size, 2);
});

test('reference images retain original identity while shared ordinary links stay redacted', () => {
  const result = resolved(`![Screenshot][pic]\n\n[ordinary link][pic]\n\n[pic]: ${signed}`);
  assert.deepEqual(result.destinations, [signed]);
  assert.ok(!result.text.includes('private-value'));
  assert.ok(result.text.includes('[ordinary link][pic]'));
  assert.ok(result.text.includes(redactSecrets(`[pic]: ${signed}`)));
});

test('code, HTML, prose and ordinary links remain identical to normal display redaction', () => {
  const example = `![Screenshot](${signed})`;
  const nonImages = [
    '`' + example + '`',
    '```md\n' + example + '\n```',
    '<pre>\n' + example + '\n</pre>',
    `<img src="${signed}">`,
    `[ordinary](${signed})`,
    `Prose ${signed}`,
  ];
  for (const text of nonImages) {
    const result = redactMarkdownImages(text);
    assert.equal(result.text, redactSecrets(text));
    assert.equal(result.sources.size, 0);
    const together = redactMarkdownImages(text + '\n\n' + example);
    assert.ok(together.text.startsWith(redactSecrets(text) + '\n\n'));
    assert.equal(together.sources.size, 1);
  }
});

test('nested Markdown, escaped paths, entities, angle destinations and CRLF keep canonical identities', () => {
  for (const text of [
    `> ![Screenshot](${signed})`,
    `- **![Screenshot](${signed})**`,
    `| Image |\n| --- |\n| ![Screenshot](${signed}) |`,
    `[![Screenshot](${signed})](https://example.com)`,
    `![Screenshot](<${signed}> "title")`,
    `![Screenshot](https://example.com/i?token=a&amp;expires=123)`,
    String.raw`![Screenshot](/tmp/a\(1\)-${'a'.repeat(48)}.png)`,
    `Before\r\n\r\n![Screenshot](${signed})\r\n`,
  ]) {
    assert.deepEqual(resolved(text).destinations, markdownImageSources(text), text);
  }
});

test('image labels, titles and surrounding secrets are still redacted', () => {
  const result = resolved(`Authorization: Bearer prose-secret\n\n![sk-1234567890abcdef](${signed} "token=title")`);
  assert.deepEqual(result.destinations, [signed]);
  assert.ok(!result.text.includes('prose-secret'));
  assert.ok(!result.text.includes('sk-1234567890abcdef'));
  assert.ok(!result.text.includes('private-value'));
});

test('settled and live sources share aliases without accepting source-authored aliases', () => {
  const settled = `![Screenshot](${signed})`;
  const authored = '![fake](maka-image-display:0)';
  const result = redactMarkdownImages(`${settled}\n\n${authored}`, settled);
  assert.equal(result.sources.has('maka-image-display:0'), false);
  assert.equal(markdownImageSources(result.text)[0], markdownImageSources(result.settledText!)[0]);
  assert.ok(!result.text.includes('private-value'));
});

test('plain messages and oversized or incomplete images retain existing redaction', () => {
  for (const text of ['Plain **text**', `![x](${signed}`, 'x'.repeat(IMAGE_MARKDOWN_MAX_LENGTH) + `![x](${signed})`]) {
    const result = redactMarkdownImages(text);
    assert.equal(result.text, redactSecrets(text));
    assert.equal(result.sources.size, 0);
  }
});
