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

import { strict as assert } from 'node:assert';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'node:test';
import { MarkdownBody } from '../markdown-body.js';
import { MakaUriContext } from '../markdown.js';
import { LocaleProvider } from '../locale-context.js';
import { parseFileReference, type MakaUriDest } from '../maka-uri.js';

function renderWithDispatcher(text: string, dispatch?: (dest: MakaUriDest) => void): string {
  return renderToStaticMarkup(
    createElement(
      LocaleProvider,
      {
        locale: 'en',
        children: createElement(
          MakaUriContext.Provider,
          { value: dispatch },
          createElement(MarkdownBody, { text }),
        ),
      },
    ),
  );
}

it('recognizes workspace-relative and absolute .md references raw', () => {
  assert.equal(parseFileReference('docs/notes.md'), 'docs/notes.md');
  assert.equal(parseFileReference('./README.markdown'), './README.markdown');
  assert.equal(parseFileReference('../shared/guide.md'), '../shared/guide.md');
  assert.equal(parseFileReference('/workspace/project/PLAN.md'), '/workspace/project/PLAN.md');
});

it('keeps spaces, CJK, and percent-encoded spellings recognizable', () => {
  // Raw non-ASCII reference.
  assert.equal(parseFileReference('docs/设计 笔记.md'), 'docs/设计 笔记.md');
  // Percent-encoded spelling of the same reference is recognized, but the raw
  // text is carried so the trusted side owns decoding.
  assert.equal(parseFileReference('docs/%E8%AE%BE%E8%AE%A1%20%E7%AC%94%E8%AE%B0.md'), 'docs/%E8%AE%BE%E8%AE%A1%20%E7%AC%94%E8%AE%B0.md');
});

it('rejects schemes, malformed input, and non-Markdown targets', () => {
  assert.equal(parseFileReference('file:///etc/passwd'), null);
  assert.equal(parseFileReference('https://example.com/a.md'), null);
  assert.equal(parseFileReference('javascript:alert(1)'), null);
  assert.equal(parseFileReference('maka://settings/models'), null);
  assert.equal(parseFileReference('docs/notes.txt'), null);
  assert.equal(parseFileReference('docs/no-extension'), null);
  assert.equal(parseFileReference(''), null);
  assert.equal(parseFileReference('a\nb.md'), null);
  assert.equal(parseFileReference(`${'a'.repeat(2049)}.md`), null);
});

it('renders workspace .md references actionable when a dispatcher is installed', () => {
  const markup = renderWithDispatcher('[Guide](docs/user%20guide.md)', () => {});

  assert.match(markup, /data-maka-uri-kind="file-ref"/);
});

it('hands the exact raw reference to the dispatcher on activation', () => {
  // Percent-encoded spelling of `docs/中文 文件.md`; recognition decodes only
  // for the suffix check while the raw reference stays untouched.
  const href = 'docs/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md';
  assert.equal(parseFileReference(href), href);
  const markup = renderWithDispatcher(`[文件](${href})`, () => {});

  assert.match(markup, /data-maka-uri-kind="file-ref"/);
  // Raw unencoded spaces are not valid CommonMark link destinations; Astryx
  // truncates the destination at the space, so the ref stays inert.
  const spacedMarkup = renderWithDispatcher('[文件](docs/中文 文件.md)');
  assert.doesNotMatch(spacedMarkup, /data-maka-uri-kind="file-ref"/);
});

it('keeps file references inert when no dispatcher is installed', () => {
  const markup = renderWithDispatcher('[Guide](docs/notes.md)');

  assert.doesNotMatch(markup, /data-maka-uri-kind="file-ref"/);
  // Same inert affordance as any other unhandled destination.
  assert.match(markup, /data-reason="unsafe-scheme"/);
});

it('never turns file:// links into file references even with a dispatcher', () => {
  const markup = renderWithDispatcher('[secret](file:///Users/example/.ssh/id_rsa)');

  assert.doesNotMatch(markup, /data-maka-uri-kind="file-ref"/);
  assert.match(markup, /data-reason="unsafe-scheme"/);
});
