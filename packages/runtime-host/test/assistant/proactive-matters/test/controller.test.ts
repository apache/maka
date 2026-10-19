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

test('dispatch runs fifteen tasks concurrently and admits queued work when a slot is released', async () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-matter-concurrency-'));
  const store = createMatterStore(root);
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const running = new Set<string>();
  const agents = new Map<string, any>();
  const matters = Array.from({ length: 16 }, (_, i) => {
    const sessionId = `session-${i}`;
    agents.set(sessionId, {
      snapshot: async () => ({ agent: { status: running.has(sessionId) ? 'running' : 'idle' } }),
      followup: async () => {
        started.push(sessionId);
        running.add(sessionId);
        return { disposition: 'turn_started', turnId: `turn-${i}` };
      },
      whenIdle: async () => {
        if (running.has(sessionId))
          await new Promise<void>((resolve) => releases.set(sessionId, resolve));
      },
      cancel: async () => {
        running.delete(sessionId);
        releases.get(sessionId)?.();
      },
    });
    return store.create({
      sessionId,
      cwd: root,
      title: `Task ${i}`,
      request: 'Keep working until cancelled',
    });
  });
  const ctx = {
    agents: {
      withInvocation: (_: unknown, fn: () => unknown) => fn(),
      resume: async ({ sessionId }: { sessionId: string }) => agents.get(sessionId),
    },
  };
  const controller = new MatterController(ctx as any, store, { tickMs: 60_000 });
  try {
    controller.start();
    await controller.tick();
    assert.equal(started.length, 15);
    assert.equal(running.size, 15);
    assert.equal(store.list().filter((m) => m.activation).length, 15);
    await controller.tick();
    assert.equal(started.length, 15, 'sixteenth task stays queued while all slots are occupied');
    const first = matters.find((m) => m.sessionId === started[0])!;
    store.control(first.id, 'cancel');
    await agents.get(first.sessionId).cancel();
    await new Promise((resolve) => setImmediate(resolve));
    await controller.tick();
    assert.equal(started.length, 16);
    assert.equal(new Set(started).size, 16, 'no task is started twice');
    assert.equal(running.size, 15);
  } finally {
    await controller.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('running task receives late amendments and Bot replies at the next model context without Recall', () => {
  const root = mkdtempSync(join(tmpdir(), 'maka-matter-live-input-'));
  const store = createMatterStore(root);
  const controller = new MatterController({} as any, store);
  try {
    const m = store.create({ sessionId: 'worker', cwd: root, title: '交接', request: '核查交接' });
    const activation = store.claim(m.id)!.matter.activation!;
    store.bindTurn(m.id, activation.id, 'live-turn');
    const initial = controller.stepContext('worker', 'live-turn')!;
    assert.doesNotMatch(initial, /不要制作材料/);
    store.ingest(m.id, { key: 'correction', source: 'user', text: '不要制作材料，只核查。' });
    store.ingest(m.id, {
      key: 'answer',
      source: 'bot_clarification',
      text: '已核对用户原话：不需要清单。',
    });
    const before = store.get(m.id);
    const context = controller.stepContext('worker', 'live-turn')!;
    assert.match(context, /不要制作材料，只核查/);
    assert.match(context, /已核对用户原话/);
    assert.match(context, /not new user authorization/);
    assert.equal(
      controller.stepContext('worker', 'live-turn')!.split('Current task inbox')[1],
      context.split('Current task inbox')[1],
      'repeated model requests retain inputs',
    );
    assert.deepEqual(
      store.get(m.id),
      before,
      'rendering does not observe, consume or settle inputs',
    );
    assert.doesNotMatch(controller.stepContext('worker', 'other-turn')!, /不要制作材料/);
    assert.equal(controller.stepContext('other-worker', 'live-turn'), undefined);
    store.observe(m.id, activation.id);
    assert.match(
      controller.stepContext('worker', 'live-turn')!,
      /不要制作材料/,
      'explicit observation must not erase live context',
    );
    store.control(m.id, 'cancel');
    assert.equal(controller.stepContext('worker', 'live-turn'), undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
