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
import { DiagnosticLogBuffer, truncateUtf8 } from '../diagnostic-log.js';
import { redactSecrets } from '../redaction.js';

const logMarker = '\n<log entry truncated>';
const when = new Date('2026-09-10T00:00:00Z');

// Preserve the original whole-input algorithm as an independent semantic oracle.
function previousTruncate(
  value: string,
  maximumBytes: number,
  marker = '',
  measure = (text: string) => new TextEncoder().encode(text).byteLength,
): string {
  if (measure(value) <= maximumBytes) return value;
  const suffix = measure(marker) <= maximumBytes ? marker : '';
  const codePoints = [...value];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${codePoints.slice(0, middle).join('')}${suffix}`;
    if (measure(candidate) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return `${codePoints.slice(0, low).join('')}${suffix}`;
}

function corpus(): string[] {
  const texts = [
    '',
    'abc',
    '文',
    '🦊',
    '\uD800x',
    '\uDBFFx',
    '\uDC00',
    '\uDFFF',
    '\uD800\uDC00',
    '\uDBFF\uDFFF',
    'a\uD800x',
    'z'.repeat(100),
    'api_key=sk-secret123456789\nrest',
    '{"secret":"abc", "detail":"tail"}',
  ];
  const tokens = [
    'a',
    '文',
    '🦊',
    '\uD800',
    '\uDBFF',
    '\uDC00',
    '\uDFFF',
    '\n',
    '\u007F',
    '\u0080',
    '\u07FF',
    '\u0800',
    '\uFFFF',
    '\u0301',
    '"',
    '\\',
  ];
  let seed = 0x5153;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let index = 0; index < 200; index++) {
    let text = '';
    const count = (next() >>> 16) % 100;
    for (let point = 0; point < count; point++) text += tokens[(next() >>> 16) % tokens.length];
    texts.push(text);
  }
  return texts;
}

test('bounded UTF-8 truncation preserves Unicode, marker fusion, and budget validation', () => {
  const markers = ['', '…', logMarker, '\uDC00', '\uDFFFabc', '\uD800', '🦊', 'x'.repeat(100)];
  for (const value of corpus()) {
    for (const maximumBytes of [1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 32, 80, 256]) {
      for (const marker of markers) {
        assert.equal(
          truncateUtf8(value, maximumBytes, marker),
          previousTruncate(value, maximumBytes, marker),
          JSON.stringify({ value, maximumBytes, marker }),
        );
      }
    }
  }
  // Joining a lone high surrogate to a low-surrogate marker changes its encoding.
  assert.equal(truncateUtf8('\uD800zz', 4, '\uDC00'), '\uD800\uDC00');
  for (const maximumBytes of [-Infinity, -1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => truncateUtf8('', maximumBytes), {
      name: 'RangeError',
      message: 'maximumBytes must be at least 1',
    });
  }
  assert.equal(truncateUtf8('🦊', Number.MAX_SAFE_INTEGER), '🦊');
});

test('public log buffering preserves redaction, prefixes, byte limits, and tail eviction', () => {
  const measure = (text: string) => Buffer.byteLength(JSON.stringify(text));
  for (const maxBytes of [4, 32, 64, 1024]) {
    for (const maxEntryCodePoints of [1, 2, 8, 100]) {
      for (const maxEntryUtf8Bytes of [undefined, 1, 4, 16, 100]) {
        const options = { maxBytes, maxEntries: 2, maxEntryCodePoints, maxEntryUtf8Bytes };
        const buffer = new DiagnosticLogBuffer(options);
        const expected: string[] = [];
        for (const message of corpus().slice(0, 40)) {
          const redacted = redactSecrets(message);
          const points = [...redacted];
          const safe =
            points.length <= maxEntryCodePoints
              ? redacted
              : `${points.slice(0, maxEntryCodePoints).join('')}${logMarker}`;
          const prefixed = `[${when.toISOString()}] ERROR ${safe}`;
          const entry =
            maxEntryUtf8Bytes === undefined
              ? prefixed
              : previousTruncate(prefixed, maxEntryUtf8Bytes, logMarker);
          expected.push(previousTruncate(entry, maxBytes - 2, logMarker, measure));
          while (
            (Buffer.byteLength(JSON.stringify(expected)) > maxBytes || expected.length > 2) &&
            expected.length > 1
          )
            expected.shift();
          buffer.append('error', message, when);
          assert.deepEqual(buffer.snapshot(), expected, JSON.stringify({ options, message }));
        }
      }
    }
  }
  const buffer = new DiagnosticLogBuffer({ maxEntryCodePoints: 4 });
  buffer.append('warn', 'sk-secret123456789 rest', when);
  assert.deepEqual(buffer.snapshot(), [`[${when.toISOString()}] WARN [red${logMarker}`]);
  for (const key of ['maxBytes', 'maxEntries', 'maxEntryCodePoints', 'maxEntryUtf8Bytes']) {
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new DiagnosticLogBuffer({ [key]: value }), RangeError);
    }
  }
});

for (const mode of ['append', 'utf8'] as const) {
  test(`${mode} allocates only a bounded prefix of a large diagnostic string`, () => {
    const moduleUrl = new URL('../diagnostic-log.js', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        '--input-type=module',
        '--eval',
        `await (${allocationProbe.toString()})(${JSON.stringify(moduleUrl)}, ${JSON.stringify(mode)})`,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const { allocatedBytes, output } = JSON.parse(result.stdout) as {
      allocatedBytes: number;
      output: string;
    };
    assert.equal(
      output,
      mode === 'append'
        ? `[${when.toISOString()}] ERROR ${'z'.repeat(8192)}${logMarker}`
        : `${'z'.repeat(8192 - logMarker.length)}${logMarker}`,
    );
    // A full 8 MiB code-point array exceeds this bound even with compressed
    // pointers. Allow ample room for redaction, binary search, and profiling.
    assert.ok(allocatedBytes < 24 * 1024 * 1024, `sampled ${allocatedBytes} transient bytes`);
  });
}

async function allocationProbe(moduleUrl: string, mode: 'append' | 'utf8') {
  const { Session } = await import('node:inspector/promises');
  const { formatWithOptions } = await import('node:util');
  const { DiagnosticLogBuffer, truncateUtf8 }: typeof import('../diagnostic-log.js') = await import(
    moduleUrl
  );
  const session = new Session();
  session.connect();
  try {
    // Flatten and allocate fixtures before sampling, including the console input.
    const text = Buffer.alloc(8 * 1024 * 1024, 'z').toString('utf8');
    const buffer = new DiagnosticLogBuffer();
    const when = new Date('2026-09-10T00:00:00Z');
    const run = (value: string) => {
      if (mode === 'utf8') return truncateUtf8(value, 8192, '\n<log entry truncated>');
      buffer.append('error', formatWithOptions({ maxStringLength: 8192 }, value), when);
      return buffer.snapshot().at(-1);
    };
    run('warm up');
    global.gc?.();
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 16 * 1024,
      includeObjectsCollectedByMinorGC: true,
      includeObjectsCollectedByMajorGC: true,
    });
    const output = run(text);
    // Count transient objects even if they have already been collected.
    global.gc?.();
    const { profile } = await session.post('HeapProfiler.stopSampling');
    const total = (node: import('node:inspector').HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
    process.stdout.write(JSON.stringify({ allocatedBytes: total(profile.head), output }));
  } finally {
    session.disconnect();
  }
}
