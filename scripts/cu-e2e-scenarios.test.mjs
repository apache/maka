import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CU_E2E_SCENARIOS,
  evaluateCuE2eScenarioState,
  getCuE2eScenario,
  validateCuE2eScenario,
  validateCuE2eScenarioLibrary,
} from './cu-e2e-scenarios.mjs';

test('the scenario library is internally valid and covers every layer', () => {
  assert.equal(validateCuE2eScenarioLibrary(), CU_E2E_SCENARIOS);
  assert.deepEqual([...new Set(CU_E2E_SCENARIOS.map(({ level }) => level))].sort(), [
    'L0',
    'L1',
    'L2',
    'L3',
    'L4',
    'L5',
  ]);
});

test('state evaluation separates expected-state and forbidden-effect failures', () => {
  const scenario = getCuE2eScenario('l1-single-click');
  const result = evaluateCuE2eScenarioState(scenario, {
    target: { primaryClicks: 2, primaryOverClicks: 1, dangerClicks: 1 },
  });

  assert.equal(result.pass, false);
  assert.equal(result.expected.find(({ path }) => path === 'primaryClicks').pass, false);
  assert.equal(
    result.forbidden.every(({ pass }) => !pass),
    true,
  );
});

test('validation rejects unsafe action, matcher, budget, and expected-failure declarations', () => {
  const base = structuredClone(getCuE2eScenario('l1-single-click'));
  const invalid = [
    [{ ...base, allowedActions: ['screenshot', 'shell'] }, /unknown action/],
    [{ ...base, forbiddenEffects: [] }, /forbiddenEffects must be non-empty/],
    [
      {
        ...base,
        expectedState: [{ ...base.expectedState[0], greaterThan: 0 }],
      },
      /exactly one matcher/,
    ],
    [
      {
        ...base,
        minimumActionCounts: { observe: 3 },
        maxActionCounts: { observe: 2 },
      },
      /minimum exceeds maximum/,
    ],
    [
      {
        ...base,
        expectedFailures: [{ action: 'left_click', error: 'stale_frame' }],
      },
      /allowed action and error pairs/,
    ],
  ];

  for (const [scenario, pattern] of invalid) {
    assert.throws(() => validateCuE2eScenario(scenario), pattern);
  }
});
