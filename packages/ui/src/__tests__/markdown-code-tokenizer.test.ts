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
import { TOKEN_TYPES, flatTokensToLines, type SyntaxToken } from '@astryxdesign/core/CodeBlock';
import { extraCodeLanguage, MAX_EXTRA_CODE_LENGTH } from '../markdown-code-highlighting.js';
import { tokenizeExtraCode } from '../markdown-code-tokenizer.js';

const SAMPLES = {
  java: 'public class X { String s = "hi"; int n = 42; }',
  go: 'package main\nfunc main() { s := "hi"; n := 42 }',
  rust: 'fn main() { let s = "hi"; let n = 42; }',
  c: 'int main(void) { char *s = "hi"; return 42; }',
  cpp: '#include <string>\nint main() { std::string s = "hi"; return 42; }',
  csharp: 'public class X { string s = "hi"; int n = 42; }',
  sql: "SELECT id FROM users WHERE name = 'hi' AND id = 42;",
};

function verifyRanges(code: string, tokens: SyntaxToken[]): void {
  let cursor = 0;
  let restored = '';
  for (const token of tokens) {
    assert.ok(Number.isInteger(token.start) && Number.isInteger(token.end));
    assert.ok(token.start >= cursor && token.end > token.start && token.end <= code.length);
    assert.ok(TOKEN_TYPES.some(type => type === token.type), token.type);
    assert.ok(!code.slice(token.start, token.end).includes('\n'));
    restored += code.slice(cursor, token.start) + code.slice(token.start, token.end);
    cursor = token.end;
  }
  restored += code.slice(cursor);
  assert.equal(restored, code);
}

for (const [language, code] of Object.entries(SAMPLES)) {
  test(`extra Markdown tokenizer highlights ${language} using Astryx categories`, () => {
    const tokens = tokenizeExtraCode(code, language);
    for (const type of ['keyword', 'string', 'number']) {
      assert.ok(tokens.some(token => token.type === type), `${language}: missing ${type}`);
    }
    verifyRanges(code, tokens);
  });
}

test('normalizes only the supported extra language names and aliases', () => {
  for (const [input, expected] of [
    [' JAVA ', 'java'], ['golang', 'go'], ['rs', 'rust'], ['C++', 'cpp'],
    ['c#', 'csharp'], ['cs', 'csharp'], ['dotnet', 'csharp'], ['SQL', 'sql'],
  ]) assert.equal(extraCodeLanguage(input), expected);
  for (const input of [undefined, '', 'typescript', 'python', 'plaintext', 'mermaid', 'unknown', '__proto__', 'constructor']) {
    assert.equal(extraCodeLanguage(input), undefined);
    assert.deepEqual(tokenizeExtraCode('return 42;', input ?? ''), []);
  }
  assert.deepEqual(tokenizeExtraCode(SAMPLES.cpp, 'c++'), tokenizeExtraCode(SAMPLES.cpp, 'cpp'));
  assert.deepEqual(tokenizeExtraCode(SAMPLES.csharp, 'c#'), tokenizeExtraCode(SAMPLES.csharp, 'csharp'));
});

test('uses document-global UTF-16 offsets across CRLF, Unicode and empty lines', () => {
  const code = 'public class X {\r\n\tString text = "中文😀<&>";\r\n\r\n\treturn 42;\r\n}';
  const tokens = tokenizeExtraCode(code, 'java');
  verifyRanges(code, tokens);
  const string = tokens.find(token => token.type === 'string');
  assert.ok(string);
  assert.equal(code.slice(string.start, string.end), '"中文😀<&>"');
  assert.ok(tokens.some(token => token.start === code.indexOf('return') && token.type === 'keyword'));
  const lines = code.split('\n');
  for (const [index, lineTokens] of flatTokensToLines(tokens, code).entries()) {
    for (const token of lineTokens) assert.ok(token.end <= lines[index]!.length);
  }
});

for (const [language, code, interior, type] of [
  ['java', '/* first\nsecond 中文😀\nlast */\nreturn 42;', 'second 中文😀', 'comment'],
  ['go', 'package main\nvar s = `first\nsecond\nlast`', 'second', 'string'],
  ['rust', 'fn main() { let s = r#"first\nsecond\nlast"#; }', 'second', 'string'],
  ['cpp', 'auto s = R"(first\nsecond\nlast)";', 'second', 'string'],
  ['csharp', 'string s = @"first\nsecond\nlast";', 'second', 'string'],
  ['sql', '/* first\nsecond\nlast */\nSELECT 42;', 'second', 'comment'],
]) {
  test(`retains ${language} multiline ${type} colours on later lines`, () => {
    const tokens = tokenizeExtraCode(code!, language!);
    verifyRanges(code!, tokens);
    const start = code!.indexOf(interior!);
    assert.ok(tokens.some(token => token.type === type && token.start <= start && token.end >= start + interior!.length));
  });
}

test('keeps literal HTML, entities, whitespace and unclosed streaming constructs intact', () => {
  for (const code of [
    'String x = "<script>alert(1)</script>&amp;";',
    'String x = "hello', '/* unclosed\n中文😀', '', '\t\r\n  \u00a0',
  ]) {
    verifyRanges(code, tokenizeExtraCode(code, 'java'));
  }
});

test('bounds work and the source cache without truncating its input', () => {
  const oversized = `/*${'x'.repeat(MAX_EXTRA_CODE_LENGTH)}*/`;
  assert.deepEqual(tokenizeExtraCode(oversized, 'java'), []);
  assert.equal(oversized.length, MAX_EXTRA_CODE_LENGTH + 4);
  const first = tokenizeExtraCode(SAMPLES.java, 'java');
  assert.equal(tokenizeExtraCode(SAMPLES.java, 'JAVA'), first);
  for (let index = 0; index < 40; index += 1) tokenizeExtraCode(`${SAMPLES.java} // ${index}`, 'java');
  const recomputed = tokenizeExtraCode(SAMPLES.java, 'java');
  assert.notEqual(recomputed, first);
  assert.deepEqual(recomputed, first);
  for (let index = 0; index < 8; index += 1) tokenizeExtraCode(`/*${'x'.repeat(15_000)}${index}*/`, 'java');
  assert.notEqual(tokenizeExtraCode(SAMPLES.java, 'java'), recomputed);
});
