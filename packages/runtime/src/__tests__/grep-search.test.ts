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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { searchFiles, GREP_MAX_MATCH_BYTES } from '../grep-search.js';
import { LocalWorkspaceExecutor } from '../workspace-executor.js';
import { FilesystemWorkerResultSchema } from '../filesystem-worker/protocol.js';

const executor = new LocalWorkspaceExecutor();
const defaults = { pattern: 'token', maxCountPerFile: 50, limit: 200, timeoutMs: 10_000 };

test('counts matching lines at per-file and total boundaries, not regex occurrences', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'grep-'));
  try {
    for (const total of [0, 49, 50, 51, 199, 200, 201]) {
      const path = join(cwd, String(total));
      await mkdir(path);
      const perFile = total < 100 ? total : 40;
      for (let remaining = total, file = 0; remaining > 0; file++) {
        const count = Math.min(perFile, remaining);
        await writeFile(join(path, `${file}.txt`), 'token token\n'.repeat(count));
        remaining -= count;
      }
      const result = await executor.grepFiles({ ...defaults, cwd, path });
      const returned = total < 100 ? Math.min(total, 50) : Math.min(total, 200);
      assert.equal(result.matchedLines, total);
      assert.equal(result.returnedLines, returned);
      assert.equal(result.matches.length, returned);
      assert.equal(result.omittedLines, total - returned);
      assert.equal(result.truncated, returned < total);
      assert.deepEqual(FilesystemWorkerResultSchema.parse({ kind: 'grep', ...result }), {
        kind: 'grep',
        ...result,
      });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('bounds retained JSON while finishing searches larger than the former stdout buffers', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'grep-'));
  try {
    const path = join(cwd, 'large.txt');
    await writeFile(path, `token ${'x'.repeat(10_000)}\n`.repeat(1_000));
    const result = await executor.grepFiles({ ...defaults, cwd, path });
    assert.equal(result.matchedLines, 1_000);
    assert.equal(result.returnedLines, 2);
    assert.equal(result.omittedLines, 998);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result.matches)) <= GREP_MAX_MATCH_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < GREP_MAX_MATCH_BYTES + 256);
    const abort = new AbortController();
    const interrupted = executor.grepFiles({ ...defaults, cwd, path, abortSignal: abort.signal });
    abort.abort();
    await assert.rejects(interrupted, /cancelled; search totals are unknown/);
    await assert.rejects(
      executor.grepFiles({ ...defaults, cwd, path, timeoutMs: 1 }),
      /timed out; search totals are unknown/,
    );

    await writeFile(path, `token ${'x'.repeat(2 * 1024 * 1024)}\ntoken 中文\r\n`);
    const oversized = await executor.grepFiles({ ...defaults, cwd, path });
    assert.deepEqual(oversized, {
      matches: [`${path}:2:token 中文`],
      matchedLines: 2,
      returnedLines: 1,
      omittedLines: 1,
      truncated: true,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('scans binary data to completion and counts non-UTF8 lines without lossy previews', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'grep-'));
  try {
    const path = join(cwd, 'bytes.txt');
    await writeFile(
      path,
      Buffer.concat([Buffer.from('token\0\ntoken '), Buffer.from([255]), Buffer.from('\ntoken\n')]),
    );
    const result = await executor.grepFiles({ ...defaults, cwd, path });
    assert.deepEqual(result, {
      matches: [`${path}:1:token\0`, `${path}:3:token`],
      matchedLines: 3,
      returnedLines: 2,
      omittedLines: 1,
      truncated: true,
    });
    assert.equal(
      (await executor.grepFiles({ ...defaults, cwd, path: cwd, glob: '*.ts' })).matchedLines,
      0,
    );
    await assert.rejects(
      executor.grepFiles({ ...defaults, cwd, path, pattern: '[' }),
      /totals are unknown.*Check the regex/s,
    );
    await assert.rejects(
      executor.grepFiles({ ...defaults, cwd, path: join(cwd, 'missing') }),
      /totals are unknown/,
    );
    await assert.rejects(
      executor.grepFiles({ ...defaults, cwd, path, abortSignal: AbortSignal.abort() }),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('reduces one chunked search and refuses partial, missing, or invalid summaries', async () => {
  const input = { ...defaults, cwd: '.', path: '.', executable: 'rg' };
  const records = [
    {
      type: 'match',
      data: { path: { text: 'a:中文.txt' }, lines: { text: 'token 中文\n' }, line_number: 7 },
    },
    { type: 'summary', data: { stats: { matched_lines: 1 } } },
  ].map((event) => JSON.stringify(event) + '\n');
  let calls = 0;
  const result = await searchFiles(input, async ({ onStdout, args }) => {
    calls++;
    assert.ok(!args.some((arg) => arg.startsWith('--max-count')));
    const bytes = Buffer.from(records.join(''));
    for (const byte of bytes) onStdout(Buffer.from([byte]));
    return { exitCode: 0, stderrTail: '' };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.matches, ['a:中文.txt:7:token 中文']);
  assert.equal(result.matchedLines, 1);
  for (const [output, exitCode] of [
    [records[0], 0],
    ['', 1],
    [records.join(''), 2],
    [records.join('').slice(0, -1), 0],
  ] as const) {
    await assert.rejects(
      searchFiles(input, async ({ onStdout }) => {
        onStdout(Buffer.from(output));
        return { exitCode, stderrTail: 'read failed' };
      }),
      /totals are unknown/,
    );
  }
});
