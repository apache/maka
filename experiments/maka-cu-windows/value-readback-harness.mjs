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

// Same real WPF UIA provider and assertions for both opaque helper paths.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
const [first, second, fixturePath, outputPath] = process.argv.slice(2).map(p => resolve(p));
if (!outputPath) throw new Error('usage: node value-readback-harness.mjs <helper1> <helper2> <fixture> <output.json>');
const pause = ms => new Promise(r => setTimeout(r, ms));
const fingerprint = path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
function artifacts(path) {
  return [path, join(dirname(path), path.split(/[\\/]/).at(-1).replace(/\.exe$/, '.dll'))].filter(existsSync).map(fingerprint);
}
function child(path, args = []) {
  const process = spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: process.stdout });
  const events = [];
  let nextId = 1, onEvent = () => {};
  const pending = new Map();
  const transcript = [];
  process.stderr.on('data', data => transcript.push({ direction: 'stderr', text: data.toString().slice(0, 8000) }));
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    transcript.push({ at: Date.now(), direction: 'received', value });
    if (value.id != null && pending.has(value.id)) {
      const waiter = pending.get(value.id); pending.delete(value.id); clearTimeout(waiter.timer); waiter.resolve(value);
    } else { events.push(value); onEvent(value); }
  });
  const rejectAll = error => { for (const w of pending.values()) { clearTimeout(w.timer); w.reject(error); } pending.clear(); };
  process.on('error', rejectAll);
  process.on('exit', () => rejectAll(new Error('child exited')));
  function call(method, params = {}) {
    const id = nextId++;
    const promise = new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 15000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      const value = { jsonrpc: '2.0', id, method, params };
      transcript.push({ at: Date.now(), direction: 'sent', value });
      process.stdin.write(`${JSON.stringify(value)}\n`);
    });
    return { id, promise };
  }
  return { process, events, transcript, call, onEvent: fn => { onEvent = fn; } };
}
const cases = [
  { name: 'delayed', mode: 'delayed', status: 'verified', verification: 'value_readback_match', retry: true },
  { name: 'timeout', mode: 'never', status: 'unknown', verification: 'value_readback_timeout' },
  { name: 'cancel-during-readback', mode: 'never', status: 'unknown', verification: 'readback_cancelled_after_dispatch', cancel: true },
  { name: 'password-after-write', mode: 'protect-after-write', status: 'unknown', verification: 'readback_password_field_refused' },
  { name: 'read-error', mode: 'read-error', status: 'unknown', verification: 'readback_unavailable' },
  { name: 'throw-after-write', mode: 'throw-after-write', status: 'unknown' },
  { name: 'window-closed-after-write', mode: 'never', status: 'unknown', close: true },
  { name: 'window-name-invalidates-generation', mode: 'name-change', status: 'unknown', verification: 'post_revalidation_failed' },
  { name: 'password-before-write', mode: 'password', status: 'refused', noMutation: true },
];
const subjects = [];
for (const helperPath of [first, second]) {
  const checks = [];
  for (const test of cases.filter(t => !process.env.MAKA_READBACK_CASE || t.name === process.env.MAKA_READBACK_CASE)) {
    const fx = child(fixturePath, [test.mode]);
    const helper = child(helperPath);
    let result;
    try {
      const readyDeadline = Date.now() + 10000;
      while (!fx.events.some(e => e.kind === 'ready') && Date.now() < readyDeadline) await pause(20);
      const ready = fx.events.find(e => e.kind === 'ready');
      if (!ready) throw new Error('fixture not ready');
      await helper.call('initialize').promise;
      const observation = await helper.call('observe', { hwnd: ready.hwnd }).promise;
      const nodes = [...(observation.result?.elements ?? []), ...(observation.result?.tree?.nodes ?? [])];
      const target = nodes.find(n => n.automationId === 'readback-target' && n.actions?.includes('set_value'));
      if (!target) throw new Error('fixture input not actionable');
      const params = { snapshotId: observation.result.snapshotId, elementToken: target.token, op: 'set_value', value: 'single-write-evidence' };
      let actId, cancellation;
      fx.onEvent(event => {
        if (event.kind !== 'mutation') return;
        if (test.cancel) cancellation = helper.call('$/cancel', { id: actId }).promise;
        if (test.close) fx.process.stdin.end('shutdown\n');
      });
      const started = Date.now();
      const act = helper.call('act', params); actId = act.id;
      const response = await act.promise;
      const durationMs = Date.now() - started;
      const cancelResponse = cancellation ? await cancellation : null;
      const afterObservation = !test.close ? await helper.call('observe', { hwnd: ready.hwnd }).promise : null;
      await pause(50);
      // Explicit security test: replay the spent token; it must not mutate.
      const replay = await helper.call('act', params).promise;
      await pause(50);
      const mutations = fx.events.filter(e => e.kind === 'mutation');
      const outcome = response.result?.outcome;
      const status = outcome?.status ?? (test.noMutation && response.error ? 'refused' : null);
      const checksOk = status === test.status
        && (!test.verification || outcome?.verification === test.verification)
        && (!test.retry || outcome?.readback?.attempts > 1)
        && mutations.length === (test.noMutation ? 0 : 1)
        && mutations.every(e => e.count === 1 && e.value === params.value)
        && !!replay.error && /snapshot_spent_or_unknown/.test(replay.error.message)
        && (!test.cancel || cancelResponse?.result?.cancelled === true)
        && durationMs < 3000;
      result = { name: test.name, state: checksOk ? 'pass' : 'fail', durationMs, response, cancelResponse, replay, mutations, observation, afterObservation };
    } catch (error) { result = { name: test.name, state: 'fail', error: error.message }; }
    finally {
      if (fx.process.exitCode === null) { try { fx.process.stdin.end('shutdown\n'); } catch {} }
      if (helper.process.exitCode === null) { try { await helper.call('shutdown').promise; } catch {} }
      await pause(100);
      for (const owned of [fx, helper]) if (owned.process.exitCode === null) owned.process.kill();
      result.fixtureEvents = fx.events;
      result.fixtureTranscript = fx.transcript;
      result.transcript = helper.transcript;
      checks.push(result);
      console.log(`${result.state.toUpperCase()} ${helperPath} ${test.name}`);
    }
  }
  subjects.push({ helperPath, artifacts: artifacts(helperPath), checks });
}
const result = { schema: 'maka/value-readback-tests/1', finishedAt: new Date().toISOString(),
  harness: fingerprint(new URL(import.meta.url)), fixture: artifacts(fixturePath), subjects,
  summary: { pass: subjects.flatMap(s => s.checks).filter(c => c.state === 'pass').length, total: subjects.flatMap(s => s.checks).length } };
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.summary.pass === result.summary.total ? 0 : 1;
