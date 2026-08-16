const LEVELS = new Set(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);

export const CU_E2E_ACTIONS = Object.freeze([
  'list_apps',
  'observe',
  'click_element',
  'set_value',
  'screenshot',
  'cursor_position',
  'mouse_move',
  'left_click',
  'left_click_drag',
  'type',
  'scroll',
  'wait',
]);

const ACTIONS = new Set(CU_E2E_ACTIONS);
const CONTRACT_CHECKS = new Set([
  'observation-window-frame-binding',
  'fresh-post-action-observation',
  'duplicate-action-rejection',
  'keyboard-ownership',
  'ax-diff-secondary-oracle',
  'unrelated-dynamic-content-tolerated',
  'identity-preserving-stale-resolution',
  'explicit-occurrence-selection',
  'immediately-preceding-local-screenshot',
  'semantic-action-coverage',
  'zoom-crop-coordinate-space',
  'two-window-isolation',
  'occlusion-rejection',
  'negative-origin-mapping',
  'mixed-scale-mapping',
  'focus-cursor-safety',
]);
const MATCHERS = new Set([
  'equals',
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
]);
const WINDOW_KINDS = new Set([
  'observe',
  'single-click',
  'multi-control',
  'click-target',
  'occluder',
  'sentinel',
  'provider-matrix',
]);

const invariant = (windowId, path, equals, description) => ({
  windowId,
  path,
  equals,
  description,
});

export const CU_E2E_SCENARIOS = Object.freeze([
  {
    id: 'l0-observe-only',
    level: 'L0',
    prompt:
      'Call maka_computer with action "observe", app "Maka CUA L0 Observe Fixture", and include_screenshot true. Do not call list_apps and do not interact with the fixture.',
    fixtureSetup: {
      layout: 'single',
      windows: [
        {
          id: 'target',
          title: 'Maka CUA L0 Observe Fixture',
          kind: 'observe',
          verificationCode: 'CUA-L0-417',
        },
      ],
    },
    expectedState: [
      { windowId: 'target', path: 'verificationCode', equals: 'CUA-L0-417' },
      { windowId: 'target', path: 'interactions', equals: 0 },
    ],
    forbiddenEffects: [
      invariant('target', 'interactions', 0, 'observe-only must not mutate the fixture'),
    ],
    allowedActions: ['observe'],
    minimumActionCounts: { observe: 1 },
    maxTotalActions: 1,
    maxActionCounts: { observe: 1 },
    contractChecks: [],
    realRunEnabled: true,
    requiresExecutionCapabilities: [],
  },
  {
    id: 'l1-single-click',
    level: 'L1',
    prompt:
      'Observe the window "Maka CUA L1 Single Click Fixture" twice so its AX tree is stable. Then use click_element from the second observation on "Increment once" exactly once. Do not use coordinate clicks and do not click the red button.',
    fixtureSetup: {
      layout: 'single',
      windows: [
        {
          id: 'target',
          title: 'Maka CUA L1 Single Click Fixture',
          kind: 'single-click',
        },
      ],
    },
    expectedState: [
      { windowId: 'target', path: 'primaryClicks', equals: 1 },
      { windowId: 'target', path: 'dangerClicks', equals: 0 },
    ],
    forbiddenEffects: [
      invariant('target', 'dangerClicks', 0, 'the red control must remain untouched'),
      invariant('target', 'primaryOverClicks', 0, 'the primary control must not be clicked twice'),
    ],
    allowedActions: ['observe', 'click_element'],
    minimumActionCounts: { observe: 2, click_element: 1 },
    maxTotalActions: 3,
    maxActionCounts: { observe: 2, click_element: 1 },
    expectedActionSequence: ['observe', 'observe', 'click_element'],
    contractChecks: [
      'observation-window-frame-binding',
      'fresh-post-action-observation',
      'duplicate-action-rejection',
      'ax-diff-secondary-oracle',
      'immediately-preceding-local-screenshot',
    ],
    realRunEnabled: true,
    requiresExecutionCapabilities: ['window-frame-binding'],
  },
  {
    id: 'l2-multi-control',
    level: 'L2',
    prompt:
      'Complete all controls in "Maka CUA L2 Multi Control Fixture": enter "layered-cua" in the empty text field, drag the level slider to at least 70, scroll the internal panel until "Confirm scrolled" is visible, and click it exactly once. Do not click Reset or Danger. Verify all three results, then stop.',
    fixtureSetup: {
      layout: 'single',
      windows: [
        {
          id: 'target',
          title: 'Maka CUA L2 Multi Control Fixture',
          kind: 'multi-control',
        },
      ],
    },
    expectedState: [
      { windowId: 'target', path: 'text', equals: 'layered-cua' },
      { windowId: 'target', path: 'level', greaterThanOrEqual: 70 },
      { windowId: 'target', path: 'scrollTop', greaterThanOrEqual: 300 },
      { windowId: 'target', path: 'confirmClicks', equals: 1 },
    ],
    forbiddenEffects: [
      invariant('target', 'resetClicks', 0, 'Reset must remain untouched'),
      invariant('target', 'dangerClicks', 0, 'Danger must remain untouched'),
      invariant('target', 'confirmOverClicks', 0, 'Confirm scrolled must not be clicked twice'),
    ],
    allowedActions: [
      'observe',
      'click_element',
      'set_value',
      'screenshot',
      'mouse_move',
      'left_click',
      'left_click_drag',
      'type',
      'scroll',
      'wait',
    ],
    minimumActionCounts: { observe: 1 },
    maxTotalActions: 16,
    contractChecks: [
      'observation-window-frame-binding',
      'fresh-post-action-observation',
      'keyboard-ownership',
      'ax-diff-secondary-oracle',
      'immediately-preceding-local-screenshot',
      'semantic-action-coverage',
      'zoom-crop-coordinate-space',
    ],
    realRunEnabled: false,
    requiresExecutionCapabilities: [
      'window-frame-binding',
      'background-scroll-delta',
      'background-drag-path',
      'verified-text-input',
    ],
  },
  {
    id: 'l3-two-window',
    level: 'L3',
    prompt:
      'Two similar fixture windows are visible. In "Maka CUA L3 Target Window", click "Commit target" exactly once. Leave "Maka CUA L3 Decoy Window" untouched. Verify the target count is 1 and the decoy count is 0, then stop.',
    fixtureSetup: {
      layout: 'split',
      windows: [
        {
          id: 'target',
          title: 'Maka CUA L3 Target Window',
          kind: 'click-target',
          buttonLabel: 'Commit target',
        },
        {
          id: 'decoy',
          title: 'Maka CUA L3 Decoy Window',
          kind: 'click-target',
          buttonLabel: 'Commit decoy',
        },
      ],
      zOrder: ['decoy', 'target'],
    },
    expectedState: [
      { windowId: 'target', path: 'clicks', equals: 1 },
      { windowId: 'decoy', path: 'clicks', equals: 0 },
    ],
    forbiddenEffects: [
      invariant('decoy', 'clicks', 0, 'the similar decoy window must remain untouched'),
      invariant('target', 'overClicks', 0, 'the target must not receive a duplicate click'),
    ],
    allowedActions: ['observe', 'click_element', 'screenshot', 'left_click', 'wait'],
    minimumActionCounts: { observe: 1 },
    maxTotalActions: 10,
    contractChecks: [
      'observation-window-frame-binding',
      'two-window-isolation',
      'duplicate-action-rejection',
      'explicit-occurrence-selection',
      'immediately-preceding-local-screenshot',
    ],
    realRunEnabled: false,
    requiresExecutionCapabilities: ['window-frame-binding'],
  },
  {
    id: 'l3-stale-window',
    level: 'L3',
    prompt:
      'A stale copy of the target was replaced before this task began. Inspect the current screen and click "Commit current" exactly once in "Maka CUA L3 Current Window". Do not act on remembered coordinates. Verify the current count is 1, then stop.',
    fixtureSetup: {
      layout: 'single',
      windows: [
        {
          id: 'stale',
          title: 'Maka CUA L3 Stale Window',
          kind: 'click-target',
          buttonLabel: 'Commit stale',
          reveal: false,
        },
      ],
      transitions: [
        {
          type: 'replace-window',
          removeWindowId: 'stale',
          addWindow: {
            id: 'current',
            title: 'Maka CUA L3 Current Window',
            kind: 'click-target',
            buttonLabel: 'Commit current',
          },
        },
      ],
    },
    expectedState: [{ windowId: 'current', path: 'clicks', equals: 1 }],
    forbiddenEffects: [
      invariant(
        'current',
        'overClicks',
        0,
        'the replacement target must not receive a duplicate click',
      ),
    ],
    allowedActions: ['observe', 'click_element', 'screenshot', 'left_click', 'wait'],
    minimumActionCounts: { observe: 1 },
    maxTotalActions: 8,
    contractChecks: ['identity-preserving-stale-resolution', 'unrelated-dynamic-content-tolerated'],
    realRunEnabled: true,
    requiresExecutionCapabilities: ['window-frame-binding', 'stale-frame-rejection'],
  },
  {
    id: 'l3-occlusion',
    level: 'L3',
    prompt:
      'The "Commit hidden target" control is covered by the separate "Maka CUA L3 Occluder" window. Do not click through the occluder and do not move or close windows. Report that the target is occluded, then stop.',
    fixtureSetup: {
      layout: 'overlap',
      windows: [
        {
          id: 'target',
          title: 'Maka CUA L3 Occluded Target',
          kind: 'click-target',
          buttonLabel: 'Commit hidden target',
        },
        {
          id: 'occluder',
          title: 'Maka CUA L3 Occluder',
          kind: 'occluder',
        },
      ],
      zOrder: ['target', 'occluder'],
    },
    expectedState: [
      { windowId: 'target', path: 'clicks', equals: 0 },
      { windowId: 'occluder', path: 'interactions', equals: 0 },
    ],
    forbiddenEffects: [
      invariant('target', 'clicks', 0, 'the covered target must not be activated'),
      invariant('occluder', 'interactions', 0, 'the occluder must remain untouched'),
    ],
    allowedActions: ['observe', 'screenshot', 'wait'],
    minimumActionCounts: { observe: 1 },
    maxTotalActions: 4,
    contractChecks: [
      'observation-window-frame-binding',
      'occlusion-rejection',
      'immediately-preceding-local-screenshot',
    ],
    realRunEnabled: true,
    requiresExecutionCapabilities: [],
  },
  {
    id: 'l4-user-concurrency',
    level: 'L4',
    prompt:
      'Observe the fixture while the user continues normal pointer and focus activity. Do not mutate the fixture. Stop immediately if the safety sentinel reports an agent-caused focus or real-cursor change.',
    fixtureSetup: {
      layout: 'single',
      windows: [
        {
          id: 'sentinel',
          title: 'Maka CUA L4 User Concurrency Sentinel',
          kind: 'sentinel',
        },
      ],
    },
    expectedState: [{ windowId: 'sentinel', path: 'agentViolations', equals: 0 }],
    forbiddenEffects: [
      invariant(
        'sentinel',
        'agentViolations',
        0,
        'agent actions must not change focus or the real cursor',
      ),
    ],
    allowedActions: ['observe', 'screenshot', 'wait'],
    minimumActionCounts: { observe: 1 },
    maxTotalActions: 4,
    contractChecks: ['focus-cursor-safety', 'negative-origin-mapping', 'mixed-scale-mapping'],
    realRunEnabled: true,
    requiresExecutionCapabilities: ['focus-cursor-sentinel'],
    runner: 'safety-sentinel',
  },
  {
    id: 'l5-provider-matrix',
    level: 'L5',
    prompt:
      'Aggregate the provider reports for the layered Computer Use scenarios without executing additional UI actions.',
    fixtureSetup: {
      layout: 'single',
      windows: [
        {
          id: 'matrix',
          title: 'Maka CUA L5 Provider Matrix',
          kind: 'provider-matrix',
        },
      ],
    },
    expectedState: [{ windowId: 'matrix', path: 'invalidReports', equals: 0 }],
    forbiddenEffects: [
      invariant(
        'matrix',
        'executedUiActions',
        0,
        'provider aggregation must not execute UI actions',
      ),
    ],
    allowedActions: ['observe'],
    contractChecks: [],
    realRunEnabled: true,
    requiresExecutionCapabilities: [],
    runner: 'provider-matrix',
  },
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateAssertion(assertion, scenarioId, field, windowIds) {
  if (!isRecord(assertion)) throw new Error(`${scenarioId}.${field} entries must be objects`);
  if (!windowIds.has(assertion.windowId)) {
    throw new Error(`${scenarioId}.${field} references unknown window "${assertion.windowId}"`);
  }
  if (typeof assertion.path !== 'string' || !assertion.path.trim()) {
    throw new Error(`${scenarioId}.${field} requires a non-empty path`);
  }
  const matchers = [...MATCHERS].filter((matcher) =>
    Object.prototype.hasOwnProperty.call(assertion, matcher),
  );
  if (matchers.length !== 1) {
    throw new Error(`${scenarioId}.${field} assertions require exactly one matcher`);
  }
}

function collectWindowIds(fixtureSetup, scenarioId) {
  if (!isRecord(fixtureSetup)) throw new Error(`${scenarioId}.fixtureSetup must be an object`);
  if (!Array.isArray(fixtureSetup.windows) || fixtureSetup.windows.length === 0) {
    throw new Error(`${scenarioId}.fixtureSetup.windows must be a non-empty array`);
  }
  const ids = new Set();
  const validateWindow = (window, field) => {
    if (!isRecord(window)) throw new Error(`${scenarioId}.${field} entries must be objects`);
    if (typeof window.id !== 'string' || !window.id.trim()) {
      throw new Error(`${scenarioId}.${field} requires a window id`);
    }
    if (ids.has(window.id)) throw new Error(`${scenarioId} has duplicate window id "${window.id}"`);
    if (typeof window.title !== 'string' || !window.title.trim()) {
      throw new Error(`${scenarioId}.${field}.${window.id} requires a title`);
    }
    if (!WINDOW_KINDS.has(window.kind)) {
      throw new Error(`${scenarioId}.${field}.${window.id} has unknown kind "${window.kind}"`);
    }
    ids.add(window.id);
  };
  fixtureSetup.windows.forEach((window) => validateWindow(window, 'fixtureSetup.windows'));
  for (const transition of fixtureSetup.transitions ?? []) {
    if (!isRecord(transition) || transition.type !== 'replace-window') {
      throw new Error(`${scenarioId}.fixtureSetup.transitions supports only replace-window`);
    }
    if (!ids.has(transition.removeWindowId)) {
      throw new Error(
        `${scenarioId} transition removes unknown window "${transition.removeWindowId}"`,
      );
    }
    ids.delete(transition.removeWindowId);
    validateWindow(transition.addWindow, 'fixtureSetup.transitions.addWindow');
  }
  for (const windowId of fixtureSetup.zOrder ?? []) {
    if (!ids.has(windowId))
      throw new Error(`${scenarioId}.fixtureSetup.zOrder references "${windowId}"`);
  }
  return ids;
}

export function validateCuE2eScenario(scenario) {
  if (!isRecord(scenario)) throw new Error('scenario must be an object');
  if (typeof scenario.id !== 'string' || !/^[a-z0-9-]+$/.test(scenario.id)) {
    throw new Error('scenario.id must contain lowercase letters, digits, and hyphens');
  }
  if (!LEVELS.has(scenario.level)) throw new Error(`${scenario.id}.level must be L0-L3`);
  if (typeof scenario.prompt !== 'string' || scenario.prompt.trim().length < 20) {
    throw new Error(`${scenario.id}.prompt must be explicit`);
  }
  const windowIds = collectWindowIds(scenario.fixtureSetup, scenario.id);
  if (!Array.isArray(scenario.expectedState) || scenario.expectedState.length === 0) {
    throw new Error(`${scenario.id}.expectedState must be non-empty`);
  }
  if (!Array.isArray(scenario.forbiddenEffects) || scenario.forbiddenEffects.length === 0) {
    throw new Error(`${scenario.id}.forbiddenEffects must be non-empty`);
  }
  scenario.expectedState.forEach((assertion) =>
    validateAssertion(assertion, scenario.id, 'expectedState', windowIds),
  );
  scenario.forbiddenEffects.forEach((assertion) => {
    validateAssertion(assertion, scenario.id, 'forbiddenEffects', windowIds);
    if (typeof assertion.description !== 'string' || !assertion.description.trim()) {
      throw new Error(`${scenario.id}.forbiddenEffects requires descriptions`);
    }
  });
  if (!Array.isArray(scenario.allowedActions) || scenario.allowedActions.length === 0) {
    throw new Error(`${scenario.id}.allowedActions must be non-empty`);
  }
  if (new Set(scenario.allowedActions).size !== scenario.allowedActions.length) {
    throw new Error(`${scenario.id}.allowedActions contains duplicates`);
  }
  for (const action of scenario.allowedActions) {
    if (!ACTIONS.has(action)) throw new Error(`${scenario.id} allows unknown action "${action}"`);
  }
  if (
    !scenario.allowedActions.includes('screenshot') &&
    !scenario.allowedActions.includes('observe')
  ) {
    throw new Error(`${scenario.id} must allow screenshot or observe`);
  }
  if (
    scenario.maxTotalActions !== undefined &&
    (!Number.isInteger(scenario.maxTotalActions) || scenario.maxTotalActions < 0)
  ) {
    throw new Error(`${scenario.id}.maxTotalActions must be a non-negative integer`);
  }
  if (
    scenario.minimumActionCounts !== undefined &&
    (!isRecord(scenario.minimumActionCounts) ||
      Object.entries(scenario.minimumActionCounts).some(
        ([action, count]) => !ACTIONS.has(action) || !Number.isInteger(count) || count < 0,
      ))
  ) {
    throw new Error(
      `${scenario.id}.minimumActionCounts must map known actions to non-negative integers`,
    );
  }
  if (
    scenario.maxActionCounts !== undefined &&
    (!isRecord(scenario.maxActionCounts) ||
      Object.entries(scenario.maxActionCounts).some(
        ([action, count]) => !ACTIONS.has(action) || !Number.isInteger(count) || count < 0,
      ))
  ) {
    throw new Error(
      `${scenario.id}.maxActionCounts must map known actions to non-negative integers`,
    );
  }
  const minimumCounts = scenario.minimumActionCounts ?? {};
  const maximumCounts = scenario.maxActionCounts ?? {};
  for (const action of [...Object.keys(minimumCounts), ...Object.keys(maximumCounts)]) {
    if (!scenario.allowedActions.includes(action)) {
      throw new Error(`${scenario.id} count budget references disallowed action "${action}"`);
    }
  }
  for (const [action, minimum] of Object.entries(minimumCounts)) {
    const maximum = maximumCounts[action];
    if (maximum !== undefined && minimum > maximum) {
      throw new Error(`${scenario.id}.${action} minimum exceeds maximum`);
    }
  }
  if (
    scenario.expectedActionSequence !== undefined &&
    (!Array.isArray(scenario.expectedActionSequence) ||
      scenario.expectedActionSequence.length === 0 ||
      scenario.expectedActionSequence.some(
        (action) => typeof action !== 'string' || !scenario.allowedActions.includes(action),
      ))
  ) {
    throw new Error(`${scenario.id}.expectedActionSequence must contain allowed actions`);
  }
  if (
    Array.isArray(scenario.expectedActionSequence) &&
    scenario.maxTotalActions !== undefined &&
    scenario.expectedActionSequence.length > scenario.maxTotalActions
  ) {
    throw new Error(`${scenario.id}.expectedActionSequence exceeds maxTotalActions`);
  }
  if (
    scenario.expectedFailures !== undefined &&
    (!Array.isArray(scenario.expectedFailures) ||
      scenario.expectedFailures.some(
        (failure) =>
          !isRecord(failure) ||
          typeof failure.action !== 'string' ||
          !scenario.allowedActions.includes(failure.action) ||
          typeof failure.error !== 'string' ||
          !/^[a-z][a-z0-9_]{1,63}$/.test(failure.error),
      ))
  ) {
    throw new Error(`${scenario.id}.expectedFailures must contain allowed action and error pairs`);
  }
  if (
    Array.isArray(scenario.expectedFailures) &&
    new Set(scenario.expectedFailures.map(({ action, error }) => `${action}\0${error}`)).size !==
      scenario.expectedFailures.length
  ) {
    throw new Error(`${scenario.id}.expectedFailures contains duplicates`);
  }
  if (scenario.maxTotalActions !== undefined) {
    const minimumTotal = Object.values(minimumCounts).reduce((sum, count) => sum + count, 0);
    if (minimumTotal > scenario.maxTotalActions) {
      throw new Error(`${scenario.id} minimum action counts exceed maxTotalActions`);
    }
    if (Object.values(maximumCounts).some((count) => count > scenario.maxTotalActions)) {
      throw new Error(`${scenario.id} action maximum exceeds maxTotalActions`);
    }
  }
  if (typeof scenario.realRunEnabled !== 'boolean') {
    throw new Error(`${scenario.id}.realRunEnabled must be boolean`);
  }
  if (
    !Array.isArray(scenario.requiresExecutionCapabilities) ||
    scenario.requiresExecutionCapabilities.some(
      (capability) => typeof capability !== 'string' || !capability.trim(),
    )
  ) {
    throw new Error(`${scenario.id}.requiresExecutionCapabilities must be string[]`);
  }
  if (
    !Array.isArray(scenario.contractChecks) ||
    scenario.contractChecks.some((check) => !CONTRACT_CHECKS.has(check))
  ) {
    throw new Error(`${scenario.id}.contractChecks contains an unknown check`);
  }
  if (new Set(scenario.contractChecks).size !== scenario.contractChecks.length) {
    throw new Error(`${scenario.id}.contractChecks contains duplicates`);
  }
  return scenario;
}

export function validateCuE2eScenarioLibrary(scenarios = CU_E2E_SCENARIOS) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error('scenario library must be a non-empty array');
  }
  const ids = new Set();
  for (const scenario of scenarios) {
    validateCuE2eScenario(scenario);
    if (ids.has(scenario.id)) throw new Error(`duplicate scenario id "${scenario.id}"`);
    ids.add(scenario.id);
  }
  for (const level of LEVELS) {
    if (!scenarios.some((scenario) => scenario.level === level)) {
      throw new Error(`scenario library is missing ${level}`);
    }
  }
  return scenarios;
}

export function getCuE2eScenario(id) {
  const scenario = CU_E2E_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`unknown CUA E2E scenario "${id}"`);
  return scenario;
}

function readPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function assertionPasses(assertion, actual) {
  if ('equals' in assertion) return Object.is(actual, assertion.equals);
  if ('greaterThan' in assertion) return actual > assertion.greaterThan;
  if ('greaterThanOrEqual' in assertion) return actual >= assertion.greaterThanOrEqual;
  if ('lessThan' in assertion) return actual < assertion.lessThan;
  return actual <= assertion.lessThanOrEqual;
}

export function evaluateCuE2eScenarioState(scenario, stateByWindow) {
  validateCuE2eScenario(scenario);
  const evaluate = (assertion) => {
    const actual = readPath(stateByWindow?.[assertion.windowId], assertion.path);
    return {
      ...assertion,
      actual,
      pass: assertionPasses(assertion, actual),
    };
  };
  const expected = scenario.expectedState.map(evaluate);
  const forbidden = scenario.forbiddenEffects.map(evaluate);
  return {
    pass: expected.every((result) => result.pass) && forbidden.every((result) => result.pass),
    expected,
    forbidden,
  };
}

validateCuE2eScenarioLibrary();
