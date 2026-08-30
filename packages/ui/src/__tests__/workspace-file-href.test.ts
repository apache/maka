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
  isMarkdownWorkspaceFile,
  linkifyBareWorkspaceMarkdownReferences,
  parseWorkspaceFileHref,
} from '../workspace-file-href.js';

test('accepts workspace-relative file hrefs including encoded spaces', () => {
  assert.deepEqual(parseWorkspaceFileHref('docs/guide.md'), {
    kind: 'workspace_file',
    relativePath: 'docs/guide.md',
  });
  assert.deepEqual(parseWorkspaceFileHref('./notes/hello%20world.md'), {
    kind: 'workspace_file',
    relativePath: 'notes/hello world.md',
  });
  assert.equal(isMarkdownWorkspaceFile('docs/guide.md'), true);
  assert.equal(isMarkdownWorkspaceFile('src/main.ts'), false);
});

test('rejects schemes, traversal, and absolute paths', () => {
  for (const href of [
    'file:///etc/passwd',
    'https://example.test/readme.md',
    '../secret.md',
    'docs/../../secret.md',
    '/etc/passwd.md',
    '~/secret.md',
    'docs/guide.md?raw=1',
    'docs/guide.md#section',
    'src/main.ts',
    'tools/setup.exe',
    'tools/install.command',
    'just-a-word',
    '',
  ]) {
    assert.equal(parseWorkspaceFileHref(href), null, href);
  }
});

test('linkifies bare Markdown paths outside existing Markdown syntax and code', () => {
  const source = [
    'Read README.md, docs/guide.md and 文档/说明.markdown.',
    '[Existing](docs/existing.md) and ![image](docs/image.md)',
    '[docs/shortcut.md] and [docs/collapsed.md][]',
    '`inline/code.md` and <https://example.test/remote.md>',
    '[guide]: docs/reference.md',
    '```text',
    'fenced/code.md',
    '```',
    'Ignore tools/setup.command and docs/note.md#heading.',
  ].join('\n');

  assert.equal(
    linkifyBareWorkspaceMarkdownReferences(source),
    [
      'Read [README.md](README.md), [docs/guide.md](docs/guide.md) and [文档/说明.markdown](文档/说明.markdown).',
      '[Existing](docs/existing.md) and ![image](docs/image.md)',
      '[docs/shortcut.md] and [docs/collapsed.md][]',
      '`inline/code.md` and <https://example.test/remote.md>',
      '[guide]: docs/reference.md',
      '```text',
      'fenced/code.md',
      '```',
      'Ignore tools/setup.command and docs/note.md#heading.',
    ].join('\n'),
  );
});

test('preserves code blocks, external autolinks, and longer non-Markdown suffixes', () => {
  const source = [
    '    indented/code.md',
    '\ttabbed/code.md',
    '> - ```text',
    '>   nested/fenced.md',
    '>   ```',
    'docs/guide.md.txt',
    'www.example.com/docs/guide.md',
    'After docs/after.md.',
  ].join('\r\n');

  assert.equal(
    linkifyBareWorkspaceMarkdownReferences(source),
    [
      '    indented/code.md',
      '\ttabbed/code.md',
      '> - ```text',
      '>   nested/fenced.md',
      '>   ```',
      'docs/guide.md.txt',
      'www.example.com/docs/guide.md',
      'After [docs/after.md](docs/after.md).',
    ].join('\r\n'),
  );
});
