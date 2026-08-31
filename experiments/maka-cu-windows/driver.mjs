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

// Feasibility spike driver for the maka-cu-windows helper (experiment only).
// Spawns the built exe and walks: initialize -> list_windows -> observe ->
// act (set_value on the first ValuePattern element found, else click) ->
// $/cancel -> shutdown. Prints a short report and sets exit code.
//
// Usage:
//   node experiments/maka-cu-windows/driver.mjs <path-to-exe> <fixture-hwnd>
//
// This driver is fixture-only. It never scans for or mutates arbitrary user
// windows: the supplied HWND must belong to the purpose-built
// maka-cu-windows-fixture title discovered by list_windows.
//
// A candidate whose action comes back unknown/refused (e.g. a WebView2 input
// that advertises ValuePattern but ignores SetValue) is recorded as a NOTE
// and the driver moves on to the next candidate — the helper itself stays
// fail-closed (typed outcomes + snapshot spend), which this driver exercises
// on every attempt.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const exe = process.argv[2];
const hwndOverride = process.argv[3];
if (!exe || !hwndOverride) {
  console.error('usage: node driver.mjs <path-to-helper-exe> <fixture-hwnd>');
  process.exit(2);
}

const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: child.stdout });
let nextId = 1;
const pending = new Map();

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id != null && pending.has(msg.id)) {
    pending.get(msg.id).resolve(msg);
    pending.delete(msg.id);
  }
});
child.on('exit', (code, signal) => {
  for (const { reject } of pending.values())
    reject(new Error(`helper exited code=${code} signal=${signal ?? 'none'}`));
  pending.clear();
});

// Baseline host deadlines per issue: handshake 10s, request 20s.
function call(method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
  });
}

const report = [];
const t0 = Date.now();
let failures = 0;
const check = (name, ok, note = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`);
  if (!ok) failures++;
};
const patternHits = (n) =>
  ['Value', 'Invoke', 'Toggle', 'SelectionItem'].filter((p) => n.patterns?.includes(p));

try {
  // 1. handshake (10s baseline)
  const hello = await call('initialize', {}, 10000);
  check(
    'initialize',
    hello.result?.protocol === 'maka.cu.windows/0',
    `protocol=${hello.result?.protocol}`,
  );

  // 2. window list
  const list = await call('list_windows');
  const windows = (list.result?.windows ?? []).filter(
    (w) => w.title === 'maka-cu-windows-fixture' && !w.isOffscreen,
  );
  check('list_windows (fixture-only)', windows.length > 0, `fixture=${windows.length}`);
  console.log(
    '  windows:',
    windows
      .slice(0, 6)
      .map((w) => `#${w.hwnd} "${w.title}" (pid ${w.pid})`)
      .join('\n            ') || '  (none)',
  );
  if (windows.length === 0) throw new Error('no visible top-level window to observe');

  const candidates = windows.filter((w) => String(w.hwnd) === hwndOverride);
  if (candidates.length !== 1)
    throw new Error('supplied hwnd is not the identified fixture window');

  // 3+4. observe + one semantic action — first verified target wins
  const attempts = [];
  let chosen = null;
  for (const w of candidates) {
    if (chosen) break;
    const obs = await call('observe', { hwnd: w.hwnd });
    if (obs.error) {
      attempts.push(`observe #${w.hwnd} "${w.title}" -> ${obs.error.message}`);
      continue;
    }
    const t = obs.result.tree;
    const actionable = (t.nodes ?? []).find((n) => patternHits(n).length > 0 && n.isEnabled);
    if (!actionable) {
      attempts.push(`#${w.hwnd} "${w.title}": no actionable element (nodes=${t.nodeCount})`);
      continue;
    }
    const isValue = actionable.patterns.includes('Value');
    const res = await call(
      'act',
      isValue
        ? {
            snapshotId: obs.result.snapshotId,
            elementToken: actionable.token,
            op: 'set_value',
            value: `spike-${Date.now() % 10000}`,
          }
        : {
            snapshotId: obs.result.snapshotId,
            elementToken: actionable.token,
            op: 'click_element',
          },
    );
    const o = res.result?.outcome;
    const label = isValue ? 'act set_value (ValuePattern)' : 'act click_element';
    const line = `${label} ${actionable.controlType} "${actionable.name}" path=${o?.path} status=${o?.status}${o?.reason ? ` reason=${o.reason}` : ''} verification=${o?.verification}`;
    const again = await call('act', {
      snapshotId: obs.result.snapshotId,
      elementToken: actionable.token,
      op: 'set_value',
      value: 'x',
    });
    const spent = again.error?.message === 'snapshot_spent_or_unknown';
    attempts.push(
      `${line} | snapshot spent: ${spent ? 'ok' : (again.error?.message ?? 'MISSING (accepted!)')}`,
    );
    if (o?.status === 'verified' && spent)
      chosen = { w, tree: t, snapshot: obs.result, outcome: o };
  }

  for (const a of attempts) report.push(`NOTE  ${a}`);
  if (chosen) {
    check(
      'observe (bounded tree)',
      chosen.tree.nodeCount > 0,
      `target=#${chosen.w.hwnd} nodes=${chosen.tree.nodeCount} truncated=${chosen.tree.truncated} elapsed=${chosen.tree.elapsedMs}ms`,
    );
    check(
      'observe target identity',
      idOk(chosen.snapshot.target),
      JSON.stringify(chosen.snapshot.target),
    );
    check(
      'semantic action verified',
      true,
      `${chosen.outcome.path} -> ${chosen.outcome.verification}`,
    );
  } else {
    check(
      'semantic action verified',
      false,
      'no candidate produced a verified action (helper stayed fail-closed)',
    );
  }

  // 5. cancel shape
  const cancel = await call('$/cancel');
  check('$/cancel', cancel.result?.cancelled === true);

  // 6. shutdown
  const bye = await call('shutdown');
  check('shutdown', bye.result?.ok === true);
  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    setTimeout(() => resolve('timeout'), 5000);
  });
  check('helper exits after shutdown', exitCode === 0, `exit=${exitCode}`);
} catch (err) {
  check('driver flow', false, err.message);
  child.kill();
}

const dt = Date.now() - t0;
console.log('\n--- spike report ---');
for (const line of report) console.log(line);
console.log(`total ${dt}ms, failures=${failures}`);
process.exitCode = failures > 0 ? 1 : 0;

function idOk(target) {
  return (
    !!target &&
    typeof target.hwnd === 'number' &&
    typeof target.pid === 'number' &&
    !!target.processStartTimeUtc
  );
}
