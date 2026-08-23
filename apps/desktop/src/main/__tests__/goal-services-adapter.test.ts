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
import { describe, it } from 'node:test';
import type { SessionChangedEvent } from '@maka/core/session';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import { createDesktopGoalServices } from '../../renderer/platform/desktop/create-goal-services.js';

describe('createDesktopGoalServices', () => {
  it('maps Goal operations and narrows Session changes to Goal events', async () => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    let sessionHandler: ((event: SessionChangedEvent) => void) | undefined;
    let disposed = 0;
    const bridge = {
      goal: new Proxy({}, {
        get: (_target, property) => (...args: unknown[]) => {
          calls.push({ name: `goal.${String(property)}`, args });
          return Promise.resolve(undefined);
        },
      }),
      sessions: {
        subscribeChanges(handler: (event: SessionChangedEvent) => void) {
          sessionHandler = handler;
          return () => {
            disposed += 1;
          };
        },
      },
    } as unknown as MakaBridge;
    const services = createDesktopGoalServices(bridge);

    await services.goal.get('s');
    await services.goal.arm('s', {
      condition: 'done',
      maxIterations: 4,
      tokenBudget: null,
    });
    await services.goal.clear('s');
    await services.goal.pause('s');
    await services.goal.resume('s');

    const changes: Array<string | undefined> = [];
    const unsubscribe = services.goal.subscribeChanges((sessionId) => {
      changes.push(sessionId);
    });
    sessionHandler?.({
      reason: 'updated',
      sessionId: 'ignored',
      ts: 1,
    });
    sessionHandler?.({
      reason: 'goal-change',
      sessionId: 's',
      ts: 2,
    });
    sessionHandler?.({
      reason: 'goal-change',
      ts: 3,
    });
    unsubscribe();

    assert.deepEqual(calls, [
      { name: 'goal.get', args: ['s'] },
      {
        name: 'goal.arm',
        args: ['s', { condition: 'done', maxIterations: 4, tokenBudget: null }],
      },
      { name: 'goal.clear', args: ['s'] },
      { name: 'goal.pause', args: ['s'] },
      { name: 'goal.resume', args: ['s'] },
    ]);
    assert.deepEqual(changes, ['s', undefined]);
    assert.equal(disposed, 1);
  });
});
