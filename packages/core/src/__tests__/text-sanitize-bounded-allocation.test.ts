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
import { type SanitizeUnicodeOptions, sanitizeUnicodeText } from '../text-sanitize.js';

// The previous implementation is an oracle for numeric slice semantics as
// well as the order of normalization, replacement, collapse, and truncation.
function previousSanitize(text: string, opts: SanitizeUnicodeOptions): string {
  const cleaned = text
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F]/g, ' ')
    .replace(/[\u200B-\u200D\u2060-\u2064\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(cleaned);
  if (points.length <= opts.maxCodePoints) return cleaned;
  return points.slice(0, opts.maxCodePoints).join('') + (opts.truncatedSuffix ?? '…');
}

test('bounded code-point truncation preserves Unicode cleaning and numeric budgets', () => {
  const budgets = [
    Number.NEGATIVE_INFINITY,
    -100,
    -3.75,
    -1,
    -0.5,
    -0,
    0,
    0.5,
    1,
    1.5,
    2,
    3,
    120,
    Number.MAX_SAFE_INTEGER,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ];
  const texts = ['', 'abc', '🦊🦊🦊', ' e\u0301\n🦊\u200D文\u202E字\uFEFF ', '\u0000\u200B'];
  const tokens = [
    'a',
    '文',
    '🦊',
    'e\u0301',
    '\u0301',
    '\uD800',
    '\uDC00',
    '\n',
    '\t',
    '\u0080',
    '\u061C',
    '\u202E',
    '\u206F',
    '\u200D',
    '\u2064',
    '\uFEFF',
    '\u00A0',
    ' ',
  ];
  let seed = 0x5eed;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let index = 0; index < 200; index++) {
    let text = '';
    const length = next() % 160;
    for (let point = 0; point < length; point++) text += tokens[next() % tokens.length];
    texts.push(text);
  }
  for (const text of texts) {
    for (const maxCodePoints of budgets) {
      for (const truncatedSuffix of [undefined, '', ' [cut]']) {
        const opts = { maxCodePoints, truncatedSuffix };
        assert.equal(
          sanitizeUnicodeText(text, opts),
          previousSanitize(text, opts),
          JSON.stringify({ text, budget: String(maxCodePoints), truncatedSuffix }),
        );
      }
    }
  }
  assert.equal(sanitizeUnicodeText(' e\u0301\n🦊tail ', { maxCodePoints: 3 }), 'é 🦊…');
  assert.equal(sanitizeUnicodeText('🦊🦊', { maxCodePoints: 2 }), '🦊🦊');
});

test('a short title does not allocate a code-point array for the entire large input', () => {
  const moduleUrl = new URL('../text-sanitize.js', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '--eval',
      `await (${allocationProbe.toString()})(${JSON.stringify(moduleUrl)})`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { allocatedBytes, title } = JSON.parse(result.stdout) as {
    allocatedBytes: number;
    title: string;
  };
  assert.equal(title, `${'a'.repeat(120)}…`);
  // Allow 24 MiB for normalization and profiling overhead. Expanding 8 MiB
  // into an array of references alone takes at least 32 MiB on 64-bit V8.
  assert.ok(allocatedBytes < 24 * 1024 * 1024, `sampled ${allocatedBytes} transient bytes`);
});

async function allocationProbe(moduleUrl: string) {
  const { Session } = await import('node:inspector/promises');
  const { sanitizeUnicodeText }: typeof import('../text-sanitize.js') = await import(moduleUrl);
  const session = new Session();
  session.connect();
  try {
    // Construct a flat string before sampling so fixture allocation is excluded.
    const text = Buffer.alloc(8 * 1024 * 1024, 'a').toString('utf8');
    sanitizeUnicodeText('warm up', { maxCodePoints: 120 });
    global.gc?.();
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 16 * 1024,
      includeObjectsCollectedByMinorGC: true,
      includeObjectsCollectedByMajorGC: true,
    });
    const title = sanitizeUnicodeText(text, { maxCodePoints: 120 });
    // The regression is transient allocation, including objects already freed.
    global.gc?.();
    const { profile } = await session.post('HeapProfiler.stopSampling');
    const total = (node: import('node:inspector').HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
    process.stdout.write(JSON.stringify({ allocatedBytes: total(profile.head), title }));
  } finally {
    session.disconnect();
  }
}
