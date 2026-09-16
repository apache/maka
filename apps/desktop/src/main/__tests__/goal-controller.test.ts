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

import { deferred } from '@maka/core/test-only/async-primitives';
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement } from 'react';
import type { GoalState, GoalStatus } from '@maka/core/goal';
import { LocaleProvider } from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeGoalServices,
  GoalServicesProvider,
  useGoalController,
  type GoalController,
  type GoalServices,
  type UseGoalControllerInput,
} from '../../renderer/features/goals/testing.js';

function goal(
  sessionId: string,
  status: GoalStatus = 'active',
): GoalState {
  return {
    id: `goal-${sessionId}`,
    revision: 1,
    sessionId,
    condition: `Finish ${sessionId}`,
    status,
    setAt: 100,
    iterations: 2,
    maxIterations: 9,
    consecutiveNoProgress: 0,
    blockCap: 3,
    tokenBudget: 500,
    tokensAtStart: 10,
    tokensNow: 60,
    tokensBaselinePending: false,
    ...(status === 'paused' ? { pausedAt: 200 } : {}),
  };
}
let latestController: GoalController | undefined;

function ControllerProbe(props: UseGoalControllerInput) {
  latestController = useGoalController(props);
  return null;
}

function renderController(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: GoalServices,
  input: UseGoalControllerInput,
) {
  root.render(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(
        GoalServicesProvider,
        { services },
        createElement(ControllerProbe, input),
      ),
    }),
  );
}

function controller(): GoalController {
  assert.ok(latestController);
  return latestController;
}

function input(
  activeSessionId: string | undefined,
  errors: string[] = [],
): UseGoalControllerInput {
  return {
    activeSessionId,
    reportError: (sessionId, title, description) => {
      errors.push(`${sessionId}: ${title}: ${description ?? ''}`);
    },
  };
}

afterEach(() => {
  latestController = undefined;
  cleanupFakeDom();
});

describe('useGoalController', () => {
  it('clears on Session switch and ignores the previous Session late read', async () => {
    const { root } = installReactRenderer();
    const first = deferred<GoalState | null>();
    let disposers = 0;
    const defaults = createFakeGoalServices();
    const services = createFakeGoalServices({
      goal: {
        ...defaults.goal,
        get: (sessionId) =>
          sessionId === 'a' ? first.promise : Promise.resolve(goal('b')),
        subscribeChanges: () => () => {
          disposers += 1;
        },
      },
    });

    await act(async () => renderController(root, services, input('a')));
    assert.equal(controller().selectors.indicator, undefined);
    await act(async () => renderController(root, services, input('b')));
    assert.equal(controller().selectors.indicator?.condition, 'Finish b');
    assert.equal(disposers, 1);

    await act(async () => first.resolve(goal('a')));
    assert.equal(controller().selectors.indicator?.condition, 'Finish b');

    await act(async () => root.unmount());
    assert.equal(disposers, 2);
  });

  it('refreshes for matching and broadcast Goal changes only', async () => {
    const { root } = installReactRenderer();
    let gets = 0;
    let emit: ((sessionId: string | undefined) => void) | undefined;
    const defaults = createFakeGoalServices();
    const services = createFakeGoalServices({
      goal: {
        ...defaults.goal,
        get: async () => {
          gets += 1;
          return gets === 2 ? goal('a', 'achieved') : goal('a');
        },
        subscribeChanges: (handler) => {
          emit = handler;
          return () => undefined;
        },
      },
    });

    await act(async () => renderController(root, services, input('a')));
    assert.equal(gets, 1);
    assert.equal(controller().selectors.active, true);

    await act(async () => emit?.('other'));
    assert.equal(gets, 1);

    await act(async () => emit?.('a'));
    assert.equal(gets, 2);
    assert.equal(controller().selectors.active, false);

    await act(async () => emit?.(undefined));
    assert.equal(gets, 3);
    assert.equal(controller().selectors.active, true);
  });

  it('snapshots the dialog Session across navigation and routes arm through the port', async () => {
    const { root } = installReactRenderer();
    const arms: unknown[][] = [];
    const defaults = createFakeGoalServices();
    const services = createFakeGoalServices({
      goal: {
        ...defaults.goal,
        arm: async (...args) => {
          arms.push(args);
          return { kind: 'armed', goal: goal(args[0]) };
        },
      },
    });

    await act(async () => renderController(root, services, input('a')));
    await act(async () => controller().commands.openDialog());
    await act(async () => renderController(root, services, input('b')));

    assert.equal(controller().host.dialogSessionId, 'a');
    await act(async () =>
      controller().host.arm(controller().host.dialogSessionId!, {
        condition: 'ship it',
        maxIterations: null,
        tokenBudget: 1_000,
      }),
    );
    assert.deepEqual(arms, [
      ['a', { condition: 'ship it', maxIterations: null, tokenBudget: 1_000 }],
    ]);
  });

  it('projects the kill switch and deduplicates pending pause controls', async () => {
    const { root } = installReactRenderer();
    const pause = deferred<void>();
    let pauseCalls = 0;
    const errors: string[] = [];
    const defaults = createFakeGoalServices();
    const services = createFakeGoalServices({
      goal: {
        ...defaults.goal,
        get: async () => goal('a'),
        pause: () => {
          pauseCalls += 1;
          return pauseCalls === 1 ? pause.promise : Promise.resolve();
        },
      },
    });

    await act(async () => renderController(root, services, input('a', errors)));
    const indicator = controller().selectors.indicator;
    assert.equal(indicator?.condition, 'Finish a');
    assert.equal(indicator?.tokensSpent, 60);
    assert.equal(indicator?.tokenBudget, 500);

    await act(async () => {
      indicator?.onPause?.();
      indicator?.onPause?.();
    });
    assert.equal(pauseCalls, 1);

    await act(async () => pause.reject(new Error('offline')));
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0],
      'a: Could not pause the goal: The goal may still be continuing. Try again now.',
    );

    await act(async () => controller().selectors.indicator?.onPause?.());
    assert.equal(pauseCalls, 2);
  });

  it('routes resume and clear controls for paused Goals', async () => {
    const { root } = installReactRenderer();
    const calls: string[] = [];
    const defaults = createFakeGoalServices();
    const services = createFakeGoalServices({
      goal: {
        ...defaults.goal,
        get: async () => goal('a', 'paused'),
        clear: async (sessionId) => {
          calls.push(`clear:${sessionId}`);
        },
        resume: async (sessionId) => {
          calls.push(`resume:${sessionId}`);
        },
      },
    });

    await act(async () => renderController(root, services, input('a')));
    const indicator = controller().selectors.indicator;
    assert.equal(indicator?.status, 'paused');
    assert.equal(indicator?.pausedAt, 200);
    await act(async () => {
      indicator?.onResume?.();
      indicator?.onClear();
    });
    assert.deepEqual(calls, ['resume:a', 'clear:a']);
  });
});
