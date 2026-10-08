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
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBody } from '../markdown-body.js';
import { MakaUriContext } from '../markdown.js';
import { LocaleProvider } from '../locale-context.js';

it('emits the scoped link hook for prose, inline code, and internal navigation', () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <MakaUriContext.Provider value={() => {}}>
        <MarkdownBody text={[
          '[Apply patch 工具指南](https://example.com/guide)',
          '[`gpt-6-astra`](https://example.com/model)',
          '[Models](maka://settings/models)',
        ].join('\n\n')} />
      </MakaUriContext.Provider>
    </LocaleProvider>,
  );

  assert.match(markup, /data-maka-contract="markdown"/);
  const links = markup.match(/<(?:a|button)\b[^>]*class="[^"]*\bastryx-link\b[^>]*>/g);
  assert.equal(links?.length, 3);
  assert.match(markup, /<code\b[^>]*>gpt-6-astra<\/code>/);
  assert.match(markup, /data-maka-uri-kind="settings"/);
});

it('keeps Markdown underlines continuous without changing global link styles', async () => {
  const css = (await readFile(resolve(import.meta.dirname, '../../src/styles.css'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\[data-maka-contract="markdown"\]\s+\.astryx-link\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the underline rule must stay scoped to Markdown links');
  assert.match(rule[1], /text-decoration-skip-ink\s*:\s*none\s*;/);
  assert.match(rule[1], /text-underline-offset\s*:\s*0\.2em\s*;/);
});
