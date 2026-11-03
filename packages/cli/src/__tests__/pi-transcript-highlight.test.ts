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
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { markdownTheme } from '../pi-transcript-format.js';
import { stripAnsi } from '../tui-ansi.js';
import { highlightMarkdownCode } from '../tui-syntax-highlight.js';

const languageExamples = {
  bash: 'echo "你好<&>" # comment',
  c: 'const char *label = "你好<&>";',
  cpp: 'constexpr auto label = "你好<&>";',
  csharp: 'public string label = "你好<&>";',
  css: '.label { color: red; content: "你好<&>"; }',
  diff: '-old text\n+你好<&> new text',
  go: 'func main() { fmt.Println("你好<&>") }',
  java: 'public class Label { String text = "你好<&>"; }',
  javascript: 'const label = "你好<&>";',
  json: '{"label": "你好<&>", "enabled": true}',
  markdown: '# 你好<&>\n**bold** and `code`',
  powershell: 'Write-Host "你好<&>" # comment',
  python: 'def label():\n    return "你好<&>"',
  rust: 'fn main() { let label = "你好<&>"; }',
  sql: "SELECT '你好<&>' FROM labels WHERE id = 1;",
  typescript: 'const label: string = "你好<&>";',
  xml: '<label title="你好&amp;">&lt;value&gt;</label>',
  yaml: 'label: "你好<&>"\nenabled: true',
} as const;

const aliases = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  'c++': 'cpp',
  cs: 'csharp',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  md: 'markdown',
  ps1: 'powershell',
  py: 'python',
  rs: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
} as const;

// Force visible ANSI in these checks even when the test runner pipes stdout.
// The production theme's environment handling is checked in fresh processes below.
const testTheme = Object.fromEntries(
  [
    'keyword',
    'built_in',
    'literal',
    'number',
    'regexp',
    'string',
    'comment',
    'doctag',
    'meta',
    'function',
    'title',
    'class',
    'type',
    'tag',
    'name',
    'attr',
    'attribute',
    'variable',
    'params',
    'operator',
    'addition',
    'deletion',
    'section',
    'strong',
    'emphasis',
    'code',
  ].map((scope) => [scope, (text: string) => `\x1b[35m${text}\x1b[39m`]),
);

test('highlights every supported language and preserves code units and logical lines', () => {
  const edgeCases = '\n\t<&>"\' &amp; &#39; &#x1f600; e\u0301 😀 \ud800|\udfff\r\n\n  ';
  for (const [language, example] of Object.entries(languageExamples)) {
    const highlighted = highlightMarkdownCode(example, language, testTheme);
    assert.match(highlighted.join('\n'), /\x1b\[35m/u, `${language} must classify tokens`);
    for (const code of [example, `${example}${edgeCases}`, '', '\n\n', '  \t\r\n ']) {
      assert.deepEqual(
        highlightMarkdownCode(code, language, testTheme).map(stripAnsi),
        code.split('\n'),
        `${language} must preserve text, whitespace, and empty lines`,
      );
    }
  }
});

test('every documented alias has the same highlighting as its canonical language', () => {
  for (const [alias, language] of Object.entries(aliases)) {
    const code = languageExamples[language];
    const expected = highlightMarkdownCode(code, language, testTheme);
    assert.match(expected.join('\n'), /\x1b\[35m/u);
    assert.deepEqual(highlightMarkdownCode(code, alias, testTheme), expected, alias);
    assert.deepEqual(
      highlightMarkdownCode(code, ` ${alias.toUpperCase()} `, testTheme),
      expected,
      `${alias} is case-insensitive and trimmed`,
    );
  }
});

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
  for (const language of [
    '',
    '  ',
    'text',
    'plaintext',
    'made-up-language',
    '__proto__',
    'constructor',
  ]) {
    assert.deepEqual(highlightMarkdownCode(code, language, testTheme), code.split('\n'), language);
  }
  assert.deepEqual(
    highlightMarkdownCode('const value = 1;', 'typescript', {
      keyword: () => {
        throw new Error('theme failed');
      },
    }),
    ['const value = 1;'],
  );
});

test('large streamed code falls back to plain text before formatting', () => {
  const prefix = 'const value = 1;\n';
  for (const [language, code] of [
    ['typescript', prefix + 'x'.repeat(4097 - prefix.length)],
    ['markdown', '['.repeat(2048) + 'x' + ']'.repeat(2048)],
  ]) {
    let formattingCalls = 0;
    const countFormatting = (text: string) => {
      formattingCalls++;
      return text;
    };
    assert.deepEqual(
      highlightMarkdownCode(code, language, {
        keyword: countFormatting,
        link: countFormatting,
        string: countFormatting,
        default: countFormatting,
      }),
      code.split('\n'),
    );
    assert.equal(
      formattingCalls,
      0,
      `${language} must bypass synchronous highlighting above the cap`,
    );
  }
});

test('production highlighting respects terminal color capabilities and NO_COLOR', () => {
  const code = languageExamples.typescript;
  const script = [
    'const { markdownTheme } = await import(process.argv[1]);',
    'if (!markdownTheme.highlightCode) throw new Error("missing shared Markdown hook");',
    'process.stdout.write(JSON.stringify(markdownTheme.highlightCode(process.argv[2], "typescript")));',
  ].join('\n');
  const moduleUrl = new URL('../pi-transcript-format.js', import.meta.url).href;
  const cases = [
    {
      name: 'truecolor',
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '' },
      colored: true,
    },
    { name: 'basic ANSI', env: { TERM: 'xterm', COLORTERM: '', NO_COLOR: '' }, colored: true },
    {
      name: 'NO_COLOR',
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1' },
      colored: false,
    },
    {
      name: 'dumb terminal',
      env: { TERM: 'dumb', COLORTERM: 'truecolor', NO_COLOR: '' },
      colored: false,
    },
  ];
  for (const { name, env, colored } of cases) {
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script, moduleUrl, code],
      {
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '', ...env },
        timeout: 15_000,
      },
    );
    const lines = JSON.parse(output) as string[];
    assert.deepEqual(lines.map(stripAnsi), code.split('\n'), name);
    assert.equal(/\x1b\[[\d;]*m/u.test(lines.join('\n')), colored, name);
    if (name === 'truecolor') assert.match(lines.join('\n'), /\x1b\[38;2;/u);
    if (name === 'basic ANSI') assert.doesNotMatch(lines.join('\n'), /\x1b\[38;[25];/u);
  }
});

test('highlighting preserves every live and detailed row during streaming and resizing', async (t) => {
  const source = [
    'const greeting: string = "你好<&>";',
    '/* multi-line comment',
    '   with e\u0301 and 😀 */',
    '',
    '\tconsole.log(greeting); // ' + 'long-code-'.repeat(8),
  ].join('\n');
  // Load the real production styles after color capability detection, with no
  // mutation of the parent process's theme or assumptions about its stdout.
  const script = [
    'const [layoutUrl, transcriptUrl, formatUrl, openText, closedText] = process.argv.slice(1);',
    'const { MakaTranscriptComponent } = await import(layoutUrl);',
    'const { createMakaPiTranscriptState } = await import(transcriptUrl);',
    'const { markdownTheme } = await import(formatUrl);',
    'const highlightCode = markdownTheme.highlightCode;',
    'if (!highlightCode) throw new Error("missing shared Markdown hook");',
    'function transcriptFor(text) {',
    '  const state = createMakaPiTranscriptState();',
    '  const entry = { kind: "assistant", messageId: "assistant-code", text };',
    '  state.entries.push(entry);',
    '  const transcript = new MakaTranscriptComponent(state, () => ({',
    '    title: "Maka", cwd: "/repo", model: "model", connectionSlug: "connection", permissionMode: "ask",',
    '  }));',
    '  return { transcript, entry };',
    '}',
    'const results = [];',
    'for (const [closed, text] of [[false, openText], [true, closedText]]) {',
    '  markdownTheme.highlightCode = undefined;',
    '  const baseline = transcriptFor(text);',
    '  const baselineDocument = baseline.transcript.createDocumentRenderer();',
    '  const before = [8, 24, 40, 100].map(width => ({',
    '    width, live: baseline.transcript.render(width), detailed: baselineDocument(width).lines,',
    '  }));',
    '  markdownTheme.highlightCode = highlightCode;',
    '  const highlighted = transcriptFor(text);',
    '  const highlightedDocument = highlighted.transcript.createDocumentRenderer();',
    '  for (const previous of before) results.push({',
    '    closed, ...previous, afterLive: highlighted.transcript.render(previous.width),',
    '    afterDetailed: highlightedDocument(previous.width).lines,',
    '    sourceUnchanged: baseline.entry.text === text && highlighted.entry.text === text,',
    '  });',
    '}',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n');
  const openText = `Code example:\n\n\`\`\`ts\n${source}`;
  for (const [name, env, colored] of [
    ['truecolor', { TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '' }, true],
    ['basic ANSI', { TERM: 'xterm', COLORTERM: '', NO_COLOR: '' }, true],
    ['NO_COLOR', { TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1' }, false],
  ] as const) {
    await t.test(name, () => {
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          script,
          new URL('../pi-tui-layout.js', import.meta.url).href,
          new URL('../pi-transcript.js', import.meta.url).href,
          new URL('../pi-transcript-format.js', import.meta.url).href,
          openText,
          `${openText}\n\`\`\`\n\nAfter the code.`,
        ],
        {
          encoding: 'utf8',
          timeout: 15_000,
          env: {
            ...process.env,
            FORCE_COLOR: '',
            ...env,
          },
        },
      );
      const results = JSON.parse(output) as Array<{
        closed: boolean;
        width: number;
        live: string[];
        detailed: string[];
        afterLive: string[];
        afterDetailed: string[];
        sourceUnchanged: boolean;
      }>;
      assert.equal(results.length, 8);
      for (const {
        closed,
        width,
        live,
        detailed,
        afterLive,
        afterDetailed,
        sourceUnchanged,
      } of results) {
        const context = `${closed ? 'closed' : 'streaming'} fence at width ${width}`;
        assert.equal(/\x1b\[[\d;]*m/u.test(afterLive.join('\n')), colored, `live ${context}`);
        assert.equal(
          /\x1b\[[\d;]*m/u.test(afterDetailed.join('\n')),
          colored,
          `detailed ${context}`,
        );
        assert.deepEqual(afterLive.map(stripAnsi), live.map(stripAnsi), `live ${context}`);
        assert.deepEqual(
          afterDetailed.map(stripAnsi),
          detailed.map(stripAnsi),
          `detailed ${context}`,
        );
        assert.deepEqual(afterLive.map(stripAnsi), afterDetailed.map(stripAnsi), context);
        assert.equal(sourceUnchanged, true, context);
      }
    });
  }
});
