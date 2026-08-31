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
 * Renderer busy JS per session switch, with the top self-time entries (#4109).
 *
 * Usage, against a running dev app with `--remote-debugging-port=9334`:
 *
 *   node scripts/perf/session-switch-busy-js.mjs [port] [trials]
 *
 * This reports one configuration: whatever the running build does. A before/
 * after needs both configurations reachable from ONE running instance — see the
 * README for how to get that from a throwaway worktree instead of from a switch
 * carried in product code.
 *
 * Sampling at 100µs. Busy time is every sample that is not `(idle)` or
 * `(program)`; the top-8 self-time list is there to show WHERE the time is, and
 * on this workload it is deliberately flat — about a thousand cheap fibers, no
 * hot component. A change that only moves the top entry around has not moved
 * the total.
 *
 * The same discipline as the commit counter: alternate configurations inside
 * ONE running instance and compare paired trials. Numbers from two launches are
 * not comparable.
 */

import { clickSessionRow, connectRenderer, median, sleep, DEFAULT_PORT } from './cdp-client.mjs';

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const port = Number(positional[0] ?? DEFAULT_PORT);
const trials = Number(positional[1] ?? 5);
const SETTLE_MS = 2000;

const client = await connectRenderer(port);
await client.ready;
await client.send('Profiler.enable');

// The commit probe walks the fiber tree on every commit. Left armed it lands in
// the profile as the app's own work.
await client.evaluate('globalThis.__MAKA_PROBE__ && (__MAKA_PROBE__.arm = false)').catch(() => {});

async function measureSwitch(row) {
  await client.send('Profiler.setSamplingInterval', { interval: 100 });
  await client.send('Profiler.start');
  await clickSessionRow(client, row);
  await sleep(SETTLE_MS);
  const { profile } = await client.send('Profiler.stop');

  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfTime = new Map();
  const deltas = profile.timeDeltas ?? [];
  let busy = 0;
  let idle = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    const dt = (deltas[i] ?? 0) / 1000;
    const name = node?.callFrame?.functionName || '(anonymous)';
    if (name === '(idle)' || name === '(program)') {
      idle += dt;
      continue;
    }
    busy += dt;
    const file = (node?.callFrame?.url || '').split('/').pop() || '';
    const key = `${name} @${file}:${node?.callFrame?.lineNumber}`;
    selfTime.set(key, (selfTime.get(key) ?? 0) + dt);
  }
  return { busy, idle, selfTime };
}

function printTop(selfTime) {
  for (const [key, value] of [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`    ${value.toFixed(0)}ms  ${key.slice(0, 110)}`);
  }
}

const busyPerSwitch = [];
for (let trial = 0; trial < trials; trial++) {
  const row = 2 + trial;
  const { busy, idle, selfTime } = await measureSwitch(row);
  busyPerSwitch.push(busy);
  console.log(`row ${row}: busyJS=${busy.toFixed(0)}ms idle=${idle.toFixed(0)}ms`);
  printTop(selfTime);
}
console.log(`\nmedian busy JS per switch = ${median(busyPerSwitch).toFixed(0)}ms`);

client.close();
