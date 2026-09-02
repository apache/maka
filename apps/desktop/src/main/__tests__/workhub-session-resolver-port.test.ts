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
  WorkHubSessionResolution,
  WorkHubSessionResolver,
} from '../../renderer/application/contracts/workhub-request-intent.js';
import {
  createWorkHubRoutePolicy,
  type WorkHubStoppableSession,
} from '../../renderer/workhub-route-policy.js';

const stoppable = (
  sessionId: string,
  sessionName: string,
  activeActionIds: readonly string[],
): WorkHubStoppableSession => ({
  target: { sessionId },
  projectName: 'demo',
  sessionName,
  updatedAt: 1,
  activeActionIds,
});

/**
 * A stand-in for a later ranked resolver. It recalls by remembered description
 * rather than display name, which is exactly the recall the exact-name baseline
 * cannot do, and it answers in the same contract.
 */
const describedResolver = (
  descriptions: ReadonlyMap<string, string>,
): WorkHubSessionResolver => ({
  resolve({ reference, sessions }): WorkHubSessionResolution {
    const candidates = sessions
      .filter((session) => descriptions.get(session.ref) === reference.text)
      .map((session) => ({
        ref: session.ref,
        evidence: { kind: 'named' as const, remainder: '' },
      }));
    const [first, ...rest] = candidates;
    if (!first) return { kind: 'none' };
    if (rest.length > 0) return { kind: 'ambiguous', candidates };
    return { kind: 'ranked', candidates: [first] };
  },
});

test('stop resolves through the shared port rather than a stop-specific grammar', () => {
  const sessions = [
    stoppable('payments', 'Payments', ['action-1']),
    stoppable('login', 'Login', ['action-2']),
  ];

  // Action Intent extracts the reference ("Stop the payment timeout work" ->
  // "payment timeout work"); resolving it is the Resolver's business alone.
  // The exact-name baseline recalls the display name and nothing else.
  const baseline = createWorkHubRoutePolicy();
  assert.deepEqual(baseline.resolveStop({ text: 'Stop Payments', sessions }), {
    kind: 'target',
    target: { sessionId: 'payments' },
    stopsActionId: 'action-1',
  });
  assert.deepEqual(
    baseline.resolveStop({ text: 'Stop the payment timeout work', sessions }),
    { kind: 'not_requested' },
  );

  // Swapping the resolver changes only recall. The decision the stop policy
  // produces keeps the same opaque identities and the same durable protocol.
  const ranked = createWorkHubRoutePolicy(
    describedResolver(new Map([['payments', 'payment timeout work']])),
  );
  assert.deepEqual(ranked.resolveStop({ text: 'Stop the payment timeout work', sessions }), {
    kind: 'target',
    target: { sessionId: 'payments' },
    stopsActionId: 'action-1',
  });
});

test('the stop policy, not the resolver, owns destructive sufficiency', () => {
  const descriptions = new Map([['payments', 'payment timeout work']]);
  const text = 'Stop the payment timeout work';

  // A confidently resolved Session with no active WorkHub delegation, and one
  // with several, are both refused with the reason they were refused.
  assert.deepEqual(
    createWorkHubRoutePolicy(describedResolver(descriptions)).resolveStop({
      text,
      sessions: [stoppable('payments', 'Payments', [])],
    }),
    { kind: 'clarification', reason: 'stop_target_not_active' },
  );
  assert.deepEqual(
    createWorkHubRoutePolicy(describedResolver(descriptions)).resolveStop({
      text,
      sessions: [stoppable('payments', 'Payments', ['action-1', 'action-2'])],
    }),
    { kind: 'clarification', reason: 'stop_target_not_unique' },
  );
});

test('an ambiguous recall never becomes a destructive target', () => {
  const resolver = describedResolver(
    new Map([
      ['payments', 'payment timeout work'],
      ['payments-eu', 'payment timeout work'],
    ]),
  );
  assert.deepEqual(
    createWorkHubRoutePolicy(resolver).resolveStop({
      text: 'Stop the payment timeout work',
      sessions: [
        stoppable('payments', 'Payments', ['action-1']),
        stoppable('payments-eu', 'Payments EU', ['action-2']),
      ],
    }),
    { kind: 'clarification', reason: 'stop_target_ambiguous' },
  );
});

test('a resolver cannot widen stop beyond the visible candidate set it was given', () => {
  const resolver: WorkHubSessionResolver = {
    resolve: () => ({
      kind: 'ranked',
      candidates: [
        { ref: 'never-offered', evidence: { kind: 'named', remainder: '' } },
      ],
    }),
  };
  assert.deepEqual(
    createWorkHubRoutePolicy(resolver).resolveStop({
      text: 'Stop Payments',
      sessions: [stoppable('payments', 'Payments', ['action-1'])],
    }),
    { kind: 'not_requested' },
  );
});

test('a stop cue with no safe reference asks for one instead of resolving', () => {
  const resolver: WorkHubSessionResolver = {
    resolve: () => assert.fail('an unsafe reference must not reach the Session Resolver'),
  };
  assert.deepEqual(
    createWorkHubRoutePolicy(resolver).resolveStop({
      text: 'Stop it',
      sessions: [stoppable('payments', 'Payments', ['action-1'])],
    }),
    { kind: 'clarification', reason: 'stop_target_required' },
  );
});
