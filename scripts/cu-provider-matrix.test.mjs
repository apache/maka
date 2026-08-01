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

const provider = {
  id: 'openai',
  readiness: 'real',
  producer: 'cu-real-model-launcher',
  model: 'gpt-5.4',
  report: 'r',
};

function reportErrors(report, reportScenario = scenario()) {
  return validateRealReport(report, provider, reportScenario).join('; ');
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

test('real reports reject invalid identity, provenance, sequence, budget, and ledger', () => {
  for (const [label, patch, reportScenario, patterns] of [
    [
      'scenario mismatch',
      { scenarioId: 'l1-single-click' },
      scenario({ id: 'l0-observe-only' }),
      [/scenarioId mismatch/],
    ],
    ['missing evidence class', { evidenceClass: undefined }, scenario(), [/real-runtime/]],
    ['hermetic evidence', { evidenceClass: 'hermetic-protocol' }, scenario(), [/real-runtime/]],
    ['inconclusive status', { status: 'inconclusive' }, scenario(), [/status must be pass/]],
    ['wrong provider', { provider: 'claude' }, scenario(), [/provider mismatch/]],
    ['wrong model', { model: 'other' }, scenario(), [/model mismatch/]],
    [
      'bad terminal',
      { terminal: { type: 'complete', stopReason: 'max_tokens' } },
      scenario(),
      [/complete\/end_turn/],
    ],
    [
      'unknown producer',
      { producer: 'legacy-runner' },
      scenario(),
      [/producer missing or unknown/],
    ],
    [
      'missing policy provenance',
      { policyMode: undefined },
      scenario(),
      [/policyMode missing or unknown/],
    ],
    ['unknown transport provenance', { transportClass: 'unknown' }, scenario(), [/live-network/]],
    [
      'ineligible qualification',
      { qualificationEligible: false },
      scenario(),
      [/qualificationEligible/],
    ],
    ['deprecated report', { deprecated: true }, scenario(), [/deprecated reports cannot qualify/]],
    [
      'broken content lineage',
      { gitRevision: 'bad', contentLineage: undefined },
      scenario(),
      [/gitRevision/, /contentLineage/],
    ],
    [
      'wrong action sequence',
      {},
      scenario({ expectedActionSequence: ['observe', 'observe', 'click_element'] }),
      [/action sequence mismatch/],
    ],
    ['over budget', {}, scenario({ maxTotalActions: 1 }), [/total action budget exceeded/]],
    [
      'ledger mismatch',
      { actionAttempts: 1, actionCounts: { observe: 2 } },
      scenario(),
      [/actionAttempts mismatch/, /actionCounts mismatch/],
    ],
  ]) {
    const errors = reportErrors(realReport(patch), reportScenario);
    for (const pattern of patterns) assert.match(errors, pattern, label);
  }
});

test('real readiness accepts one canonical report and rejects an unowned producer', async () => {
  const matrix = await buildProviderMatrix({
    scenarios: [scenario()],
    providers: [provider],
    loadReport: async () => realReport(),
  });
  assert.equal(matrix.rows[0].status, 'pass');

  await assert.rejects(
    buildProviderMatrix({
      scenarios: [scenario()],
      providers: [{ id: 'openai', readiness: 'real', model: 'gpt-5.4', report: 'r' }],
    }),
    /explicit known producer/,
  );
});

test('action evidence fails closed for stale lineage, self-authorization, and missing dispatch', () => {
  const staleLineage = withLedgerCounts(
    realReport({
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
    }),
  );
  const orderedScenario = scenario({
    expectedActionSequence: ['observe', 'observe', 'click_element'],
    minimumActionCounts: { observe: 2, click_element: 1 },
    maxActionCounts: { observe: 2, click_element: 1 },
  });
  assert.match(reportErrors(staleLineage, orderedScenario), /observation lineage/);

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
  const selfAuthorized = withLedgerCounts(
    realReport({ actions: [realReport().actions[0], failedAction] }),
  );
  assert.match(reportErrors(selfAuthorized), /scenario-authorized/);
  assert.doesNotMatch(
    reportErrors(
      selfAuthorized,
      scenario({ expectedFailures: [{ action: 'click_element', error: 'stale_frame' }] }),
    ),
    /scenario-authorized/,
  );

  const missingDispatch = withLedgerCounts(
    realReport({
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
    }),
  );
  const dispatchScenario = scenario({
    allowedActions: ['observe', 'set_value', 'click_element'],
    minimumActionCounts: { observe: 1, set_value: 1, click_element: 1 },
    maxActionCounts: { observe: 1, set_value: 1, click_element: 1 },
    maxTotalActions: 3,
  });
  assert.match(
    reportErrors(missingDispatch, dispatchScenario),
    /safe dispatch evidence missing for click_element/,
  );
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
  assert.match(reportErrors(incomplete, restartScenario), /restart recovery requires/);

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
  assert.doesNotMatch(reportErrors(complete, restartScenario), /restart recovery requires/);
});
