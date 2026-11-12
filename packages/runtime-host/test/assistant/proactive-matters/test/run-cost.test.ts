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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatterController } from '../../../../src/assistant/proactive-matters/controller.js';
import { createMatterStore } from '../../../../src/assistant/proactive-matters/store.js';
import { RunCostLedger } from '../../../../src/assistant/run-cost.js';

// Matter activation cost and outcome (#6309): the activation is the unit, and the
// Usage window is the Matter's own Session while that activation held it.
test('each activation is recorded against its Matter with the Session usage of its window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-matter-cost-'));
  const store = createMatterStore(root);
  const asked: { sessionId: string; from: number; to: number }[] = [];
  const ledger = new RunCostLedger(join(root, 'cost'), async (sessionId, from, to) => {
    asked.push({ sessionId, from, to });
    return {
      calls: 6,
      inputTokens: 9000,
      cacheReadTokens: 8000,
      cacheWriteTokens: 0,
      outputTokens: 700,
      modelDurationMs: 12000,
      complete: true,
    };
  });
  let running = false;
  const agent = {
    snapshot: async () => ({ agent: { status: running ? 'running' : 'idle' } }),
    followup: async () => {
      running = true;
      return { disposition: 'turn_started', turnId: 'turn-1' };
    },
    whenIdle: async () => {
      running = false;
    },
    cancel: async () => {
      running = false;
    },
  };
  const ctx = {
    runCost: ledger,
    agents: {
      withInvocation: (_: unknown, fn: () => unknown) => fn(),
      resume: async () => agent,
    },
  };
  const controller = new MatterController(ctx as any, store, { tickMs: 60_000 });
  try {
    const m = store.create({ sessionId: 'matter-session', cwd: root, title: '核查', request: 'x' });
    controller.start();
    await controller.tick();
    await controller.close();
    const [first] = ledger.summary().recent;
    assert.equal(first.kind, 'matter_activation');
    assert.equal(first.matterId, m.id);
    // The activation ended without committing a settlement.
    assert.equal(first.outcome, 'failed');
    assert.equal(first.reported, null, 'an activation has no discovery report to count');
    assert.equal(first.calls, 6);
    assert.equal(first.inputTokens, 9000);
    assert.equal(first.durationMs, first.endedAt - first.startedAt);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].sessionId, 'matter-session');
    assert.ok(asked[0].from <= asked[0].to);

    // A second activation of the same Matter is counted for that Matter.
    const next = createMatterController(ctx, store);
    store.control(m.id, 'resume');
    next.start();
    await next.tick();
    await next.close();
    const { matters, daily } = ledger.summary();
    assert.equal(matters.length, 1);
    assert.equal(matters[0].matterId, m.id);
    assert.equal(matters[0].activations, 2);
    assert.equal(matters[0].calls, 12);
    assert.equal(daily[0].kind, 'matter_activation');
    assert.equal(daily[0].runs, 2);
  } finally {
    ledger.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function createMatterController(ctx: unknown, store: ReturnType<typeof createMatterStore>) {
  return new MatterController(ctx as any, store, { tickMs: 60_000 });
}

test('an admission the Host rejected ran no model and is not recorded as an activation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-matter-cost-defer-'));
  const store = createMatterStore(root);
  const ledger = new RunCostLedger(join(root, 'cost'), async () => {
    throw Error('must not read usage for a run that never started');
  });
  const agent = {
    snapshot: async () => ({ agent: { status: 'idle' } }),
    followup: async () => ({ disposition: 'blocked' }),
    whenIdle: async () => {},
    cancel: async () => {},
  };
  const ctx = {
    runCost: ledger,
    agents: {
      withInvocation: (_: unknown, fn: () => unknown) => fn(),
      resume: async () => agent,
    },
  };
  const controller = createMatterController(ctx, store);
  try {
    store.create({ sessionId: 'matter-session', cwd: root, title: '核查', request: 'x' });
    controller.start();
    await controller.tick();
    await controller.close();
    assert.deepEqual(ledger.summary().recent, []);
  } finally {
    ledger.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// A retryable failure clears the activation on purpose (retryExecution). That is
// an automatic retry, not the user pausing the run, and must be recorded as one.
for (const [name, errorClass, expected] of [
  ['a retryable execution failure', 'network', 'retried'],
  ['a failure that is not retryable', 'invalid_request', 'failed'],
] as const)
  test(`${name} is recorded as ${expected}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'maka-matter-cost-retry-'));
    const store = createMatterStore(root);
    const ledger = new RunCostLedger(join(root, 'cost'), async () => ({
      calls: 1,
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      modelDurationMs: 5,
      complete: true,
    }));
    let running = false;
    const agent = {
      snapshot: async () => ({
        agent: { status: running ? 'running' : 'blocked' },
        pendingInteractions: 0,
      }),
      followup: async () => {
        running = true;
        return { disposition: 'turn_started', turnId: 'turn-1' };
      },
      whenIdle: async () => {
        running = false;
      },
      transcript: async () => [{ type: 'turn_state', turnId: 'turn-1', errorClass }],
      cancel: async () => {
        running = false;
      },
    };
    const ctx = {
      runCost: ledger,
      agents: {
        withInvocation: (_: unknown, fn: () => unknown) => fn(),
        resume: async () => agent,
      },
    };
    const controller = createMatterController(ctx, store);
    try {
      store.create({ sessionId: 'matter-session', cwd: root, title: '核查', request: 'x' });
      controller.start();
      await controller.tick();
      await controller.close();
      const [row] = ledger.summary().recent;
      assert.equal(row.kind, 'matter_activation');
      assert.equal(row.outcome, expected);
    } finally {
      ledger.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
