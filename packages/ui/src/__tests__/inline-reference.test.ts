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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineReferenceText } from '../inline-reference.js';
import { MakaUriContext } from '../markdown.js';

test('makes a sent Markdown workspace-file reference interactive', () => {
  const markup = renderToStaticMarkup(
    createElement(
      MakaUriContext.Provider,
      { value: () => {} },
      createElement(InlineReferenceText, {
        text: 'Read @docs/guide.md next',
        references: [
          {
            kind: 'workspace_file',
            value: '@docs/guide.md',
            label: 'guide.md',
            start: 5,
          },
        ],
      }),
    ),
  );

  assert.match(markup, /role="button"/);
  assert.match(markup, /tabindex="0"/);
  assert.match(markup, /data-maka-uri-kind="workspace_file"/);
  assert.match(markup, /data-workspace-file="docs\/guide.md"/);
});

test('keeps executable workspace-file references inert', () => {
  const markup = renderToStaticMarkup(
    createElement(
      MakaUriContext.Provider,
      { value: () => {} },
      createElement(InlineReferenceText, {
        text: '@tools/setup.command',
        references: [
          {
            kind: 'workspace_file',
            value: '@tools/setup.command',
            label: 'setup.command',
            start: 0,
          },
        ],
      }),
    ),
  );

  assert.doesNotMatch(markup, /role="button"/);
  assert.doesNotMatch(markup, /data-workspace-file=/);
});
