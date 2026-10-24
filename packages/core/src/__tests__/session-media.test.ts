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
  isSessionMediaInput,
  isSessionContentPart,
  sessionContentMarkdown,
  SESSION_MEDIA_MAX_BASE64,
} from '../session-media.js';
import { normalizeArtifactImagePreviewMime, normalizeMediaPreviewMime } from '../artifacts.js';
import { prepareSvgPreview, SVG_PREVIEW_MAX_CHARS } from '../svg-preview.js';

test('media transport bounds binary input and only publishes durable image references', () => {
  assert.ok(isSessionMediaInput({ kind: 'inline', mimeType: 'image/png', base64: 'AAAA' }));
  for (const base64 of ['not base64', 'AA', 'AAAA=', 'A'.repeat(SESSION_MEDIA_MAX_BASE64 + 4)])
    assert.equal(isSessionMediaInput({ kind: 'inline', mimeType: 'image/png', base64 }), false);
  assert.equal(
    isSessionMediaInput({ kind: 'source', source: '/tmp/image.svg', extra: true }),
    false,
  );
  assert.equal(isSessionMediaInput({ kind: 'source', source: '/tmp/\0image.svg' }), false);
  const part = {
    kind: 'image' as const,
    mimeType: 'image/svg+xml',
    ref: { kind: 'session_file' as const, sessionId: 'session', relativePath: 'image-1' },
  };
  assert.ok(isSessionContentPart(part));
  assert.equal(sessionContentMarkdown(part), '\n\n![](maka://runtime/attachments/image-1)\n\n');
  assert.equal(
    isSessionContentPart({ ...part, ref: { ...part.ref, relativePath: '../other' } }),
    false,
  );
});

test('SVG display support does not expand model image admission', () => {
  assert.equal(normalizeMediaPreviewMime('image/svg+xml'), 'image/svg+xml');
  assert.equal(normalizeMediaPreviewMime(undefined, 'drawing.svg'), 'image/svg+xml');
  assert.equal(normalizeArtifactImagePreviewMime('image/svg+xml'), null);
});

test('static SVG preserves geometry, text, gradients and safe inline styles', () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><defs><linearGradient id="paint"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="240" height="120" fill="url(#paint)"/><text x="10" y="40" style="font-size:20px;fill:white">你好 &amp; Maka</text></svg>';
  const result = prepareSvgPreview(source);
  assert.match(result, /linearGradient/);
  assert.match(result, /url\(#paint\)/);
  assert.match(result, /你好 &amp; Maka/);
  assert.match(result, /font-size:20px;fill:white/);
  assert.match(prepareSvgPreview('<svg width="100" height="50"><circle r="20"/></svg>'), /circle/);
});

test('SVG strips executable content, external dependencies and CSS escapes', () => {
  const result = prepareSvgPreview(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" xml:base="https://evil.test"><script>alert(1)</script><foreignObject><div>html</div></foreignObject><image href="https://evil.test/a"/><use href="#recursive"/><style>@import "https://evil.test";</style><rect width="10" fill="url(https://evil.test/a)" style="stroke:url(&quot;https://evil.test&quot;);fill:red"/><animate attributeName="href"/></svg>',
  );
  assert.doesNotMatch(
    result,
    /script|onload|foreignObject|https:|<image|<use|<style|animate|xml:base/,
  );
  assert.match(result, /fill:red/);
});

test('SVG rejects malformed documents, entities and bounded complexity', () => {
  for (const source of [
    '<svg><broken',
    '<html/>',
    '<!DOCTYPE svg [<!ENTITY x "test">]><svg>&x;</svg>',
    '<svg xmlns="urn:evil"/>',
    '<svg viewBox="0 0 -1 1"/>',
    '<svg>' + '<g>'.repeat(66) + '</g>'.repeat(66) + '</svg>',
    '<svg>' + '<path/>'.repeat(4001) + '</svg>',
    '<svg>' + ' '.repeat(SVG_PREVIEW_MAX_CHARS) + '</svg>',
  ])
    assert.throws(() => prepareSvgPreview(source));
});

test('ordered media survives canonical tool-result validation without allowing nested payloads', async () => {
  const { decodeCanonicalToolResultContent } = await import('../tool-result-record-schema.js');
  const content = {
    kind: 'content',
    parts: [
      { kind: 'text', text: 'before' },
      {
        kind: 'image',
        mimeType: 'image/svg+xml',
        ref: { kind: 'session_file', sessionId: 'session', relativePath: 'image-1' },
      },
    ],
  };
  assert.deepEqual(decodeCanonicalToolResultContent(content), content);
  assert.throws(() => decodeCanonicalToolResultContent({ kind: 'content', parts: [content] }));
  assert.throws(() =>
    decodeCanonicalToolResultContent({
      kind: 'content',
      parts: Array.from({ length: 65 }, () => ({ kind: 'text', text: 'a' })),
    }),
  );
});

test('static SVG class styles preserve generated diagram colors without external CSS', () => {
  const result = prepareSvgPreview(
    '<svg><style>.box { fill: #4355d9; stroke: white; } .label {font-size:20px;fill:white;background:url(https://evil.test);} @import "https://evil.test";</style><rect class="box" width="20" height="10"/></svg>',
  );
  assert.match(result, /class="box"/);
  assert.match(result, /\.box\{fill:#4355d9;stroke:white\}/);
  assert.doesNotMatch(result, /https:|@import|background/);
});
