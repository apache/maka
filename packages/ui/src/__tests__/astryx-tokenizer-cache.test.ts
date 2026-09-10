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
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

type TokenLine = { type: string; start: number; end: number }[];
type Tokenizer = {
  tokenize: (code: string, language: string) => TokenLine[];
  tokenizeAsync: (code: string, language: string) => Promise<TokenLine[]>;
  tokenizeStreaming: (
    code: string,
    language: string,
    onBatch: (lines: TokenLine[], startLine: number) => void,
  ) => Promise<void>;
};
type Definition = { patterns: { anchored: RegExp }[] };

const tokenizerUrl = new URL('tokenizer.js', import.meta.resolve('@astryxdesign/core/CodeBlock'));
const tokenizer: Tokenizer = await import(tokenizerUrl.href);
const { parseMarkdown }: {
  parseMarkdown: (text: string) => { type: string; language?: string; content?: string }[];
} = await import(new URL('parser.js', import.meta.resolve('@astryxdesign/core/Markdown')).href);

async function streamed(api: Tokenizer, code: string, language: string) {
  const result: TokenLine[] = [];
  let batches = 0;
  await api.tokenizeStreaming(code, language, (lines, startLine) => {
    assert.equal(startLine, result.length);
    result.push(...lines);
    batches += 1;
  });
  return { result, batches };
}

test('installed tokenizer preserves known aliases across sync, async and streaming paths', async () => {
  const samples = [
    [['typescript', 'javascript', 'tsx', 'jsx', 'ts', 'js'], 'const answer = 42;'],
    [['json'], '{"answer": 42}'],
    [['html', 'xml', 'svg'], '<div id="answer">42</div>'],
    [['css', 'scss', 'less'], '.answer { color: red; }'],
    [['python', 'py'], 'def answer(): return 42'],
    [['bash', 'sh', 'zsh', 'shell'], 'echo "$answer"'],
    [['php'], '<?php echo 42;'],
    [['hack'], 'function answer(): int { return 42; }'],
    [['yaml', 'yml'], 'answer: true'],
    [['markdown', 'md'], '# Answer'],
  ] as const;

  for (const [aliases, line] of samples) {
    const code = `${line}\n`.repeat(100);
    const expected = tokenizer.tokenize(code, aliases[0]);
    assert.ok(expected.some((tokens) => tokens.length > 0), aliases[0]);
    for (const language of aliases) {
      assert.deepEqual(tokenizer.tokenize(code, language), expected, language);
      assert.deepEqual(await tokenizer.tokenizeAsync(code, language), expected, language);
      const { result, batches } = await streamed(tokenizer, code, language);
      assert.deepEqual(result, expected, language);
      assert.ok(batches > 1, `${language} should cross the async batch boundary`);
    }
  }
});

test('installed tokenizer keeps unsupported labels on the plain-text fallback', async () => {
  for (const language of ['', 'plaintext', 'text', 'console_output_1', 'c++']) {
    const code = 'const answer = 42;\n'.repeat(100);
    assert.deepEqual(tokenizer.tokenize(code, language), []);
    assert.deepEqual(await tokenizer.tokenizeAsync(code, language), []);
    assert.deepEqual(await streamed(tokenizer, code, language), { result: [], batches: 0 });
  }
});

test('parsed unsupported fence labels never accumulate in the shared language cache', async () => {
  // Observe the actual installed module's private cache without adding a vendor
  // test API. Only ESM export keywords are removed; tokenizer logic is unchanged.
  // This checks the retaining root deterministically. Browser heap validation
  // separately confirms V8 can retain an entire Markdown source via a sliced key.
  const source = readFileSync(tokenizerUrl, 'utf8').replace(/^export /gm, '');
  const observed = runInNewContext(
    `${source}\n;({ tokenize, tokenizeAsync, tokenizeStreaming, langCache })`,
    { setTimeout },
    { filename: tokenizerUrl.pathname },
  ) as Tokenizer & { langCache: Map<string, Definition | null> };

  observed.tokenize('const answer = 42;', 'javascript');
  const definition = observed.langCache.get('javascript');
  assert.ok(definition);
  const regex = definition.patterns[0].anchored;

  for (let index = 1; index <= 40; index += 1) {
    const language = `console_output_${index}`;
    const markdown = `${'prose content '.repeat(23_000)}\n\n\`\`\`${language}\nsmall output\n\`\`\``;
    const block = parseMarkdown(markdown).find((node) => node.type === 'codeblock');
    assert.ok(block);
    assert.equal(block.language, language, 'the parser must preserve the displayed fence label');
    assert.equal(block.content, 'small output');
    assert.equal(observed.tokenize(block.content, block.language).length, 0);
    assert.equal((await observed.tokenizeAsync(block.content, block.language)).length, 0);
    assert.equal((await streamed(observed, block.content, block.language)).batches, 0);
  }

  assert.equal(observed.langCache.size, 1, 'only the known language may remain cached');
  assert.deepEqual([...observed.langCache.keys()], ['javascript']);
  await observed.tokenizeAsync('const next = 43;', 'javascript');
  await streamed(observed, 'const last = 44;', 'javascript');
  assert.equal(observed.langCache.get('javascript'), definition, 'reuse compiled definitions');
  assert.equal(definition.patterns[0].anchored, regex, 'reuse compiled regular expressions');
});
