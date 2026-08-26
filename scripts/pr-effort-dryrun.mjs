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

// Reports the tier pr-effort.mjs would assign to every open pull request,
// writing nothing. Run it after changing a tier boundary or an exclusion so the
// rule is reviewed against real pull requests rather than only fixtures.
//
//   node scripts/pr-effort-dryrun.mjs [--repo apache/maka] [--limit 300]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { classifyEffort } from './pr-effort.mjs';

const run = promisify(execFile);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const repo = arg('repo', 'apache/maka');
const limit = arg('limit', '300');

const { stdout } = await run(
  'gh',
  ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', limit, '--json', 'number,files'],
  { maxBuffer: 256 * 1024 * 1024 },
);

const rows = JSON.parse(stdout).map((pull) => {
  const files = (pull.files ?? []).map((file) => ({
    filename: file.path,
    additions: file.additions,
    deletions: file.deletions,
  }));
  const { label, lines } = classifyEffort(files);
  return {
    number: pull.number,
    label,
    readable: lines,
    raw: files.reduce((sum, file) => sum + file.additions + file.deletions, 0),
  };
});

const counts = new Map();
for (const row of rows) counts.set(row.label, (counts.get(row.label) ?? 0) + 1);

console.log(`${repo}: ${rows.length} open pull requests\n`);
for (const label of ['effort/XS', 'effort/S', 'effort/M', 'effort/L', 'effort/XL']) {
  console.log(`  ${label.padEnd(12)} ${String(counts.get(label) ?? 0).padStart(4)}`);
}

const discounted = rows
  .filter((row) => row.raw !== row.readable)
  .sort((a, b) => b.raw - b.readable - (a.raw - a.readable))
  .slice(0, 10);

if (discounted.length > 0) {
  console.log('\nlargest gaps between raw and readable lines');
  for (const row of discounted) {
    console.log(
      `  #${String(row.number).padEnd(6)} raw ${String(row.raw).padStart(7)} -> ${String(row.readable).padStart(7)}  ${row.label}`,
    );
  }
}
