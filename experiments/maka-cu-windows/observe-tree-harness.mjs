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

// Language-blind observation harness for the deep-tree WPF fixture.
// Checks multiple same-type controls, deep nesting, and budget truncation.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const outputPath = resolve(outIndex >= 0 ? argv[outIndex + 1] : 'observe-tree-results.json');
if (outIndex >= 0) argv.splice(outIndex, 2);
const [firstHelper, secondHelper, fixture] = argv;
if (!firstHelper || !secondHelper || !fixture) {
  console.error('usage: node observe-tree-harness.mjs <helper-1.exe> <helper-2.exe> <fixture.exe> [--out result.json]');
  process.exit(2);
}

const FIXTURE_TITLE = 'maka-cu-windows-deep-tree-fixture';
const REQUEST_TIMEOUT_MS = 20_000;
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
const artifact = (path) => {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return { path: absolute, exists: false, sizeBytes: null, sha256: null, lastWrite: null };
  const stats = statSync(absolute);
  return { path: absolute, exists: true, sizeBytes: stats.size, sha256: hash(absolute), lastWrite: stats.mtime.toISOString() };
};

function nodesOf(observation) {
  return [...(observation?.result?.elements ?? []), ...(observation?.result?.tree?.nodes ?? [])];
}

function named(observation, name) {
  return nodesOf(observation).filter((node) => node.name === name);
}

function actionableNamed(observation, name, action) {
  return named(observation, name).filter((node) => !action || node.actions?.includes(action) || node.patterns?.includes(action) || node.patterns?.includes('Value') || node.patterns?.includes('Invoke'));
}

async function startFixture() {
  const child = spawn(resolve(fixture), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const identity = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 20_000);
    lines.on('line', (line) => {
      const match = line.match(/^READY\s+(\d+)\s+(-?\d+)$/);
      if (match) { clearTimeout(timer); resolveReady({ pid: Number(match[1]), hwnd: Number(match[2]) }); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`fixture exited ${code}`)); });
  });
  return { child, ...identity };
}

async function stopFixture(fixtureProcess) {
  if (!fixtureProcess?.child || fixtureProcess.child.exitCode !== null) return;
  try { fixtureProcess.child.stdin.write('shutdown\n'); } catch {}
  await new Promise((resolveDone) => {
    const timer = setTimeout(() => { try { fixtureProcess.child.kill(); } catch {} resolveDone(); }, 2_000);
    fixtureProcess.child.once('exit', () => { clearTimeout(timer); resolveDone(); });
  });
}

function startHelper(path) {
  const child = spawn(resolve(path), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map();
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  child.once('exit', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('helper exited'));
    }
    pending.clear();
  });
  const call = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); rejectCall(new Error(`${method} timeout`)); }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { child, call };
}

async function stopHelper(helper) {
  if (!helper || helper.child.exitCode !== null) return;
  try { await helper.call('shutdown'); } catch { try { helper.child.kill(); } catch {} }
}

async function runSubject(path, fixtureProcess) {
  const started = Date.now();
  const helper = startHelper(path);
  const checks = [];
  const record = async (name, fn) => {
    const at = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, state: detail.state ?? 'pass', durationMs: Date.now() - at, ...detail });
    } catch (error) {
      checks.push({ name, state: 'fail', durationMs: Date.now() - at, error: error.message });
    }
  };
  try {
    await helper.call('initialize');
    const observe = (extra = {}) => helper.call('observe', { hwnd: fixtureProcess.hwnd, ...extra });

    await record('multiple_same_type_edits', async () => {
      const observation = await observe();
      const found = [];
      for (let index = 1; index <= 5; index++) {
        const name = `Sibling edit ${String(index).padStart(2, '0')}`;
        found.push({ name, count: named(observation, name).length, actionable: actionableNamed(observation, name, 'set_value').length });
      }
      const missing = found.filter((item) => item.actionable < 1);
      return {
        state: missing.length === 0 ? 'pass' : 'fail',
        found,
        truncated: observation.result?.tree?.truncated ?? null,
        truncatedReasons: observation.result?.tree?.truncatedReasons ?? [],
        nodeCount: observation.result?.tree?.nodeCount ?? nodesOf(observation).length,
        elapsedMs: observation.result?.tree?.elapsedMs ?? null,
        passes: observation.result?.tree?.passes ?? null,
      };
    });

    await record('multiple_same_type_buttons', async () => {
      const observation = await observe();
      const found = [];
      for (let index = 1; index <= 5; index++) {
        const name = `Sibling button ${String(index).padStart(2, '0')}`;
        found.push({ name, count: named(observation, name).length, actionable: actionableNamed(observation, name, 'click_element').length });
      }
      const missing = found.filter((item) => item.count < 1);
      return { state: missing.length === 0 ? 'pass' : 'fail', found };
    });

    await record('deep_nested_input_beyond_render_depth', async () => {
      const observation = await observe();
      const deep = named(observation, 'Deep nested input');
      const mid = named(observation, 'Mid nested input');
      const renderDepth = observation.result?.tree?.limits?.maxRenderDepth;
      const hasDepthEvidence = Number.isInteger(renderDepth) && deep.some(node => Number.isInteger(node.rawDepth));
      const actuallyDeep = hasDepthEvidence && deep.some(node => node.rawDepth > renderDepth && node.actions?.includes('set_value'));
      return {
        // Visual WPF nesting is not necessarily exposed as UIA nesting.
        // Do not claim deep traversal coverage merely because a named edit exists.
        state: deep.length === 0 ? 'fail' : actuallyDeep ? 'pass' : 'not_tested',
        reason: deep.length === 0 ? 'target_not_observed' : actuallyDeep ? 'deep_actionable_target_observed' : hasDepthEvidence ? 'fixture_target_not_beyond_render_depth' : 'raw_depth_evidence_unavailable',
        deepCount: deep.length,
        midCount: mid.length,
        depthEvidence: {
          maxRawDepthVisited: observation.result?.tree?.maxRawDepthVisited ?? null,
          deep: deep.map(({ runtimeId, rawDepth, observationSource }) => ({ runtimeId, rawDepth, observationSource })),
          mid: mid.map(({ runtimeId, rawDepth, observationSource }) => ({ runtimeId, rawDepth, observationSource })),
        },
        truncated: observation.result?.tree?.truncated ?? null,
        truncatedReasons: observation.result?.tree?.truncatedReasons ?? [],
        nodeCount: observation.result?.tree?.nodeCount ?? nodesOf(observation).length,
        elapsedMs: observation.result?.tree?.elapsedMs ?? null,
      };
    });

    await record('budget_truncation_shared_node_limit', async () => {
      const observation = await observe({ debugLimits: { maxTreeNodes: 8 } });
      const tree = observation.result?.tree ?? {};
      const siblingEdits = [];
      for (let index = 1; index <= 5; index++) siblingEdits.push(named(observation, `Sibling edit ${String(index).padStart(2, '0')}`).length);
      if (tree.limits?.maxTreeNodes !== 8) {
        return {
          state: 'not_tested',
          reason: 'helper_ignores_debug_limits',
          truncated: tree.truncated ?? null,
          nodeCount: tree.nodeCount ?? nodesOf(observation).length,
          elapsedMs: tree.elapsedMs ?? null,
          rawDescendantCount: tree.rawDescendantCount ?? null,
        };
      }
      const truncated = tree.truncated === true;
      const nodeCount = tree.nodeCount ?? nodesOf(observation).length;
      return {
        state: truncated && nodeCount <= 8 ? 'pass' : 'fail',
        truncated,
        truncatedReasons: tree.truncatedReasons ?? [],
        nodeCount,
        elapsedMs: tree.elapsedMs ?? null,
        limits: tree.limits ?? null,
        passes: tree.passes ?? null,
        siblingEditCounts: siblingEdits,
        deepCount: named(observation, 'Deep nested input').length,
        note: 'Actionable runs first; a tiny shared node budget can still omit deep controls. Inter-node budget checks cannot interrupt a stuck COM call.',
      };
    });

    await record('actionable_depth_boundary', async () => {
      // The current fixture exposes shallow UIA descendants even though its
      // WPF layout is deeply nested. Exercise a boundary it actually crosses.
      // This does not replace a future fixture with explicit deep UIA peers.
      const observation = await observe({ debugLimits: { maxActionableDepth: 2, maxRenderDepth: 1 } });
      const tree = observation.result?.tree ?? {};
      if (tree.limits?.maxActionableDepth !== 2 || tree.limits?.maxRenderDepth !== 1) {
        return { state: 'not_tested', reason: 'helper_ignores_debug_limits', truncated: tree.truncated ?? null, truncatedReasons: tree.truncatedReasons ?? [] };
      }
      return {
        state: tree.truncated === true && tree.truncatedReasons?.includes('actionable_depth')
          && Number.isInteger(tree.maxRawDepthVisited) && tree.maxRawDepthVisited <= 2
          && nodesOf(observation).every(node => node.observationSource === 'live-patterns' ? node.rawDepth == null || node.rawDepth <= 2 : node.observationSource === 'cached-properties' ? node.rawDepth <= 1 : true)
          ? 'pass' : 'fail',
        truncated: tree.truncated ?? null,
        truncatedReasons: tree.truncatedReasons ?? [],
        limits: tree.limits ?? null,
        maxRawDepthVisited: tree.maxRawDepthVisited ?? null,
        depthEvidence: nodesOf(observation).map(({ name, automationId, runtimeId, rawDepth, observationSource }) => ({ name, automationId, runtimeId, rawDepth, observationSource })),
        deepCount: named(observation, 'Deep nested input').length,
        midCount: named(observation, 'Mid nested input').length,
        siblingEditCounts: [1, 2, 3, 4, 5].map((index) => named(observation, `Sibling edit ${String(index).padStart(2, '0')}`).length),
      };
    });

    const executionState = checks.some((check) => check.state === 'fail') ? 'fail' : checks.every((check) => check.state === 'not_tested') ? 'not_tested' : 'pass';
    return { label: path, app: { kind: 'WPF', title: FIXTURE_TITLE }, artifact: artifact(path), fixture: artifact(fixture), executionState, checks, durationMs: Date.now() - started };
  } finally {
    await stopHelper(helper);
  }
}

const startedAt = new Date().toISOString();
const fixtureProcess = await startFixture();
const subjects = [];
try {
  for (const helperPath of [firstHelper, secondHelper]) subjects.push(await runSubject(helperPath, fixtureProcess));
} finally {
  await stopFixture(fixtureProcess);
}

const result = {
  schema: 'maka.cu.windows/observe-tree-results/1',
  startedAt,
  finishedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  subjects,
  summary: {
    subjects: { pass: subjects.filter((item) => item.executionState === 'pass').length, fail: subjects.filter((item) => item.executionState === 'fail').length, total: subjects.length },
    checks: {
      pass: subjects.flatMap((item) => item.checks).filter((item) => item.state === 'pass').length,
      fail: subjects.flatMap((item) => item.checks).filter((item) => item.state === 'fail').length,
      not_tested: subjects.flatMap((item) => item.checks).filter((item) => item.state === 'not_tested').length,
      total: subjects.flatMap((item) => item.checks).length,
    },
  },
  distributionReady: false,
};
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
for (const subject of subjects) console.log(`${subject.executionState.toUpperCase()} ${subject.artifact.path} checks=${subject.checks.filter((item) => item.state === 'pass').length}/${subject.checks.length}`);
console.log(`RESULTS ${outputPath}`);
process.exitCode = result.summary.subjects.fail === 0 ? 0 : 1;
