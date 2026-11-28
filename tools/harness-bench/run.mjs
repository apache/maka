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

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { getAdapter, listAdapters, probeAllAdapters, startProviderProxy } from './adapters.mjs';
import { loadScenario, materializeWorkspace, verifyWorkspace } from './fixtures.mjs';
import { MockAdminClient, resolveMockAiBinary, startMockAi } from './mock-client.mjs';
import { ClusterMonitor, runMonitoredProcess } from './proc-monitor.mjs';
import { aggregateComparison, reconcileLaneResult, renderMarkdownReport, renderCliffLeaderboard } from './report.mjs';

import { climbCliff, generateStressScenario, stressSuites } from './stress.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(directory, '../..');
const builtIns = ['smoke-edit', 'concurrency-fanout', 'long-compaction', 'chaos-recovery', 'mcp-smoke-edit'];
const prompt = 'Complete the benchmark task in this workspace. Use the supplied tools to inspect, edit, and verify files as directed, then return the final answer with its requested markers.';
const usage = [
  'Usage: node tools/harness-bench/run.mjs <command> [flags]',
  '  preflight [--harnesses a,b] [--json]',
  '  run --scenario <name|path> --harnesses a,b [--lanes 1] [--runs 1]',
  '      [--latency-profile instant|frontier|degraded] [--provider-dialect <dialect>]',
  '      [--timeout-ms 120000] [--sigkill-after-ms <ms>] [--resume-after-kill]',
  '  calibrate [--scenario smoke-edit] [--lanes 16]',
  '  matrix --harnesses a,b [--scenarios smoke-edit,concurrency-fanout,long-compaction,chaos-recovery,mcp-smoke-edit]',
  '      [--lanes 1] [--runs 1]',
  '  stress --suite deep-grind|burst-flood|cliff-ramp|chaos-storm|firehose|all --harnesses a,b',
  '      [--turns <n>] [--parallel 16] [--output-bytes <n>] [--steps 4,8,16,32,64,128]',
  '      [--lanes <n>] [--latency-profile instant|frontier] [--chunk-chars 16] [--wire-poison]',
  '      [--max-cluster-rss-gib 32] [--timeout-ms 120000]',
  '  All commands that run lanes accept --mock-bin <path> and --output <directory>.',
].join('\n');

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const sharedOptions = { output: string, 'mock-bin': string, lanes: string, 'max-cluster-rss-gib': string };
const commandOptions = {
  preflight: { harnesses: string, json: boolean },
  run: {
    ...sharedOptions, harnesses: string, scenario: string, runs: string,
    'latency-profile': string, 'provider-dialect': string, 'timeout-ms': string,
    'sigkill-after-ms': string, 'resume-after-kill': boolean,
  },
  stress: {
    ...sharedOptions, suite: string, harnesses: string, turns: string, parallel: string,
    'output-bytes': string, steps: string, 'chunk-chars': string, 'wire-poison': boolean,
    'latency-profile': string, 'timeout-ms': string, 'provider-dialect': string,
  },
  calibrate: { ...sharedOptions, scenario: string },
  matrix: { ...sharedOptions, harnesses: string, scenarios: string, runs: string },
};

function csv(value, flag) {
  const values = value?.split(',').map(item => item.trim());
  if (!values || values.some(item => !item) || new Set(values).size !== values.length) {
    throw new Error('Expected a comma-separated list of distinct values for --' + flag);
  }
  return values;
}

function integer(value, flag, fallback, minimum = 1) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < minimum || number > 2 ** 31 - 1) {
    throw new Error('Invalid --' + flag + ' value: ' + value);
  }
  return number;
}

function json(path, data) {
  return writeFile(path, JSON.stringify(data, null, 2) + '\n');
}

function diagnose(errors, stage, error) {
  errors.push(stage + ': ' + (error instanceof Error ? error.message : String(error)));
}

async function withOutput(path, run) {
  if (path !== undefined) {
    if (!path.trim()) throw new Error('--output requires a directory');
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const output = await realpath(path ?? await mkdtemp(join(tmpdir(), 'maka-harness-bench-')));
  const claim = join(output, '.running');
  await mkdir(claim);
  try {
    if ((await readdir(output)).some(entry => entry !== '.running')) {
      throw new Error('Output directory must be empty: ' + output);
    }
    console.log('Artifacts: ' + output);
    return await run(output);
  } finally {
    await rmdir(claim);
  }
}

async function scenarioConfig(value) {
  if (!value?.trim()) throw new Error('--scenario requires a built-in name or JSON path');
  const path = builtIns.includes(value) ? join(directory, 'scenarios', value + '.json') : resolve(value);
  const source = await loadScenario(path);
  return { path, source };
}

async function preflight(values) {
  const filter = values.harnesses === undefined ? undefined : csv(values.harnesses, 'harnesses');
  const adapters = new Map(listAdapters().map(adapter => [adapter.id, adapter]));
  const probes = await probeAllAdapters({ repoRoot, filter });
  const results = probes.map(({ id, binaryPath, version, ...probe }) => {
    const { supportedTracks, protocol, launchMode, shared } = adapters.get(id);
    return { id, binaryPath: binaryPath ?? null, version: version ?? null, supportedTracks, protocol, launchMode, sharedTracks: shared, ...probe };
  });
  if (values.json) console.log(JSON.stringify(results, null, 2));
  else {
    for (const probe of results) {
      const label = probe.id + ' [' + probe.supportedTracks.join(', ') + ']';
      if (probe.available) console.log(label + ' ' + probe.binaryPath + ' (' + probe.version + ')');
      else {
        const reason = probe.reason.split('\n')[0];
        console.log(label + ' unavailable' + (probe.binaryPath ? ' at ' + probe.binaryPath : '')
          + '\n  ' + reason + (reason.includes(probe.installHint) ? '' : '\n  ' + probe.installHint));
      }
    }
  }
}

async function prepareLane({ output, adapter, spec, origin, admin, repeat, laneIndex, runId, options, tempDirs }) {
  const sessionId = randomUUID();
  const logicalLane = 'lane-' + (laneIndex + 1);
  const artifactDir = join('repeat-' + (repeat + 1), adapter.id, logicalLane);
  const laneDir = join(output, artifactDir);
  const workspaceDir = join(laneDir, 'workspace');
  const isolatedDir = join(laneDir, 'isolated');
  const mcpAuditPath = spec.track === 'sharedMcp' ? join(laneDir, 'mcp-audit.jsonl') : undefined;
  const identity = { runId, sessionId, harness: adapter.id, logicalLane, scenario: spec.scenario };
  const lane = { identity, laneDir, artifactDir, workspaceDir, isolatedDir, mcpAuditPath, errors: [], segments: [] };
  try {
    await mkdir(laneDir, { recursive: true, mode: 0o700 });
    lane.initialManifest = await materializeWorkspace(spec, workspaceDir);
    await mkdir(isolatedDir, { mode: 0o700 });
    await admin.registerSession({
      ...identity, workspace: workspaceDir,
      launchMode: adapter.shared.includes(spec.track) ? 'shared-daemon' : adapter.startDaemon ? 'warm-daemon' : 'cold',
    });
    lane.registered = true;
    lane.context = {
      ...identity, repoRoot, prompt, track: spec.track, workspace: workspaceDir, isolatedDir,
      scopedOrigin: origin, apiKey: 'maka-benchmark-' + sessionId, mcpAuditPath, tempDirs,
      resumeAfterKill: options.resumeAfterKill,
    };
  } catch (error) {
    diagnose(lane.errors, 'Lane setup', error);
  }
  return lane;
}

async function finalizeWhenIdle(admin, sessionId, proof) {
  const deadline = performance.now() + 2000;
  while (true) {
    try {
      return await admin.finalizeSession(sessionId, proof);
    } catch (error) {
      // A killed client can exit before the server drops its response body.
      if (error.status !== 409 || !error.body.includes('in-flight attempts') || performance.now() >= deadline) throw error;
      await delay(20);
    }
  }
}

async function exportSession(lane, admin, finalStep, observedMarkers) {
  const { sessionId } = lane.identity;
  const detailPath = join(lane.laneDir, 'mock-session.json');
  const preliminary = await admin.getSessionDetailAll(sessionId);
  const response = preliminary.items.findLast(item => item.stepId === finalStep.id
    && item.purpose === 'main' && item.outcome === 'completed' && item.responseId);
  const markers = finalStep.finalAnswer.expectMarkers ?? [];
  const proof = response && observedMarkers.length === markers.length
    ? { responseId: response.responseId, observedMarkers } : undefined;
  let finalization;
  // Even unsuccessful lanes must export and release their mock session.
  if (proof) {
    try {
      finalization = await finalizeWhenIdle(admin, sessionId, proof);
    } catch (error) {
      if (error.status !== 422) throw error;
      diagnose(lane.errors, 'Mock rejected completion proof', error);
    }
  }
  try {
    finalization ??= await finalizeWhenIdle(admin, sessionId);
    const detail = await admin.getSessionDetailAll(sessionId, { finalization });
    await json(detailPath, { ...detail, completionProof: detail.scenarioCompleted ? proof : null });
    lane.sessionDetail = detail;
    lane.completionProof = detail.scenarioCompleted ? proof : null;
    lane.deletion = await admin.deleteSession(sessionId, { cursor: finalization.cursor, after: detail.nextCursor });
    if (lane.deletion.deleted !== true) throw new Error('Mock did not acknowledge session deletion');
  } catch (error) {
    if (!lane.sessionDetail) await json(detailPath, { ...preliminary, completionProof: null });
    throw error;
  }
}

async function executeLane(lane, { adapter, options, monitor, abortBatch, sharedDaemon }) {
  if (!lane.context) return;
  let daemon;
  try {
    monitor.signal.throwIfAborted();
    const ctx = { ...lane.context, monitor, abortBatch };
    daemon = !sharedDaemon && adapter.startDaemon ? await adapter.startDaemon(ctx) : undefined;
    const invocation = await adapter.prepareInvocation({ ...ctx, daemonState: sharedDaemon ?? daemon });
    const processOptions = { ...invocation, monitor, timeoutMs: options.timeoutMs, onTimeout: abortBatch };
    const proc = await runMonitoredProcess({ ...processOptions, sigkillAfterMs: options.sigkillAfterMs });
    lane.segments.push(proc);
    if (options.sigkillAfterMs !== undefined && proc.termination !== 'sigkill') {
      lane.errors.push('Scheduled SIGKILL did not occur');
    }
    if (proc.termination === 'sigkill' && options.resumeAfterKill) {
      lane.segments.push(await runMonitoredProcess(processOptions));
    }
  } catch (error) {
    diagnose(lane.errors, 'Lane process', error);
  } finally {
    if (daemon) {
      try {
        await adapter.stopDaemon(daemon);
      } catch (error) {
        diagnose(lane.errors, 'Daemon shutdown', error);
      }
    }
  }
}

async function recordLane(lane, { admin, spec, diskStateMib, termination }) {
  const { laneDir, segments } = lane;
  const proc = segments.at(-1);
  // Only the final invocation can supply completion markers after a restart.
  const agentOutputText = stripVTControlCharacters(proc?.stdout ?? '');
  const processEvidence = await Promise.all(segments.map(async ({ stdout, stderr, ...metrics }, index) => {
    const prefix = 'segment-' + (index + 1);
    const stdoutLog = prefix + '.stdout.log';
    const stderrLog = prefix + '.stderr.log';
    const writes = await Promise.allSettled([writeFile(join(laneDir, stdoutLog), stdout), writeFile(join(laneDir, stderrLog), stderr)]);
    for (const write of writes) {
      if (write.status === 'rejected') diagnose(lane.errors, 'Process log write', write.reason);
    }
    return { ...metrics, stdoutLog, stderrLog };
  }));

  let workspaceProof;
  if (lane.initialManifest) {
    try {
      workspaceProof = await verifyWorkspace(spec, {
        workspaceDir: lane.workspaceDir, initialManifest: lane.initialManifest,
        agentOutputText, mcpAuditPath: lane.mcpAuditPath,
      });
    } catch (error) {
      diagnose(lane.errors, 'Workspace verification', error);
    }
  }

  const finalStep = spec.steps.at(-1);
  const observedMarkers = (finalStep.finalAnswer.expectMarkers ?? [])
    .filter(marker => agentOutputText.includes(marker));
  if (lane.registered) {
    try {
      await exportSession(lane, admin, finalStep, observedMarkers);
    } catch (error) {
      diagnose(lane.errors, 'Mock session export or cleanup', error);
    }
  }
  const sessionDetail = lane.sessionDetail;
  const toolRounds = spec.steps.filter(step => !step.finalAnswer && !step.triggerCompaction
    && ![step.badToolCall, step.unknownTool].some(action => action && action.expectHandling !== 'toolError'));
  const result = reconcileLaneResult({
    laneConfig: { ...lane.identity, track: spec.track, expectedToolRounds: toolRounds.length },
    procResult: proc && {
      ...proc,
      wallMs: segments.reduce((sum, segment) => sum + segment.wallMs, 0),
      peakRssKib: Math.max(...segments.map(segment => segment.peakRssKib)),
    },
    workspaceProof,
    sessionDetail,
  });
  if (workspaceProof?.mcpAudit && sessionDetail) {
    const confirmedCalls = new Set(sessionDetail.items.flatMap(item => item.confirmedCallIds)).size;
    if (confirmedCalls !== workspaceProof.mcpAudit.calls) {
      result.verifiedWork = false;
      lane.errors.push('MCP audit has ' + workspaceProof.mcpAudit.calls + ' calls but mock confirmed ' + confirmedCalls);
    }
  }
  result.failures.push(...lane.errors);
  if (termination && !result.success && !result.failures.some(error => error.includes(termination))) {
    result.failures.push(termination);
  }
  result.success &&= result.failures.length === 0;
  const record = {
    ...result, artifacts: lane.artifactDir, diskStateMib,
    mockCompleted: sessionDetail?.scenarioCompleted === true, sessionDeleted: lane.deletion?.deleted === true,
  };
  await json(join(laneDir, 'lane.json'), {
    ...record, process: processEvidence, workspaceProof, observedMarkers, completionProof: lane.completionProof,
  });
  return record;
}

function processWindow(lanes) {
  const segments = lanes.flatMap(lane => lane.segments);
  if (!segments.length) return null;
  const starts = segments.map(segment => BigInt(segment.startNs));
  const ends = segments.map(segment => BigInt(segment.endNs));
  return Number(ends.reduce((a, b) => a > b ? a : b) - starts.reduce((a, b) => a < b ? a : b)) / 1e6;
}

async function runBatch({ output, adapter, spec, origin, admin, repeat, runId, options, signal, errors }) {
  const tempDirs = new Set();
  const lanes = await Promise.all(Array.from({ length: options.lanes }, (_, laneIndex) =>
    prepareLane({ output, adapter, spec, origin, admin, repeat, laneIndex, runId, options, tempDirs })));
  const batchController = new AbortController();
  const abortBatch = (reason = 'timeout') => batchController.abort(new Error(reason));
  const batchSignal = AbortSignal.any([signal, batchController.signal]);
  const shared = adapter.shared.includes(spec.track);
  const batchArtifact = join('repeat-' + (repeat + 1), adapter.id);
  const sharedDir = join(output, batchArtifact, 'shared-state');
  const stateDirs = new Map(lanes.map(lane => [lane.identity.logicalLane, lane.isolatedDir]));
  if (shared) stateDirs.set('shared', sharedDir);
  const monitor = new ClusterMonitor({ signal: batchSignal, stateDirs, maxClusterRssGib: options.maxClusterRssGib });
  let daemon;
  let stopping = false;
  let resources;
  let wallMs;
  let sharedProcess;
  try {
    monitor.signal.throwIfAborted();
    const active = lanes.filter(lane => lane.context);
    if (shared && active.length) {
      const ctx = { ...active[0].context, workspace: sharedDir, isolatedDir: sharedDir, monitor, abortBatch };
      const contexts = active.map(lane => lane.context);
      await mkdir(sharedDir);
      if (adapter.prepareBatch) {
        if (options.sigkillAfterMs !== undefined) throw new Error('SIGKILL injection requires a lane process');
        const invocation = await adapter.prepareBatch(ctx, contexts);
        const answers = new Map();
        const proc = await runMonitoredProcess({
          ...invocation, timeoutMs: options.timeoutMs, monitor, onTimeout: abortBatch,
          onStdoutLine(line) {
            const row = JSON.parse(line);
            if (answers.has(row.logicalLane)) throw new Error('Duplicate result from ' + row.logicalLane);
            answers.set(row.logicalLane, row);
          },
        });
        wallMs = proc.wallMs;
        if (!proc.termination && (proc.code !== 0 || proc.stdinError)) {
          errors.push(adapter.id + ' shared process failed (' + (proc.stdinError ?? proc.signal ?? proc.code) + ')');
        }
        const { stdout, stderr, ...metrics } = proc;
        sharedProcess = { ...metrics, stderrLog: join(batchArtifact, 'shared.stderr.log') };
        await writeFile(join(output, sharedProcess.stderrLog), stderr);
        for (const lane of active) {
          const answer = answers.get(lane.identity.logicalLane);
          if (!answer && proc.code === 0) lane.errors.push('Shared process did not return a lane result');
          if (answer?.error) lane.errors.push(answer.error);
          lane.segments.push({
            ...proc, stdout: answer?.answer ?? '', stderr: '', wallMs: answer?.wallMs ?? proc.wallMs,
            ...(answer ? { code: answer.error ? 1 : 0, signal: null, termination: null } : {}),
            stdoutTruncated: false, stderrTruncated: false,
            peakRssKib: 0, peakProcessCount: 0, samples: [],
          });
        }
      } else {
        daemon = await adapter.startDaemon(ctx, contexts);
        void daemon.exited.then(() => {
          if (!stopping) abortBatch('shared_daemon_exited');
        });
      }
    }
    if (!adapter.prepareBatch) {
      await Promise.all(lanes.map(lane => executeLane(lane, { adapter, options, monitor, abortBatch, sharedDaemon: daemon })));
      wallMs = processWindow(lanes);
    }
  } catch (error) {
    for (const lane of lanes) diagnose(lane.errors, 'Batch process', error);
  } finally {
    stopping = true;
    if (daemon) {
      try {
        await adapter.stopDaemon(daemon);
      } catch (error) {
        for (const lane of lanes) diagnose(lane.errors, 'Daemon shutdown', error);
      }
    }
    try {
      resources = await monitor.close();
    } catch (error) {
      diagnose(errors, 'Cluster monitor', error);
    }
    const cleanup = await Promise.allSettled([...tempDirs].map(path => rm(path, { recursive: true, force: true })));
    for (const result of cleanup) {
      if (result.status === 'rejected') diagnose(errors, 'Temporary process directory cleanup', result.reason);
    }
  }
  const termination = monitor.signal.aborted ? monitor.signal.reason.message : null;
  const finished = await Promise.allSettled(lanes.map(lane => recordLane(lane, {
    admin, spec, termination, diskStateMib: resources?.diskStateMib[lane.identity.logicalLane] ?? null,
  })));
  const records = [];
  for (const [index, result] of finished.entries()) {
    if (result.status === 'fulfilled') records.push(result.value);
    else diagnose(errors, 'Could not record ' + lanes[index].artifactDir, result.reason);
  }
  const successfulLanes = records.filter(row => row.success).length;
  const completedToolRounds = records.reduce((sum, lane) => sum + (lane.completedToolRounds ?? 0), 0);
  return { records, batch: {
    repeat: repeat + 1, harness: adapter.id, lanes: options.lanes, successfulLanes,
    successRate: successfulLanes / options.lanes, termination, wallMs: wallMs ?? null, completedToolRounds,
    throughputTurnsPerSec: wallMs > 0 ? completedToolRounds * 1000 / wallMs : null, sharedProcess, ...resources,
  } };
}

async function benchmark({ scenario, adapters, output, options, signal, calibrate }) {
  const { source: spec, path } = scenario;
  const runId = randomUUID();
  const candidates = adapters.map(({ id, protocol, launchMode, supportedTracks, shared }) => ({
    id, protocol, launchMode, supportedTracks, sharedTracks: shared,
  }));
  const batches = [];
  for (let repeat = 0; repeat < options.runs; repeat++) {
    for (let index = 0; index < adapters.length; index++) {
      batches.push({ repeat, harness: adapters[(repeat + index) % adapters.length].id });
    }
  }
  const manifest = {
    runId, scenario: spec.scenario, track: spec.track, scenarioPath: path,
    startedAt: new Date().toISOString(), candidates, batches, ...options, mockBinary: null,
  };
  const records = [];
  const batchMetrics = [];
  let calibration;
  const errors = [];
  const server = {};
  let mock;
  let proxy;
  let discovery;
  let admin;
  try {
    manifest.mockBinary = resolveMockAiBinary(repoRoot, options.mockBin);
    mock = await startMockAi({
      binary: manifest.mockBinary, scenarioPath: path,
      latencyProfile: options.latencyProfile, providerDialect: options.providerDialect,
      extraArgs: [
        ...(options.wire?.chunkChars ? ['--chunk-chars', String(options.wire.chunkChars)] : []),
        ...(options.wire?.wirePoison ? ['--wire-poison'] : []),
      ],
    });
    server.origin = mock.baseUrl;
    admin = new MockAdminClient(mock.baseUrl);
    if (options.wire?.retryAfterMs && adapters.some(adapter => adapter.protocol !== 'openai-responses-ws')) {
      proxy = await startProviderProxy(mock.baseUrl, { retryAfterMs: options.wire.retryAfterMs });
    }
    if (spec.track === 'sharedMcp' && adapters.some(adapter => adapter.harness === 'maka')) {
      discovery = await startProviderProxy(mock.baseUrl, { discoverMcp: true });
    }
    if (calibrate) server.metricsBefore = await admin.metrics();
    for (const { repeat, harness } of batches) {
      signal.throwIfAborted();
      const adapter = getAdapter(harness);
      const routed = adapter.harness === 'maka' ? discovery ?? proxy : proxy;
      const origin = adapter.protocol === 'openai-responses-ws' ? mock.baseUrl : routed?.origin ?? mock.baseUrl;
      const { records: batchRecords, batch } = await runBatch({
        output, adapter, spec, origin, admin, repeat, runId, options, signal, errors,
      });
      records.push(...batchRecords);
      batchMetrics.push(batch);
      if (calibrate && batch.wallMs > 0) {
        const { wallMs, successfulLanes: verifiedLanes } = batch;
        calibration = { wallMs, verifiedLanes, verifiedLanesPerSecond: 1000 * verifiedLanes / wallMs };
      }
    }
  } catch (error) {
    diagnose(errors, 'Benchmark', error);
  } finally {
    const stopped = await Promise.allSettled([proxy, discovery].filter(Boolean).map(server => server.stop()));
    for (const result of stopped) {
      if (result.status === 'rejected') diagnose(errors, 'Provider proxy shutdown', result.reason);
    }
    if (admin) {
      try {
        [server.metrics, server.sessionsAfterCleanup, server.watchdog] = await Promise.all([
          admin.metrics(), admin.listSessions({ run: runId }), admin.violations(),
        ]);
        if (server.sessionsAfterCleanup.items.length) errors.push('Mock still has sessions after cleanup');
        const exportedViolations = records.reduce((total, row) => total + (row.watchdogViolations?.length ?? 0), 0);
        if (server.watchdog.totalViolations > exportedViolations) {
          errors.push('Mock recorded watchdog violations outside the exported lane diagnostics');
        }
      } catch (error) {
        diagnose(errors, 'Mock metrics or cleanup check', error);
      }
    }
    if (mock) {
      try {
        server.exit = await mock.stop();
        if (server.exit.code !== 0) errors.push('Mock shutdown failed: ' + (server.exit.signal ?? server.exit.code));
      } catch (error) {
        diagnose(errors, 'Mock shutdown', error);
      }
    }
  }

  const summary = aggregateComparison(records);
  const results = { runId, lanes: records, batches: batchMetrics, summary, server, errors, calibration };
  let report = renderMarkdownReport(manifest, summary, records, batchMetrics);
  if (calibrate && calibration) {
    report += '\n## Calibration\n\n' + calibration.verifiedLanesPerSecond.toFixed(2)
      + ' verified lanes/s over the ' + calibration.wallMs.toFixed(1)
      + ' ms batch process window.\n';
    if (server.metrics) {
      const { totalRequests, ttftMs, turnDurationMs, abandonedStreams } = server.metrics;
      report += '\nMock handled ' + (totalRequests - server.metricsBefore.totalRequests)
        + ' model requests with p95 TTFT of ' + ttftMs.p95 + ' ms, p95 turn duration of '
        + turnDurationMs.p95 + ' ms and ' + abandonedStreams + ' abandoned streams. '
        + 'Full metrics snapshots are in results.json.\n';
    }
  }
  if (errors.length) report += '\n## Run errors\n\n' + errors.map(error => '- ' + error).join('\n') + '\n';
  await Promise.all([
    json(join(output, 'manifest.json'), manifest),
    json(join(output, 'results.json'), results),
    writeFile(join(output, 'report.md'), report),
  ]);
  return {
    summary, calibration, batches: batchMetrics, errors,
    passed: errors.length === 0 && records.length === batches.length * options.lanes && records.every(row => row.success)
      && batchMetrics.every(batch => !batch.termination),
  };
}

const markdown = value => String(value).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
const ms = value => value == null ? '—' : value.toFixed(1);

function overview(rows) {
  const lines = [
    '| Scenario | Track | Adapter | Result | Wall ms (median) | Mock union ms | Outside mock ms |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |',
  ];
  for (const { scenario, track, harness, result, summary } of rows) {
    lines.push('| ' + [
      scenario, track, harness, result,
      ms(summary?.wallMs.median), ms(summary?.mockUnionMs.median), ms(summary?.outsideMockWallMs.median),
    ].map(markdown).join(' | ') + ' |');
  }
  return lines.join('\n');
}

function overviewRow(scenario, track, harness, summary) {
  const result = summary
    ? Math.round(summary.runs * summary.successRate) + '/' + summary.runs + ' passed' : 'Failed';
  return { scenario, track, harness, result, summary };
}

async function matrix({ scenarios, adapters, output, options, signal }) {
  const rows = [];
  const links = [];
  let passed = true;
  for (const [index, scenario] of scenarios.entries()) {
    if (signal.aborted) {
      passed = false;
      break;
    }
    const { scenario: name, track } = scenario.source;
    const compatible = adapters.filter(adapter => adapter.supportedTracks.includes(track));
    const folder = 'scenario-' + (index + 1);
    let summary = [];
    if (compatible.length) {
      const scenarioOutput = join(output, folder);
      await mkdir(scenarioOutput);
      const result = await benchmark({ scenario, adapters: compatible, output: scenarioOutput, options, signal });
      summary = result.summary;
      passed &&= result.passed;
      links.push('- ' + markdown(name) + ' [' + folder + '/report.md](' + folder + '/report.md)'
        + (result.passed ? '' : ' (failed)'));
    }
    for (const adapter of adapters) {
      const row = overviewRow(name, track, adapter.id, summary.find(item => item.harness === adapter.id));
      if (!adapter.supportedTracks.includes(track)) row.result = 'N/A (unsupported track)';
      rows.push(row);
    }
  }
  const table = overview(rows);
  await writeFile(join(output, 'matrix-report.md'), '# Harness benchmark matrix\n\n' + table
    + '\n\n' + links.join('\n') + '\n');
  console.log(table);
  return passed;
}

function stressConfig(values) {
  const suites = values.suite === 'all' ? stressSuites : [values.suite];
  if (suites.some(suite => !stressSuites.includes(suite))) throw new Error('Invalid --suite. See stress --help.');
  const steps = csv(values.steps ?? '4,8,16,32,64,128', 'steps').map(step => integer(step, 'steps'));
  if (steps.some((lanes, index) => index > 0 && lanes <= steps[index - 1])) {
    throw new Error('--steps must be strictly increasing');
  }
  const latency = values['latency-profile'] ?? 'instant';
  if (!['instant', 'frontier'].includes(latency)) throw new Error('Invalid stress --latency-profile');
  const turns = integer(values.turns, 'turns');
  if (turns > 1023) throw new Error('--turns must be at most 1023');
  if (suites.includes('chaos-storm') && turns < 5) throw new Error('chaos-storm needs at least 5 turns');
  const parallel = integer(values.parallel, 'parallel', 16, 4);
  if (parallel > 32) throw new Error('--parallel must be at most 32');
  const outputBytes = integer(values['output-bytes'], 'output-bytes');
  if (outputBytes > 1024 ** 2) throw new Error('--output-bytes must be at most 1 MiB (1048576)');
  return { suites, steps, turns, parallel, outputBytes, latency,
    chunkChars: integer(values['chunk-chars'], 'chunk-chars', 16), wirePoison: values['wire-poison'] ?? false };
}

async function stress({ config, adapters, output, options, signal }) {
  let passed = true;
  for (const suite of config.suites) {
    if (signal.aborted) break;
    const suiteDir = join(output, suite);
    await mkdir(suiteDir);
    const scenario = { path: join(suiteDir, 'scenario.json'), source: generateStressScenario(suite, config) };
    await json(scenario.path, scenario.source);
    const wire = suite === 'firehose' || suite === 'chaos-storm' || config.wirePoison ? {
      chunkChars: suite === 'firehose' ? config.chunkChars : undefined,
      retryAfterMs: suite === 'chaos-storm' ? 80 : undefined, wirePoison: config.wirePoison || suite === 'chaos-storm',
    } : undefined;
    const settings = { ...options, wire,
      latencyProfile: suite === 'firehose' ? 'instant' : config.latency,
      lanes: options.lanes ?? (['chaos-storm', 'firehose'].includes(suite) ? 8 : 1),
    };
    if (suite === 'cliff-ramp') {
      const leaderboard = await climbCliff({
        adapters, steps: config.steps, signal, async runStage(harness, lanes) {
          const relative = join('lanes-' + lanes, harness);
          const stageDir = join(suiteDir, relative);
          await mkdir(stageDir, { recursive: true });
          const result = await benchmark({
            scenario, adapters: [getAdapter(harness)], output: stageDir, options: { ...settings, lanes }, signal,
          });
          const [batch] = result.batches;
          return { ...batch, lanes, passed: result.passed, errors: result.errors, report: join(relative, 'report.md') };
        },
      });
      const report = renderCliffLeaderboard(leaderboard);
      await Promise.all([
        json(join(suiteDir, 'leaderboard.json'), leaderboard),
        writeFile(join(suiteDir, 'leaderboard.md'), report),
      ]);
      console.log(report);
      passed &&= leaderboard.every(row => !row.breakingPoint);
    } else {
      const result = await benchmark({ scenario, adapters, output: suiteDir, options: settings, signal });
      console.log(overview(adapters.map(adapter => overviewRow(
        suite, scenario.source.track, adapter.id, result.summary.find(row => row.harness === adapter.id),
      ))));
      passed &&= result.passed;
    }
  }
  return passed;
}

async function main(args, signal) {
  const [command, ...tokens] = args;
  if (!command || ['-h', '--help', 'help'].includes(command)) {
    console.log(usage);
    return true;
  }
  if (!Object.hasOwn(commandOptions, command)) throw new Error('Unknown command ' + command + '\n' + usage);
  const { values } = parseArgs({ args: tokens, options: { ...commandOptions[command], help: boolean } });
  if (values.help) {
    console.log(usage);
    return true;
  }
  if (command === 'preflight') {
    await preflight(values);
    return true;
  }

  const calibrate = command === 'calibrate';
  const adapters = calibrate ? [getAdapter('ref-agent')] : csv(values.harnesses, 'harnesses').map(getAdapter);
  const maxClusterRssGib = Number(values['max-cluster-rss-gib'] ?? 32);
  if (!Number.isFinite(maxClusterRssGib) || maxClusterRssGib <= 0) throw new Error('Invalid --max-cluster-rss-gib');
  const options = {
    maxClusterRssGib,
    lanes: integer(values.lanes, 'lanes', command === 'stress' ? undefined : calibrate ? 16 : 1),
    runs: integer(values.runs, 'runs', 1),
    timeoutMs: integer(values['timeout-ms'], 'timeout-ms', 120_000),
    sigkillAfterMs: integer(values['sigkill-after-ms'], 'sigkill-after-ms', undefined, 0),
    resumeAfterKill: values['resume-after-kill'] ?? false,
    latencyProfile: values['latency-profile'] ?? 'instant',
    providerDialect: values['provider-dialect'],
    mockBin: values['mock-bin'],
  };
  if (options.resumeAfterKill && options.sigkillAfterMs === undefined) {
    throw new Error('--resume-after-kill requires --sigkill-after-ms');
  }
  if (options.sigkillAfterMs >= options.timeoutMs) throw new Error('--sigkill-after-ms must be less than --timeout-ms');
  if (command === 'stress') {
    const config = stressConfig(values);
    return withOutput(values.output, output => stress({ config, adapters, output, options, signal }));
  }
  if (command === 'matrix') {
    const names = values.scenarios === undefined ? builtIns : csv(values.scenarios, 'scenarios');
    const scenarios = await Promise.all(names.map(scenarioConfig));
    return withOutput(values.output, output => matrix({ scenarios, adapters, output, options, signal }));
  }

  const scenario = await scenarioConfig(values.scenario ?? (calibrate ? 'smoke-edit' : undefined));
  for (const adapter of adapters) {
    if (!adapter.supportedTracks.includes(scenario.source.track)) {
      throw new Error(adapter.id + ' does not support track ' + scenario.source.track);
    }
  }
  return withOutput(values.output, async output => {
    const result = await benchmark({ scenario, adapters, output, options, signal, calibrate });
    console.log(overview(adapters.map(adapter => overviewRow(
      scenario.source.scenario, scenario.source.track, adapter.id,
      result.summary.find(row => row.harness === adapter.id),
    ))));
    if (result.calibration) console.log(result.calibration.verifiedLanesPerSecond.toFixed(2) + ' verified lanes/s');
    return result.passed;
  });
}

const stop = new AbortController();
const interrupt = () => stop.abort(new Error('Benchmark interrupted'));
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  process.exitCode = await main(process.argv.slice(2), stop.signal) && !stop.signal.aborted ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
