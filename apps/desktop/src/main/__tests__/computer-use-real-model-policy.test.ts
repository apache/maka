/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ComputerUseToolSet,
  PreparedComputerUseInvocation,
} from '@maka/runtime/computer-use-tools';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import {
  applyComputerUseRealModelPolicy,
  parseComputerUseRealModelPolicy,
} from '../computer-use-real-model-policy.js';

const fixtureTarget = {
  kind: 'running' as const,
  identity: { kind: 'bundle_id' as const, bundleId: 'com.github.Electron' },
  selector: { pid: 42, processGeneration: 'pst:7', windowId: 9 },
};

function toolSet(executed: string[]): ComputerUseToolSet {
  const tool: MakaTool = {
    name: 'maka_computer',
    description: 'test',
    parameters: {},
    impl: async () => {
      throw new Error('raw implementation must not bypass preparation');
    },
  };
  const tools = [tool] as ComputerUseToolSet;
  tools.prepareInvocation = async (rawArgs) => {
    const action = (rawArgs as { action: string }).action;
    const binding =
      action === 'list_apps'
        ? ({ action, target: { kind: 'app_catalog' } } as const)
        : action === 'wait'
          ? ({ action, target: { kind: 'targetless' } } as const)
          : action === 'launch_app'
            ? ({
                action,
                target: {
                  kind: 'application',
                  resolved: {
                    kind: 'installed',
                    identity: { kind: 'bundle_id', bundleId: 'com.github.Electron' },
                  },
                },
              } as const)
            : action === 'observe'
              ? ({ action, target: { kind: 'application', resolved: fixtureTarget } } as const)
              : ({
                  action,
                  target: {
                    kind: 'observation',
                    binding: {
                      turnId: 't',
                      frameId: 'owned-frame',
                      epoch: 1,
                      target: fixtureTarget,
                    },
                  },
                } as const);
    return {
      admission: { kind: 'macos_bundle_id', bundleId: 'com.github.Electron' },
      projectionInput: rawArgs as never,
      policyBinding: binding as PreparedComputerUseInvocation['policyBinding'],
      async execute() {
        executed.push(action);
        return {
          result: { text: 'ok' },
          metadata:
            action === 'observe'
              ? {
                  freshObservation: {
                    turnId: 't',
                    frameId: 'owned-frame',
                    epoch: 1,
                    target: fixtureTarget,
                  },
                }
              : {},
        };
      },
    } satisfies PreparedComputerUseInvocation;
  };
  tools.clearSession = () => {};
  tools.sessionEvents = {
    snapshot: () => ({ status: 'unobserved', generation: 0 }),
    physicalUserIntervened: () => ({ status: 'intervention_debounce', generation: 1 }),
    interventionDebounceElapsed: () => ({ status: 'reobserve_required', generation: 1 }),
    reobserveRequired: () => ({ status: 'reobserve_required', generation: 1 }),
    screenLocked: () => ({ status: 'screen_locked', generation: 1 }),
    screenUnlocked: () => ({ status: 'reobserve_required', generation: 1 }),
    blockedUrlDetected: () => ({ status: 'blocked_url', generation: 1 }),
    userStopped: () => ({ status: 'user_stopped', generation: 1 }),
    dynamicContentChanged: () => ({ status: 'unobserved', generation: 0 }),
  };
  return tools;
}

const policy = {
  allowedActions: ['observe', 'click_element'],
  maxTotalActions: 2,
  maxActionCounts: { observe: 1, click_element: 1 },
  allowedTargets: [{ pid: 42, processGeneration: 'pst:7', windowIds: [9] }],
};

const context = {
  sessionId: 's',
  turnId: 't',
  toolCallId: 'c',
  cwd: '/tmp',
  abortSignal: new AbortController().signal,
  emitOutput() {},
};

test('parses exact native target allowlists and rejects obsolete app names', () => {
  assert.deepEqual(parseComputerUseRealModelPolicy(JSON.stringify(policy)), policy);
  assert.throws(
    () =>
      parseComputerUseRealModelPolicy(
        JSON.stringify({ ...policy, allowedTargets: undefined, allowedApps: ['Fixture'] }),
      ),
    /allowedTargets/,
  );
  assert.throws(
    () =>
      parseComputerUseRealModelPolicy(
        JSON.stringify({
          ...policy,
          allowedTargets: [{ pid: 42, processGeneration: 'pst:18446744073709551616' }],
        }),
      ),
    /allowedTargets/,
  );
});

test('prepared policy binds the fixture target and observation before execution', async () => {
  const executed: string[] = [];
  const wrapped = applyComputerUseRealModelPolicy(toolSet(executed), policy);
  const observe = await wrapped.prepareInvocation(
    { action: 'observe' },
    { sessionId: 's', turnId: 't', toolCallId: 'observe', signal: context.abortSignal },
  );
  assert.deepEqual(executed, [], 'preparation and admission do not consume execution budget');
  await observe.execute(context);
  const click = await wrapped.prepareInvocation(
    { action: 'click_element' },
    { sessionId: 's', turnId: 't', toolCallId: 'click', signal: context.abortSignal },
  );
  await click.execute(context);
  assert.deepEqual(executed, ['observe', 'click_element']);
});

test('installed targets and the wrong process generation fail before admission', async () => {
  const executed: string[] = [];
  const wrapped = applyComputerUseRealModelPolicy(toolSet(executed), {
    ...policy,
    allowedActions: [...policy.allowedActions, 'launch_app'],
    maxActionCounts: { ...policy.maxActionCounts, launch_app: 1 },
  });
  await assert.rejects(
    wrapped.prepareInvocation(
      { action: 'launch_app' },
      { sessionId: 's', turnId: 't', toolCallId: 'launch', signal: context.abortSignal },
    ),
    /target_policy_mismatch/,
  );
  const wrongGeneration = applyComputerUseRealModelPolicy(toolSet(executed), {
    ...policy,
    allowedTargets: [{ pid: 42, processGeneration: 'pst:8', windowIds: [9] }],
  });
  await assert.rejects(
    wrongGeneration.prepareInvocation(
      { action: 'observe' },
      { sessionId: 's', turnId: 't', toolCallId: 'observe', signal: context.abortSignal },
    ),
    /target_policy_mismatch/,
  );
  assert.deepEqual(executed, []);
});
