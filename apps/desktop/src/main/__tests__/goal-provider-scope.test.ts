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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement, Fragment } from 'react';
import type { GoalState } from '@maka/core/goal';
import {
  LocaleProvider,
  useChatViewGoalProjection,
  useComposerGoalProjection,
} from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeGoalServices,
  GoalProvider,
  GoalServicesProvider,
  type GoalServices,
} from '../../renderer/features/goals/testing.js';

type ComposerProbeProps = ReturnType<typeof useComposerGoalProjection>;
type IndicatorProbeProps = ReturnType<typeof useChatViewGoalProjection>;

let shellRenders = 0;
let composerRenders = 0;
let indicatorRenders = 0;
let latestComposer: ComposerProbeProps | undefined;
let latestIndicator: IndicatorProbeProps | undefined;

function ComposerProbe() {
  const props = useComposerGoalProjection();
  composerRenders += 1;
  latestComposer = props;
  return null;
}

function IndicatorProbe() {
  const props = useChatViewGoalProjection();
  indicatorRenders += 1;
  latestIndicator = props;
  return null;
}

function ShellProbe() {
  shellRenders += 1;
  return createElement(
    Fragment,
    null,
    createElement(ComposerProbe),
    createElement(IndicatorProbe),
  );
}

function goal(tokensNow: number): GoalState {
  return {
    id: 'goal-a',
    revision: tokensNow,
    sessionId: 'a',
    condition: 'Finish a',
    status: 'active',
    setAt: 100,
    iterations: 2,
    maxIterations: 9,
    consecutiveNoProgress: 0,
    blockCap: 3,
    tokenBudget: 500,
    tokensAtStart: 10,
    tokensNow,
    tokensBaselinePending: false,
  };
}

function renderProvider(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: GoalServices,
  reportError: (sessionId: string, title: string, description?: string) => void,
  enabled = true,
) {
  root.render(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(
        GoalServicesProvider,
        { services },
        createElement(
          GoalProvider,
          { activeSessionId: 'a', canOpenDialog: enabled, reportError },
          createElement(ShellProbe),
        ),
      ),
    }),
  );
}

afterEach(() => {
  shellRenders = 0;
  composerRenders = 0;
  indicatorRenders = 0;
  latestComposer = undefined;
  latestIndicator = undefined;
  cleanupFakeDom();
});

describe('GoalProvider render scope', () => {
  it('updates only the projection whose reader changed', async () => {
    const { root } = installReactRenderer();
    let current = goal(60);
    let emit: ((sessionId: string | undefined) => void) | undefined;
    const defaults = createFakeGoalServices();
    const services = createFakeGoalServices({
      goal: {
        ...defaults.goal,
        get: async () => current,
        subscribeChanges: (handler) => {
          emit = handler;
          return () => undefined;
        },
      },
    });

    await act(async () => renderProvider(root, services, () => undefined));
    assert.equal(latestComposer?.goalActive, true);
    assert.equal(latestIndicator?.goalIndicator?.tokensSpent, 60);
    assert.equal(shellRenders, 1);

    const composerBeforeRefresh = composerRenders;
    const indicatorBeforeRefresh = indicatorRenders;
    current = goal(75);
    await act(async () => emit?.('a'));

    assert.equal(shellRenders, 1);
    assert.equal(composerRenders, composerBeforeRefresh);
    assert.equal(indicatorRenders, indicatorBeforeRefresh + 1);
    assert.equal(latestIndicator?.goalIndicator?.tokensSpent, 75);

    const composerBeforeDialog = composerRenders;
    const indicatorBeforeDialog = indicatorRenders;
    await act(async () => latestComposer?.onSetGoal?.());
    assert.equal(shellRenders, 1);
    assert.equal(composerRenders, composerBeforeDialog);
    assert.equal(indicatorRenders, indicatorBeforeDialog);

    await act(async () => root.unmount());
  });

  it('withholds the command when disabled and reports failures to the latest owner', async () => {
    const { root } = installReactRenderer();
    const firstErrors: string[] = [];
    const latestErrors: string[] = [];
    const defaults = createFakeGoalServices();
    const services = createFakeGoalServices({
      goal: {
        ...defaults.goal,
        get: async () => goal(60),
        pause: async () => {
          throw new Error('offline');
        },
      },
    });

    await act(async () =>
      renderProvider(
        root,
        services,
        (_sessionId, _title, description) => firstErrors.push(description ?? ''),
        false,
      ),
    );
    assert.equal(latestComposer?.goalActive, true);
    assert.equal(latestComposer?.onSetGoal, undefined);

    await act(async () =>
      renderProvider(
        root,
        services,
        (_sessionId, _title, description) => latestErrors.push(description ?? ''),
      ),
    );
    assert.equal(typeof latestComposer?.onSetGoal, 'function');
    await act(async () => {
      latestIndicator?.goalIndicator?.onPause?.();
      await Promise.resolve();
    });

    assert.deepEqual(firstErrors, []);
    assert.equal(latestErrors.length, 1);
    assert.match(latestErrors[0] ?? '', /still be continuing/);

    await act(async () => root.unmount());
  });

  it('defaults standalone UI readers to an inactive Goal projection', async () => {
    const { root } = installReactRenderer();
    await act(async () => root.render(createElement(ShellProbe)));
    assert.equal(latestComposer?.goalActive, false);
    assert.equal(latestComposer?.onSetGoal, undefined);
    assert.equal(latestIndicator?.goalIndicator, undefined);
    await act(async () => root.unmount());
  });
});
