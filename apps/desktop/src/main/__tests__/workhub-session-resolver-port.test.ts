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
import { createWorkHubRoutePolicy } from '../../renderer/workhub-route-policy.js';

const routable = (sessionId: string, sessionName: string) => ({
  target: { sessionId },
  projectName: 'demo',
  sessionName,
  updatedAt: 1,
});

/** Stands in for the Host read the stop policy makes once a reference resolves. */
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

test('stop resolves through the shared port rather than a stop-specific grammar', async () => {
  const sessions = [routable('payments', 'Payments'), routable('login', 'Login')];

  // Action Intent extracts the reference ("Stop the payment timeout work" ->
  // "payment timeout work"); resolving it is the Resolver's business alone.
  // The exact-name baseline recalls the display name and nothing else.
  const baseline = createWorkHubRoutePolicy();
  assert.deepEqual(baseline.resolveStop({ text: 'Stop Payments', sessions}), {
    kind: 'target',
    target: { sessionId: 'payments' },
  });
  assert.deepEqual(
    baseline.resolveStop({
      text: 'Stop the payment timeout work',
      sessions,
    }),
    { kind: 'not_requested' },
  );

  // Swapping the resolver changes only recall. The decision the stop policy
  // produces keeps the same opaque identities and the same durable protocol.
  const ranked = createWorkHubRoutePolicy(
    describedResolver(new Map([['payments', 'payment timeout work']])),
  );
  assert.deepEqual(
    ranked.resolveStop({
      text: 'Stop the payment timeout work',
      sessions,
    }), {
    kind: 'target',
    target: { sessionId: 'payments' },
  });
});

test('an ambiguous recall never becomes a destructive target', async () => {
  const resolver = describedResolver(
    new Map([
      ['payments', 'payment timeout work'],
      ['payments-eu', 'payment timeout work'],
    ]),
  );
  assert.deepEqual(
    createWorkHubRoutePolicy(resolver).resolveStop({
      text: 'Stop the payment timeout work',
      sessions: [routable('payments', 'Payments'), routable('payments-eu', 'Payments EU')],
    }),
    { kind: 'clarification', reason: 'stop_target_ambiguous' },
  );
});

test('a resolver cannot widen stop beyond the visible candidate set it was given', async () => {
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
      sessions: [routable('payments', 'Payments')],
    }),
    { kind: 'not_requested' },
  );
});

test('a stop cue with no safe reference asks for one instead of resolving', async () => {
  const resolver: WorkHubSessionResolver = {
    resolve: () => assert.fail('an unsafe reference must not reach the Session Resolver'),
  };
  assert.deepEqual(
    createWorkHubRoutePolicy(resolver).resolveStop({
      text: 'Stop it',
      sessions: [routable('payments', 'Payments')],
    }),
    { kind: 'clarification', reason: 'stop_target_required' },
  );
});
