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
import { registerHooks } from 'node:module';
import test from 'node:test';

const app = new URL('../app/', import.meta.url);
const locale = `
  export const tr = (key, values = {}) =>
    key.replace(/\\{(\\w+)\\}/g, (placeholder, name) => values[name] ?? placeholder);
`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(app.href) && specifier === './locale')
      return { url: `data:text/javascript,${encodeURIComponent(locale)}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { codePieces, columns, largestTextSize, lineColumns, pieceLines } = await import(
  new URL('codePieces.ts', app)
);
hooks.deregister();

const numbered = (count) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

test('short code text stays one piece, unchanged', () => {
  const text = 'first\n\nlast\n';
  assert.deepEqual(codePieces(text, '1\n2\n3\n4'), [{ index: 0, text, gutter: '1\n2\n3\n4' }]);
});

test('long code text is split into pieces of 200 lines that keep every line', () => {
  const lines = numbered(pieceLines * 2 + 5);
  const gutter = lines.map((_, index) => String(index + 1)).join('\n');
  const pieces = codePieces(lines.join('\n'), gutter);
  assert.deepEqual(
    pieces.map((piece) => piece.text.split('\n').length),
    [pieceLines, pieceLines, 5],
  );
  assert.deepEqual(
    pieces.flatMap((piece) => piece.text.split('\n')),
    lines,
  );
  // Line numbers are padded to the widest one, so every piece lines up.
  assert.equal(pieces[0].gutter.split('\n')[0], '  1');
  assert.equal(pieces[2].gutter.split('\n').at(-1), '405');
});

test('an empty line at a piece edge keeps its height', () => {
  const lines = numbered(pieceLines * 2);
  lines[pieceLines - 1] = '';
  lines[pieceLines] = '';
  const pieces = codePieces(lines.join('\n'));
  assert.equal(pieces[0].text.split('\n').at(-1), ' ');
  assert.equal(pieces[1].text.split('\n')[0], ' ');
});

test('the budget covers the largest text size the desktop offers', async () => {
  const appearance = await readFile(new URL('appearance.ts', app), 'utf8');
  const sizes = JSON.parse(appearance.match(/textSizes = (\[[^\]]*\])/)[1]);
  assert.equal(largestTextSize, Math.max(...sizes));
  // 13 pt code text on 20 pt lines, a monospace column about 0.62 em wide, a 2x display.
  assert.ok(lineColumns * 13 * largestTextSize * 0.62 * 2 < 16384 * 0.95);
  assert.ok(pieceLines * 20 * largestTextSize * 2 < 16384 * 0.95);
});

test('a line exactly at the limit stays whole', () => {
  const line = 'a'.repeat(lineColumns);
  assert.equal(codePieces(line)[0].text, line);
  const wide = '字'.repeat(lineColumns / 2);
  assert.equal(codePieces(wide)[0].text, wide);
});

test('a line too wide for one layer is cut, its note included in the limit', () => {
  for (const line of [
    'a'.repeat(lineColumns + 1),
    'a'.repeat(lineColumns + 30),
    'a'.repeat(lineColumns * 50),
    '字'.repeat(lineColumns),
    `a${'字'.repeat(lineColumns)}`,
    '✅'.repeat(lineColumns / 2),
    '👨‍👩‍👧 '.repeat(lineColumns / 4),
  ]) {
    const [piece] = codePieces(`${line}\nshort`);
    const [shown, next] = piece.text.split('\n');
    assert.equal(next, 'short');
    assert.ok(columns(shown) <= lineColumns, `${columns(shown)} columns`);
    const [, kept, count] = shown.match(/^(.*) … (\d+) more characters$/u);
    assert.ok(line.startsWith(kept));
    assert.equal([...kept].length + Number(count), [...line].length);
  }
});
