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
import { searchToolResultText } from '../tool-result-search.js';
import { readToolResultPage, READ_PAGE_MAX_BYTES } from '../read-page.js';
import { runRipgrep, type GrepRunner } from '../grep-search.js';

const path = 'maka://runtime/tool-results/log';
const search = (text: string, pattern = 'timeout') =>
  searchToolResultText({
    path,
    pattern,
    serializedResult: JSON.stringify({ content: text }),
  });

test('searches the same decoded text as Read and counts lines rather than occurrences', async () => {
  const text = 'first\n前缀 timeout timeout\r\nlast timeout\n';
  const result = await search(text);
  assert.deepEqual(result, {
    matches: [`${path}:2:前缀 timeout timeout`, `${path}:3:last timeout`],
    matchedLines: 2,
    returnedLines: 2,
    omittedLines: 0,
    truncated: false,
  });
  const page = readToolResultPage(JSON.stringify({ content: text }), { path, offset: 1, limit: 1 });
  assert.equal(page.content, '前缀 timeout timeout\r');
  assert.equal((await search(text, 'absent')).matchedLines, 0);
  assert.equal((await search('')).matchedLines, 0);
  assert.equal((await search('a\n\nb\n', '')).matchedLines, 3);
  assert.equal((await search('a\n\nb\n', '^$')).matchedLines, 1);
  assert.equal((await search('\uFEFFtimeout\n', '^\uFEFFtimeout')).matchedLines, 1);
});

test('caps matches and the entire escaped JSON envelope while finishing the search', async () => {
  const text = `${'timeout 中文😀\\"'.repeat(12)}\n`.repeat(201);
  const result = await search(text);
  assert.equal(result.matchedLines, 201);
  assert.ok(result.returnedLines > 0 && result.returnedLines <= 50);
  assert.equal(result.omittedLines, 201 - result.returnedLines);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READ_PAGE_MAX_BYTES);
  assert.equal(result.matches.length, result.returnedLines);
});

test('long Unicode JSON lines return usable digest-bound Read positions', async () => {
  const serializedResult = JSON.stringify({
    padding: '中😀'.repeat(80_000),
    error: 'timeout',
    suffix: 'z'.repeat(20_000),
  });
  const result = await searchToolResultText({ path, pattern: 'timeout', serializedResult });
  assert.equal(result.matchedLines, 1);
  assert.equal(result.returnedLines, 1);
  assert.equal(result.omittedLines, 0);
  assert.equal(result.truncated, true);
  assert.ok(result.matches[0]!.includes('timeout'));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READ_PAGE_MAX_BYTES);
  const hint = result.readHints![0]!;
  assert.equal(hint.matchIndex, 0);
  const page = readToolResultPage(serializedResult, hint.read);
  assert.ok(page.content.includes('timeout'));
  assert.equal(page.offset, 0);
  assert.equal(page.partialLine, true);
  assert.ok(!page.content.includes('�'));
  assert.throws(() => readToolResultPage(serializedResult + ' ', hint.read), /changed/);
});

test('retains only a bounded prefix while streaming a huge regex match', async () => {
  const text = `${'😀'.repeat(200_000)}\ntimeout\n`;
  const result = await search(text, '^.*$');
  assert.equal(result.matchedLines, 2);
  assert.equal(result.returnedLines, 2);
  assert.ok(result.matches[0]!.length < 600);
  assert.equal(result.matches[1], `${path}:2:timeout`);
  assert.ok(!JSON.stringify(result).includes('�'));
  const page = readToolResultPage(JSON.stringify({ content: text }), result.readHints![0]!.read);
  assert.ok(page.content.startsWith('😀'));
});

test('dense and zero-width regexes keep subprocess output proportional to source lines', async () => {
  const row = '2026-10-16T12:34:56.789Z request=123456789 status=200 latency=12345ms\n';
  const rows = Math.ceil((4 * 1024 * 1024) / row.length);
  for (const [text, pattern, matchedLines] of [
    [row.repeat(rows), '\\d', rows],
    ['x'.repeat(2 * 1024 * 1024), '.', 1],
    ['x'.repeat(2 * 1024 * 1024), 'z*', 1],
  ] as const) {
    let stdoutBytes = 0;
    const result = await searchToolResultText(
      { path, pattern, serializedResult: JSON.stringify({ content: text }) },
      (execution) =>
        runRipgrep({
          ...execution,
          onStdout(chunk) {
            stdoutBytes += chunk.length;
            execution.onStdout(chunk);
          },
        }),
    );
    assert.equal(result.matchedLines, matchedLines);
    assert.ok(result.returnedLines > 0 && result.returnedLines <= 50);
    assert.equal(result.omittedLines, matchedLines - result.returnedLines);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READ_PAGE_MAX_BYTES);
    // Include room for numeric positions and rg's final newline. A record per
    // occurrence would amplify these inputs into millions of output records.
    assert.ok(stdoutBytes <= Buffer.byteLength(text) + matchedLines * 60 + 1);
  }
});

test('preserves failed execution and retained-output truncation metadata', async () => {
  const result = await searchToolResultText({
    path,
    pattern: 'timeout',
    serializedResult: JSON.stringify({
      kind: 'terminal',
      status: 'failed',
      exitCode: 2,
      output: {
        stdout: 'discarded before capture',
        stderr: 'timeout',
        stdoutTruncated: true,
        stderrTruncated: false,
      },
    }),
  });
  assert.equal(result.matchedLines, 1);
  assert.deepEqual(result.metadata, {
    kind: 'terminal',
    status: 'failed',
    exitCode: 2,
    stdoutTruncated: true,
    stderrTruncated: false,
  });
});

test('invalid regexes and cancellation never produce a zero-match result', async () => {
  await assert.rejects(
    search('timeout'.repeat(100_000), '['),
    /totals are unknown.*Check the regex/s,
  );
  await assert.rejects(
    searchToolResultText({
      path,
      pattern: 'timeout',
      serializedResult: '"timeout"',
      abortSignal: AbortSignal.abort(new Error('stop')),
    }),
    /stop/,
  );
  const controller = new AbortController();
  await assert.rejects(
    searchToolResultText(
      {
        path,
        pattern: 'timeout',
        serializedResult: '"timeout"',
        abortSignal: controller.signal,
      },
      async () => {
        controller.abort(new Error('stop after scan'));
        return { exitCode: 1, stderrTail: '' };
      },
    ),
    /stop after scan/,
  );
});

test('chunked numeric prefixes are bounded and partial or failed searches are rejected', async () => {
  const input = {
    path,
    pattern: 'timeout',
    serializedResult: JSON.stringify('前缀 timeout timeout\n'),
    executable: 'rg',
  };
  const result = await searchToolResultText(input, async ({ onStdout, stdin, args }) => {
    assert.equal(stdin, '前缀 timeout timeout\n');
    assert.ok(args.includes('--no-config'));
    assert.equal(args.at(-1), '-');
    for (const byte of Buffer.from('1:8:0:前缀 timeout timeout\n')) onStdout(Buffer.from([byte]));
    return { exitCode: 0, stderrTail: '' };
  });
  assert.equal(result.matchedLines, 1);
  for (const [stdout, exitCode] of [
    ['1:8:0:前缀 timeout timeout', 0],
    ['1:', 0],
    ['', 0],
    ['1:8:0:前缀 timeout timeout\n', 1],
    ['1:8:0:前缀 timeout timeout\n', 2],
    ['1:999999:0:timeout\n', 0],
    ['1:8:0:timeout\n1:16:0:timeout\n', 0],
    ['x'.repeat(100), 0],
  ] as const) {
    await assert.rejects(
      searchToolResultText(input, async ({ onStdout }) => {
        onStdout(Buffer.from(stdout));
        return { exitCode, stderrTail: 'interrupted' };
      }),
      /totals are unknown/,
    );
  }
});

test('the shared runner enforces a deadline and cancellation while waiting for a process', async () => {
  const wait: Parameters<GrepRunner>[0] = {
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    stdin: 'bounded input',
    timeoutMs: 20,
    onStdout() {},
  };
  await assert.rejects(
    runRipgrep(wait),
    /timed out; search totals are unknown\. Retry with a narrower pattern\./,
  );
  const controller = new AbortController();
  const execution = runRipgrep({ ...wait, timeoutMs: 10_000, abortSignal: controller.signal });
  controller.abort();
  await assert.rejects(execution, /cancelled; search totals are unknown/);
});
