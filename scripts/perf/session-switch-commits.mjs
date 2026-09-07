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

/**
 * How many React commits one session switch costs, and how much of each is a
 * full-tree render (#4109).
 *
 * Usage, against a running dev app with `--remote-debugging-port=9334`:
 *
 *   node scripts/perf/session-switch-commits.mjs <label> [port]
 *
 * Reloads the page to install `react-commit-probe.js` before React boots, then
 * switches sessions several times and reports the median. Read the medians, not
 * a single row: the first switch after a reload pays for caches the rest do
 * not, which is why row 1 is a warm-up and is excluded.
 *
 * NEVER compare two numbers from two app launches. Restarting the app moves
 * these metrics by an order of magnitude while the spread inside one instance
 * is small; an A/B has to alternate configurations inside one running instance
 * and compare paired trials.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickSessionRow, connectRenderer, median, sleep, DEFAULT_PORT } from './cdp-client.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const label = process.argv[2] ?? 'run';
const port = Number(process.argv[3] ?? DEFAULT_PORT);

/** A full-tree render: React re-rendered essentially everything under the root. */
const FULL_TREE_FIBERS = 1000;
const SETTLE_MS = 2500;
const BOOT_MS = 9000;
const ROWS = [2, 3, 4, 5, 6, 7, 8, 9];

const client = await connectRenderer(port);
await client.ready;
await client.send('Page.enable');
await client.send('Page.addScriptToEvaluateOnNewDocument', {
  source: readFileSync(join(here, 'react-commit-probe.js'), 'utf8'),
});
await client.send('Page.reload');
await sleep(BOOT_MS);

await clickSessionRow(client, 1);
await sleep(3000);

const results = [];
for (const row of ROWS) {
  await client.evaluate(
    '__MAKA_PROBE__.commits.length = 0; __MAKA_PROBE__.dispatches.length = 0; __MAKA_PROBE__.arm = true',
  );
  await clickSessionRow(client, row);
  await sleep(SETTLE_MS);
  await client.evaluate('__MAKA_PROBE__.arm = false');
  const { commits } = JSON.parse(
    await client.evaluate('JSON.stringify({ commits: __MAKA_PROBE__.commits })'),
  );
  const fullTree = commits.filter((commit) => commit.total > FULL_TREE_FIBERS);
  const renderRoots = {};
  for (const commit of fullTree) {
    const name = commit.rr[0]?.name ?? '?';
    renderRoots[name] = (renderRoots[name] ?? 0) + 1;
  }
  const rendered = commits.reduce((sum, commit) => sum + commit.total, 0);
  results.push({ row, commits: commits.length, fullTree: fullTree.length, renderRoots, rendered });
  console.log(
    `row ${row}: commits=${commits.length} fullTree=${fullTree.length} renderedFibers=${rendered} roots=${JSON.stringify(renderRoots)}`,
  );
}

console.log(
  `\n[${label}] median commits=${median(results.map((r) => r.commits))} ` +
    `fullTree=${median(results.map((r) => r.fullTree))} ` +
    `renderedFibers=${median(results.map((r) => r.rendered))}`,
);
writeFileSync(`session-switch-commits-${label}.json`, `${JSON.stringify(results, null, 1)}\n`);
client.close();
