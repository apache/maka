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
import { it } from 'node:test';
import type { PtyShellOutput } from '@maka/core/shell-run';
import { PtyScreenCollector } from '../pty-screen-collector.js';
import { loadPtyStack } from '../pty-stack.js';
import { projectPtyOutputForModel } from '../shell-run-tool-result.js';

const marker = '[terminal snapshot truncated to fit the output limit]';

it('projects real PTY scrollback without expanding its discarded prefix', async () => {
  const failures: Error[] = [];
  const collector = new PtyScreenCollector({
    stack: await loadPtyStack(),
    cols: 240,
    rows: 24,
    onProtocolReply() {},
    onDirty() {},
    onFailure(error) {
      failures.push(error);
    },
  });
  let fullTextReads = 0;
  try {
    collector.accept(('LOG ' + 'x'.repeat(235) + '\r\n').repeat(700));
    const source = (await collector.snapshotAtCut()).output;
    const saved = structuredClone(source);
    assert.equal(source.scrollback.length, 119999);
    const expected = {
      ...source,
      scrollback: tail(source.scrollback, 51200 - Buffer.byteLength(source.screen)),
      truncated: true,
    };
    const original = String.prototype[Symbol.iterator];
    String.prototype[Symbol.iterator] = function* (this: string) {
      const tracked = String(this) === source.scrollback;
      for (const point of { [Symbol.iterator]: () => original.call(this) }) {
        if (tracked) fullTextReads++;
        yield point;
      }
      return undefined;
    };
    let projected: PtyShellOutput;
    try {
      projected = projectPtyOutputForModel(source);
    } finally {
      String.prototype[Symbol.iterator] = original;
    }
    assert.deepEqual(projected, expected);
    assert.deepEqual(source, saved);
    assert.deepEqual(failures, []);

    // A forward-codepoint oracle preserves lone surrogates and counts their UTF-8 replacement bytes.
    const texts = [
      '',
      'ordinary',
      'A'.repeat(3000),
      '中😀e\u0301'.repeat(800),
      '\ud800X\udfff😀\ud800\udfff'.repeat(800),
    ];
    for (const screen of texts) {
      for (const budget of [0, 1, 51, 52, 53, 54, 55, 56, 128, 1024, 51200]) {
        const fixture = { ...source, screen, scrollback: '', truncated: false };
        const result = projectPtyOutputForModel(fixture, budget);
        assert.deepEqual(result, {
          ...fixture,
          screen: tail(screen, budget),
          truncated: Buffer.byteLength(screen) > budget,
        });
        assert.ok(Buffer.byteLength(result.screen) <= budget);
      }
    }
    // Ordinary output remains unchanged and does not need tail collection.
    const ordinary = { ...source, screen: 'ordinary', scrollback: 'previous', truncated: false };
    assert.deepEqual(projectPtyOutputForModel(ordinary), ordinary);
    assert.equal(fullTextReads, 0, 'discarded scrollback must not be expanded into codepoints');
  } finally {
    collector.dispose();
  }
});

function tail(text: string, budget: number): string {
  if (Buffer.byteLength(text) <= budget) return text;
  if (budget <= Buffer.byteLength(marker)) return '';
  const room = budget - Buffer.byteLength(marker) - 1;
  let used = 0;
  let result = '';
  for (const point of Array.from(text).reverse()) {
    const size = Buffer.byteLength(point);
    if (used + size > room) break;
    result = point + result;
    used += size;
  }
  return marker + '\n' + result;
}
