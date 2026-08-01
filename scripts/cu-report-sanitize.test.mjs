import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeCuDirectReport, sanitizeCuReport } from './cu-report-sanitize.mjs';

test('CU reports keep metrics while dropping typed text, coordinates, URL secrets, and trace payloads', () => {
  const secret = 'secret-canary';
  const report = sanitizeCuDirectReport({
    schemaVersion: 1,
    evidenceClass: 'real-runtime',
    scenarioId: 'l1-single-click',
    model: 'gpt-test',
    baseUrl: `https://user:${secret}@example.test/v1?token=${secret}`,
    actions: [
      {
        action: { type: 'type', text: secret, x: 12, y: 34 },
        durationMs: 5,
        text: `computer.type failed: unsupported_action ${secret}`,
      },
    ],
    traces: [
      {
        type: 'dispatch',
        actionType: 'type',
        expectedPid: 42,
        winnerPid: 84,
        title: secret,
        raw: { secret },
        durationMs: 4,
      },
    ],
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.endpointOrigin, 'https://example.test');
  assert.deepEqual(report.actions, [
    {
      type: 'type',
      durationMs: 5,
      resultCode: 'unsupported_action',
    },
  ]);
  assert.deepEqual(report.traces, [
    {
      type: 'dispatch',
      actionType: 'type',
      expectedPid: 42,
      winnerPid: 84,
      durationMs: 4,
    },
  ]);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /"x":12|"y":34/);
});

test('canonical evidence keeps attribution and lineage without private fields', () => {
  const generatedAt = '2026-07-12T00:00:00.000Z';
  const gitRevision = '0123456789abcdef0123456789abcdef01234567';
  const report = sanitizeCuReport({
    schemaVersion: 1,
    runId: 'run-1',
    gitRevision,
    generatedAt,
    contentLineage: {
      generator: 'scripts/cu-real-ax-model-e2e.mjs',
      gitRevision,
      generatedAt,
    },
    evidenceClass: 'fault-injection',
    scenarioId: 'appkit-ax-intervention-recovery',
    producer: 'cu-real-ax-model-e2e',
    transportClass: 'live-network',
    policyMode: 'enforced',
    qualificationEligible: false,
    provider: 'openai',
    model: 'gpt-5.4',
    status: 'inconclusive',
    run: { status: 'waiting_for_user' },
    failure: 'private provider body',
    loopStatus: { private: true },
    turns: [{ text: 'private' }],
    state: { private: true },
    display: { private: true },
    fixtureIdentity: {
      instances: [
        { pid: 42, windowIds: [7, 7, -1] },
        { pid: 84, windowIds: [9] },
      ],
    },
    faultInjection: { layer: 'runtime', kind: 'user_intervened' },
    actions: [
      {
        action: { type: 'set_value', value: 'private' },
        toolCallId: 'tool-1',
        sourceObservationId: 'observation-1',
        resultObservationId: 'observation-2',
        targetPid: 42,
        targetWindowId: 7,
        targetOwned: true,
        success: true,
      },
    ],
    actionAttempts: 1,
    traces: [
      {
        type: 'dispatch',
        toolCallId: 'tool-1',
        actionType: 'set_value',
        pid: 42,
        windowId: 7,
        address: 'ax',
        tool: 'set_value',
        path: 'private-path',
        effect: 'private-effect',
      },
    ],
  });

  assert.deepEqual(report.fixtureIdentity, {
    instances: [
      { pid: 42, windowIds: [7] },
      { pid: 84, windowIds: [9] },
    ],
  });
  assert.equal(report.runId, 'run-1');
  assert.equal(report.gitRevision, gitRevision);
  assert.equal(report.generatedAt, generatedAt);
  assert.deepEqual(report.contentLineage, {
    generator: 'scripts/cu-real-ax-model-e2e.mjs',
    gitRevision,
    generatedAt,
  });
  assert.equal(report.actionAttempts, 1);
  assert.equal(report.provider, 'openai');
  assert.equal(report.model, 'gpt-5.4');
  assert.equal(report.run.status, 'waiting_for_user');
  assert.deepEqual(report.faultInjection, {
    layer: 'runtime',
    kind: 'user_intervened',
  });
  assert.deepEqual(report.actions[0], {
    type: 'set_value',
    toolCallId: 'tool-1',
    sourceObservationId: 'observation-1',
    resultObservationId: 'observation-2',
    targetPid: 42,
    targetWindowId: 7,
    success: true,
    targetOwned: true,
  });
  assert.deepEqual(report.traces[0], {
    type: 'dispatch',
    toolCallId: 'tool-1',
    actionType: 'set_value',
    pid: 42,
    windowId: 7,
    address: 'ax',
    tool: 'set_value',
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /private/);
  assert.doesNotMatch(serialized, /loopStatus|turns|display/);
});
