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
import test from 'node:test';
import { createTerminalViewport } from '../app/terminalViewport.ts';

function originalGrid() {
  const screen = { rows: 24, cursor: 1, lines: ['READY', ...Array(23).fill('')] };
  const calls = [];
  const read = createTerminalViewport((offset, rows) => {
    assert.equal(typeof offset, 'number', 'old native clients require a numeric offset');
    calls.push(offset);
    const count = Math.min(rows, screen.rows);
    const bounded = Math.min(offset, screen.lines.length - count);
    const first = screen.lines.length - count - bounded;
    return {
      metadata: { size: { rows: screen.rows }, cursor: { y: screen.cursor } },
      rows: screen.lines.slice(first, first + count),
      offset: bounded,
    };
  });
  return { screen, calls, read };
}

test('a short observer shows initial output using the original numeric API', () => {
  const { read, calls } = originalGrid();
  assert.equal(read(null, 18).rows[0], 'READY');
  calls.length = 0;
  assert.equal(read(null, 18).rows[0], 'READY');
  assert.equal(calls.length, 1, 'unchanged follow position needs only one native read');
});

test('following tracks later output and returns to the top after clear', () => {
  const { screen, read } = originalGrid();
  read(null, 18);
  screen.cursor = 23;
  screen.lines = Array.from({ length: 45 }, (_, index) => `line-${index}`);
  assert.equal(read(null, 18).rows.at(-1), 'line-44');
  screen.cursor = 1;
  screen.lines = ['AFTER CLEAR', ...Array(23).fill('')];
  assert.equal(read(null, 18).rows[0], 'AFTER CLEAR');
});

test('manual history remains selected while output continues', () => {
  const { screen, read } = originalGrid();
  screen.cursor = 23;
  screen.lines = Array.from({ length: 45 }, (_, index) => `line-${index}`);
  assert.equal(read(27, 18).rows[0], 'line-0');
  screen.lines.push('line-45');
  assert.equal(read(28, 18).rows[0], 'line-0');
  assert.equal(read(null, 18).rows.at(-1), 'line-45');
});

test('resizing an observer preserves initial output and clamps to the PTY height', () => {
  const { read } = originalGrid();
  for (const rows of [24, 18, 8, 30, 18]) {
    const frame = read(null, rows);
    assert.equal(frame.rows[0], 'READY');
    assert.equal(frame.rows.length, Math.min(rows, 24));
  }
});
