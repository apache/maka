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

import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

export function summarize(samples) {
  if (!samples.length || samples.some((n) => !Number.isFinite(n)))
    throw new Error('Invalid samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2,
    p95: sorted[Math.ceil(n * 0.95) - 1],
    samples,
  };
}
export const outputDir = path.resolve(process.env.MAKA_PERF_OUTPUT ?? 'perf-results');
export async function report(name, metadata, rows) {
  if (!rows.length) throw new Error('Empty performance report');
  await mkdir(outputDir, { recursive: true });
  const result = {
    schemaVersion: 1,
    name,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    environment: {
      node: process.version,
      os: os.version(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      memoryBytes: os.totalmem(),
      runner: process.env.RUNNER_NAME,
      image: process.env.ImageVersion,
    },
    metadata,
    rows,
  };
  await writeFile(path.join(outputDir, name + '.json'), JSON.stringify(result, null, 2));
  const summary = [
    '## ' + name,
    '',
    'Commit: ' + result.commit,
    '',
    '| Scenario / metric | n | median | p95 |',
    '| --- | ---: | ---: | ---: |',
    ...rows.map(
      (r) =>
        '| ' +
        r.scenario +
        ' / ' +
        r.metric +
        ' | ' +
        r.n +
        ' | ' +
        r.median.toFixed(3) +
        ' | ' +
        r.p95.toFixed(3) +
        ' |',
    ),
    '',
    'Raw samples and environment: ' +
      name +
      '.json. Nearest-rank p95; median averages the two middle samples.',
    '',
    JSON.stringify(metadata),
    '',
  ].join('\n');
  await writeFile(path.join(outputDir, name + '.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
