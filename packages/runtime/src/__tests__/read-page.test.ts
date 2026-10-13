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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  readPage,
  readToolResultPage,
  resolveReadInput,
  READ_PAGE_MAX_BYTES,
  type ReadInput,
} from '../read-page.js';

test('malformed continuation positions fail instead of restarting the resource', () => {
  const page = readPage('x'.repeat(10000), { path: 'file.txt' });
  assert.ok(page.next);
  for (const at of [undefined, '', ' ', '-1', '1.5', '1e2']) {
    const url = new URL(page.next.path);
    if (at === undefined) url.searchParams.delete('at');
    else url.searchParams.set('at', at);
    assert.throws(() => resolveReadInput({ path: url.toString() }), /Invalid Read continuation/);
  }
  assert.ok(resolveReadInput(page.next).position! > 0);
});

test('default and explicit large ranges stay bounded and continue to the requested end', () => {
  const lines = Array.from({ length: 900 }, (_, i) => `line ${i} ${'x'.repeat(160)}`);
  for (const limit of [undefined, 80, 1_000_000]) {
    let input: ReadInput | null = { path: 'file.txt', offset: 200, ...(limit ? { limit } : {}) };
    const returned: string[] = [];
    while (input) {
      const page = readPage(lines.join('\n'), input);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= READ_PAGE_MAX_BYTES);
      assert.ok(page.returnedLines > 0);
      returned.push(...page.content.split('\n'));
      assert.notDeepEqual(page.next, input);
      input = page.next;
      assert.ok(returned.length <= 700);
    }
    assert.deepEqual(returned, lines.slice(200, limit ? 200 + limit : undefined));
  }
});

test('a long Unicode line continues without loss and refuses changed content', () => {
  const content = 'first\n' + '😀\\"'.repeat(12_000) + '\nlast';
  const pieces: string[] = [];
  let input: ReadInput | null = { path: 'long.txt', offset: 1, limit: 1 };
  while (input) {
    const page = readPage(content, input);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= READ_PAGE_MAX_BYTES);
    assert.ok(page.content.length > 0);
    assert.ok(!/[\uD800-\uDBFF]$/.test(page.content));
    pieces.push(page.content);
    if (page.next)
      assert.throws(() => readPage(content + 'changed', page.next!), /content changed/);
    input = page.next;
    assert.ok(pieces.length < 100);
  }
  assert.equal(pieces.join(''), content.split('\n')[1]);
});

test('line-boundary continuations reject a rolling output snapshot', () => {
  const lines = Array.from({ length: 160 }, (_, i) => `line-${i} ${'x'.repeat(100)}`);
  const content = lines.join('\n');
  const first = readPage(content, { path: 'maka://runtime/background-tasks/live' });
  assert.ok(first.next);
  assert.equal(first.partialLine, undefined);
  const second = readPage(content, first.next);
  assert.equal(second.content.split('\n')[0], lines[first.returnedLines]);
  assert.equal(second.partialLine, undefined);
  assert.throws(() => readPage(lines.slice(10).join('\n'), first.next!), /content changed/);
});

test('archive Read decodes content lines and retains terminal execution metadata', () => {
  assert.equal(
    readToolResultPage(JSON.stringify({ content: 'a\nb\nc' }), {
      path: 'maka://runtime/tool-results/e',
      offset: 1,
      limit: 1,
    }).content,
    'b',
  );
  const page = readToolResultPage(
    JSON.stringify({
      kind: 'terminal',
      exitCode: 2,
      failureMessage: 'command failed',
      output: { stdout: 'one\ntwo', stderr: 'error' },
    }),
    { path: 'maka://runtime/tool-results/e' },
  );
  assert.equal(page.content, 'one\ntwo\nerror\ncommand failed');
  assert.equal(page.metadata?.exitCode, 2);
  assert.equal(page.metadata?.failureMessage, undefined);
  assert.equal(page.next, null);
  assert.deepEqual(readPage('', { path: 'empty', offset: 3 }), {
    content: '',
    offset: 3,
    returnedLines: 0,
    totalLines: 1,
    next: null,
  });
});

test('archive Read pages a long shell failure without losing output or execution metadata', () => {
  const stdout = 'one\ntwo';
  const stderr = 'error';
  const failureMessage = `failure: ${'界\\"'.repeat(4_000)}`;
  const serialized = JSON.stringify({
    kind: 'terminal',
    cwd: '/workspace',
    cmd: 'failing-command',
    status: 'failed',
    exitCode: 7,
    failureMessage,
    output: {
      mode: 'pipes',
      stdout,
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  });
  let input: ReadInput | null = { path: 'maka://runtime/tool-results/failure' };
  let recovered = '';
  let pages = 0;
  while (input) {
    const page = readToolResultPage(serialized, input);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= READ_PAGE_MAX_BYTES);
    assert.equal(page.metadata?.status, 'failed');
    assert.equal(page.metadata?.exitCode, 7);
    assert.equal(page.metadata?.failureMessage, undefined);
    recovered += page.content;
    if (page.next && page.partialLine !== true) recovered += '\n';
    input = page.next;
    pages += 1;
    assert.ok(pages < 100);
  }

  assert.ok(pages > 1);
  assert.equal(recovered, `${stdout}\n${stderr}\n${failureMessage}`);
});

test('archive Read preserves fields beside structured text across pages', () => {
  for (const value of [
    { content: 'x'.repeat(9000), cursor: 'CURSOR-123', status: 'more' },
    { kind: 'text', text: 'x'.repeat(9000), cursor: 'CURSOR-123' },
  ]) {
    const serialized = JSON.stringify(value);
    let input: ReadInput | null = { path: 'maka://runtime/tool-results/e' };
    let recovered = '';
    while (input) {
      const page = readToolResultPage(serialized, input);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= READ_PAGE_MAX_BYTES);
      recovered += page.content;
      input = page.next;
    }
    assert.deepEqual(JSON.parse(recovered), value);
  }
});

test('small line ranges do not need a whole-file line index', async () => {
  // 固定堆预算验证实际资源边界，不依赖耗时阈值或具体索引实现。
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--max-old-space-size=64',
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import { readPage } from ${JSON.stringify(new URL('../read-page.js', import.meta.url).href)};
        const content = 'x\\n'.repeat(8_000_000);
        const page = readPage(content, { path: 'log.txt', offset: 2_000_000, limit: 20 });
        assert.equal(page.totalLines, 8_000_001);
        assert.equal(page.offset, 2_000_000);
        assert.equal(page.returnedLines, 20);
        assert.equal(page.content, 'x\\n'.repeat(19) + 'x');
        assert.equal(page.next, null);
        console.log('bounded read passed');
      `,
    ],
    { timeout: 30_000 },
  );
  assert.equal(stdout.trim(), 'bounded read passed');
});

test('line ranges preserve empty lines, trailing newlines and offsets beyond EOF', () => {
  for (const content of ['', '\n', '\n\n', 'a\nb', 'a\nb\n', 'a\r\n😀\n\nlast']) {
    const lines = content.split('\n');
    for (let offset = 0; offset <= lines.length + 1; offset++) {
      for (const limit of [undefined, 1, 2, 100]) {
        const selected = lines.slice(offset, limit === undefined ? undefined : offset + limit);
        assert.deepEqual(readPage(content, { path: 'file.txt', offset, limit }), {
          content: selected.join('\n'),
          offset,
          returnedLines: selected.length,
          totalLines: lines.length,
          next: null,
        });
      }
    }
  }
});
