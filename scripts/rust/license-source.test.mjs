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
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { licenseDownloader } from './license-source.mjs';

const revision = 'a'.repeat(40);
const url = `https://raw.githubusercontent.com/owner/repo/${revision}/LICENSE`;
const text = 'Fixture license\r\nCopyright fixture\r\nAll rights reserved.\r\n';
const bytes = Buffer.from(text);
const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function sourceFixture(t, options = {}) {
  const state = { raw: [], api: [] };
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(globalThis, 'setTimeout', (resolve) => {
    queueMicrotask(resolve);
    return 0;
  });
  t.mock.method(globalThis, 'fetch', async (request) => {
    state.raw.push(request);
    if (options.raw) return new Response(text);
    throw new Error('raw reset ' + state.raw.length);
  });
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
    state.api.push(args[3]);
    if (options.apiError) throw options.apiError;
    if (args[3] === `repos/owner/repo/contents/LICENSE?ref=${revision}`)
      return JSON.stringify({
        type: 'file',
        path: 'LICENSE',
        encoding: 'base64',
        size: bytes.length,
        content: bytes.toString('base64'),
        sha,
        download_url: `https://raw.githubusercontent.com/canonical/renamed/${revision}/LICENSE`,
        ...options.entry,
      });
    assert.equal(args[3], `repos/owner/repo/git/trees/${revision}`);
    return JSON.stringify({
      sha: 'b'.repeat(40),
      truncated: false,
      tree: [{ path: 'LICENSE', type: 'blob', mode: options.mode ?? '100644', sha }],
    });
  });
  syncBuiltinESMExports();
  return { ...state, download: licenseDownloader(process.cwd()) };
}

test('a raw source returns complete text and a repeated URL reuses the same download', async (t) => {
  const source = sourceFixture(t, { raw: true });
  assert.equal(await source.download(url), text);
  assert.equal(await source.download(url), text);
  assert.deepEqual(source.raw, [url]);
  assert.deepEqual(source.api, []);
});

test('GitHub fallback binds bytes to an ordinary blob at the original pinned path', async (t) => {
  const source = sourceFixture(t);
  assert.equal(await source.download(url), text);
  assert.deepEqual(
    new Set(source.api),
    new Set([
      `repos/owner/repo/contents/LICENSE?ref=${revision}`,
      `repos/owner/repo/git/trees/${revision}`,
    ]),
  );
  assert.deepEqual(source.raw, [url]);
});

test('fallback rejects a mismatched blob digest or symlink', async (t) => {
  for (const options of [{ entry: { sha: '0'.repeat(40) } }, { mode: '120000' }]) {
    await t.test(JSON.stringify(options), async (t) => {
      const source = sourceFixture(t, options);
      await assert.rejects(source.download(url), /License source failed/);
    });
  }
});

test('unpinned sources retry the original URL without a GitHub fallback', async (t) => {
  const source = sourceFixture(t);
  const request = url.replace(revision, 'main');
  await assert.rejects(source.download(request), /License source failed/);
  assert.ok(source.raw.length > 1);
  assert.ok(source.raw.every((entry) => entry === request));
  assert.deepEqual(source.api, []);
});

test('a failed fallback preserves every transport cause and the original API error', async (t) => {
  const apiError = new Error('API denied');
  const source = sourceFixture(t, { apiError });
  await assert.rejects(source.download(url), (error) => {
    assert.equal(error.message, 'License source failed: ' + url);
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(
      error.cause.errors.map((entry) => entry.message).sort(),
      [...source.raw.map((_, index) => 'raw reset ' + (index + 1)), 'API denied'].sort(),
    );
    assert.ok(error.cause.errors.includes(apiError));
    return true;
  });
});
