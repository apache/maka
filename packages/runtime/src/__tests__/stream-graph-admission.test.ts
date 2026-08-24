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
import { describe, test } from 'node:test';
import type {
  AgentGraphIntentClaim,
  AgentGraphIntentClaimRequest,
  AgentGraphIntentClaimStore,
} from '@maka/core/agent-graph-control';
import {
  claimAgentGraphRunnableIntent,
  fingerprintAgentGraphRunnableIntent,
} from '../stream-graph-admission.js';
import type { AgentGraphRunnableIntent } from '../stream-graph-readiness.js';

describe('stream graph admission', () => {
  test('claims one durable activation identity without invoking runtime', async () => {
    const store = new MemoryClaimStore();
    const generated = ['turn-first', 'run-first', 'turn-discarded', 'run-discarded'];
    const first = await claimAgentGraphRunnableIntent({
      intent: runnableIntent(),
      store,
      newId: () => generated.shift()!,
      executionInput: { prompt: 'summarize the committed record' },
    });
    const retry = await claimAgentGraphRunnableIntent({
      intent: runnableIntent(),
      store,
      newId: () => generated.shift()!,
      executionInput: { prompt: 'summarize the committed record' },
    });

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.deepEqual(retry.claim, first.claim);
    assert.equal(first.claim.targetSessionId, 'session-child');
    assert.equal(first.claim.targetTurnId, 'turn-first');
    assert.equal(first.claim.targetRunId, 'run-first');
    assert.match(first.claim.claimId, /^graph_claim_[a-f0-9]{32}$/);
    assert.match(first.claim.intentFingerprint, /^sha256:[a-f0-9]{64}$/);
  });

  test('binds resolved execution input into the durable intent fingerprint', async () => {
    const firstStore = new MemoryClaimStore();
    const secondStore = new MemoryClaimStore();
    const first = await claimAgentGraphRunnableIntent({
      intent: runnableIntent(),
      store: firstStore,
      newId: nextId(),
      executionInput: { prompt: 'summarize the committed record' },
    });
    const same = await claimAgentGraphRunnableIntent({
      intent: runnableIntent(),
      store: secondStore,
      newId: nextId(),
      executionInput: { prompt: 'summarize the committed record' },
    });
    const drifted = await claimAgentGraphRunnableIntent({
      intent: runnableIntent(),
      store: new MemoryClaimStore(),
      newId: nextId(),
      executionInput: { prompt: 'perform different work' },
    });

    assert.equal(first.claim.intentFingerprint, same.claim.intentFingerprint);
    assert.notEqual(first.claim.intentFingerprint, drifted.claim.intentFingerprint);
    assert.equal(
      first.claim.intentFingerprint,
      fingerprintAgentGraphRunnableIntent({
        intent: runnableIntent(),
        executionInput: { prompt: 'summarize the committed record' },
      }),
    );
    assert.throws(
      () =>
        claimAgentGraphRunnableIntent({
          intent: runnableIntent(),
          store: new MemoryClaimStore(),
          newId: nextId(),
          executionInput: { prompt: '   ' },
        }),
      /prompt must not be empty/,
    );
  });
});

class MemoryClaimStore implements AgentGraphIntentClaimStore {
  private claim: AgentGraphIntentClaim | undefined;

  async claimAgentGraphIntent(request: AgentGraphIntentClaimRequest) {
    if (this.claim) return { claim: this.claim, created: false };
    this.claim = { ...request, claimedAt: 42 };
    return { claim: this.claim, created: true };
  }

  async readAgentGraphIntentClaim() {
    return this.claim;
  }

  async listAgentGraphIntentClaims() {
    return this.claim ? [this.claim] : [];
  }
}

function runnableIntent(): AgentGraphRunnableIntent {
  return {
    schemaVersion: 1,
    intentId: `graph_intent_${'a'.repeat(32)}`,
    graphId: 'graph-1',
    readinessContextFingerprint: `sha256:${'b'.repeat(64)}`,
    policyFingerprint: `sha256:${'c'.repeat(64)}`,
    readinessId: 'readiness-1',
    operatorId: 'summarizer',
    targetSessionId: 'session-child',
    policyKind: 'map',
    triggerRouteIds: ['route-1'],
    triggerRecordIds: ['record-1'],
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}
