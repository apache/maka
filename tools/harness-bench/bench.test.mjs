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

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ClusterMonitor, runMonitoredProcess } from './proc-monitor.mjs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateStressScenario } from './stress.mjs';
import { resolveMockAiBinary } from './mock-client.mjs';

const cli = fileURLToPath(new URL('run.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const exec = promisify(execFile);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const readySource = 'pub fn status() -> &\'static str {\n    "ready"\n}\n';

let mockBinary;
before(async () => {
  const name = process.platform === 'win32' ? 'maka-mock-ai.exe' : 'maka-mock-ai';
  const debug = resolve(repoRoot, process.env.CARGO_TARGET_DIR ?? 'target', 'debug', name);
  try {
    await access(debug);
    mockBinary = resolveMockAiBinary(repoRoot, debug);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mockBinary = resolveMockAiBinary(repoRoot);
  }
});

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'harness-bench-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function invoke(args, { env = process.env, expectedCode = 0 } = {}) {
  let result;
  try {
    result = { ...await exec(process.execPath, [cli, ...args], { env, timeout: 30_000 }), code: 0 };
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, expectedCode, [result.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result;
}

async function runScenario(t, scenario, args = []) {
  const output = join(await scratch(t), 'output');
  const result = await invoke([
    'run', '--scenario', scenario, '--harnesses', 'ref-agent',
    '--mock-bin', mockBinary, '--output', output, ...args,
  ]);
  return { output, result, results: await readJson(join(output, 'results.json')) };
}

async function assertCleanServer(results) {
  assert.deepEqual(results.errors, []);
  assert.deepEqual(results.server.sessionsAfterCleanup, { items: [], nextCursor: null });
  assert.deepEqual(results.server.exit, { code: 0, signal: null });
  await assert.rejects(fetch(results.server.origin + '/admin/health', {
    signal: AbortSignal.timeout(1000),
  }), error => error.cause?.code === 'ECONNREFUSED');
}

async function laneEvidence(output, lane, markers) {
  const dir = join(output, lane.artifacts);
  const evidence = await readJson(join(dir, 'lane.json'));
  const detail = await readJson(join(dir, 'mock-session.json'));
  assert.equal(lane.mockCompleted, true);
  assert.equal(lane.sessionDeleted, true);
  assert.equal(evidence.workspaceProof.passed, true, JSON.stringify(evidence.workspaceProof));
  assert.deepEqual(evidence.observedMarkers, markers);
  assert.deepEqual(detail.completionProof.observedMarkers, markers);
  assert.equal(detail.scenarioCompleted, true);
  assert.equal(detail.summary.finalized, true);
  assert.equal(detail.summary.sessionId, lane.sessionId);
  assert.equal(detail.summary.runId, lane.runId);
  assert.equal(detail.summary.dropped, 0);
  assert.equal(detail.nextCursor, detail.summary.attempts);
  const final = detail.items.find(item => item.responseId === detail.completionProof.responseId
    && item.stepId === 'done' && item.outcome === 'completed');
  assert.equal(final?.purpose, 'main');
  return { dir, evidence, detail };
}

test('preflight reports all adapters and runs the version probe in isolated HOME', async t => {
  const dir = await scratch(t);
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  await Promise.all([mkdir(home), mkdir(bin)]);
  await writeFile(join(home, 'sentinel'), 'user config\n');
  await writeFile(join(bin, 'claude'),
    '#!/bin/sh\nprintf "isolated\\n" > "$HOME/probe-write"\nprintf "test-cli 1.0\\n"\n', { mode: 0o700 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: bin };
  const { stdout } = await invoke(['preflight', '--json'], { env });
  const probes = JSON.parse(stdout);
  assert.deepEqual(probes.map(probe => probe.id), [
    'ref-agent', 'maka-direct', 'maka-codemode', 'claude', 'codex-ws', 'codex-http',
    'opencode-cold', 'opencode-attach', 'pi', 'pi-durable', 'dim', 'dsh', 'zcode',
    'kimi-openai', 'kimi-responses', 'kimi-anthropic',
    'maka-host-direct', 'maka-host-codemode', 'opencode-serve', 'pi-durable-shared',
  ]);
  const claude = probes.find(probe => probe.id === 'claude');
  assert.equal(claude.binaryPath, join(bin, 'claude'));
  assert.equal(claude.version, 'test-cli 1.0');
  assert.equal(claude.available, true);
  assert.deepEqual(claude.supportedTracks, ['native', 'sharedMcp']);
  for (const id of ['codex-http', 'codex-ws', 'dim']) {
    assert.deepEqual(probes.find(probe => probe.id === id).supportedTracks, ['native', 'sharedMcp']);
  }
  const opencode = probes.find(probe => probe.id === 'opencode-cold');
  assert.equal(opencode.available, false);
  assert.match(opencode.installHint, /Install OpenCode/);
  assert.deepEqual(await readdir(home), ['sentinel']);
  assert.equal(await readFile(join(home, 'sentinel'), 'utf8'), 'user config\n');
});

test('smoke-edit runs four concurrent lanes per repeat and exports proof before cleanup', async t => {
  const { output, result, results } = await runScenario(t, 'smoke-edit', ['--lanes', '4', '--runs', '2']);
  assert.match(result.stdout, /\| smoke-edit \| native \| ref-agent \| 8\/8 passed \|/);
  const manifest = await readJson(join(output, 'manifest.json'));
  assert.equal(manifest.runId, results.runId);
  assert.equal(manifest.mockBinary, mockBinary);
  assert.equal(results.lanes.length, 8);
  assert.equal(new Set(results.lanes.map(lane => lane.sessionId)).size, 8);
  assert.equal(results.summary[0].verifiedWorkRate, 1);
  assert.equal(results.summary[0].watchdogViolationsTotal, 0);
  assert.equal(results.server.watchdog.totalViolations, 0);
  const report = await readFile(join(output, 'report.md'), 'utf8');
  assert.match(report, /\| smoke-edit \| native \| ref-agent \| 8 \| 100\.0% \| 100\.0% \|/);
  for (const repeat of [1, 2]) {
    const times = [];
    const lanes = results.lanes.filter(lane => lane.artifacts.startsWith('repeat-' + repeat + '/'));
    assert.deepEqual(lanes.map(lane => lane.logicalLane), ['lane-1', 'lane-2', 'lane-3', 'lane-4']);
    for (const lane of lanes) {
      const { dir, detail, evidence } = await laneEvidence(output, lane, ['SMOKE_EDIT_OK']);
      assert.equal(await readFile(join(dir, 'workspace', 'src', 'lib.rs'), 'utf8'), readySource);
      assert.equal(lane.completedToolRounds, 3);
      assert.deepEqual(detail.violations, []);
      const [segment] = evidence.process;
      assert.equal(segment.code, 0);
      assert.match(await readFile(join(dir, segment.stdoutLog), 'utf8'), /SMOKE_EDIT_OK/);
      times.push([BigInt(segment.startNs), BigInt(segment.endNs)]);
    }
    times.sort(([a], [b]) => a < b ? -1 : 1);
    assert.ok(times.some(([, end], index) => index + 1 < times.length && end > times[index + 1][0]),
      'Expected CLI process windows to overlap');
  }
  await assertCleanServer(results);
});

test('Shared MCP reconciles actual audit calls, workspace hash and mock tool receipts', async t => {
  const { output, results } = await runScenario(t, 'mcp-smoke-edit', ['--lanes', '2']);
  assert.equal(results.lanes.length, 2);
  for (const lane of results.lanes) {
    const { dir, detail, evidence } = await laneEvidence(output, lane, ['SMOKE_EDIT_OK']);
    const audit = (await readFile(join(dir, 'mcp-audit.jsonl'), 'utf8')).trimEnd().split('\n')
      .map(line => JSON.parse(line)).sort((a, b) => a.seq - b.seq);
    assert.deepEqual(audit.map(row => row.seq), [1, 2, 3, 4]);
    assert.deepEqual(audit.slice(0, 2).map(row => row.tool), ['bench_read_file', 'bench_edit_file']);
    assert.deepEqual(audit.slice(2).map(row => row.tool).sort(), ['bench_exec_shell', 'bench_read_file']);
    assert.ok(audit.every(row => row.ok));
    const workspace = await readFile(join(dir, 'workspace', 'src', 'lib.rs'), 'utf8');
    assert.equal(workspace, readySource);
    const hash = createHash('sha256').update(workspace).digest('hex');
    assert.deepEqual(evidence.workspaceProof.files.find(file => file.path === 'src/lib.rs'),
      { path: 'src/lib.rs', expectedSha256: hash, actualSha256: hash });
    const receipts = new Set(detail.items.flatMap(attempt => attempt.confirmedCallIds));
    assert.equal(receipts.size, audit.length);
    assert.equal(evidence.workspaceProof.mcpAudit.calls, receipts.size);
  }
  await assertCleanServer(results);
});

test('chaos-recovery retries real injected HTTP failures and stream disconnect', async t => {
  const { output, results } = await runScenario(t, 'chaos-recovery');
  const [lane] = results.lanes;
  const { dir, detail } = await laneEvidence(output, lane, ['CHAOS_RECOVERY_OK']);
  assert.equal(await readFile(join(dir, 'workspace', 'artifacts', 'recovery.txt'), 'utf8'), 'state=recovered\n');
  assert.deepEqual(detail.items.filter(item => item.faultId).map(item => item.faultId),
    ['read/1:Http429', 'write/1:Http503', 'interrupted-check/1:Disconnect']);
  assert.deepEqual(detail.items.filter(item => item.retryReason === 'scenario_replay' && item.outcome === 'completed')
    .map(item => item.stepId), ['read', 'write', 'interrupted-check']);
  assert.equal(lane.retries, 3);
  await assertCleanServer(results);
});

test('long-compaction adopts the returned checkpoint and reduces request context', async t => {
  const { output, results } = await runScenario(t, 'long-compaction');
  const [lane] = results.lanes;
  const { dir, detail } = await laneEvidence(output, lane, ['COMPACTION_OK', 'handoff-ticket-6f32']);
  assert.equal(await readFile(join(dir, 'workspace', 'state', 'handoff.txt'), 'utf8'),
    'fact=handoff-ticket-6f32\nstate=recovered\n');
  const [issued, adopted] = detail.compactions;
  assert.equal(issued.purpose, 'compact');
  assert.match(issued.checkpointId, /^cmp_/);
  assert.equal(adopted.adoptedCheckpointId, issued.checkpointId);
  assert.equal(adopted.purpose, 'main');
  assert.ok(lane.promptBytesPeak >= 131072 && lane.promptBytesFinal < 65536);
  assert.equal(results.server.metrics.contextOverflowsEmitted, 1);
  await assertCleanServer(results);
});

test('matrix rotates candidates and distinguishes an unavailable compatible adapter from an unsupported track', async t => {
  const dir = await scratch(t);
  const output = join(dir, 'output');
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await symlink('/bin/ps', join(bin, 'ps'));
  const { stdout } = await invoke([
    'matrix', '--scenarios', 'smoke-edit,mcp-smoke-edit', '--harnesses', 'pi,ref-agent',
    '--runs', '2', '--mock-bin', mockBinary, '--output', output,
  ], { env: { ...process.env, PATH: bin }, expectedCode: 1 });
  assert.match(stdout, /\| mcp-smoke-edit \| sharedMcp \| pi \| N\/A \(unsupported track\) \|/);
  const report = await readFile(join(output, 'matrix-report.md'), 'utf8');
  assert.match(report, /\| smoke-edit \| native \| pi \| 0\/2 passed \|/);
  assert.match(report, /\| mcp-smoke-edit \| sharedMcp \| pi \| N\/A \(unsupported track\) \|/);
  assert.match(report, /\| mcp-smoke-edit \| sharedMcp \| ref-agent \| 2\/2 passed \|/);
  const native = await readJson(join(output, 'scenario-1', 'results.json'));
  assert.deepEqual(native.lanes.map(lane => [lane.harness, lane.success]), [
    ['pi', false], ['ref-agent', true], ['ref-agent', true], ['pi', false],
  ]);
  for (const lane of native.lanes.filter(lane => !lane.success)) {
    assert.match(lane.failures.join('\n'), /could not locate pi/);
    assert.equal(lane.sessionDeleted, true);
  }
  const mcp = await readJson(join(output, 'scenario-2', 'results.json'));
  assert.deepEqual(mcp.lanes.map(lane => [lane.harness, lane.success]), [['ref-agent', true], ['ref-agent', true]]);
  await assertCleanServer(native);
  await assertCleanServer(mcp);
});

test('SIGKILL restarts the reference client with one workspace, session and MCP audit', async t => {
  const scratchDir = await scratch(t);
  const output = join(scratchDir, 'output');
  const scenarioPath = join(scratchDir, 'restart.json');
  const scenario = await readJson(new URL('scenarios/mcp-smoke-edit.json', import.meta.url));
  // Four 429s hold the second step in exponential backoff after the first tool receipt.
  scenario.faults = [1, 2, 3, 4].map(attempt => ({ step: 'edit', attempt, emit: 'http429' }));
  await writeFile(scenarioPath, JSON.stringify(scenario));
  await invoke([
    'run', '--scenario', scenarioPath, '--harnesses', 'ref-agent',
    '--mock-bin', mockBinary, '--output', output,
    '--sigkill-after-ms', '600', '--resume-after-kill',
  ]);
  const results = await readJson(join(output, 'results.json'));
  assert.equal(results.lanes.length, 1);
  const [lane] = results.lanes;
  const { dir, evidence, detail } = await laneEvidence(output, lane, ['SMOKE_EDIT_OK']);
  assert.deepEqual(evidence.process.map(({ signal, termination, code }) => [signal, termination, code]),
    [['SIGKILL', 'sigkill', null], [null, null, 0]]);
  assert.equal(await readFile(join(dir, 'workspace', 'src', 'lib.rs'), 'utf8'), readySource);
  assert.equal(evidence.workspaceProof.mcpAudit.calls, 4);
  assert.deepEqual(lane.watchdogViolations, []);
  assert.deepEqual(detail.items.filter(item => item.faultId).map(item => item.faultId),
    ['edit/1:Http429', 'edit/2:Http429', 'edit/3:Http429', 'edit/4:Http429']);
  await assertCleanServer(results);
});


async function runStress(t, suite, args, { harnesses = 'ref-agent', ...options } = {}) {
  const output = join(await scratch(t), 'output');
  const result = await invoke([
    'stress', '--suite', suite, '--harnesses', harnesses,
    '--mock-bin', mockBinary, '--output', output, ...args,
  ], options);
  return { output: join(output, suite), result };
}

test('deep-grind generates real filesystem work and measures history growth', async t => {
  const { output } = await runStress(t, 'deep-grind', ['--turns', '10', '--output-bytes', '16384']);
  const { version, fixture, steps } = await readJson(join(output, 'scenario.json'));
  assert.equal(version, 1);
  assert.equal(fixture, 'deep-grind-v1');
  assert.deepEqual(steps.filter(step => step.largeOutput).map(step => step.id), ['turn-5', 'turn-10']);
  assert.deepEqual(generateStressScenario('deep-grind', { turns: 10 }),
    await readJson(join(output, 'scenario.json')));
  const results = await readJson(join(output, 'results.json'));
  const [lane] = results.lanes;
  const { dir } = await laneEvidence(output, lane, ['DEEP_GRIND_OK']);
  assert.equal(await readFile(join(dir, 'workspace', 'state-6.txt'), 'utf8'), 'state=edited-8\n');
  assert.equal(lane.completedToolRounds, 10);
  assert.ok(lane.promptBytesFinal > 32_768);
  const { intervalsMs, headMedianMs, tailMedianMs, degradationRatio } = lane.turnLatencyCurve;
  assert.equal(intervalsMs.length, 10);
  assert.equal(degradationRatio, tailMedianMs / headMedianMs);
  await assertCleanServer(results);
});

test('burst-flood runs independent calls with UTF-8 output and samples the live cluster', async t => {
  const { output } = await runStress(t, 'burst-flood', ['--turns', '2', '--parallel', '8', '--lanes', '2']);
  const results = await readJson(join(output, 'results.json'));
  const [batch] = results.batches;
  assert.equal(batch.completedToolRounds, 4);
  assert.equal(batch.throughputTurnsPerSec, 4_000 / batch.wallMs);
  assert.ok(batch.peakClusterRssMib > 0);
  assert.ok(batch.peakClusterProcessCount >= 2);
  assert.deepEqual(Object.keys(batch.diskStateMib).sort(), ['lane-1', 'lane-2']);
  for (const lane of results.lanes) {
    const { dir, detail } = await laneEvidence(output, lane, ['BURST_FLOOD_OK']);
    assert.equal(new Set(detail.items.flatMap(item => item.confirmedCallIds)).size, 16);
    assert.ok(lane.promptBytesFinal >= 2 * 262_144);
    assert.ok(lane.turnLatencyCurve.intervalsMs.every(ms => ms >= 95));
    assert.equal(await readFile(join(dir, 'workspace', 'burst-output-2-6.txt'), 'utf8'), 'burst-result=2-6\n');
  }
  await assertCleanServer(results);
});

test('firehose reassembles fragmented multibyte JSON and final SSE text', async t => {
  const { output } = await runStress(t, 'firehose', [
    '--turns', '2', '--lanes', '2', '--chunk-chars', '16', '--wire-poison', '--latency-profile', 'frontier',
  ]);
  const results = await readJson(join(output, 'results.json'));
  const spec = await readJson(join(output, 'scenario.json'));
  for (const lane of results.lanes) {
    const { dir, detail } = await laneEvidence(output, lane, ['FIREHOSE_OK']);
    const { path, content } = spec.steps[0].writeFile;
    assert.equal(await readFile(join(dir, 'workspace', path), 'utf8'), content);
    assert.ok(detail.items[0].responseWireBytes > 4 * Buffer.byteLength(content));
    assert.ok(detail.items.every(item => item.simulatedDelayNs === 0));
  }
  await assertCleanServer(results);
});

test('cliff-ramp continues passing harnesses and stops at the first failed stage', async t => {
  const bin = await scratch(t);
  const { output } = await runStress(t, 'cliff-ramp', ['--steps', '1,2'], {
    harnesses: 'pi,ref-agent', env: { ...process.env, PATH: bin }, expectedCode: 1,
  });
  const [ref, pi] = await readJson(join(output, 'leaderboard.json'));
  assert.equal(ref.harness, 'ref-agent');
  assert.equal(ref.maxPassedLanes, 2);
  assert.equal(ref.breakingPoint, null);
  assert.equal(ref.stages[1].completedToolRounds, 24);
  assert.equal(pi.harness, 'pi');
  assert.equal(pi.breakingPoint.lanes, 1);
  assert.deepEqual(pi.stages.map(stage => stage.lanes), [1]);
  assert.deepEqual(await readdir(join(output, 'lanes-2')), ['ref-agent']);
  assert.match(await readFile(join(output, 'leaderboard.md'), 'utf8'), /Breaking-Point Cliff Leaderboard/);
  await assertCleanServer(await readJson(join(output, 'lanes-2', 'ref-agent', 'results.json')));
});

test('cliff-ramp records RSS termination and cleans all registered sessions', async t => {
  const { output } = await runStress(t, 'cliff-ramp', [
    '--steps', '2,4', '--latency-profile', 'frontier', '--max-cluster-rss-gib', '0.01',
  ], { expectedCode: 1 });
  const [row] = await readJson(join(output, 'leaderboard.json'));
  assert.equal(row.breakingPoint.lanes, 2);
  assert.equal(row.breakingPoint.termination, 'cluster_rss_limit_exceeded');
  assert.ok(row.breakingPoint.peakClusterRssMib > 10.24);
  assert.deepEqual(row.stages.map(stage => stage.lanes), [2]);
  const results = await readJson(join(output, 'lanes-2', 'ref-agent', 'results.json'));
  assert.ok(results.lanes.every(lane => lane.sessionDeleted && !lane.success));
  await assertCleanServer(results);
});


test('chaos-storm routes scheduled failures through poisoned streaming and verifies recovery', async t => {
  const { output } = await runStress(t, 'chaos-storm', ['--lanes', '2']);
  const results = await readJson(join(output, 'results.json'));
  for (const lane of results.lanes) {
    const { detail } = await laneEvidence(output, lane, ['CHAOS_STORM_OK']);
    assert.deepEqual(detail.items.filter(item => item.faultId).map(item => item.faultId), [
      'turn-1/1:Http429', 'turn-2/1:Http503', 'turn-3/1:Disconnect',
    ]);
    assert.equal(lane.completedToolRounds, 10);
  }
  await assertCleanServer(results);
});

test('one cluster abort kills both process groups and their inherited children', async () => {
  const controller = new AbortController();
  const monitor = new ClusterMonitor({ signal: controller.signal });
  const descendants = [];
  try {
    const processes = [1, 2].map(() => runMonitoredProcess({
      command: '/bin/sh', args: ['-c', '/bin/sleep 30 & printf "%s\n" "$!"; wait'],
      monitor, timeoutMs: 2000,
      onStdoutLine(line) {
        descendants.push(Number(line));
        if (descendants.length === 2) controller.abort(new Error('test interruption'));
      },
    }));
    const results = await Promise.all(processes);
    assert.deepEqual(results.map(result => result.termination), ['aborted', 'aborted']);
    for (const pid of descendants) {
      const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,stat=']);
      const row = stdout.split('\n').map(line => line.trim().split(/\s+/)).find(([id]) => Number(id) === pid);
      assert.ok(!row || row[1].startsWith('Z'), `Descendant still active: ${row}`);
    }
  } finally {
    await monitor.close();
  }
});
