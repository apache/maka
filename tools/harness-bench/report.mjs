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

const sideChannelPurposes = new Set([
  'title', 'probe', 'summary_aux', 'side', 'count_tokens', 'warmup', 'control',
]);

function summarizeAttempts(items) {
  const receiptRevisions = new Set();
  let newestRevision = 0;
  const turnStarts = new Map();
  let completedAttempts = 0;
  let retries = 0;
  let sideChannelCalls = 0;
  for (const item of items) {
    if (item.revision !== null) newestRevision = Math.max(newestRevision, item.revision);
    if (item.purpose === 'main' && Number.isFinite(item.revision) && Number.isFinite(item.headersReceivedNs)) {
      turnStarts.set(item.revision, Math.min(turnStarts.get(item.revision) ?? Infinity, item.headersReceivedNs));
    }
    if (item.outcome === 'completed') completedAttempts++;
    if (item.retryReason !== null) retries++;
    if (sideChannelPurposes.has(item.purpose)) sideChannelCalls++;
    for (const id of item.confirmedCallIds) {
      // The scenario emits call_<session scope>_<revision>_<slot>.
      const receipt = /^call_.+_(\d+)_\d+$/.exec(id);
      if (!receipt) throw new Error(`Invalid mock-ai scenario call ID: ${id}`);
      receiptRevisions.add(Number(receipt[1]));
    }
  }
  // One receipt from a parallel batch does not advance the scenario.
  const revisions = [...receiptRevisions].filter(revision => revision < newestRevision).sort((a, b) => a - b);
  const intervalsMs = revisions.map(revision => (turnStarts.get(revision + 1) - turnStarts.get(revision)) / 1e6)
    .filter(value => Number.isFinite(value) && value >= 0);
  const headMedianMs = median(intervalsMs.slice(0, 5).sort((a, b) => a - b));
  const tailMedianMs = median(intervalsMs.slice(-5).sort((a, b) => a - b));
  const turnLatencyCurve = {
    intervalsMs, headMedianMs, tailMedianMs,
    degradationRatio: intervalsMs.length >= 10 && headMedianMs > 0 ? tailMedianMs / headMedianMs : null,
  };
  return { completedAttempts, completedToolRounds: revisions.length, retries, sideChannelCalls, turnLatencyCurve };
}

function summarizePrompt(trajectory) {
  let promptBytesPeak = null;
  let promptBytesFinal = null;
  for (const point of trajectory) {
    if (point.purpose !== 'main') continue;
    promptBytesFinal = point.effectiveContextBytes;
    promptBytesPeak = Math.max(promptBytesPeak ?? 0, promptBytesFinal);
  }
  return { promptBytesPeak, promptBytesFinal };
}

export function reconcileLaneResult({ laneConfig, procResult, workspaceProof, sessionDetail }) {
  const { scenario, track, harness, logicalLane, expectedToolRounds, minAttempts } = laneConfig;
  const failures = [];
  const cliPassed = procResult?.code === 0 && procResult.signal === null
    && procResult.termination === null && !procResult.stdinError;
  if (!cliPassed) {
    const exit = procResult
      ? procResult.termination ?? procResult.signal ?? `exit ${procResult.code}`
      : 'missing process result';
    const input = procResult?.stdinError ? `, stdin: ${procResult.stdinError}` : '';
    failures.push(`CLI failed (${exit}${input})`);
  }

  const workspacePassed = workspaceProof?.passed === true;
  if (!workspacePassed) {
    const evidence = workspaceProof?.errors?.slice(0, 3).join(', ');
    failures.push(evidence ? `Workspace proof failed (${evidence})` : 'Workspace proof missing or failed');
  }

  const mockFailures = [];
  const mock = {};
  if (sessionDetail) {
    const { summary, items, violations, audit, attribution, registration } = sessionDetail;
    Object.assign(mock, summarizeAttempts(items), summarizePrompt(attribution.promptBytesTrajectory), {
      attempts: summary.attempts,
      watchdogViolations: violations,
      mockServiceSumMs: attribution.mockServiceSumNs / 1e6,
      mockUnionMs: attribution.mockUnionNs / 1e6,
      outsideMockWallMs: attribution.outsideMockWallNs / 1e6,
    });

    if (registration.scenario !== scenario || registration.harness !== harness
        || (logicalLane !== undefined && registration.logicalLane !== logicalLane)
        || (laneConfig.runId !== undefined && summary.runId !== laneConfig.runId)
        || (laneConfig.sessionId !== undefined && summary.sessionId !== laneConfig.sessionId)) {
      mockFailures.push('Mock session identity differs from the lane configuration');
    }
    if (!summary.finalized || sessionDetail.scenarioCompleted !== true) {
      mockFailures.push('Mock scenario completion unverified');
    }
    if (summary.dropped !== 0 || items.length !== summary.attempts) {
      mockFailures.push(`Mock attempt export incomplete (${items.length}/${summary.attempts} retained, ${summary.dropped} dropped)`);
    }
    if (audit?.auditIncomplete) mockFailures.push('Watchdog audit incomplete');
    if (violations.length > 0) mockFailures.push(`Watchdog reported ${violations.length} violation(s)`);
    if (mock.completedAttempts === 0) mockFailures.push('No completed mock attempts');
    if (expectedToolRounds !== undefined && mock.completedToolRounds !== expectedToolRounds) {
      mockFailures.push(`Completed tool rounds ${mock.completedToolRounds}/${expectedToolRounds}`);
    }
    if (minAttempts !== undefined && mock.attempts < minAttempts) {
      mockFailures.push(`Mock attempts ${mock.attempts}/${minAttempts} minimum`);
    }
  } else {
    mockFailures.push('Mock session detail missing');
  }

  const verifiedWork = workspacePassed && mockFailures.length === 0;
  return {
    scenario,
    track,
    harness,
    logicalLane,
    runId: sessionDetail?.summary.runId ?? laneConfig.runId,
    sessionId: sessionDetail?.summary.sessionId ?? laneConfig.sessionId,
    success: cliPassed && verifiedWork,
    verifiedWork,
    failures: [...failures, ...mockFailures],
    wallMs: procResult?.wallMs ?? null,
    peakRssMib: procResult?.peakRssKib > 0 ? procResult.peakRssKib / 1024 : null,
    mockServiceSumMs: mock.mockServiceSumMs ?? null,
    mockUnionMs: mock.mockUnionMs ?? null,
    outsideMockWallMs: mock.outsideMockWallMs ?? null,
    retries: mock.retries ?? null,
    sideChannelCalls: mock.sideChannelCalls ?? null,
    watchdogViolations: mock.watchdogViolations ?? null,
    promptBytesPeak: mock.promptBytesPeak ?? null,
    promptBytesFinal: mock.promptBytesFinal ?? null,
    attempts: mock.attempts ?? null,
    completedAttempts: mock.completedAttempts ?? null,
    completedToolRounds: mock.completedToolRounds ?? null,
    turnLatencyCurve: mock.turnLatencyCurve ?? null,
  };
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function distribution(records, field) {
  const values = records.map(record => record[field]).filter(Number.isFinite).sort((a, b) => a - b);
  const count = values.length;
  if (count === 0) return { median: null, min: null, max: null, p95: null };
  return {
    median: median(values),
    min: values[0],
    max: values[count - 1],
    p95: values[Math.ceil(count * 0.95) - 1],
  };
}

export function aggregateComparison(runRecords) {
  const groups = new Map();
  for (const record of runRecords) {
    const key = JSON.stringify([record.scenario, record.track, record.harness]);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  return Array.from(groups.values(), records => {
    const [{ scenario, track, harness }] = records;
    const runs = records.length;
    return {
      scenario,
      track,
      harness,
      runs,
      successRate: records.filter(record => record.success).length / runs,
      verifiedWorkRate: records.filter(record => record.verifiedWork).length / runs,
      wallMs: distribution(records, 'wallMs'),
      outsideMockWallMs: { median: distribution(records, 'outsideMockWallMs').median },
      mockUnionMs: { median: distribution(records, 'mockUnionMs').median },
      peakRssMib: { median: distribution(records, 'peakRssMib').median },
      watchdogViolationsTotal: records.reduce((sum, lane) => sum + (lane.watchdogViolations?.length ?? 0), 0),
      retriesTotal: records.reduce((sum, lane) => sum + (lane.retries ?? 0), 0),
    };
  }).sort((a, b) => a.scenario.localeCompare(b.scenario) || a.track.localeCompare(b.track)
    || a.harness.localeCompare(b.harness));
}

function markdownText(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/[\\|`*_\[\]<>]/g, '\\$&');
}

function measurement(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

function rate(value) {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderMarkdownReport(manifest, summary, lanes, batches) {
  const lines = ['# Harness benchmark', ''];
  if (manifest.runId !== undefined) lines.push(`Run ${markdownText(manifest.runId)}`, '');
  if (summary.length === 0) lines.push('No benchmark runs recorded.');
  else {
    lines.push(
      '| Scenario | Track | Harness | Runs | Success | Verified work | Wall median (ms) | Wall min–max (ms) | Wall p95 (ms) | Outside mock median (ms) | Mock union median (ms) | Peak RSS median (MiB) | Retries | Violations |',
      '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const row of summary) {
      const range = row.wallMs.min === null ? '—' : `${measurement(row.wallMs.min)}–${measurement(row.wallMs.max)}`;
      const cells = [
        markdownText(row.scenario), markdownText(row.track), markdownText(row.harness), row.runs,
        rate(row.successRate), rate(row.verifiedWorkRate), measurement(row.wallMs.median), range,
        measurement(row.wallMs.p95), measurement(row.outsideMockWallMs.median),
        measurement(row.mockUnionMs.median), measurement(row.peakRssMib.median),
        row.retriesTotal, row.watchdogViolationsTotal,
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
  }

  if (batches?.length) {
    lines.push('', '## Concurrent batches', '',
      '| Harness | Repeat | Passed | Wall ms | Tool rounds/s | Peak cluster RSS (MiB) | Peak processes | Max lane disk (MiB) | Shared disk (MiB) | Median degradation ratio | Termination |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const batch of batches) {
      const ratios = lanes.filter(lane => lane.harness === batch.harness && lane.artifacts.startsWith('repeat-' + batch.repeat + '/'))
        .map(lane => lane.turnLatencyCurve?.degradationRatio).filter(Number.isFinite).sort((a, b) => a - b);
      const { shared, ...laneDisk } = batch.diskStateMib ?? {};
      lines.push('| ' + [
        batch.harness, batch.repeat, batch.successfulLanes + '/' + batch.lanes, measurement(batch.wallMs),
        measurement(batch.throughputTurnsPerSec), measurement(batch.peakClusterRssMib),
        batch.peakClusterProcessCount ?? '—', measurement(Math.max(...Object.values(laneDisk))),
        measurement(shared), measurement(median(ratios)), batch.termination ?? '—',
      ].map(markdownText).join(' | ') + ' |');
    }
  }

  const failed = lanes.filter(lane => !lane.success || lane.watchdogViolations?.length > 0);
  if (failed.length) {
    lines.push('', '## Failures and violations', '');
    for (const lane of failed) {
      const label = [lane.scenario, lane.track, lane.harness, lane.logicalLane, lane.sessionId]
        .filter(value => value !== undefined).map(markdownText).join(' / ');
      lines.push(`- ${label} — ${lane.failures.map(markdownText).join('. ')}`);
      for (const violation of lane.watchdogViolations?.slice(0, 3) ?? []) {
        lines.push(`  - ${markdownText(violation.kind)} — ${markdownText(violation.detail).slice(0, 240)}`);
      }
      if (lane.watchdogViolations?.length > 3) {
        lines.push(`  - ${lane.watchdogViolations.length - 3} more violation(s)`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderCliffLeaderboard(rows) {
  const lines = [
    '# Breaking-Point Cliff Leaderboard', '',
    '| Harness | Highest passing stage | First failed stage | Passed lanes | Termination | Tool rounds/s at last stage | Peak RSS MiB at last stage |',
    '| --- | ---: | ---: | ---: | --- | ---: | ---: |',
  ];
  for (const { harness, maxPassedLanes, breakingPoint, stages } of rows) {
    const last = stages.at(-1);
    lines.push('| ' + [
      markdownText(harness), maxPassedLanes ?? '—',
      breakingPoint ? `[${breakingPoint.lanes}](${breakingPoint.report})` : '—',
      last ? (last.successfulLanes ?? 0) + '/' + last.lanes : '—',
      breakingPoint ? markdownText(breakingPoint.termination ?? breakingPoint.errors[0] ?? 'lane verification failed') : '—',
      measurement(last?.throughputTurnsPerSec), measurement(last?.peakClusterRssMib),
    ].join(' | ') + ' |');
  }
  return lines.join('\n') + '\n';
}
