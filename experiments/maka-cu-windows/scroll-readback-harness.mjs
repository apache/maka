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

// Identical native UIA-provider cases for both opaque helper paths.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
const [first, second, fixturePath, outputPath] = process.argv.slice(2).map((p) => resolve(p));
if (!outputPath)
  throw new Error(
    'usage: node scroll-readback-harness.mjs <helper1> <helper2> <fixture> <output.json>',
  );
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const fingerprint = (path) => ({
  path,
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
});
const artifacts = (path) =>
  [path, join(dirname(path), basename(path).replace(/\.exe$/, '.dll'))]
    .filter(existsSync)
    .map(fingerprint);
function child(path, args = []) {
  const process = spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [],
    transcript = [],
    pending = new Map();
  let nextId = 1,
    onEvent = () => {};
  createInterface({ input: process.stdout }).on('line', (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    transcript.push({ at: Date.now(), direction: 'received', value });
    if (value.id != null && pending.has(value.id)) {
      const w = pending.get(value.id);
      pending.delete(value.id);
      clearTimeout(w.timer);
      w.resolve(value);
    } else {
      events.push(value);
      onEvent(value);
    }
  });
  process.stderr.on('data', (data) =>
    transcript.push({ direction: 'stderr', text: data.toString().slice(0, 8000) }),
  );
  const rejectAll = (error) => {
    for (const w of pending.values()) {
      clearTimeout(w.timer);
      w.reject(error);
    }
    pending.clear();
  };
  process.on('error', rejectAll);
  process.on('exit', () => rejectAll(new Error('child exited')));
  function call(method, params = {}) {
    const id = nextId++;
    const promise = new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 15000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      const value = { jsonrpc: '2.0', id, method, params };
      transcript.push({ at: Date.now(), direction: 'sent', value });
      process.stdin.write(`${JSON.stringify(value)}\n`);
    });
    return { id, promise };
  }
  return {
    process,
    events,
    transcript,
    call,
    onEvent: (fn) => {
      onEvent = fn;
    },
  };
}
const cases = [
  ...['vertical', 'horizontal'].flatMap((direction) =>
    ['small_increment', 'large_increment', 'small_decrement', 'large_decrement'].map((amount) => ({
      name: `delayed-${direction}-${amount}`,
      mode: 'delayed',
      direction,
      amount,
      status: 'verified',
      verification: 'scroll_position_readback_changed',
      retry: true,
    })),
  ),
  { name: 'timeout', mode: 'never', status: 'unknown', verification: 'scroll_readback_timeout' },
  {
    name: 'cancel-after-mutation',
    mode: 'never',
    status: 'unknown',
    verification: 'readback_cancelled_after_dispatch',
    cancel: true,
  },
  {
    name: 'wrong-direction',
    mode: 'wrong-direction',
    status: 'unknown',
    verification: 'scroll_readback_wrong_direction',
  },
  {
    name: 'invalid-after',
    mode: 'invalid-after',
    status: 'unknown',
    verification: 'scroll_readback_invalid_percent',
  },
  {
    name: 'read-error',
    mode: 'read-error',
    status: 'unknown',
    verification: 'scroll_readback_unavailable',
  },
  {
    name: 'throw-after-scroll',
    mode: 'throw-after-scroll',
    status: 'unknown',
    verification: 'scroll_failed_after_dispatch',
  },
  {
    name: 'axis-lost',
    mode: 'no-scroll-after',
    status: 'unknown',
    verification: 'scroll_readback_axis_not_scrollable',
  },
  { name: 'late-match', mode: 'late', status: 'unknown', verification: 'scroll_readback_timeout' },
  { name: 'window-closed', mode: 'never', status: 'unknown', close: true },
  {
    name: 'generation-changed',
    mode: 'name-change',
    status: 'unknown',
    verification: 'post_revalidation_failed',
  },
  {
    name: 'at-end',
    mode: 'at-end',
    status: 'refused',
    verification: 'scroll_at_boundary',
    noMutation: true,
  },
  {
    name: 'at-start',
    mode: 'at-start',
    amount: 'large_decrement',
    status: 'refused',
    verification: 'scroll_at_boundary',
    noMutation: true,
  },
  {
    name: 'no-scroll',
    mode: 'no-scroll',
    status: 'refused',
    verification: 'scroll_axis_not_scrollable',
    noMutation: true,
  },
  {
    name: 'invalid-before',
    mode: 'invalid-before',
    status: 'refused',
    verification: 'scroll_invalid_percent',
    noMutation: true,
  },
  {
    name: 'no-amount',
    mode: 'delayed',
    amount: 'no_amount',
    status: 'refused',
    verification: 'scroll_no_amount',
    noMutation: true,
  },
  {
    name: 'scroll-item-not-directional',
    mode: 'scrollitem-only',
    status: 'refused',
    verification: 'scroll_pattern_unavailable',
    noMutation: true,
  },
];
const subjects = [];
for (const helperPath of [first, second]) {
  const checks = [];
  for (const test of cases.filter(
    (t) => !process.env.MAKA_SCROLL_CASE || t.name === process.env.MAKA_SCROLL_CASE,
  )) {
    const fx = child(fixturePath, [test.mode]),
      helper = child(helperPath);
    let result;
    try {
      const readyDeadline = Date.now() + 10000;
      while (!fx.events.some((e) => e.kind === 'ready') && Date.now() < readyDeadline)
        await pause(20);
      const ready = fx.events.find((e) => e.kind === 'ready');
      if (!ready) throw new Error('fixture not ready');
      await helper.call('initialize').promise;
      const observation = await helper.call('observe', { hwnd: ready.hwnd }).promise;
      const nodes = [
        ...(observation.result?.elements ?? []),
        ...(observation.result?.tree?.nodes ?? []),
      ];
      // For the negative ScrollItem-only test it is intentional to submit a
      // request even though observe must no longer advertise directional scroll.
      const target = nodes.find(
        (n) =>
          n.automationId === 'scroll-readback-target' &&
          n.patterns?.includes(test.mode === 'scrollitem-only' ? 'ScrollItem' : 'Scroll'),
      );
      if (!target || !target.runtimeId?.length)
        throw new Error('fixture scroll target not observed');
      const direction = test.direction ?? 'vertical',
        amount = test.amount ?? 'large_increment';
      const params = {
        snapshotId: observation.result.snapshotId,
        elementToken: target.token,
        op: 'scroll',
        direction,
        amount,
      };
      let actId, cancellation;
      fx.onEvent((event) => {
        if (event.kind !== 'mutation') return;
        if (test.cancel) cancellation = helper.call('$/cancel', { id: actId }).promise;
        if (test.close) fx.process.stdin.end('shutdown\n');
      });
      const started = Date.now();
      const act = helper.call('act', params);
      actId = act.id;
      const response = await act.promise;
      const durationMs = Date.now() - started;
      const cancelResponse = cancellation ? await cancellation : null;
      // Security regression only: the explicitly replayed spent snapshot must
      // be refused. It is never used as a retry to achieve task success.
      const replay = await helper.call('act', params).promise;
      await pause(100);
      const mutations = fx.events.filter((e) => e.kind === 'mutation');
      const outcome = response.result?.outcome;
      const increment = amount.endsWith('_increment');
      const expectedPosition =
        40 + (increment ? 20 : -20) * (test.mode === 'wrong-direction' ? -1 : 1);
      const expectedAmount = amount
        .split('_')
        .map((s) => s[0].toUpperCase() + s.slice(1))
        .join('');
      const checksOk =
        outcome?.status === test.status &&
        (!test.verification || outcome?.verification === test.verification) &&
        (!outcome?.readback ||
          (outcome.readback.direction === direction &&
            outcome.readback.amount === amount &&
            outcome.readback.beforePercent === 40 &&
            outcome.readback.source ===
              `ScrollPattern.Current${direction === 'horizontal' ? 'Horizontal' : 'Vertical'}ScrollPercent`)) &&
        (test.status !== 'verified' ||
          outcome?.readback?.samples?.at(-1)?.percent === expectedPosition) &&
        (!test.retry ||
          (outcome?.readback?.attempts > 1 && outcome.readback.samples[0].percent === 40)) &&
        mutations.length === (test.noMutation ? 0 : 1) &&
        mutations.every(
          (e) =>
            e.count === 1 &&
            e.position === expectedPosition &&
            e.horizontalAmount === (direction === 'horizontal' ? expectedAmount : 'NoAmount') &&
            e.verticalAmount === (direction === 'vertical' ? expectedAmount : 'NoAmount'),
        ) &&
        !fx.events.some((e) => e.kind === 'scroll-item-mutation') &&
        (test.mode !== 'scrollitem-only' || !target.actions?.includes('scroll')) &&
        !!replay.error &&
        /snapshot_spent_or_unknown/.test(replay.error.message) &&
        (!test.cancel || cancelResponse?.result?.cancelled === true) &&
        durationMs < 3000;
      result = {
        name: test.name,
        state: checksOk ? 'pass' : 'fail',
        durationMs,
        response,
        cancelResponse,
        replay,
        mutations,
        observation,
      };
    } catch (error) {
      result = { name: test.name, state: 'fail', error: error.message };
    } finally {
      if (fx.process.exitCode === null) {
        try {
          fx.process.stdin.end('shutdown\n');
        } catch {}
      }
      if (helper.process.exitCode === null) {
        try {
          await helper.call('shutdown').promise;
        } catch {}
      }
      await pause(100);
      for (const owned of [fx, helper]) if (owned.process.exitCode === null) owned.process.kill();
      result.fixtureEvents = fx.events;
      result.fixtureTranscript = fx.transcript;
      result.transcript = helper.transcript;
      checks.push(result);
      console.log(`${result.state.toUpperCase()} ${basename(helperPath)} ${test.name}`);
    }
  }
  subjects.push({ helperPath, artifacts: artifacts(helperPath), checks });
}
const result = {
  schema: 'maka/scroll-readback-tests/1',
  finishedAt: new Date().toISOString(),
  harness: fingerprint(new URL(import.meta.url)),
  fixture: artifacts(fixturePath),
  subjects,
  summary: {
    pass: subjects.flatMap((s) => s.checks).filter((c) => c.state === 'pass').length,
    total: subjects.flatMap((s) => s.checks).length,
  },
};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.summary.pass === result.summary.total ? 0 : 1;
