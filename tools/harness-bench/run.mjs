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
import { mkdir, mkdtemp, readdir, realpath, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { getAdapter, listAdapters, probeAllAdapters } from './adapters.mjs';
import { loadScenario, materializeWorkspace, verifyWorkspace } from './fixtures.mjs';
import { MockAdminClient, resolveMockAiBinary, startMockAi } from './mock-client.mjs';
import { runMonitoredProcess } from './proc-monitor.mjs';
import { aggregateComparison, reconcileLaneResult, renderMarkdownReport } from './report.mjs';

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
  '  All commands that run lanes accept --mock-bin <path> and --output <directory>.',
].join('\n');

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const sharedOptions = { output: string, 'mock-bin': string, lanes: string };
const commandOptions = {
  preflight: { harnesses: string, json: boolean },
  run: {
    ...sharedOptions, harnesses: string, scenario: string, runs: string,
    'latency-profile': string, 'provider-dialect': string, 'timeout-ms': string,
    'sigkill-after-ms': string, 'resume-after-kill': boolean,
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
    const { supportedTracks, protocol, launchMode } = adapters.get(id);
    return { id, binaryPath: binaryPath ?? null, version: version ?? null, supportedTracks, protocol, launchMode, ...probe };
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

async function prepareLane({ output, adapter, spec, mock, admin, repeat, laneIndex, runId, options }) {
  const sessionId = randomUUID();
  const logicalLane = 'lane-' + (laneIndex + 1);
  const artifactDir = join('repeat-' + (repeat + 1), adapter.id, logicalLane);
  const laneDir = join(output, artifactDir);
  const workspaceDir = join(laneDir, 'workspace');
  const isolatedDir = join(laneDir, 'isolated');
  const mcpAuditPath = spec.track === 'sharedMcp' ? join(laneDir, 'mcp-audit.jsonl') : undefined;
  const identity = { runId, sessionId, harness: adapter.id, logicalLane, scenario: spec.scenario };
  const lane = { identity, laneDir, artifactDir, workspaceDir, mcpAuditPath, errors: [] };
  try {
    await mkdir(laneDir, { recursive: true, mode: 0o700 });
    lane.initialManifest = await materializeWorkspace(spec, workspaceDir);
    await mkdir(isolatedDir, { mode: 0o700 });
    await admin.registerSession({
      ...identity, launchMode: adapter.launchMode, workspace: workspaceDir,
    });
    lane.registered = true;
    const context = {
      ...identity, repoRoot, prompt, track: spec.track, workspace: workspaceDir, isolatedDir,
      scopedOrigin: mock.baseUrl, apiKey: 'maka-benchmark-' + sessionId, mcpAuditPath,
      resumeAfterKill: options.resumeAfterKill,
    };
    if (adapter.startDaemon) lane.daemon = await adapter.startDaemon(context);
    lane.invocation = await adapter.prepareInvocation({ ...context, daemonState: lane.daemon });
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

async function executeLane(lane, { admin, adapter, spec, options, signal }) {
  const { laneDir } = lane;
  const segments = [];
  let proc;
  let agentOutputText = '';
  try {
    if (lane.invocation) {
      proc = await runMonitoredProcess({
        ...lane.invocation, signal, timeoutMs: options.timeoutMs, sigkillAfterMs: options.sigkillAfterMs,
      });
      segments.push(proc);
      if (options.sigkillAfterMs !== undefined && proc.termination !== 'sigkill') {
        lane.errors.push('Scheduled SIGKILL did not occur');
      }
      if (proc.termination === 'sigkill' && options.resumeAfterKill) {
        proc = await runMonitoredProcess({ ...lane.invocation, signal, timeoutMs: options.timeoutMs });
        segments.push(proc);
      }
      // Only the final invocation can supply completion markers after a restart.
      agentOutputText = stripVTControlCharacters(proc.stdout);
    }
  } catch (error) {
    proc = null;
    diagnose(lane.errors, 'Lane process', error);
  } finally {
    if (lane.daemon) {
      try {
        await adapter.stopDaemon(lane.daemon);
      } catch (error) {
        diagnose(lane.errors, 'Daemon shutdown', error);
      }
    }
  }
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
  result.success &&= result.failures.length === 0;
  const record = {
    ...result, artifacts: lane.artifactDir,
    mockCompleted: sessionDetail?.scenarioCompleted === true, sessionDeleted: lane.deletion?.deleted === true,
  };
  await json(join(laneDir, 'lane.json'), {
    ...record, process: processEvidence, workspaceProof, observedMarkers, completionProof: lane.completionProof,
  });
  return {
    record,
    firstStart: segments[0]?.startNs,
    lastEnd: segments.at(-1)?.endNs,
  };
}

async function benchmark({ scenario, adapters, output, options, signal, calibrate }) {
  const { source: spec, path } = scenario;
  const runId = randomUUID();
  const candidates = adapters.map(({ id, protocol, launchMode, supportedTracks }) => ({ id, protocol, launchMode, supportedTracks }));
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
  let calibration;
  const errors = [];
  const server = {};
  let mock;
  let admin;
  try {
    manifest.mockBinary = resolveMockAiBinary(repoRoot, options.mockBin);
    mock = await startMockAi({
      binary: manifest.mockBinary, scenarioPath: path,
      latencyProfile: options.latencyProfile, providerDialect: options.providerDialect,
    });
    server.origin = mock.baseUrl;
    admin = new MockAdminClient(mock.baseUrl);
    if (calibrate) server.metricsBefore = await admin.metrics();
    for (const { repeat, harness } of batches) {
      signal.throwIfAborted();
      const adapter = getAdapter(harness);
      const lanes = await Promise.all(Array.from({ length: options.lanes }, (_, laneIndex) =>
        prepareLane({ output, adapter, spec, mock, admin, repeat, laneIndex, runId, options })));
      const finished = await Promise.allSettled(lanes.map(lane => executeLane(lane, { admin, adapter, spec, options, signal })));
      const starts = [];
      const ends = [];
      for (const [index, lane] of finished.entries()) {
        if (lane.status === 'fulfilled') {
          records.push(lane.value.record);
          if (lane.value.firstStart) starts.push(BigInt(lane.value.firstStart));
          if (lane.value.lastEnd) ends.push(BigInt(lane.value.lastEnd));
        } else {
          diagnose(errors, 'Could not record ' + lanes[index].artifactDir, lane.reason);
        }
      }
      if (calibrate && starts.length) {
        const start = starts.reduce((min, ns) => ns < min ? ns : min);
        const end = ends.reduce((max, ns) => ns > max ? ns : max);
        const wallMs = Number(end - start) / 1e6;
        const verifiedLanes = records.filter(row => row.success).length;
        calibration = { wallMs, verifiedLanes, verifiedLanesPerSecond: 1000 * verifiedLanes / wallMs };
      }
    }
  } catch (error) {
    diagnose(errors, 'Benchmark', error);
  } finally {
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
  const results = { runId, lanes: records, summary, server, errors, calibration };
  let report = renderMarkdownReport(manifest, summary, records);
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
    summary, calibration,
    passed: errors.length === 0 && records.length === batches.length * options.lanes && records.every(row => row.success),
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
  const options = {
    lanes: integer(values.lanes, 'lanes', calibrate ? 16 : 1),
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
