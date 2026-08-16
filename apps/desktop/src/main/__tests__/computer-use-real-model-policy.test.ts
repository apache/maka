import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComputerUseToolSet } from '@maka/runtime/computer-use-tools';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  applyComputerUseRealModelPolicy,
  parseComputerUseRealModelPolicy,
} from '../computer-use-real-model-policy.js';

function tool(calls: string[]): MakaTool {
  return {
    name: 'maka_computer',
    description: 'test',
    parameters: {},
    impl: async (args) => {
      calls.push((args as { action: string }).action);
      return (args as { action: string }).action === 'observe'
        ? { text: '{"observation_id":"owned-observation"}' }
        : { text: 'ok' };
    },
  };
}

function toolSet(calls: string[]): ComputerUseToolSet {
  return Object.assign([tool(calls)], {
    clearSession(_sessionId: string) {},
    sessionEvents: {
      snapshot: () => ({ status: 'unobserved' as const, generation: 0 }),
      physicalUserIntervened: () => ({ status: 'intervention_debounce' as const, generation: 1 }),
      interventionDebounceElapsed: () => ({ status: 'reobserve_required' as const, generation: 1 }),
      reobserveRequired: () => ({ status: 'reobserve_required' as const, generation: 1 }),
      screenLocked: () => ({ status: 'screen_locked' as const, generation: 1 }),
      screenUnlocked: () => ({ status: 'reobserve_required' as const, generation: 1 }),
      blockedUrlDetected: () => ({ status: 'blocked_url' as const, generation: 1 }),
      userStopped: () => ({ status: 'user_stopped' as const, generation: 1 }),
      dynamicContentChanged: () => ({ status: 'unobserved' as const, generation: 0 }),
    },
  });
}

test('parses one bounded allowlist and rejects malformed policies', () => {
  assert.deepEqual(parseComputerUseRealModelPolicy(JSON.stringify({
    allowedActions: ['list_apps', 'observe', 'wait'],
    maxTotalActions: 4,
    maxActionCounts: { list_apps: 1, observe: 2, wait: 1 },
    allowedApps: ['Fixture'],
  })), {
    allowedActions: ['list_apps', 'observe', 'wait'],
    maxTotalActions: 4,
    maxActionCounts: { list_apps: 1, observe: 2, wait: 1 },
    allowedApps: ['Fixture'],
  });
  assert.throws(
    () => parseComputerUseRealModelPolicy(undefined),
    /Missing Computer Use real-model policy/,
  );
  assert.throws(
    () => parseComputerUseRealModelPolicy('{"allowedActions":[],"maxTotalActions":0}'),
    /Invalid Computer Use real-model/,
  );
});

test('blocks disallowed and over-budget actions before dispatch', async () => {
  const calls: string[] = [];
  const [wrapped] = applyComputerUseRealModelPolicy(toolSet(calls), {
    allowedActions: ['observe'],
    maxTotalActions: 2,
    maxActionCounts: { observe: 1 },
    allowedApps: ['Fixture'],
  });
  const context = {
    sessionId: 's',
    turnId: 't',
    toolCallId: 'c',
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };

  const allowed = await wrapped.impl({
    action: 'observe',
    app: 'Fixture',
  } as never, context) as { text: string };
  assert.match(allowed.text, /owned-observation/);
  const disallowed = await wrapped.impl(
    { action: 'left_click' } as never,
    context,
  ) as { text: string };
  assert.match(
    disallowed.text,
    /unsupported_action_policy/,
  );
  const overBudget = await wrapped.impl(
    { action: 'observe', app: 'Fixture' } as never,
    context,
  ) as { text: string };
  assert.match(
    overBudget.text,
    /total_action_budget_exceeded/,
  );
  assert.deepEqual(calls, ['observe']);
});

test('blocks wrong targets before dispatch', async () => {
  const calls: string[] = [];
  const [wrapped] = applyComputerUseRealModelPolicy(toolSet(calls), {
    allowedActions: ['observe', 'click_element'],
    maxTotalActions: 3,
    maxActionCounts: { observe: 2, click_element: 1 },
    allowedApps: ['Owned Fixture'],
  });
  const context = {
    sessionId: 's',
    turnId: 't',
    toolCallId: 'c',
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
  const wrong = await wrapped.impl({
    action: 'observe',
    app: 'Other App',
  } as never, context) as { text: string };
  const unbound = await wrapped.impl({
    action: 'click_element',
    element_id: '7',
  } as never, context) as { text: string };
  assert.match(wrong.text, /target_policy_mismatch/);
  assert.match(unbound.text, /target_policy_mismatch/);
  assert.deepEqual(calls, []);
});

test('semantic mutations require an observation created by the owned fixture', async () => {
  const calls: string[] = [];
  const [wrapped] = applyComputerUseRealModelPolicy(toolSet(calls), {
    allowedActions: ['observe', 'click_element'],
    maxTotalActions: 3,
    maxActionCounts: { observe: 1, click_element: 1 },
    allowedApps: ['Owned Fixture'],
  });
  const context = {
    sessionId: 's',
    turnId: 't',
    toolCallId: 'c',
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
  await wrapped.impl({
    action: 'observe',
    app: 'Owned Fixture',
  } as never, context);
  const owned = await wrapped.impl({
    action: 'click_element',
    observation_id: 'owned-observation',
    element_id: '7',
  } as never, context) as { text: string };
  assert.equal(owned.text, 'ok');
  assert.deepEqual(calls, ['observe', 'click_element']);
});

test('wait and cursor_position do not require an impossible observation_id', async () => {
  const calls: string[] = [];
  const [wrapped] = applyComputerUseRealModelPolicy(toolSet(calls), {
    allowedActions: ['wait', 'cursor_position'],
    maxTotalActions: 2,
    maxActionCounts: { wait: 1, cursor_position: 1 },
    allowedApps: ['Owned Fixture'],
  });
  const context = {
    sessionId: 's',
    turnId: 't',
    toolCallId: 'c',
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };

  const wait = await wrapped.impl(
    { action: 'wait', duration: 0.01 } as never,
    context,
  ) as { text: string };
  const cursor = await wrapped.impl(
    { action: 'cursor_position' } as never,
    context,
  ) as { text: string };

  assert.equal(wait.text, 'ok');
  assert.equal(cursor.text, 'ok');
  assert.deepEqual(calls, ['wait', 'cursor_position']);
});
