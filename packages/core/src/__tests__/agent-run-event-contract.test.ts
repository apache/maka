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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeAgentRunEvent } from '../agent-run.js';
import type { AgentRunEvent, AgentRunStore, EmittedAgentRunEvent } from '../agent-run.js';

function ledgerRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'run_started',
    id: 'event-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    ...overrides,
  };
}

test('AgentRun reads an event type this build does not write', () => {
  // The ledger outlives the build that wrote it, so a reader meets types whose writer was retired
  // and types that have not shipped yet. Rejecting either one bricks startup on real data (#1942).
  const decoded = decodeAgentRunEvent(
    ledgerRecord({ type: 'written_by_another_version', data: { inputTokens: 7 } }),
  );

  assert.equal(decoded.type, 'written_by_another_version');
  assert.equal(decoded.data?.inputTokens, 7);
});

test('AgentRun still rejects a record whose envelope is damaged', () => {
  // Tolerating an unknown `type` is not tolerating an unreadable record: everything around `type`
  // stays exact, so real corruption is still caught rather than carried forward as a live event.
  for (const record of [
    ledgerRecord({ type: '' }),
    ledgerRecord({ type: '   ' }),
    ledgerRecord({ type: 42 }),
    ledgerRecord({ unexpectedField: 'present' }),
    ledgerRecord({ ts: 'not-a-number' }),
    ledgerRecord({ id: undefined }),
  ]) {
    assert.throws(() => decodeAgentRunEvent(record), /Invalid AgentRun event schema/);
  }
});

test('AgentRun closes its write contract against a type this build does not emit', () => {
  // The assertion here is the compiler: `@ts-expect-error` itself fails to build if the call ever
  // type-checks again, which is what widening `appendEvent` back to `AgentRunEvent` would do. The
  // call is only declared, never made, so the contract is checked without a store.
  const retired: AgentRunEvent = ledgerRecord({
    type: 'written_by_another_version',
  }) as unknown as AgentRunEvent;
  const appendRetired = (store: AgentRunStore) =>
    // @ts-expect-error A ledger is read with any type but appended to only with an emitted one.
    store.appendEvent('session-1', 'run-1', retired);
  assert.equal(typeof appendRetired, 'function');

  const emitted: EmittedAgentRunEvent = { ...retired, type: 'run_started' };
  const appendEmitted = (store: AgentRunStore) => store.appendEvent('session-1', 'run-1', emitted);
  assert.equal(typeof appendEmitted, 'function');
});
