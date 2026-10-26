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
import { normalizeArtifactImagePreviewMime, normalizeMediaPreviewMime } from '../artifacts.js';
import { prepareSvgPreview, SVG_PREVIEW_MAX_CHARS, SVG_PREVIEW_MAX_NODES } from '../svg-preview.js';

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

test('static SVG class styles preserve generated diagram colors without external CSS', () => {
  const result = prepareSvgPreview(
    '<svg><style>.box { fill: #4355d9; stroke: white; } .label {font-size:20px;fill:white;background:url(https://evil.test);} @import "https://evil.test";</style><rect class="box" width="20" height="10"/></svg>',
  );
  assert.match(result, /class="box"/);
  assert.match(result, /\.box\{fill:#4355d9;stroke:white\}/);
  assert.doesNotMatch(result, /https:|@import|background/);
});

test('static SVG styles preserve safe rules around comments and malformed rules', () => {
  const result = prepareSvgPreview(
    '<svg><style>/* leading */ .a{fill:/* paint */red} stray } .outer{.b{stroke:blue}} .c{fill:green} /* unterminated .hidden{fill:red}</style><rect class="a"/></svg>',
  );
  assert.match(result, /\.a\{fill:red\}/);
  assert.match(result, /\.b\{stroke:blue\}/);
  assert.match(result, /\.c\{fill:green\}/);
  assert.doesNotMatch(result, /stray|outer|hidden|unterminated|leading/);
});

test('static SVG style parsing stays bounded for long malformed CSS', () => {
  for (const css of ['x'.repeat(32000), '/*'.repeat(16000)]) {
    const source =
      '<svg width="40" height="20">' +
      `<style>${css}</style>`.repeat(8) +
      '<rect width="40" height="20" fill="blue"/></svg>';
    assert.ok(source.length < SVG_PREVIEW_MAX_CHARS);
    const started = process.cpuUsage();
    const result = prepareSvgPreview(source);
    const elapsed = process.cpuUsage(started);
    // CPU time avoids wall-clock failures under load; the old scanner took seconds.
    assert.ok(
      elapsed.user + elapsed.system < 500_000,
      'Malformed CSS must not consume 500 ms of CPU',
    );
    assert.doesNotMatch(result, /<style/);
    assert.match(result, /fill="blue"/);
  }
});

test('SVG bounds discarded elements and non-element nodes before sanitizing', () => {
  for (const child of ['<a/>', '<!-- -->', '<?discard?>', '<style/>']) {
    const source = '<svg>' + child.repeat(16000) + '</svg>';
    assert.ok(source.length < SVG_PREVIEW_MAX_CHARS);
    const started = process.cpuUsage();
    assert.throws(() => prepareSvgPreview(source), /SVG complexity exceeds preview limits/);
    const elapsed = process.cpuUsage(started);
    assert.ok(
      elapsed.user + elapsed.system < 500_000,
      'Discarded nodes must not consume 500 ms of CPU',
    );
  }
});

test('SVG bounds discarded subtrees before reading their descendants', () => {
  for (const parent of ['a', 'style']) {
    assert.throws(
      () => prepareSvgPreview(`<svg><${parent}>${'<g/>'.repeat(4000)}</${parent}></svg>`),
      /SVG complexity exceeds preview limits/,
    );
    assert.throws(
      () =>
        prepareSvgPreview(
          `<svg><${parent}>${'<g>'.repeat(65)}${'</g>'.repeat(65)}</${parent}></svg>`,
        ),
      /SVG complexity exceeds preview limits/,
    );
  }
});

test('SVG input budgets preserve the element boundary with indentation', () => {
  const source = '<svg>\n' + '  <g/>\n'.repeat(SVG_PREVIEW_MAX_NODES - 1) + '</svg>';
  assert.equal((prepareSvgPreview(source).match(/<g\/>/g) ?? []).length, SVG_PREVIEW_MAX_NODES - 1);
});
