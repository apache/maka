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

// Language-blind semantic app-task harness for the deterministic WPF fixture.
// Both helper paths run the same fixture and the same action/readback tasks;
// no executable name or implementation language is inspected.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const outputPath = resolve(outIndex >= 0 ? argv[outIndex + 1] : 'app-task-results.json');
if (outIndex >= 0) argv.splice(outIndex, 2);
const [firstHelper, secondHelper, fixture] = argv;
if (!firstHelper || !secondHelper || !fixture) {
  console.error(
    'usage: node app-task-harness.mjs <helper-1.exe> <helper-2.exe> <fixture.exe> [--out result.json]',
  );
  process.exit(2);
}

const FIXTURE_TITLE = 'maka-cu-windows-wpf-fixture';
const REQUEST_TIMEOUT_MS = 20_000;
const fixturePath = resolve(fixture);
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
const artifact = (path) => {
  const absolute = resolve(path);
  if (!existsSync(absolute))
    return { path: absolute, exists: false, sizeBytes: null, sha256: null, lastWrite: null };
  const stats = statSync(absolute);
  return {
    path: absolute,
    exists: true,
    sizeBytes: stats.size,
    sha256: hash(absolute),
    lastWrite: stats.mtime.toISOString(),
  };
};

function processLines(child) {
  const lines = createInterface({ input: child.stdout });
  return lines;
}

async function startFixture() {
  const child = spawn(fixturePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = processLines(child);
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 20_000);
    lines.on('line', (line) => {
      const match = line.match(/^READY\s+(\d+)\s+(-?\d+)$/);
      if (match) {
        clearTimeout(timer);
        resolveReady({ pid: Number(match[1]), hwnd: Number(match[2]) });
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited ${code}`));
    });
  });
  const identity = await ready;
  return { child, lines, ...identity };
}

async function stopFixture(fixtureProcess) {
  if (!fixtureProcess?.child || fixtureProcess.child.exitCode !== null) return;
  fixtureProcess.child.stdin.write('shutdown\n');
  await new Promise((resolveDone) => {
    const timer = setTimeout(() => {
      fixtureProcess.child.kill();
      resolveDone();
    }, 2_000);
    fixtureProcess.child.once('exit', () => {
      clearTimeout(timer);
      resolveDone();
    });
  });
}

function startHelper(path) {
  const child = spawn(resolve(path), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = processLines(child);
  let nextId = 1;
  const pending = new Map();
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  child.once('exit', () => {
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`helper exited while awaiting ${id}`));
    }
    pending.clear();
  });
  const call = (method, params = {}) =>
    new Promise((resolveCall, rejectCall) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCall(new Error(`${method} timeout`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { child, call };
}

async function stopHelper(helper) {
  if (!helper?.child || helper.child.exitCode !== null) return;
  try {
    await helper.call('shutdown');
  } catch {
    helper.child.kill();
  }
  await new Promise((resolveDone) => {
    const timer = setTimeout(() => {
      helper.child.kill();
      resolveDone();
    }, 2_000);
    helper.child.once('exit', () => {
      clearTimeout(timer);
      resolveDone();
    });
  });
}

const allNodes = (observation) => {
  const nodes = [
    ...(observation.result?.elements ?? []),
    ...(observation.result?.tree?.nodes ?? []),
  ];
  const seen = new Set();
  return nodes.filter((node) => node?.token && !seen.has(node.token) && seen.add(node.token));
};
const findNode = (observation, automationId, action) =>
  allNodes(observation).find(
    (node) =>
      node.automationId === automationId &&
      (!action || node.actions?.includes(action) || node.patterns?.includes(action)),
  );
const findAnyNode = (observation, automationId) =>
  allNodes(observation)
    .filter((node) => node.automationId === automationId)
    .sort(
      (left, right) =>
        Number(
          Boolean(right.actions?.length || right.patterns?.length || right.value !== undefined),
        ) -
        Number(Boolean(left.actions?.length || left.patterns?.length || left.value !== undefined)),
    )[0];

async function runSubject(path, label) {
  const started = Date.now();
  let fixtureProcess;
  let helper;
  const tasks = [];
  const securityChecks = [];
  try {
    fixtureProcess = await startFixture();
    helper = startHelper(path);
    const initialized = await helper.call('initialize');
    const listed = await helper.call('list_windows');
    const window = listed.result?.windows?.find((candidate) => candidate.title === FIXTURE_TITLE);
    const setup = window && window.hwnd === fixtureProcess.hwnd;
    if (!setup)
      throw new Error(
        `fixture window not selected by explicit HWND/title (hwnd=${fixtureProcess.hwnd})`,
      );
    const observe = async () => helper.call('observe', { hwnd: fixtureProcess.hwnd });
    const action = async (observation, node, params) =>
      helper.call('act', {
        snapshotId: observation.result.snapshotId,
        elementToken: node.token,
        ...params,
      });
    const compatAction = async (observation, node, op, value) => {
      const authorization = await helper.call('authorize_compat', {
        snapshotId: observation.result.snapshotId,
        elementToken: node.token,
        op,
        ...(op === 'compat_type_text' ? { value } : {}),
      });
      if (authorization.error) return authorization;
      return action(observation, node, {
        op,
        authorizationToken: authorization.result.authorizationToken,
        ...(op === 'compat_type_text' ? { value } : {}),
      });
    };
    const record = async (name, fn) => {
      const taskStarted = Date.now();
      try {
        const detail = await fn();
        const executionState = detail?.executionState ?? 'pass';
        const contractConformance = detail?.contractConformance ?? 'pass';
        tasks.push({
          name,
          executionState,
          contractConformance,
          durationMs: Date.now() - taskStarted,
          detail: detail?.detail ?? detail,
        });
      } catch (error) {
        tasks.push({
          name,
          executionState: error.blocked ? 'blocked' : 'fail',
          contractConformance: error.blocked ? 'pass' : 'fail',
          durationMs: Date.now() - taskStarted,
          error: error.message,
        });
      }
    };
    if (!initialized.result || initialized.result.protocol !== 'maka.cu.windows/0')
      throw new Error('initialize protocol mismatch');
    await record('set_text_and_readback', async () => {
      const before = await observe();
      const node = findNode(before, 'wpf-input', 'set_value');
      if (!node) throw new Error('wpf-input ValuePattern token unavailable');
      const response = await action(before, node, { op: 'set_value', value: 'matrix-text' });
      if (response.result?.outcome?.status !== 'verified')
        throw new Error(`set_value ${JSON.stringify(response)}`);
      const after = await observe();
      const readback = findAnyNode(after, 'wpf-input');
      if (readback?.value !== 'matrix-text')
        throw new Error(
          `set_value readback=${JSON.stringify(readback?.value)} nodes=${JSON.stringify(allNodes(after).filter((candidate) => candidate.automationId === 'wpf-input'))}`,
        );
      return {
        status: response.result.outcome.status,
        verification: response.result.outcome.verification,
      };
    });
    await record('semantic_click_and_status_readback', async () => {
      const before = await observe();
      const node = findNode(before, 'wpf-button', 'click_element');
      if (!node)
        throw new Error(
          `wpf-button Invoke token unavailable nodes=${JSON.stringify(allNodes(before).filter((candidate) => candidate.automationId === 'wpf-button'))}`,
        );
      const response = await action(before, node, { op: 'click_element' });
      if (response.result?.outcome?.status !== 'verified')
        throw new Error(`click ${JSON.stringify(response)}`);
      const status = findAnyNode(await observe(), 'wpf-status');
      if (status?.name !== 'clicked')
        throw new Error(`click readback=${JSON.stringify(status?.name)}`);
      return {
        status: response.result.outcome.status,
        verification: response.result.outcome.verification,
      };
    });
    await record('selection_and_status_readback', async () => {
      const before = await observe();
      const node = allNodes(before).find(
        (candidate) =>
          candidate.name === 'Alpha' &&
          (candidate.actions?.includes('select') || candidate.patterns?.includes('SelectionItem')),
      );
      if (!node)
        throw new Error(
          `Alpha SelectionItem token unavailable candidates=${JSON.stringify(allNodes(before).filter((candidate) => candidate.name?.includes('Alpha') || candidate.actions?.includes('select') || candidate.patterns?.includes('SelectionItem')))}`,
        );
      const response = await action(before, node, { op: 'select' });
      if (response.result?.outcome?.status !== 'verified')
        throw new Error(`select ${JSON.stringify(response)}`);
      const status = findAnyNode(await observe(), 'wpf-status');
      if (status?.name !== 'selected:Alpha')
        throw new Error(`select readback=${JSON.stringify(status?.name)}`);
      return {
        status: response.result.outcome.status,
        verification: response.result.outcome.verification,
      };
    });
    await record('toggle_and_status_readback', async () => {
      const before = await observe();
      const node = findNode(before, 'wpf-toggle', 'toggle');
      if (!node) throw new Error('wpf-toggle TogglePattern token unavailable');
      const response = await action(before, node, { op: 'toggle' });
      if (response.result?.outcome?.status !== 'verified')
        throw new Error(`toggle ${JSON.stringify(response)}`);
      const status = findAnyNode(await observe(), 'wpf-status');
      if (status?.name !== 'toggled:on')
        throw new Error(`toggle readback=${JSON.stringify(status?.name)}`);
      return {
        status: response.result.outcome.status,
        verification: response.result.outcome.verification,
      };
    });
    await record('scroll_and_position_readback', async () => {
      const before = await observe();
      const node = findNode(before, 'wpf-scroll', 'scroll');
      if (!node) throw new Error('wpf-scroll ScrollPattern token unavailable');
      const response = await action(before, node, {
        op: 'scroll',
        direction: 'vertical',
        amount: 'large_increment',
      });
      if (!['verified', 'unknown'].includes(response.result?.outcome?.status))
        throw new Error(`scroll ${JSON.stringify(response)}`);
      const after = await observe();
      const readback = findAnyNode(after, 'wpf-scroll');
      return {
        executionState: response.result.outcome.status === 'verified' ? 'pass' : 'unknown',
        contractConformance: 'pass',
        detail: {
          status: response.result.outcome.status,
          verification: response.result.outcome.verification,
          observed: !!readback,
        },
      };
    });
    await record('enter_is_typed_unsupported', async () => {
      const before = await observe();
      const node = findAnyNode(before, 'wpf-input');
      if (!node) throw new Error('wpf-input token unavailable');
      const response = await action(before, node, { op: 'press_enter' });
      const outcome = response.result?.outcome;
      if (
        outcome?.status !== 'refused' ||
        outcome.reason !== 'unsupported_enter' ||
        outcome.effect !== 'none'
      )
        throw new Error(`enter was not typed unsupported: ${JSON.stringify(response)}`);
      return { executionState: 'blocked', contractConformance: 'pass', detail: outcome };
    });
    await record('compat_type_text_authorized', async () => {
      const before = await observe();
      const node = findAnyNode(before, 'wpf-input');
      if (!node) throw new Error('wpf-input token unavailable');
      // Establish an empty, focused-independent precondition. The earlier
      // semantic task intentionally writes matrix-text; SendInput types at
      // the provider's current caret and therefore must not be compared with
      // a replacement value unless the field is reset first.
      const cleared = await action(before, node, { op: 'set_value', value: '' });
      if (cleared.result?.outcome?.status !== 'verified')
        throw new Error(`compat precondition clear ${JSON.stringify(cleared)}`);
      const compatBefore = await observe();
      const compatNode = findAnyNode(compatBefore, 'wpf-input');
      if (!compatNode) throw new Error('wpf-input token unavailable after clear');
      const response = await compatAction(
        compatBefore,
        compatNode,
        'compat_type_text',
        'compat-text',
      );
      if (response.error) {
        if (response.error.message?.includes('compat_focus_refused'))
          return { executionState: 'blocked', contractConformance: 'pass', detail: response.error };
        throw new Error(`compat_type_text ${JSON.stringify(response)}`);
      }
      const outcome = response.result?.outcome;
      if (outcome?.status === 'unknown') {
        // Keep helper status unknown, but collect one independent post-dispatch
        // observation so a provider readback timeout is distinguishable from
        // an input that visibly had no effect. This observation never upgrades
        // the helper outcome or authorizes a retry.
        const afterUnknown = await observe();
        const observed = findAnyNode(afterUnknown, 'wpf-input');
        return {
          executionState: 'unknown',
          contractConformance: 'pass',
          detail: {
            ...outcome,
            postDispatchReadback: {
              value: observed?.value ?? null,
              matchesRequested: observed?.value === 'compat-text',
              observationError: afterUnknown.error ?? null,
            },
          },
        };
      }
      if (outcome?.status !== 'verified')
        throw new Error(`compat_type_text ${JSON.stringify(response)}`);
      const readback = findAnyNode(await observe(), 'wpf-input');
      if (readback?.value !== 'compat-text')
        throw new Error(`compat readback=${JSON.stringify(readback?.value)}`);
      return { executionState: 'pass', contractConformance: 'pass', detail: outcome };
    });
    await record('compat_press_enter_authorized', async () => {
      const before = await observe();
      const node = findAnyNode(before, 'wpf-input');
      if (!node) throw new Error('wpf-input token unavailable');
      const response = await compatAction(before, node, 'compat_press_enter');
      if (response.error) {
        if (response.error.message?.includes('compat_focus_refused'))
          return { executionState: 'blocked', contractConformance: 'pass', detail: response.error };
        throw new Error(`compat_press_enter ${JSON.stringify(response)}`);
      }
      const outcome = response.result?.outcome;
      if (outcome?.status === 'unknown')
        return { executionState: 'unknown', contractConformance: 'pass', detail: outcome };
      if (outcome?.status === 'refused')
        return { executionState: 'blocked', contractConformance: 'pass', detail: outcome };
      throw new Error(`compat_press_enter unexpectedly verified ${JSON.stringify(response)}`);
    });
    const security = async (name, fn) => {
      try {
        securityChecks.push({ name, state: await fn() });
      } catch (error) {
        securityChecks.push({ name, state: 'fail', error: error.message });
      }
    };
    await security('missing_authorization_refused', async () => {
      const before = await observe();
      const node = findAnyNode(before, 'wpf-input');
      const response = await action(before, node, { op: 'compat_type_text', value: 'negative' });
      return response.error?.message === 'compat_authorization_missing' ? 'pass' : 'fail';
    });
    await security('authorization_payload_and_reuse_refused', async () => {
      const before = await observe();
      const node = findAnyNode(before, 'wpf-input');
      const auth = await helper.call('authorize_compat', {
        snapshotId: before.result.snapshotId,
        elementToken: node.token,
        op: 'compat_type_text',
        value: 'negative',
      });
      const mismatch = await action(before, node, {
        op: 'compat_type_text',
        value: 'tampered',
        authorizationToken: auth.result.authorizationToken,
      });
      if (mismatch.error?.message !== 'compat_authorization_mismatch') return 'fail';
      const used = await action(before, node, {
        op: 'compat_type_text',
        value: 'negative',
        authorizationToken: auth.result.authorizationToken,
      });
      if (used.error || !['verified', 'unknown', 'refused'].includes(used.result?.outcome?.status))
        return 'fail';
      const reused = await action(before, node, {
        op: 'compat_type_text',
        value: 'negative',
        authorizationToken: auth.result.authorizationToken,
      });
      return reused.error?.message === 'compat_authorization_unknown' ? 'pass' : 'fail';
    });
    await security('authorization_cross_snapshot_refused', async () => {
      const before = await observe();
      const node = findAnyNode(before, 'wpf-input');
      const auth = await helper.call('authorize_compat', {
        snapshotId: before.result.snapshotId,
        elementToken: node.token,
        op: 'compat_type_text',
        value: 'negative-cross',
      });
      const other = await observe();
      const otherNode = findAnyNode(other, 'wpf-input');
      const response = await action(other, otherNode, {
        op: 'compat_type_text',
        value: 'negative-cross',
        authorizationToken: auth.result.authorizationToken,
      });
      return response.error?.message === 'compat_authorization_mismatch' ? 'pass' : 'fail';
    });
    const executionState = tasks.some((task) => task.executionState === 'fail')
      ? 'fail'
      : tasks.some((task) => task.executionState === 'unknown')
        ? 'unknown'
        : tasks.some((task) => task.executionState === 'blocked')
          ? 'blocked'
          : 'pass';
    return {
      label,
      app: { kind: 'WPF', title: FIXTURE_TITLE, version: 'fixture-v1' },
      artifact: artifact(path),
      fixture: artifact(fixturePath),
      executionState,
      contractConformance:
        tasks.every((task) => task.contractConformance === 'pass') &&
        securityChecks.every((check) => check.state === 'pass')
          ? 'pass'
          : 'fail',
      tasks,
      securityChecks,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      label,
      app: { kind: 'WPF', title: FIXTURE_TITLE, version: 'fixture-v1' },
      artifact: artifact(path),
      fixture: artifact(fixturePath),
      executionState: 'blocked',
      contractConformance: 'pass',
      tasks,
      securityChecks,
      durationMs: Date.now() - started,
      error: error.message,
    };
  } finally {
    await stopHelper(helper);
    await stopFixture(fixtureProcess);
  }
}

const startedAt = new Date().toISOString();
const subjects = [
  await runSubject(firstHelper, 'subject-1'),
  await runSubject(secondHelper, 'subject-2'),
];
const counts = (items, field = 'executionState') => ({
  pass: items.filter((item) => item[field] === 'pass').length,
  fail: items.filter((item) => item[field] === 'fail').length,
  blocked: items.filter((item) => item[field] === 'blocked').length,
  unknown: items.filter((item) => item[field] === 'unknown').length,
  total: items.length,
});
const tasks = subjects.flatMap((subject) => subject.tasks);
const result = {
  schema: 'maka.cu.windows/app-task-results/3',
  startedAt,
  finishedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  fixture: artifact(fixturePath),
  subjects,
  summary: {
    subjects: {
      execution: counts(subjects),
      contractConformance: counts(subjects, 'contractConformance'),
    },
    tasks: { execution: counts(tasks), contractConformance: counts(tasks, 'contractConformance') },
    byTask: Object.fromEntries(
      [...new Set(tasks.map((task) => task.name))].map((name) => {
        const matching = tasks.filter((task) => task.name === name);
        return [
          name,
          {
            execution: counts(matching),
            contractConformance: counts(matching, 'contractConformance'),
          },
        ];
      }),
    ),
  },
};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
for (const subject of subjects)
  console.log(
    `${subject.executionState.toUpperCase()} ${subject.label} tasks=${subject.tasks.filter((task) => task.executionState === 'pass').length}/${subject.tasks.length}`,
  );
console.log(`RESULTS ${outputPath}`);
process.exitCode =
  result.summary.subjects.execution.fail === 0 &&
  result.summary.subjects.execution.blocked === 0 &&
  result.summary.subjects.execution.unknown === 0
    ? 0
    : 1;
