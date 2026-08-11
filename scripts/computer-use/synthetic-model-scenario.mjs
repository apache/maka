export const SYNTHETIC_COMPUTER_TOOL_PROPERTIES = {
  action: {
    type: 'string',
    enum: ['list_apps', 'observe', 'click_element', 'set_value'],
  },
  app: { type: 'string' },
  window_id: { type: 'integer' },
  include_screenshot: { type: 'boolean' },
  observation_id: { type: 'string' },
  element_id: { type: 'string' },
  value: { type: 'string' },
};

export const SYNTHETIC_COMPUTER_KNOWN_KEYS = Object.freeze(
  Object.keys(SYNTHETIC_COMPUTER_TOOL_PROPERTIES),
);

export const SYNTHETIC_COMPUTER_ALLOWED_KEYS = Object.freeze({
  list_apps: ['action'],
  observe: ['action', 'app', 'window_id', 'include_screenshot'],
  click_element: ['action', 'observation_id', 'element_id'],
  set_value: ['action', 'observation_id', 'element_id', 'value'],
});

export function createSyntheticComputerScenario() {
  const state = {
    value: '',
    observationSequence: 0,
    activeObservationId: undefined,
  };
  const calls = [];

  return {
    state,
    calls,
    execute(args, discardedKeys = []) {
      const result = executeSyntheticComputerAction(state, args);
      calls.push({
        action: args.action,
        argumentKeys: Object.keys(args).sort(),
        discardedKeys,
        resultKind: result.kind,
      });
      return result;
    },
  };
}

export function canonicalizeSyntheticComputerArgs(args) {
  return args.action === 'observe' && args.include_screenshot === undefined
    ? { ...args, include_screenshot: true }
    : args;
}

function executeSyntheticComputerAction(state, args) {
  switch (args.action) {
    case 'list_apps':
      requireExactKeys(args, ['action']);
      return {
        kind: 'apps',
        apps: [
          {
            app_id: 'pid:42',
            pid: 42,
            name: 'Codex CUA Lab',
            windows: [{ window_id: 7, title: 'Codex CUA Lab' }],
          },
        ],
      };
    case 'observe':
      requireExactKeys(args, ['action', 'app', 'window_id', 'include_screenshot']);
      if (args.app !== 'pid:42' || args.window_id !== 7) {
        throw new Error('model targeted the wrong synthetic app/window');
      }
      return observation(state);
    case 'set_value':
      requireExactKeys(args, ['action', 'observation_id', 'element_id', 'value']);
      if (
        args.observation_id !== state.activeObservationId ||
        args.element_id !== 'field-1' ||
        args.value !== 'model-e2e'
      ) {
        throw new Error(`invalid semantic mutation: ${JSON.stringify(args)}`);
      }
      state.value = args.value;
      state.activeObservationId = undefined;
      return {
        kind: 'action_result',
        outcome: {
          ok: true,
          tier: 'ax',
          verified: true,
          evidence: { path: 'ax', effect: 'confirmed' },
        },
        fresh_observation: observation(state),
      };
    case 'click_element':
      requireExactKeys(args, ['action', 'observation_id', 'element_id']);
      if (args.observation_id !== state.activeObservationId || args.element_id !== 'field-1') {
        throw new Error(`invalid semantic click: ${JSON.stringify(args)}`);
      }
      state.activeObservationId = undefined;
      return {
        kind: 'action_result',
        outcome: {
          ok: true,
          tier: 'ax',
          verified: true,
          evidence: { path: 'ax', effect: 'confirmed' },
        },
        fresh_observation: observation(state),
      };
    default:
      throw new Error(`unsupported model action ${String(args.action)}`);
  }
}

function observation(state) {
  const observationId = `obs-fixture-${++state.observationSequence}`;
  state.activeObservationId = observationId;
  return {
    kind: 'observation',
    observation_id: observationId,
    app: 'pid:42',
    pid: 42,
    window_id: 7,
    elements: [
      {
        element_id: 'field-1',
        role: 'AXTextField',
        label: 'CUA Lab Set Value Field',
        value: state.value,
      },
    ],
  };
}

function requireExactKeys(value, allowed) {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `unexpected arguments for ${value.action}: ${actual.join(',')} expected ${expected.join(',')}`,
    );
  }
}
