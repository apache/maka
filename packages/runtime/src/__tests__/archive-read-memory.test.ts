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
import { buildArchiveReadTool } from '../archive-read-tool.js';
import {
  readToolResultArchiveResource,
  type ToolResultArchiveResourceRequest,
} from '../tool-result-archive-resource.js';

const context = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  cwd: '/tmp',
  toolCallId: 'call-1',
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
};
const ref = `maka://archive/test/${'a'.repeat(64)}/1000`;

test('ArchiveRead final result preserves pages, UTF-16 and failure semantics', async () => {
  const text = `a😀\ud800!\udfff\nneedle\\\"${'x'.repeat(700)}`;
  const requests: ToolResultArchiveResourceRequest[] = [
    { ref, operation: 'inspect' },
    { ref, operation: 'read', offset: 2, limit: 4 },
    { ref, operation: 'read', unit: 'line', limit: 1 },
    { ref, operation: 'search', pattern: 'needle' },
    { ref, operation: 'query', itemId: 'one', offset: 2, limit: 4 },
    { ref: 'invalid', operation: 'read' },
  ];
  for (const payload of [text, { kind: 'agent_swarm', items: [{ itemId: 'one', result: text }] }]) {
    const reader = {
      readArchivedToolResultResource: () => ({
        ok: true as const,
        serializedResult: JSON.stringify(payload),
      }),
    };
    const tool = buildArchiveReadTool(reader);
    for (const request of requests) {
      const result = await tool.impl(request, context);
      assert.deepEqual(
        result,
        await readToolResultArchiveResource(reader, context.sessionId, request),
      );
      if (
        typeof payload === 'string' &&
        request.ref === ref &&
        request.operation === 'read' &&
        !request.unit
      ) {
        assert.equal((result as { content: string }).content, text.slice(2, 6));
      }
    }
    await assert.rejects(
      async () => tool.impl({ ref }, { ...context, abortSignal: AbortSignal.abort() }),
      /ArchiveRead aborted/,
    );
  }
  const failure = new Error('reader failed');
  await assert.rejects(
    async () =>
      buildArchiveReadTool({ readArchivedToolResultResource: () => Promise.reject(failure) }).impl(
        { ref },
        context,
      ),
    (error) => error === failure,
  );
  assert.deepEqual(
    await buildArchiveReadTool({
      readArchivedToolResultResource: () => ({ ok: false, reason: 'not_found' }),
    }).impl({ ref }, context),
    { ok: false, kind: 'tool_result_archive', ref, reason: 'not_found' },
  );
});

const CHILD_SOURCE = String.raw`
  import assert from 'node:assert/strict';
  import { setImmediate as tick } from 'node:timers/promises';
  const { buildArchiveReadTool } = await import(process.argv[1]);
  const size = 2 * 1024 * 1024;
  const ref = 'maka://archive/test/' + 'a'.repeat(64) + '/' + (size + 4096);
  const ctx = { sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1',
    cwd: '/tmp', abortSignal: new AbortController().signal, emitOutput() {} };
  const requests = [
    { ref, operation: 'read', offset: 1, limit: 1000 },
    { ref, operation: 'read', unit: 'line', limit: 1 },
    { ref, operation: 'search', pattern: 'needle' },
    { ref, operation: 'query', itemId: 'one', limit: 1000 },
  ];
  async function read(index) {
    const request = requests[index % requests.length];
    const tool = buildArchiveReadTool({ readArchivedToolResultResource() {
      const text = 'needle-' + index + '-' + 'a'.repeat(1000) + '\n' + 'x'.repeat(size);
      const value = request.operation === 'query'
        ? { items: [{ itemId: 'one', result: text }] } : text;
      const serializedResult = JSON.stringify(value);
      assert(Buffer.byteLength(serializedResult) < size + 4096);
      return { ok: true, serializedResult };
    } });
    return tool.impl(request, ctx);
  }
  async function heap() {
    for (let i = 0; i < 8; i++) { await tick(); global.gc(); }
    return process.memoryUsage().heapUsed;
  }
  for (let i = 0; i < 8; i++) await read(i);
  const baseline = await heap();
  const positive = [];
  for (let i = 0; i < 8; i++) {
    positive.push(JSON.parse(JSON.stringify(i + '-' + 'x'.repeat(size))).slice(1, 1001));
  }
  const positiveBytes = (await heap()) - baseline;
  assert(positiveBytes > 12 * 1024 * 1024, 'slice control did not retain its parents');
  positive.length = 0;
  const releasedBytes = (await heap()) - baseline;
  assert(releasedBytes < 6 * 1024 * 1024, 'slice control did not release');
  const results = [];
  for (let i = 0; i < 24; i++) results.push(await read(i));
  const retainedBytes = (await heap()) - baseline;
  for (const result of results) {
    assert.equal(result.ok, true);
    assert(JSON.stringify(result).length <= 7500);
  }
  assert(retainedBytes < 8 * 1024 * 1024,
    'bounded ArchiveRead results retained ' + retainedBytes + ' heap bytes');
  results.length = 0;
  const finalBytes = (await heap()) - baseline;
  assert(finalBytes < 6 * 1024 * 1024, 'ArchiveRead results did not release');
  console.log(JSON.stringify({ positiveBytes, releasedBytes, retainedBytes, finalBytes }));
`;

test('bounded ArchiveRead tool results release the full archive backing', (context) => {
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '--eval',
      CHILD_SOURCE,
      new URL('../archive-read-tool.js', import.meta.url).href,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  context.diagnostic(result.stdout.trim());
});
