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
import { MakaTranscriptComponent } from '../pi-tui-layout.js';
import { createMakaPiTranscriptState } from '../pi-transcript.js';
import { markdownTheme } from '../pi-transcript-format.js';
import { stripAnsi } from '../tui-ansi.js';
import { highlightMarkdownCode } from '../tui-syntax-highlight.js';

test('highlights tagged TypeScript code without changing its text', () => {
  const highlightCode = markdownTheme.highlightCode;
  assert.ok(highlightCode, 'the shared Markdown theme must provide the highlighting hook');
  const code = ['const greeting: string = "你好";', 'console.log(greeting);'].join('\n');

  const highlighted = highlightCode(code, 'typescript');

  assert.equal(stripAnsi(highlighted.join('\n')), code);
});

test('classifies aliased language tokens without changing escaped source text', () => {
  const code = 'const label = "你好<&>";';
  const highlighted = highlightMarkdownCode(code, ' TS ', {
    keyword: (text) => `<keyword>${text}</keyword>`,
    string: (text) => `<string>${text}</string>`,
  }).join('\n');

  assert.match(highlighted, /<keyword>const<\/keyword>/u);
  assert.match(highlighted, /<string>你好<\/string>/u);
  assert.equal(highlighted.replace(/<\/?(?:keyword|string)>/gu, ''), code);
});

test('falls back to plain code for absent, unknown, or failed highlighting', () => {
  const code = ['  first line', '', '最后一行  '].join('\n');

  assert.deepEqual(highlightMarkdownCode(code), code.split('\n'));
  assert.deepEqual(highlightMarkdownCode(code, 'made-up-language'), code.split('\n'));
  assert.deepEqual(
    highlightMarkdownCode('const value = 1;', 'typescript', {
      keyword: () => {
        throw new Error('theme failed');
      },
    }),
    ['const value = 1;'],
  );
});

test('renders the same streaming code through live and detailed transcript surfaces', () => {
  const state = createMakaPiTranscriptState();
  const source = 'const greeting = "你好"; // ' + 'long-code-'.repeat(8);
  const entry = {
    kind: 'assistant' as const,
    messageId: 'assistant-code',
    text: `\`\`\`ts\n${source}`,
  };
  state.entries.push(entry);
  const transcript = new MakaTranscriptComponent(state, () => ({
    title: 'Maka',
    cwd: '/repo',
    model: 'model',
    connectionSlug: 'connection',
    permissionMode: 'ask',
  }));

  const narrowLive = transcript.render(32).map(stripAnsi).join('\n');
  const detailed = transcript.createDocumentRenderer()(80).lines.map(stripAnsi).join('\n');
  assert.match(narrowLive, /const greeting = "你好";/u);
  assert.match(detailed, /const greeting = "你好";/u);
  assert.equal(entry.text, `\`\`\`ts\n${source}`);

  // Closing the streamed fence and resizing must not change the source text.
  entry.text += '\n```';
  const wideLive = transcript.render(80).map(stripAnsi).join('\n');
  assert.match(wideLive, /const greeting = "你好";/u);
  assert.equal(entry.text, `\`\`\`ts\n${source}\n\`\`\``);
});
