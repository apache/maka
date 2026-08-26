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

// Reports what pr-triage.mjs would label on every open pull request, without
// writing anything. Run it before enabling the workflow and after changing a
// rule, so the classification is reviewed against real pull requests rather
// than only against fixtures.
//
//   node scripts/pr-triage-dryrun.mjs [--repo apache/maka] [--limit 300]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { classifyEffort, classifyStatus } from './pr-triage.mjs';

const run = promisify(execFile);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const repo = arg('repo', 'apache/maka');
const limit = arg('limit', '300');

// A full sweep makes one request per reviewed pull request, so a single
// transient socket error should not discard the whole run.
async function gh(args, attempt = 1) {
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 256 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    return gh(args, attempt + 1);
  }
}

const pulls = await gh([
  'pr',
  'list',
  '--repo',
  repo,
  '--state',
  'open',
  '--limit',
  limit,
  '--json',
  'number,isDraft,author,reviewDecision,headRefOid,statusCheckRollup,files,labels',
]);

// Only pull requests carrying a review at all need the per-review detail that
// decides merge-ready and needs-author, so the extra request stays off the
// common path.
const reviewsByNumber = new Map();
for (const pull of pulls) {
  if (pull.reviewDecision === null) continue;
  reviewsByNumber.set(
    pull.number,
    await gh(['api', `repos/${repo}/pulls/${pull.number}/reviews`, '--paginate']),
  );
}

const rows = pulls.map((pull) => {
  const input = {
    isDraft: pull.isDraft,
    headSha: pull.headRefOid,
    authorLogin: pull.author?.login,
    checks: pull.statusCheckRollup ?? [],
    reviews: reviewsByNumber.get(pull.number) ?? [],
    files: (pull.files ?? []).map((file) => ({
      filename: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
  };

  const effort = classifyEffort(input.files);
  return {
    number: pull.number,
    status: classifyStatus(input) ?? '(none)',
    effort: pull.isDraft ? '(none)' : effort.label,
    readable: effort.lines,
    raw: (pull.files ?? []).reduce((sum, file) => sum + file.additions + file.deletions, 0),
  };
});

function tally(rows, key) {
  const counts = new Map();
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

console.log(`${repo}: ${rows.length} open pull requests\n`);

console.log('status');
for (const [label, count] of tally(rows, 'status')) {
  console.log(`  ${label.padEnd(22)} ${String(count).padStart(4)}`);
}

console.log('\neffort');
for (const [label, count] of tally(rows, 'effort')) {
  console.log(`  ${label.padEnd(22)} ${String(count).padStart(4)}`);
}

const discounted = rows
  .filter((row) => row.raw !== row.readable)
  .sort((a, b) => b.raw - a.raw)
  .slice(0, 10);

if (discounted.length > 0) {
  console.log('\nlargest gaps between raw and readable lines');
  for (const row of discounted) {
    console.log(
      `  #${String(row.number).padEnd(6)} raw ${String(row.raw).padStart(7)} -> ${String(row.readable).padStart(7)}  ${row.effort}`,
    );
  }
}
