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

// Node >=22.19; no build or generated fixtures needed.
// node --expose-gc packages/core/scripts/benchmark-unified-diff.mjs [baseline-ref]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { cpus, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

assert.equal(typeof global.gc, 'function', 'Run with node --expose-gc');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sourcePath = 'packages/core/src/unified-diff.ts';
const baselineRef = process.argv[2] ?? 'd2e1be5db93101ffcc0fb6a107a0d51764ace28b';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
const baselineCommit = git('rev-parse', '--verify', `${baselineRef}^{commit}`);
const baselineSource = git('show', `${baselineCommit}:${sourcePath}`);
const candidateSource = readFileSync(new URL('../src/unified-diff.ts', import.meta.url), 'utf8');
const load = (source) =>
  import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
  );
const baseline = await load(baselineSource);
const candidate = await load(candidateSource);
const implementations = { baseline, candidate };
const samples = 21;
const warmupBatches = 8;
const memorySamples = 9;
let checksum = 0;

const removed = '-old content 0123456789abcdefghijklmnopqrstuvwxyz\n';
const added = '+new content 0123456789abcdefghijklmnopqrstuvwxyz\n';
const context = ' unchanged content 0123456789abcdefghijklmnopqrst\n';

function replacement(bodyLines, linePair = [removed, added]) {
  const count = bodyLines / 2;
  return {
    name: `replacement-${bodyLines}`,
    bodyLines,
    diff:
      `--- a/file\n+++ b/file\n@@ -1,${count} +1,${count} @@\n` +
      linePair[0].repeat(count) +
      linePair[1].repeat(count),
    expected: { additions: count, deletions: count },
  };
}

function manyHunks() {
  const parts = [];
  for (let file = 0; file < 100; file += 1) {
    parts.push(
      `diff --git a/file${file} b/file${file}\nindex 111..222\n--- a/file${file}\n+++ b/file${file}\n`,
    );
    for (let hunk = 0; hunk < 10; hunk += 1) {
      const start = 1 + hunk * 100;
      parts.push(`@@ -${start},50 +${start},50 @@\n`, removed.repeat(50), added.repeat(50));
    }
  }
  return {
    name: '100-files-1000-hunks',
    bodyLines: 100000,
    diff: parts.join(''),
    expected: { additions: 50000, deletions: 50000 },
  };
}

const fixtures = [
  replacement(400),
  replacement(10000),
  replacement(100000),
  replacement(500000),
  {
    name: 'context-heavy-100000',
    bodyLines: 100000,
    diff: '@@ -1,99000 +1,99000 @@\n' + (context.repeat(98) + removed + added).repeat(1000),
    expected: { additions: 1000, deletions: 1000 },
  },
  manyHunks(),
  {
    ...replacement(200, [`-${'a'.repeat(32768)}\n`, `+${'b'.repeat(32768)}\n`]),
    name: 'long-lines-200',
  },
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function consume(result) {
  checksum += Array.isArray(result) ? result.length : result.additions + result.deletions;
}

function timeBatch(fn, diff, iterations) {
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) consume(fn(diff));
  return (performance.now() - start) / iterations;
}

function heapDelta(fn, diff) {
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const result = fn(diff);
  const delta = process.memoryUsage().heapUsed - before;
  consume(result);
  return delta;
}

// An untimed allocation-shape probe catches the original regression without
// relying on noisy timing thresholds. Restore both hooks even on failure.
function countAllocations(fn, diff) {
  const originalPush = Array.prototype.push;
  const originalSplit = String.prototype.split;
  let displayRows = 0;
  let fullLineSplits = 0;
  let result;
  try {
    Array.prototype.push = function (...items) {
      for (const item of items) {
        if (item && typeof item === 'object' && 'kind' in item && 'text' in item) displayRows += 1;
      }
      return originalPush.apply(this, items);
    };
    String.prototype.split = function (...args) {
      if (this === diff && args[0] === '\n') fullLineSplits += 1;
      return originalSplit.apply(this, args);
    };
    result = fn(diff);
  } finally {
    Array.prototype.push = originalPush;
    String.prototype.split = originalSplit;
  }
  return { displayRows, fullLineSplits, result };
}

const results = [];
for (const fixture of fixtures) {
  const { name, bodyLines, diff, expected } = fixture;
  // Flatten generated ropes and verify before measuring; exclude fixture setup.
  const inputBytes = Buffer.byteLength(diff);
  for (const implementation of Object.values(implementations)) {
    assert.deepEqual(implementation.countDiffLineStats(diff), expected, name);
  }
  assert.deepEqual(candidate.parseUnifiedDiffRows(diff), baseline.parseUnifiedDiffRows(diff), name);

  const measurements = {};
  // Bound each batch by both body lines and bytes, including the long-line case.
  const iterations = Math.max(
    1,
    Math.min(250, Math.floor(100000 / bodyLines), Math.floor((8 * 1024 * 1024) / inputBytes)),
  );
  for (const operation of ['countDiffLineStats', 'parseUnifiedDiffRows']) {
    for (let warmup = 0; warmup < warmupBatches; warmup += 1) {
      for (const implementation of Object.values(implementations)) {
        timeBatch(implementation[operation], diff, iterations);
      }
    }
    const elapsed = { baseline: [], candidate: [] };
    const heap = { baseline: [], candidate: [] };
    for (let sample = 0; sample < samples; sample += 1) {
      const order = sample % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const version of order) {
        global.gc();
        elapsed[version].push(timeBatch(implementations[version][operation], diff, iterations));
      }
    }
    for (let sample = 0; sample < memorySamples; sample += 1) {
      const order = sample % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const version of order) {
        heap[version].push(heapDelta(implementations[version][operation], diff));
      }
    }
    measurements[operation] = {
      iterationsPerSample: iterations,
      baselineMedianMs: median(elapsed.baseline),
      candidateMedianMs: median(elapsed.candidate),
      speedup: median(elapsed.baseline) / median(elapsed.candidate),
      baselineHeapDeltaBytes: median(heap.baseline),
      candidateHeapDeltaBytes: median(heap.candidate),
      baselineSamplesMs: elapsed.baseline,
      candidateSamplesMs: elapsed.candidate,
    };
  }
  const allocations = Object.fromEntries(
    Object.entries(implementations).map(([version, implementation]) => [
      version,
      countAllocations(implementation.countDiffLineStats, diff),
    ]),
  );
  assert.deepEqual(allocations.candidate.result, expected);
  assert.equal(allocations.candidate.displayRows, 0, `${name}: counting created display rows`);
  assert.equal(allocations.candidate.fullLineSplits, 0, `${name}: counting split the full diff`);
  results.push({ name, bodyLines, inputBytes, expected, measurements, allocations });
}

console.log(
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
        cpu: cpus()[0]?.model,
      },
      baselineCommit,
      candidateSourceSha256: createHash('sha256').update(candidateSource).digest('hex'),
      method: {
        samples,
        warmupBatches,
        memorySamples,
        order: 'alternating baseline/candidate; forced GC before each timed batch and heap sample',
        heapMetric:
          'heapUsed after one call minus heapUsed before it, after forced GC; not total allocations or exact peak',
        scope: 'synthetic in-memory inputs; excludes Git, I/O, rendering and fixture construction',
      },
      results,
      checksum,
    },
    null,
    2,
  ),
);
