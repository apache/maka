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
import { test } from 'node:test';
import type {
  HostedExecutionCompletion,
  HostedExecutionListener,
  HostedExecutionRef,
  HostedExecutionSnapshot,
} from '../server/hosted-execution-authority.js';
import { waitForHostedExecutionTerminal } from '../server/hosted-execution-wait.js';

test('Hosted Execution wait rejects an authority failure after the active owner is released', async () => {
  const execution: HostedExecutionRef = {
    sessionId: 'session-wait',
    turnId: 'turn-wait',
    runId: 'run-wait',
  };
  const running = snapshot(execution, 'running');
  let settleCompletion!: (completion: HostedExecutionCompletion) => void;
  const completion = new Promise<HostedExecutionCompletion>((resolve) => {
    settleCompletion = resolve;
  });
  const listeners = new Set<HostedExecutionListener>();
  const waiting = waitForHostedExecutionTerminal(
    {
      reconcile: async () => running,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    execution,
    running,
    { completion },
  );

  settleCompletion({
    kind: 'authority_error',
    execution,
    reason: 'terminal authority write failed',
  });

  await assert.rejects(waiting, /terminal authority write failed/u);
  assert.equal(listeners.size, 0);
});

function snapshot(
  execution: HostedExecutionRef,
  status: Extract<HostedExecutionSnapshot['status'], 'running'>,
): HostedExecutionSnapshot {
  return {
    ...execution,
    status,
  };
}
