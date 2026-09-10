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
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  renderMemoryLocalizationContext,
  type MemoryExtractionEventEntry,
} from '../memory-extraction-evidence.js';

test('localization preserves normalized Unicode at the event prefix boundary', () => {
  for (const [source, normalized] of [
    ['', ''],
    [' \t\r\n ', ''],
    ['  cafe\u0301\t中文\n😀 \u0000 \ud800x\udc00  ', 'café 中文 😀 \u0000 \ud800x\udc00'],
    ['e\u0301'.repeat(1_999) + '😀tail', 'é'.repeat(1_999) + '😀'],
    ['😀'.repeat(2_000) + 'discarded', '😀'.repeat(2_000)],
    ['x'.repeat(1_999) + '\ud800tail', 'x'.repeat(1_999) + '\ud800'],
    ['x'.repeat(1_999) + '\udc00tail', 'x'.repeat(1_999) + '\udc00'],
  ]) {
    assert.equal(
      renderMemoryLocalizationContext([entry('a', source!)]),
      normalized ? `[assistant event:a] ${normalized}` : '',
    );
  }
});

test('localization counts code points across lines and stops exactly at the total budget', () => {
  const entries = Array.from({ length: 5 }, (_, index) => entry(`${index}`, '😀'.repeat(2_001)));
  const prefix = entries.map(({ event }) => `[assistant event:${event.id}] ${'😀'.repeat(2_000)}`);
  // Five 2,020-point lines leave 1,900 points. Newlines are outside this budget.
  const lastHeader = '[assistant event:5] ';
  const available = 12_000 - 5 * 2_020 - lastHeader.length;
  entries.push(entry('5', 'é'.repeat(available - 1) + '😀DROP'), entry('6', 'OMITTED'));
  const expected = [...prefix, lastHeader + 'é'.repeat(available - 1) + '😀'].join('\n');
  const rendered = renderMemoryLocalizationContext(entries);
  assert.equal(rendered, expected);
  assert.equal(Array.from(rendered).length, 12_005);

  // A remaining budget smaller than the next header must clip the header too.
  const nearFull = [...entries.slice(0, 5), entry('5', 'x'.repeat(available - 1))];
  assert.equal(
    renderMemoryLocalizationContext([...nearFull, entry('6', 'discarded')]),
    [...prefix, lastHeader + 'x'.repeat(available - 1), '['].join('\n'),
  );
  assert.equal(
    renderMemoryLocalizationContext([
      {
        ...entry('partial', 'ignored'),
        event: { ...entry('partial', 'ignored').event, partial: true },
      },
      entry('empty', ' \t '),
      entry('visible', 'yes'),
    ]),
    '[assistant event:visible] yes',
  );
});

test('localization only iterates a bounded prefix of long assistant responses', () => {
  // Isolate the iterator observer from the test runner and other tests. It
  // measures consumed code points, independent of GC behavior or wall time.
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      String.raw`
        import assert from 'node:assert/strict';
        const { renderMemoryLocalizationContext } = await import(process.argv[1]);
        const entries = [];
        for (let turn = 0; turn < 6; turn++) {
          for (const role of ['user', 'model']) {
            entries.push({ ordinal: entries.length + 1, event: {
              id: role + turn, invocationId: 'invocation', runId: 'run',
              sessionId: 'session', turnId: String(turn), ts: 1_000, partial: false,
              role, author: role === 'user' ? 'user' : 'agent',
              content: { kind: 'text', text: role === 'user'
                ? 'Please explain atlas.' : 'atlas '.repeat(43_691).trim() },
            }});
          }
        }
        let remaining = 12_000;
        const expected = [];
        for (const { event } of entries) {
          const role = event.role === 'model' ? 'assistant' : 'user';
          const text = Array.from(event.content.text).slice(0, 2_000).join('');
          const line = Array.from('[' + role + ' event:' + event.id + '] ' + text)
            .slice(0, remaining).join('');
          expected.push(line);
          remaining -= Array.from(line).length;
        }
        const originalIterator = String.prototype[Symbol.iterator];
        const reads = [];
        String.prototype[Symbol.iterator] = function* () {
          const iterator = originalIterator.call(this);
          const observed = this.length > 128 * 1_024;
          const index = reads.length;
          if (observed) reads.push(0);
          for (let point = iterator.next(); !point.done; point = iterator.next()) {
            if (observed) {
              reads[index]++;
              assert.ok(reads[index] <= 2_001, 'long assistant prefix read past 2,001 points');
            }
            yield point.value;
          }
        };
        let actual;
        try { actual = renderMemoryLocalizationContext(entries); }
        finally { String.prototype[Symbol.iterator] = originalIterator; }
        assert.equal(actual, expected.join('\n'));
        assert.equal(reads.length, 6, 'all six long assistant responses were observed');
        assert.ok(reads.every(count => count >= 2_000 && count <= 2_001));
      `,
      new URL('../memory-extraction-evidence.js', import.meta.url).href,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr + child.stdout);
});

function entry(id: string, text: string): MemoryExtractionEventEntry {
  return {
    ordinal: 1,
    event: {
      id,
      invocationId: 'invocation',
      runId: 'run',
      sessionId: 'session',
      turnId: 'turn',
      ts: 1_000,
      partial: false,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text },
    },
  };
}
