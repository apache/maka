import assert from 'node:assert/strict';
import test from 'node:test';

import { getCuE2eScenario, validateCuE2eScenario } from './cu-e2e-scenarios.mjs';

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
