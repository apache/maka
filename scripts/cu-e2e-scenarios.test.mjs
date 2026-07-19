import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CU_E2E_ACTIONS,
  CU_E2E_SCENARIOS,
  evaluateCuE2eScenarioState,
  getCuE2eScenario,
  validateCuE2eScenario,
  validateCuE2eScenarioLibrary,
} from './cu-e2e-scenarios.mjs';

test('scenario library validates and covers every layer', () => {
  assert.equal(validateCuE2eScenarioLibrary(), CU_E2E_SCENARIOS);
  assert.deepEqual([...new Set(CU_E2E_SCENARIOS.map((scenario) => scenario.level))].sort(), [
    'L0',
    'L1',
    'L2',
    'L3',
    'L4',
    'L5',
  ]);
  assert.equal(
    new Set(CU_E2E_SCENARIOS.map((scenario) => scenario.id)).size,
    CU_E2E_SCENARIOS.length,
  );
});

test('L4 and L5 use dedicated non-mutating runners', () => {
  const l4 = getCuE2eScenario('l4-user-concurrency');
  const l5 = getCuE2eScenario('l5-provider-matrix');
  assert.equal(l4.runner, 'safety-sentinel');
  assert.equal(l5.runner, 'provider-matrix');
  assert.deepEqual(l4.allowedActions, ['observe', 'screenshot', 'wait']);
  assert.deepEqual(l5.allowedActions, ['observe']);
});

test('the first enabled real-model scenario is observe-only', () => {
  const first = CU_E2E_SCENARIOS.find((scenario) => scenario.realRunEnabled);
  assert.equal(first?.id, 'l0-observe-only');
  assert.deepEqual(first?.allowedActions, ['observe']);
  assert.deepEqual(first?.requiresExecutionCapabilities, []);
});

test('every scenario carries prompt, fixture, expected state, forbidden effects, and bounded actions', () => {
  const knownActions = new Set(CU_E2E_ACTIONS);
  for (const scenario of CU_E2E_SCENARIOS) {
    assert.ok(scenario.prompt.length >= 20, scenario.id);
    assert.ok(scenario.fixtureSetup.windows.length > 0, scenario.id);
    assert.ok(scenario.expectedState.length > 0, scenario.id);
    assert.ok(scenario.forbiddenEffects.length > 0, scenario.id);
    assert.ok(
      scenario.allowedActions.includes('screenshot') || scenario.allowedActions.includes('observe'),
      scenario.id,
    );
    assert.ok(
      scenario.allowedActions.every((action) => knownActions.has(action)),
      scenario.id,
    );
    assert.equal(typeof scenario.realRunEnabled, 'boolean', scenario.id);
    assert.ok(Array.isArray(scenario.requiresExecutionCapabilities), scenario.id);
    assert.ok(Array.isArray(scenario.contractChecks), scenario.id);
    if (['L0', 'L1', 'L2', 'L3', 'L4'].includes(scenario.level)) {
      assert.ok((scenario.minimumActionCounts?.observe ?? 0) >= 1, scenario.id);
      assert.ok(Number.isInteger(scenario.maxTotalActions), scenario.id);
      assert.ok(scenario.maxTotalActions > 0, scenario.id);
    }
  }
});

test('layer action budgets increase deliberately', () => {
  assert.deepEqual(getCuE2eScenario('l0-observe-only').allowedActions, ['observe']);
  assert.ok(getCuE2eScenario('l1-single-click').allowedActions.includes('click_element'));
  assert.ok(!getCuE2eScenario('l1-single-click').allowedActions.includes('left_click'));
  assert.equal(getCuE2eScenario('l1-single-click').minimumActionCounts.observe, 2);
  assert.deepEqual(getCuE2eScenario('l1-single-click').expectedActionSequence, [
    'observe',
    'observe',
    'click_element',
  ]);
  assert.deepEqual(getCuE2eScenario('l1-background-zoom').allowedActions, ['observe', 'zoom']);
  assert.deepEqual(getCuE2eScenario('l2-background-semantic').allowedActions, [
    'observe',
    'set_value',
    'press_key',
    'click_element',
  ]);

  const multi = getCuE2eScenario('l2-multi-control');
  assert.ok(multi.allowedActions.includes('scroll'));
  assert.ok(multi.allowedActions.includes('left_click_drag'));
  assert.ok(multi.allowedActions.includes('type'));

  const occlusion = getCuE2eScenario('l3-occlusion');
  assert.ok(!occlusion.allowedActions.includes('left_click'));
  assert.equal(occlusion.realRunEnabled, true);
  assert.equal(getCuE2eScenario('l3-two-window').realRunEnabled, false);
});

test('background semantic scenarios cover covered capture and exact-token mutations', () => {
  const zoom = getCuE2eScenario('l1-background-zoom');
  const semantic = getCuE2eScenario('l2-background-semantic');
  assert.equal(zoom.fixtureSetup.layout, 'overlap');
  assert.equal(semantic.fixtureSetup.layout, 'overlap');
  assert.equal(zoom.realRunEnabled, true);
  assert.equal(semantic.realRunEnabled, true);
  assert.equal(semantic.minimumActionCounts.press_key, 1);
  assert.equal(semantic.expectedState.find((entry) => entry.path === 'checked')?.equals, true);
});

test('L3 isolates two-window, stale, and occlusion hazards', () => {
  const l3 = CU_E2E_SCENARIOS.filter((scenario) => scenario.level === 'L3');
  assert.deepEqual(
    l3.map((scenario) => scenario.id),
    ['l3-two-window', 'l3-stale-window', 'l3-occlusion'],
  );
  assert.equal(getCuE2eScenario('l3-two-window').fixtureSetup.windows.length, 2);
  assert.equal(
    getCuE2eScenario('l3-stale-window').fixtureSetup.transitions[0].type,
    'replace-window',
  );
  assert.equal(getCuE2eScenario('l3-occlusion').fixtureSetup.layout, 'overlap');
});

test('L1-L4 declare exact Window/frame, stale, zoom, display, and ownership gates', () => {
  const checks = new Set(
    CU_E2E_SCENARIOS.filter(({ level }) => ['L1', 'L2', 'L3', 'L4'].includes(level)).flatMap(
      ({ contractChecks }) => contractChecks,
    ),
  );
  assert.deepEqual([...checks].sort(), [
    'ax-diff-secondary-oracle',
    'duplicate-action-rejection',
    'explicit-occurrence-selection',
    'focus-cursor-safety',
    'fresh-post-action-observation',
    'identity-preserving-stale-resolution',
    'immediately-preceding-local-screenshot',
    'keyboard-ownership',
    'mixed-scale-mapping',
    'negative-origin-mapping',
    'observation-window-frame-binding',
    'occlusion-rejection',
    'semantic-action-coverage',
    'two-window-isolation',
    'unrelated-dynamic-content-tolerated',
    'zoom-crop-coordinate-space',
  ]);
});

test('state evaluation reports expected and forbidden-effect failures separately', () => {
  const scenario = getCuE2eScenario('l1-single-click');
  const passing = evaluateCuE2eScenarioState(scenario, {
    target: { primaryClicks: 1, primaryOverClicks: 0, dangerClicks: 0 },
  });
  assert.equal(passing.pass, true);

  const failing = evaluateCuE2eScenarioState(scenario, {
    target: { primaryClicks: 2, primaryOverClicks: 1, dangerClicks: 1 },
  });
  assert.equal(failing.pass, false);
  assert.equal(failing.expected.find((result) => result.path === 'primaryClicks').pass, false);
  assert.equal(
    failing.forbidden.every((result) => !result.pass),
    true,
  );
});

test('validation rejects ambiguous or unsafe scenario declarations', () => {
  const base = structuredClone(getCuE2eScenario('l1-single-click'));

  assert.throws(
    () => validateCuE2eScenario({ ...base, allowedActions: ['screenshot', 'shell'] }),
    /unknown action "shell"/,
  );
  assert.throws(
    () => validateCuE2eScenario({ ...base, forbiddenEffects: [] }),
    /forbiddenEffects must be non-empty/,
  );

  const unknownWindow = structuredClone(base);
  unknownWindow.expectedState[0].windowId = 'other';
  assert.throws(() => validateCuE2eScenario(unknownWindow), /references unknown window "other"/);

  const ambiguousMatcher = structuredClone(base);
  ambiguousMatcher.expectedState[0].greaterThan = 0;
  assert.throws(() => validateCuE2eScenario(ambiguousMatcher), /exactly one matcher/);

  assert.throws(
    () => validateCuE2eScenario({ ...base, contractChecks: ['not-a-contract'] }),
    /unknown check/,
  );
  assert.throws(
    () =>
      validateCuE2eScenario({
        ...base,
        minimumActionCounts: { left_click: 1 },
      }),
    /disallowed action/,
  );
  assert.throws(
    () =>
      validateCuE2eScenario({
        ...base,
        minimumActionCounts: { observe: 3 },
        maxActionCounts: { observe: 2 },
      }),
    /minimum exceeds maximum/,
  );
  assert.throws(
    () =>
      validateCuE2eScenario({
        ...base,
        minimumActionCounts: { observe: 2, click_element: 2 },
        maxActionCounts: { observe: 2, click_element: 2 },
        maxTotalActions: 3,
      }),
    /exceed maxTotalActions/,
  );
  assert.throws(
    () =>
      validateCuE2eScenario({
        ...base,
        expectedFailures: [{ action: 'left_click', error: 'stale_frame' }],
      }),
    /allowed action and error pairs/,
  );
  assert.throws(
    () =>
      validateCuE2eScenario({
        ...base,
        expectedFailures: [{ action: 'click_element', error: 'Stale frame' }],
      }),
    /allowed action and error pairs/,
  );
  assert.throws(
    () =>
      validateCuE2eScenario({
        ...base,
        expectedFailures: [
          { action: 'click_element', error: 'stale_frame' },
          { action: 'click_element', error: 'stale_frame' },
        ],
      }),
    /contains duplicates/,
  );
});

test('fixture helper is Electron-only and does not import Maka runtime or runners', async () => {
  const source = await readFile(new URL('./cu-e2e-fixture.mjs', import.meta.url), 'utf8');
  assert.match(source, /new BrowserWindow\(/);
  assert.match(source, /\.showInactive\(\)/);
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  assert.doesNotMatch(
    source,
    /@maka|packages\/|apps\/desktop|createCuaDriverBackend|runOpenAIComputerLoop/,
  );
});
