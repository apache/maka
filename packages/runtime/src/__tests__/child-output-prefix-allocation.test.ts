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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSessionStore } from '@maka/storage/session-store';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { SessionManager, BackendRegistry } from '../session-manager.js';
import { seedInvocation } from './invocation-fixture.js';

test('child result reads preserve canonical output while bounding prefix iteration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-child-output-prefix-'));
  const store = createSessionStore(root);
  const runs = createSqliteAgentRunStore(root);
  const runtime = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  t.after(async () => {
    runtime.close();
    runs.close?.();
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  });
  const manager = new SessionManager({
    store,
    runStore: runs,
    runtimeEventStore: runtime,
    backends: new BackendRegistry(),
    newId: () => crypto.randomUUID(),
    now: () => 100,
  });
  const input = {
    cwd: root,
    llmConnectionSlug: 'test',
    model: 'test-model',
    permissionMode: 'ask' as const,
    name: 'Parent',
    labels: [],
  };
  const parent = await manager.createSession(input);
  const child = await manager.createSession({
    ...input,
    name: 'Child',
    subagentParent: {
      kind: 'subagent',
      parentSessionId: parent.id,
      spawnedBy: { parentRunId: 'parent-run', parentTurnId: 'parent-turn', toolCallId: 'spawn' },
      lifecycle: 'foreground',
    },
  });
  const observations: Array<{ steps: number; budget: number }> = [];
  const cases = [
    { text: 'A short, complete answer.', budget: 1024 },
    { text: 'Atlas '.repeat(44_000), budget: 32 * 1024 },
    { text: '结😀\ud800Z\udc00\n"\\\u0000'.repeat(24_000), budget: 1024 },
    { text: 'A'.repeat(256 * 1024), budget: 128 * 1024 },
  ];
  for (const [index, { text, budget }] of cases.entries()) {
    const identity = await seedInvocation(runtime, {
      sessionId: child.id,
      runId: 'run-' + index,
      turnId: 'turn-' + index,
      invocationId: 'invocation-' + index,
      openedAt: 1,
    });
    await runtime.appendRuntimeEvent(child.id, identity.runId, {
      ...identity,
      id: 'result-' + index,
      ts: 11,
      role: 'model',
      author: 'agent',
      partial: false,
      content: { kind: 'text', text },
    });
    await runtime.appendRuntimeEvent(child.id, identity.runId, {
      ...identity,
      id: 'terminal-' + index,
      ts: 12,
      role: 'system',
      author: 'system',
      partial: false,
      status: 'completed',
      actions: { endInvocation: true },
    });
    const before = await runtime.readImmutableRuntimeEvents(child.id, identity.runId);
    const originalIterator = String.prototype[Symbol.iterator];
    let iterations = 0;
    // One non-concurrent test owns this observer; always restore before assertions.
    String.prototype[Symbol.iterator] = function* (this: string) {
      const observed = this.toString() === text;
      let steps = 0;
      try {
        for (const point of originalIterator.call(this)) {
          if (observed) steps++;
          yield point;
        }
      } finally {
        if (observed) {
          iterations++;
          observations.push({ steps, budget });
        }
      }
      return undefined;
    };
    let output;
    try {
      output = await manager.readChildAgentOutput(parent.id, {
        execution: { kind: 'child_session', sessionId: child.id, currentRunId: identity.runId },
        view: 'result',
        maxBytes: budget,
      });
    } finally {
      String.prototype[Symbol.iterator] = originalIterator;
    }
    assert.equal(output.result?.status, 'completed');
    assert.deepEqual(output.events, []);
    assert.deepEqual(output.runtimeEvents, []);
    assert.equal(output.budget?.projectedBytes, Buffer.byteLength(JSON.stringify(output.result)));
    assert.ok(output.budget!.projectedBytes <= budget);
    assert.deepEqual(await runtime.readImmutableRuntimeEvents(child.id, identity.runId), before);
    assert.equal(output.result?.sourceRuntimeEventId, 'result-' + index);
    assert.equal(output.invocation?.invocationId, identity.invocationId);
    if (index === 0) {
      assert.equal(output.result?.text, text);
      assert.equal(output.result?.textTruncated, false);
      assert.equal(iterations, 0, 'fitting text does not need prefix iteration');
    } else {
      assert.equal(iterations, 1);
      assert.equal(output.result?.textTruncated, true);
      const result = output.result!;
      const prefix = result.text!.slice(0, -1);
      assert.equal(result.text!.at(-1), '…');
      const points = Array.from(text);
      const count = Array.from(prefix).length;
      assert.equal(prefix, points.slice(0, count).join(''));
      // The preserved binary search must return the largest fitting prefix.
      const longer = { ...result, text: points.slice(0, count + 1).join('') + '…' };
      assert.ok(Buffer.byteLength(JSON.stringify(longer)) > budget);
    }
  }
  // Run every semantic assertion first: the old helper fails only this bound.
  assert.equal(observations.length, 3);
  assert.ok(
    observations.every(({ steps, budget }) => steps <= budget + 1),
    'child result iteration exceeded its budget: ' + JSON.stringify(observations),
  );
});
