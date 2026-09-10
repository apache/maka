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
import { queryTavily } from '../tavily-search.js';

test('Tavily truncation preserves existing UTF-16 prefixes and title fallback', async () => {
  const url = `https://example.test/${'fallback'.repeat(40)}`;
  const values: unknown[] = [
    '',
    'short',
    'a'.repeat(240),
    'a'.repeat(241),
    'a'.repeat(400),
    'a'.repeat(401),
    `a${'😀'.repeat(250)}`,
    `${'a'.repeat(239)}😀tail`,
    `${'a'.repeat(399)}😀tail`,
    '\ud800'.repeat(500),
    '\udfff'.repeat(500),
    `${'a'.repeat(239)}\udc00tail`,
    `${'a'.repeat(399)}\udc00tail`,
    undefined,
    null,
    42,
  ];
  for (const value of values) {
    const result = await queryTavily({
      apiKey: 'synthetic',
      query: 'synthetic',
      limit: 1,
      fetch: async () => Response.json({ results: [{ title: value, content: value, url }] }),
    });
    assert.deepEqual(result, {
      ok: true,
      results: [
        {
          provider: 'tavily',
          title: (typeof value === 'string' ? value : url).slice(0, 240),
          url,
          snippet: (typeof value === 'string' ? value : '').slice(0, 400),
          source: 'example.test',
        },
      ],
    });
  }
});

const CHILD_SOURCE = String.raw`
  import assert from 'node:assert/strict';
  import { setImmediate as tick } from 'node:timers/promises';
  const { queryTavily } = await import(process.argv[1]);
  async function search(index) {
    return queryTavily({
      apiKey: 'synthetic', query: 'synthetic', limit: 1,
      fetch: async () => {
        const body = JSON.stringify({ results: [{
          url: 'https://example.test/' + index,
          title: 'title-' + index + '-' + 'abcdefgh'.repeat(45_000),
          content: 'snippet-' + index + '-' + 'abcdefgh'.repeat(55_000),
        }] });
        assert(Buffer.byteLength(body) < 1_048_576);
        return new Response(body);
      },
    });
  }
  async function settledHeap() {
    for (let i = 0; i < 8; i++) { await tick(); global.gc(); }
    return process.memoryUsage().heapUsed;
  }
  // Warm up fetch/JSON machinery before measuring only retained result growth.
  for (let i = 0; i < 10; i++) await search(i);
  const baseline = await settledHeap();
  const results = [];
  for (let i = 0; i < 30; i++) results.push(await search(i));
  const retainedBytes = (await settledHeap()) - baseline;
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].title.length, 240);
    assert.equal(result.results[0].snippet.length, 400);
  }
  // Sliced parents retain about 24 MB; detached prefixes leave ample room below 8 MiB.
  assert(retainedBytes < 8 * 1024 * 1024,
    'bounded Tavily results retained ' + retainedBytes + ' heap bytes');
  console.log(JSON.stringify({ retainedResults: results.length, retainedBytes }));
`;

test('retained Tavily results do not retain large truncated provider strings', (context) => {
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '--eval',
      CHILD_SOURCE,
      new URL('../tavily-search.js', import.meta.url).href,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const measurement = JSON.parse(result.stdout.trim()) as {
    retainedResults: number;
    retainedBytes: number;
  };
  assert.equal(measurement.retainedResults, 30);
  context.diagnostic(`retained result heap growth: ${measurement.retainedBytes} bytes`);
});
