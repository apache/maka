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
import { performance } from 'node:perf_hooks';
import {
  canonicalRuntimeResources,
  createRuntimeResourcePage,
  runtimeResourceRevision,
} from '../../packages/runtime-host/dist/server/runtime-resource-projection.js';
import {
  decodeRuntimeResourceQueryResult,
  decodeHostFrame,
  encodeProtocolMessage,
  RUNTIME_RESOURCE_RESULT_MAX_BYTES,
} from '../../packages/runtime-host/dist/protocol/index.js';
import { report, summarize } from './report.mjs';

const rows = [];
const stringify = JSON.stringify;
function workload(resources, countEncoding = false, duplicate = false, validate = true) {
  let calls = 0,
    encodedBytes = 0,
    wireBytes = 0;
  const seen = [];
  let canonical;
  if (countEncoding)
    JSON.stringify = function (...args) {
      const encoded = Reflect.apply(stringify, JSON, args);
      calls++;
      encodedBytes += Buffer.byteLength(encoded ?? '', 'utf8');
      return encoded;
    };
  try {
    canonical = canonicalRuntimeResources(resources);
    const revision = runtimeResourceRevision(canonical);
    let cursor = 0;
    do {
      const page = createRuntimeResourcePage('session-1', revision, canonical, cursor);
      if (duplicate) createRuntimeResourcePage('session-1', revision, canonical, cursor);
      // This is the existing final wire encoder; assertions run outside the counter.
      const bytes = encodeProtocolMessage({
        operation: 'runtime.resource.query',
        requestId: 'perf',
        ok: true,
        result: page,
      });
      wireBytes += bytes.length;
      seen.push({ page, bytes });
      const next = page.nextCursor === null ? null : Number(page.nextCursor);
      assert(
        next === null || (Number.isSafeInteger(next) && next > cursor && next < resources.length),
      );
      cursor = next;
    } while (cursor !== null);
  } finally {
    JSON.stringify = stringify;
  }
  const actual = [];
  for (const { page, bytes } of seen) {
    const decoded = decodeRuntimeResourceQueryResult(decodeHostFrame(JSON.parse(bytes)).result);
    if (validate) {
      assert(Buffer.byteLength(stringify(page), 'utf8') <= RUNTIME_RESOURCE_RESULT_MAX_BYTES);
      assert.deepEqual(decoded, page);
      actual.push(...page.resources);
    }
  }
  if (validate) {
    assert.deepEqual(
      actual.map((r) => r.result.ref),
      [...resources]
        .sort((a, b) => a.result.ref.localeCompare(b.result.ref))
        .map((r) => r.result.ref),
    );
    assert(actual.every((r) => r.result.cmd.includes('中文🙂')));
    assert.deepEqual(actual, canonical);
  }
  return { calls, encodedBytes, wireBytes, pages: seen.length };
}
for (const payload of [32, 8192]) {
  for (const size of [8, 32, 128]) {
    const resources = Array.from({ length: size }, (_, i) => ({
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'call-' + i,
      result: {
        kind: 'shell_run',
        ref: 'maka://runtime/background-tasks/shell-' + i,
        mode: 'pipes',
        status: 'running',
        cwd: '/workspace',
        cmd: '中文🙂' + 'x'.repeat(payload),
        startedAt: 1,
        updatedAt: 1,
        revision: 1,
      },
    }));
    const counts = workload(resources, true);
    const negative = workload(resources, true, true);
    assert(negative.encodedBytes > counts.encodedBytes, 'Duplicate page work must be detectable');
    const samples = [];
    for (let i = 0; i < 11; i++) {
      const start = performance.now();
      workload(resources, false, false, false);
      if (i) samples.push(performance.now() - start);
    }
    const scenario = 'runtime-resource/' + size + 'x' + payload;
    rows.push({ scenario, metric: 'warm-projection-codec-ms', ...summarize(samples) });
    for (const metric of ['calls', 'encodedBytes', 'wireBytes', 'pages'])
      rows.push({ scenario, metric, ...summarize([counts[metric]]) });
    rows.push({
      scenario,
      metric: 'negative-control-encodedBytes',
      ...summarize([negative.encodedBytes]),
    });
  }
}
await report(
  'protocol',
  {
    fixture: 'runtime-resource-v1',
    repetitions: 10,
    warmup: 1,
    conditions:
      'Synthetic in-process production projection + wire encoding/decoding; no disk/network. Fresh objects per scale, warm process. Correctness assertions run before timing; the cursor progress guard remains timed.',
    limits:
      'JSON.stringify instrumentation counts UTF-8 output work separately from timing; not allocations, SQLite I/O or whole Host latency. Includes canonicalization, revision and decoder work. Negative control duplicates production page call only in harness.',
  },
  rows,
);
