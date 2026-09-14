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
import type { SessionEvent } from '@maka/core/events';
import { PluginExecutorBackend } from '../plugin-executor-backend.js';
import { Context } from '../plugin-kernel.js';
import { PluginExecutorService } from '../plugin-executor-service.js';

test('executor backend converts plugin output and result to ordinary Session events', async () => {
  const { root, service } = fixture(async (request, context) => {
    assert.equal(request.instructions, 'child instructions');
    context.emit({ type: 'output_delta', text: 'hel' });
    return { status: 'completed', text: 'hello' };
  });
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    executorId: 'remote',
    instructions: 'child instructions',
    service,
    newId: ids(),
    now: () => 42,
  });

  const events = await collect(backend.send({ turnId: 'turn-a', runId: 'run-a', text: 'task' }));
  assert.deepEqual(
    events.map((event) => event.type),
    ['text_delta', 'text_complete', 'complete'],
  );
  assert.equal(events[0]?.turnId, 'turn-a');
  assert.equal(events[0]?.type === 'text_delta' ? events[0].text : undefined, 'hel');
  assert.equal(events[1]?.type === 'text_complete' ? events[1].text : undefined, 'hello');
  assert.equal(events[2]?.type === 'complete' ? events[2].stopReason : undefined, 'end_turn');
  await root.fiber.dispose();
});

test('executor backend turns stop into abort and terminal events', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { root, service } = fixture(async (_request, context) => {
    started();
    await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve()));
    return { status: 'cancelled' };
  });
  const backend = new PluginExecutorBackend({
    sessionId: 'session-a',
    cwd: '/workspace',
    executorId: 'remote',
    service,
  });

  const eventsPromise = collect(backend.send({ turnId: 'turn-a', text: 'task' }));
  await ready;
  await backend.stop('user_stop');
  const events = await eventsPromise;
  assert.deepEqual(
    events.map((event) => event.type),
    ['abort', 'complete'],
  );
  assert.equal(events[1]?.type === 'complete' ? events[1].stopReason : undefined, 'user_stop');
  await root.fiber.dispose();
});

function fixture(execute: Parameters<PluginExecutorService['register']>[0]['execute']): {
  root: Context;
  service: PluginExecutorService;
} {
  const root = new Context();
  const service = new PluginExecutorService(root);
  root
    .extend({
      maka: { rootId: 'profile', packageId: 'fixture', entryId: 'provider', generation: 1 },
    })
    .executors.register({ id: 'remote', execute });
  return { root, service };
}

function ids(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const result: SessionEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
