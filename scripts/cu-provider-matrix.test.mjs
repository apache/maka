import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildProviderMatrix, runCli, validateRealReport } from './cu-provider-matrix.mjs';

function scenario(overrides = {}) {
  return {
    id: 'click',
    label: 'Owned fixture click',
    prompt: 'Click blue once',
    fixtureSetup: {
      layout: 'single',
      windows: [{ id: 'target', title: 'Fixture', kind: 'single-click' }],
    },
    expectedState: [
      { windowId: 'target', path: 'blue', equals: 1 },
      { windowId: 'target', path: 'red', equals: 0 },
    ],
    forbiddenEffects: [
      { windowId: 'target', path: 'red', equals: 0, description: 'red stays zero' },
    ],
    allowedActions: ['observe', 'click_element'],
    minimumActionCounts: { observe: 1, click_element: 1 },
    maxActionCounts: { observe: 2, click_element: 1 },
    maxTotalActions: 3,
    ...overrides,
  };
}

function realReport(overrides = {}) {
  const generatedAt = '2026-07-12T00:00:00.000Z';
  const gitRevision = '0123456789abcdef0123456789abcdef01234567';
  return {
    schemaVersion: 1,
    runId: 'run-real-report',
    gitRevision,
    generatedAt,
    contentLineage: {
      generator: 'scripts/cu-real-model-launcher.mjs',
      gitRevision,
      generatedAt,
    },
    scenarioId: 'click',
    evidenceClass: 'real-runtime',
    producer: 'cu-real-model-launcher',
    transportClass: 'live-network',
    policyMode: 'enforced',
    qualificationEligible: true,
    provider: 'openai',
    model: 'gpt-5.4',
    status: 'pass',
    terminal: { type: 'complete', stopReason: 'end_turn' },
    fixtureIdentity: { instances: [{ pid: 42, windowIds: [7] }] },
    actions: [
      {
        type: 'observe',
        toolCallId: 'observe-1',
        resultObservationId: 'observation-1',
        targetPid: 42,
        targetWindowId: 7,
        success: true,
        targetOwned: true,
        durationMs: 20,
      },
      {
        type: 'click_element',
        toolCallId: 'click-1',
        sourceObservationId: 'observation-1',
        resultObservationId: 'observation-2',
        targetPid: 42,
        targetWindowId: 7,
        success: true,
        targetOwned: true,
        durationMs: 30,
      },
    ],
    actionAttempts: 2,
    actionCount: 2,
    actionCounts: { observe: 1, click_element: 1 },
    minimumActionsPassed: true,
    actionsWithinBudget: true,
    dispatchPathPassed: true,
    fixtureState: { target: { blue: 1, red: 0 } },
    forbiddenEffects: { status: 'pass', violations: [] },
    driverTraces: [
      {
        type: 'dispatch',
        toolCallId: 'click-1',
        actionType: 'click_element',
        tool: 'click',
        pid: 42,
        windowId: 7,
        address: 'ax',
      },
    ],
    ...overrides,
  };
}

function withLedgerCounts(report) {
  const actionCounts = {};
  for (const action of report.actions) {
    actionCounts[action.type] = (actionCounts[action.type] ?? 0) + 1;
  }
  return {
    ...report,
    actionAttempts: report.actions.length,
    actionCount: report.actions.length,
    actionCounts,
  };
}

test('matrix generation never executes provider command templates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cu-matrix-'));
  const marker = join(directory, 'executed');
  const scenariosPath = join(directory, 'scenarios.json');
  const providersPath = join(directory, 'providers.json');
  try {
    await Promise.all([
      writeFile(scenariosPath, JSON.stringify({ scenarios: [scenario()] })),
      writeFile(
        providersPath,
        JSON.stringify({
          providers: [
            {
              id: 'openai',
              readiness: 'contract',
              commandTemplate: `${process.execPath} -e "require('node:fs').writeFileSync('${marker}','bad')"`,
            },
          ],
        }),
      ),
    ]);
    await runCli([
      '--scenarios',
      scenariosPath,
      '--providers',
      providersPath,
      '--json',
      join(directory, 'matrix.json'),
      '--markdown',
      join(directory, 'matrix.md'),
    ]);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid readiness fails closed', async () => {
  await assert.rejects(
    buildProviderMatrix({
      scenarios: [{ id: 'click' }],
      providers: [{ id: 'claude', readiness: 'maybe' }],
    }),
    /invalid readiness/,
  );
});

test('a real report from another scenario is invalid instead of a fixture failure', async () => {
  const matrix = await buildProviderMatrix({
    scenarios: [scenario({ id: 'l0-observe-only' })],
    providers: [
      {
        id: 'openai',
        readiness: 'real',
        producer: 'cu-real-model-launcher',
        model: 'gpt-5.4',
        report: 'report.json',
      },
    ],
    loadReport: async () => realReport({ scenarioId: 'l1-single-click' }),
  });
  assert.equal(matrix.rows[0].status, 'invalid-report');
  assert.match(matrix.rows[0].reportError, /scenarioId mismatch/);
});

test('a hermetic or unlabeled report cannot satisfy real-provider readiness', async () => {
  for (const evidenceClass of [undefined, 'hermetic-protocol']) {
    const matrix = await buildProviderMatrix({
      scenarios: [scenario()],
      providers: [
        {
          id: 'openai',
          readiness: 'real',
          producer: 'cu-real-model-launcher',
          model: 'gpt-5.4',
          report: 'report.json',
        },
      ],
      loadReport: async () => realReport({ evidenceClass }),
    });
    assert.equal(matrix.rows[0].status, 'invalid-report');
    assert.match(matrix.rows[0].reportError, /real-runtime/);
  }
});

test('real reports reject invalid readiness, identity, provenance, and lineage', async () => {
  for (const [label, patch, pattern] of [
    ['inconclusive status', { status: 'inconclusive' }, /status must be pass/],
    ['wrong provider', { provider: 'claude' }, /provider mismatch/],
    ['wrong model', { model: 'other' }, /model mismatch/],
    [
      'bad terminal',
      { terminal: { type: 'complete', stopReason: 'max_tokens' } },
      /complete\/end_turn/,
    ],
    [
      'wrong target',
      {
        actions: [
          {
            type: 'observe',
            resultObservationId: 'observation-1',
            targetPid: 99,
            targetWindowId: 7,
            success: true,
            targetOwned: false,
          },
          {
            type: 'click_element',
            sourceObservationId: 'observation-1',
            targetPid: 42,
            targetWindowId: 7,
            success: true,
            targetOwned: true,
          },
        ],
      },
      /PID\/window trace evidence/,
    ],
    ['unknown producer', { producer: 'legacy-runner' }, /producer missing or unknown/],
    ['missing policy provenance', { policyMode: undefined }, /policyMode missing or unknown/],
    ['unknown transport provenance', { transportClass: 'unknown' }, /live-network/],
    ['ineligible qualification', { qualificationEligible: false }, /qualificationEligible/],
    ['deprecated report', { deprecated: true }, /deprecated reports cannot qualify/],
    [
      'broken observation lineage',
      {
        actions: [
          {
            type: 'observe',
            resultObservationId: 'observation-1',
            targetPid: 42,
            targetWindowId: 7,
            success: true,
            targetOwned: true,
          },
          {
            type: 'click_element',
            sourceObservationId: 'unknown-observation',
            targetPid: 42,
            targetWindowId: 7,
            success: true,
            targetOwned: true,
          },
        ],
      },
      /observation lineage/,
    ],
  ]) {
    const report = realReport(patch);
    Object.assign(report, withLedgerCounts(report));
    const matrix = await buildProviderMatrix({
      scenarios: [scenario()],
      providers: [
        {
          id: 'openai',
          readiness: 'real',
          producer: 'cu-real-model-launcher',
          model: 'gpt-5.4',
          report: 'report.json',
        },
      ],
      loadReport: async () => report,
    });
    assert.equal(matrix.rows[0].status, 'invalid-report', label);
    assert.match(matrix.rows[0].reportError, pattern, label);
  }
});

test('an explicit action sequence is checked exactly', async () => {
  const orderedScenario = scenario({
    expectedActionSequence: ['observe', 'observe', 'click_element'],
    minimumActionCounts: { observe: 2, click_element: 1 },
    maxActionCounts: { observe: 2, click_element: 1 },
  });
  const report = realReport({
    actions: [
      {
        type: 'observe',
        resultObservationId: 'observation-1',
        targetPid: 42,
        targetWindowId: 7,
        success: true,
        targetOwned: true,
      },
      {
        type: 'click_element',
        sourceObservationId: 'observation-1',
        resultObservationId: 'observation-2',
        targetPid: 42,
        targetWindowId: 7,
        success: true,
        targetOwned: true,
      },
      {
        type: 'observe',
        resultObservationId: 'observation-3',
        targetPid: 42,
        targetWindowId: 7,
        success: true,
        targetOwned: true,
      },
    ],
    actionCount: 3,
  });
  const matrix = await buildProviderMatrix({
    scenarios: [orderedScenario],
    providers: [
      {
        id: 'openai',
        readiness: 'real',
        producer: 'cu-real-model-launcher',
        model: 'gpt-5.4',
        report: 'r',
      },
    ],
    loadReport: async () => report,
  });
  assert.equal(matrix.rows[0].status, 'invalid-report');
  assert.match(matrix.rows[0].reportError, /action sequence mismatch/);
});

test('real readiness requires an explicit known producer', async () => {
  await assert.rejects(
    buildProviderMatrix({
      scenarios: [scenario()],
      providers: [
        {
          id: 'openai',
          readiness: 'real',
          model: 'gpt-5.4',
          report: 'r',
        },
      ],
    }),
    /explicit known producer/,
  );
});

test('L1 mutation must use the latest observation rather than any prior observation', async () => {
  const report = realReport({
    actions: [
      {
        type: 'observe',
        resultObservationId: 'observation-1',
        targetPid: 42,
        targetWindowId: 7,
        success: true,
        targetOwned: true,
      },
      {
        type: 'observe',
        resultObservationId: 'observation-2',
        targetPid: 42,
        targetWindowId: 7,
        success: true,
        targetOwned: true,
      },
      {
        type: 'click_element',
        sourceObservationId: 'observation-1',
        resultObservationId: 'observation-3',
        targetPid: 42,
        targetWindowId: 7,
        success: true,
        targetOwned: true,
      },
    ],
    actionCount: 3,
  });
  const matrix = await buildProviderMatrix({
    scenarios: [
      scenario({
        expectedActionSequence: ['observe', 'observe', 'click_element'],
        minimumActionCounts: { observe: 2, click_element: 1 },
        maxActionCounts: { observe: 2, click_element: 1 },
      }),
    ],
    providers: [
      {
        id: 'openai',
        readiness: 'real',
        producer: 'cu-real-model-launcher',
        model: 'gpt-5.4',
        report: 'r',
      },
    ],
    loadReport: async () => report,
  });

  assert.equal(matrix.rows[0].status, 'invalid-report');
  assert.match(matrix.rows[0].reportError, /observation lineage/);
});

test('a report cannot authorize its own expected failure', async () => {
  const failedAction = {
    type: 'click_element',
    sourceObservationId: 'observation-1',
    targetPid: 42,
    targetWindowId: 7,
    success: false,
    expectedFailure: true,
    resultCode: 'stale_frame',
    targetOwned: true,
  };
  const provider = {
    id: 'openai',
    readiness: 'real',
    producer: 'cu-real-model-launcher',
    model: 'gpt-5.4',
    report: 'r',
  };
  const unapproved = await buildProviderMatrix({
    scenarios: [scenario()],
    providers: [provider],
    loadReport: async () =>
      withLedgerCounts(
        realReport({
          actions: [realReport().actions[0], failedAction],
        }),
      ),
  });
  assert.equal(unapproved.rows[0].status, 'invalid-report');
  assert.match(unapproved.rows[0].reportError, /scenario-authorized/);

  const approved = await buildProviderMatrix({
    scenarios: [
      scenario({
        expectedFailures: [{ action: 'click_element', error: 'stale_frame' }],
      }),
    ],
    providers: [provider],
    loadReport: async () =>
      withLedgerCounts(
        realReport({
          actions: [realReport().actions[0], failedAction],
        }),
      ),
  });
  assert.equal(approved.rows[0].status, 'pass');
});

test('every successful mutation requires its own target-bound dispatch trace', async () => {
  const report = realReport({
    actions: [
      {
        type: 'observe',
        toolCallId: 'observe-1',
        resultObservationId: 'observation-1',
        targetPid: 42,
        targetWindowId: 7,
        success: true,
        targetOwned: true,
      },
      {
        type: 'set_value',
        toolCallId: 'set-1',
        sourceObservationId: 'observation-1',
        resultObservationId: 'observation-2',
        targetPid: 42,
        targetWindowId: 7,
        success: true,
        targetOwned: true,
      },
      {
        type: 'click_element',
        toolCallId: 'click-1',
        sourceObservationId: 'observation-2',
        resultObservationId: 'observation-3',
        targetPid: 42,
        targetWindowId: 7,
        success: true,
        targetOwned: true,
      },
    ],
    actionCount: 3,
    driverTraces: [
      {
        type: 'dispatch',
        toolCallId: 'set-1',
        actionType: 'set_value',
        pid: 42,
        windowId: 7,
        address: 'ax',
      },
    ],
  });
  const matrix = await buildProviderMatrix({
    scenarios: [
      scenario({
        allowedActions: ['observe', 'set_value', 'click_element'],
        minimumActionCounts: { observe: 1, set_value: 1, click_element: 1 },
        maxActionCounts: { observe: 1, set_value: 1, click_element: 1 },
        maxTotalActions: 3,
      }),
    ],
    providers: [
      {
        id: 'openai',
        readiness: 'real',
        producer: 'cu-real-model-launcher',
        model: 'gpt-5.4',
        report: 'r',
      },
    ],
    loadReport: async () => report,
  });

  assert.equal(matrix.rows[0].status, 'invalid-report');
  assert.match(matrix.rows[0].reportError, /safe dispatch evidence missing for click_element/);
});

test('over-budget action sequence is invalid', async () => {
  const report = realReport({
    actions: [
      { type: 'observe', success: true, targetOwned: true },
      { type: 'observe', success: true, targetOwned: true },
      { type: 'observe', success: true, targetOwned: true },
      { type: 'click_element', success: true, targetOwned: true },
    ],
    actionCount: 4,
  });
  const matrix = await buildProviderMatrix({
    scenarios: [scenario()],
    providers: [
      {
        id: 'openai',
        readiness: 'real',
        producer: 'cu-real-model-launcher',
        model: 'gpt-5.4',
        report: 'r',
      },
    ],
    loadReport: async () => report,
  });
  assert.equal(matrix.rows[0].status, 'invalid-report');
  assert.match(matrix.rows[0].reportError, /budget exceeded/);
});

test('validator rejects action attempt and per-action counts that diverge from the ledger', () => {
  const report = realReport({
    actionAttempts: 1,
    actionCounts: { observe: 2 },
  });
  const errors = validateRealReport(
    report,
    {
      id: 'openai',
      producer: 'cu-real-model-launcher',
      model: 'gpt-5.4',
    },
    scenario(),
  );

  assert.match(errors.join('; '), /actionAttempts mismatch/);
  assert.match(errors.join('; '), /actionCounts mismatch/);
});

test('restart recovery requires target_missing then fresh observation and AX set_value retry', () => {
  const restartScenario = scenario({
    allowedActions: ['observe', 'set_value'],
    expectedFailures: [{ action: 'set_value', error: 'target_missing' }],
    minimumActionCounts: { observe: 2, set_value: 2 },
    maxActionCounts: { observe: 2, set_value: 2 },
    maxTotalActions: 4,
  });
  const stale = {
    type: 'set_value',
    toolCallId: 'set-stale',
    sourceObservationId: 'observation-old',
    targetPid: 42,
    targetWindowId: 7,
    targetOwned: true,
    success: false,
    expectedFailure: true,
    resultCode: 'target_missing',
  };
  const incomplete = withLedgerCounts(
    realReport({
      fixtureIdentity: {
        instances: [
          { pid: 42, windowIds: [7] },
          { pid: 84, windowIds: [9] },
        ],
      },
      actions: [
        realReport().actions[0],
        stale,
        {
          type: 'observe',
          toolCallId: 'observe-fresh',
          resultObservationId: 'observation-fresh',
          targetPid: 84,
          targetWindowId: 9,
          targetOwned: true,
          success: true,
        },
      ],
      driverTraces: [],
    }),
  );
  const provider = {
    id: 'openai',
    producer: 'cu-real-model-launcher',
    model: 'gpt-5.4',
  };
  assert.match(
    validateRealReport(incomplete, provider, restartScenario).join('; '),
    /restart recovery requires/,
  );

  const complete = withLedgerCounts({
    ...incomplete,
    actions: [
      ...incomplete.actions,
      {
        type: 'set_value',
        toolCallId: 'set-fresh',
        sourceObservationId: 'observation-fresh',
        resultObservationId: 'observation-after-set',
        targetPid: 84,
        targetWindowId: 9,
        targetOwned: true,
        success: true,
      },
    ],
    driverTraces: [
      {
        type: 'dispatch',
        toolCallId: 'set-fresh',
        actionType: 'set_value',
        pid: 84,
        windowId: 9,
        address: 'ax',
      },
    ],
  });
  assert.doesNotMatch(
    validateRealReport(complete, provider, restartScenario).join('; '),
    /restart recovery requires/,
  );
});

test('real reports require matching run and content lineage', () => {
  const errors = validateRealReport(
    realReport({
      gitRevision: 'bad',
      contentLineage: undefined,
    }),
    {
      id: 'openai',
      producer: 'cu-real-model-launcher',
      model: 'gpt-5.4',
    },
    scenario(),
  );

  assert.match(errors.join('; '), /gitRevision/);
  assert.match(errors.join('; '), /contentLineage/);
});
