import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  actionRecords,
  allActionTargetsOwned,
  bindActionTargets,
  discoverFixtureIdentity,
  parseFixtureReady,
  waitForTraceFlush,
} from './cu-real-model-launcher.mjs';

const launcher = await readFile(new URL('./cu-real-model-launcher.mjs', import.meta.url), 'utf8');
// The ai-sdk backend wiring (the isComputerUseRealModelE2e tool / economy
// branches) moved into the shared backend tool-surface resolver; scan main.ts
// plus both extracted modules so the isolation-gate pins follow the split.
const main = (
  await Promise.all([
    readFile(new URL('../apps/desktop/src/main/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../apps/desktop/src/main/session-stream.ts', import.meta.url), 'utf8'),
    readFile(
      new URL('../apps/desktop/src/main/desktop-backend-tool-surface.ts', import.meta.url),
      'utf8',
    ),
  ])
).join('\n');

test('real-model launcher uses an isolated profile and the production Desktop IPC path', () => {
  assert.match(launcher, /mkdtemp\(join\(tmpdir\(\), 'maka-cu-real-model-'\)\)/);
  assert.match(launcher, /MAKA_CU_REAL_MODEL_E2E: '1'/);
  assert.doesNotMatch(launcher, /MAKA_E2E:\s*'1'/);
  assert.match(launcher, /window\.maka\.sessions\.create/);
  assert.match(launcher, /backend: 'ai-sdk'/);
  assert.match(launcher, /window\.maka\.sessions\.send/);
  assert.match(launcher, /MAKA_CU_REAL_MODEL_POLICY/);
  assert.match(launcher, /Use the maka_computer tool/);
  assert.match(launcher, /MAKA_CU_KEEP_PROFILE/);
  assert.match(launcher, /MAKA_CU_PROVIDER/);
  assert.match(launcher, /createConnectionStore/);
});

test('real-model launcher owns a synthetic fixture and emits only sanitized evidence', () => {
  assert.match(launcher, /cu-real-model-fixture\.mjs/);
  assert.match(launcher, /sanitizeCuActionRecord/);
  assert.match(launcher, /sanitizeCuReport/);
  assert.match(launcher, /sanitizeCuTrace/);
  assert.match(launcher, /evaluateCuE2eScenarioState/);
  assert.match(launcher, /createSqliteAgentRunStore/);
  assert.match(launcher, /await runStore\.ready\?\.\(\)/);
  assert.match(launcher, /safeFailureMetadata\(runHeader\.failureMessage\)/);
  assert.doesNotMatch(launcher, /failureMessage:\s*runHeader\.failureMessage/);
  assert.match(launcher, /minimumActionsPassed/);
  assert.match(launcher, /terminalPassed/);
  assert.match(launcher, /stopReason === 'end_turn'/);
  assert.match(launcher, /actionsWithinBudget/);
  assert.match(launcher, /dispatchPathPassed/);
  assert.match(launcher, /ownershipPassed/);
  assert.match(launcher, /waitForTraceFlush\([\s\S]*tracePath,[\s\S]*expectedDispatchToolCallIds/);
  assert.match(launcher, /observedToolCallIds\.has\(toolCallId\)/);
  assert.match(launcher, /trace\.toolCallId === action\.toolCallId/);
  assert.match(launcher, /targetPid: target\.pid/);
  assert.match(launcher, /targetWindowId: target\.windowId/);
  assert.match(launcher, /fixtureIdentity/);
  assert.match(launcher, /qualificationEligible: true/);
  assert.match(launcher, /activeWindowSpecs\(scenario\)\.map/);
  assert.match(launcher, /sourceObservationId: start\.args\?\.observation_id/);
  assert.match(launcher, /resultObservationId: target\?\.observationId/);
  assert.match(launcher, /scenario\.runner/);
  assert.match(launcher, /requiresExecutionCapabilities/);
  assert.match(launcher, /qualificationErrors = validateRealReport/);
  assert.match(launcher, /status: qualificationErrors\.length === 0 \? 'pass' : 'fail'/);
  assert.match(launcher, /validateRealReport\(report/);
  assert.match(launcher, /validationErrors\.length > 0/);
  assert.match(launcher, /evidenceClass: 'real-runtime'/);
  assert.match(launcher, /runId: randomUUID\(\)/);
  assert.match(launcher, /gitRevision/);
  assert.match(launcher, /generatedAt/);
  assert.match(launcher, /contentLineage/);
  assert.match(launcher, /actionAttempts: actions\.length/);
  assert.doesNotMatch(launcher, /readMessages\(/);
});

test('launcher ownership verdict matches matrix exemptions for targetless actions', () => {
  assert.equal(
    allActionTargetsOwned([
      { type: 'list_apps', targetOwned: false },
      { type: 'wait', targetOwned: false },
      { type: 'cursor_position', targetOwned: false },
      { type: 'observe', targetOwned: true },
    ]),
    true,
  );
});

test('Desktop isolation gate does not enable FakeBackend', () => {
  assert.match(main, /const isComputerUseRealModelE2e =[\s\S]*MAKA_CU_REAL_MODEL_E2E/);
  assert.match(main, /const isE2e = hasIsolatedE2eProfile && process\.env\.MAKA_E2E === '1'/);
  assert.match(main, /const isIsolatedE2e = isE2e \|\| isComputerUseRealModelE2e/);
  assert.match(main, /deps\.isComputerUseRealModelE2e[\s\S]*\? \[\.\.\.deps\.computerUseTools\]/);
  assert.match(
    main,
    /const toolEconomy = deps\.isComputerUseRealModelE2e \? false : deps\.toolEconomy/,
  );
  assert.match(
    main,
    /projectEffectiveProductToolSurface\(\{[\s\S]*policy: \{ economy: toolEconomy \}/,
  );
  assert.doesNotMatch(main, /if \(isComputerUseRealModelE2e\) \{[\s\S]*backends\.register\('fake'/);
});

test('fixture identity is discovered independently and a wrong action window cannot join it', async () => {
  const fixtureIdentity = await discoverFixtureIdentity(4242, [{ title: 'Fixture Target' }], {
    listApps: async () => [
      {
        pid: 4242,
        windows: [
          { title: 'Fixture Target', windowId: 7 },
          { title: 'Wrong Window', windowId: 99 },
        ],
      },
    ],
    timeoutMs: 50,
    pollIntervalMs: 1,
  });
  const actions = [
    {
      type: 'observe',
      toolCallId: 'observe-wrong',
      resultObservationId: 'wrong-observation',
      targetPid: 4242,
      targetWindowId: 99,
      success: true,
    },
    {
      type: 'click_element',
      toolCallId: 'click-wrong',
      sourceObservationId: 'wrong-observation',
      success: true,
    },
    {
      type: 'click_element',
      toolCallId: 'click-result-only',
      targetPid: 4242,
      targetWindowId: 7,
      success: true,
    },
  ];
  const bound = bindActionTargets(
    actions,
    [
      {
        type: 'dispatch',
        toolCallId: 'click-wrong',
        actionType: 'click_element',
        pid: 4242,
        windowId: 99,
        address: 'ax',
      },
    ],
    fixtureIdentity,
  );

  assert.deepEqual(fixtureIdentity, {
    instances: [{ pid: 4242, windowIds: [7] }],
  });
  assert.equal(bound[0].targetOwned, false);
  assert.equal(bound[1].targetOwned, false);
  assert.equal(bound[1].targetWindowId, 99);
  assert.equal(bound[2].targetOwned, false);
  assert.equal(allActionTargetsOwned(bound), false);
});

test('screenshot without observation_id still contributes PID/window ownership evidence', () => {
  const records = actionRecords([
    {
      type: 'tool_start',
      toolName: 'maka_computer',
      toolUseId: 'screenshot-1',
      args: { action: 'screenshot', app: 'Fixture Target' },
    },
    {
      type: 'tool_result',
      toolUseId: 'screenshot-1',
      content: {
        kind: 'text',
        text: JSON.stringify({
          app_id: 'pid:4242',
          pid: 4242,
          window_id: 7,
          screenshot: { mime_type: 'image/png', width_px: 800, height_px: 600 },
        }),
      },
      durationMs: 12,
      isError: false,
    },
  ]);
  const [screenshot] = bindActionTargets(records, [], {
    instances: [{ pid: 4242, windowIds: [7] }],
  });

  assert.equal(records[0].resultObservationId, undefined);
  assert.equal(screenshot.targetPid, 4242);
  assert.equal(screenshot.targetWindowId, 7);
  assert.equal(screenshot.targetOwned, true);
  assert.equal(allActionTargetsOwned([screenshot]), true);
});

test('policy rejection remains canonical action-attempt evidence', () => {
  const records = actionRecords([
    {
      type: 'tool_start',
      toolName: 'maka_computer',
      toolUseId: 'disallowed-1',
      args: { action: 'left_click', observation_id: 'owned-observation' },
    },
    {
      type: 'tool_result',
      toolUseId: 'disallowed-1',
      content: {
        kind: 'text',
        text: 'maka_computer.left_click failed: unsupported_action_policy',
      },
      durationMs: 1,
      isError: true,
    },
    {
      type: 'tool_start',
      toolName: 'maka_computer',
      toolUseId: 'budget-1',
      args: { action: 'observe', app: 'Fixture Target' },
    },
    {
      type: 'tool_result',
      toolUseId: 'budget-1',
      content: {
        kind: 'text',
        text: 'maka_computer failed: total_action_budget_exceeded',
      },
      durationMs: 1,
      isError: true,
    },
  ]);

  assert.deepEqual(
    records.map(({ type, success, resultCode }) => ({ type, success, resultCode })),
    [
      {
        type: 'left_click',
        success: false,
        resultCode: 'unsupported_action_policy',
      },
      {
        type: 'observe',
        success: false,
        resultCode: 'total_action_budget_exceeded',
      },
    ],
  );
});

test('fixture READY identity and window discovery fail closed', async () => {
  assert.equal(parseFixtureReady('CU_FIXTURE_READY 4242\n', 4242), 4242);
  assert.throws(
    () => parseFixtureReady('CU_FIXTURE_READY 99\n', 4242),
    /does not match launcher child pid/,
  );
  await assert.rejects(
    discoverFixtureIdentity(4242, [{ title: 'Fixture Target' }], {
      listApps: async () => [{ pid: 4242, windows: [] }],
      timeoutMs: 5,
      pollIntervalMs: 1,
    }),
    /fixture identity discovery failed/,
  );
});

test('trace flush waits for every corresponding dispatch tool call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-cu-trace-test-'));
  const path = join(directory, 'trace.jsonl');
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        type: 'dispatch',
        toolCallId: 'first',
      })}\n`,
    );
    const pending = waitForTraceFlush(path, ['first', 'second'], 500);
    setTimeout(() => {
      void writeFile(
        path,
        [
          JSON.stringify({ type: 'dispatch', toolCallId: 'first' }),
          JSON.stringify({ type: 'dispatch', toolCallId: 'second' }),
          '',
        ].join('\n'),
      );
    }, 30);
    const traces = await pending;
    assert.deepEqual(
      traces.map((trace) => trace.toolCallId),
      ['first', 'second'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
