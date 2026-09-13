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
import { act, createElement, useState } from 'react';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { useStableActions } from '../../renderer/use-stable-actions.js';

/**
 * Action identity is a contract in this renderer, not an implementation
 * detail. AppShell's nine `useStableActions` call sites hand their results to
 * consumers that list them in dependency arrays and pass them down as props;
 * a per-render identity there re-arms effect timers and defeats `memo` on
 * every commit — measured at 20 full re-renders of a 32-row sidebar for one
 * session switch (#4109).
 *
 * Asserting it on the mechanism covers all nine by construction. What it
 * cannot cover is a factory that goes through neither this hook nor a
 * once-created object; that failure is invisible to types and to
 * `useExhaustiveDependencies`, which is why the Session rail also carries an
 * outcome budget in `session-rail-render-contract.spec.ts`.
 */
describe('useStableActions', () => {
  afterEach(cleanupFakeDom);

  it('fixes action identities while delegating to the latest committed closures', () => {
    const { root } = installReactRenderer();
    const identities: Array<{ report(): number }> = [];
    let bump: ((next: number) => void) | undefined;

    function Probe(): null {
      const [value, setValue] = useState(0);
      bump = setValue;
      // A factory whose closure genuinely captures a changing dep — the case
      // the facade exists for.
      identities.push(
        useStableActions((deps: { value: number }) => ({ report: () => deps.value }), { value }),
      );
      return null;
    }

    act(() => {
      root.render(createElement(Probe));
    });
    act(() => bump?.(1));
    act(() => bump?.(2));

    assert.equal(identities.length, 3);
    const [first] = identities;
    assert.ok(first);
    for (const actions of identities) {
      assert.equal(actions, first, 'the facade itself is re-created');
      assert.equal(actions.report, first.report, 'a method identity changed between renders');
    }
    assert.equal(first.report(), 2, 'the facade did not delegate to the latest committed render');
  });
});
