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
import { randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import type { InteractionPendingSnapshot } from '@maka/runtime-host/protocol';
import { createRuntimeHostRunContext } from '../runtime-host-run-command.js';
import type { RuntimeHostMakaSessionDriver } from '../runtime-host-session-driver.js';

export function runWaitFixture(
  events: () => AsyncIterable<SessionEvent>,
  respondToSandboxBoundary: () => Promise<void> = async () => {},
) {
  let listener: ((pending: InteractionPendingSnapshot) => void) | undefined;
  const driver = {
    subscribePendingInteractions(callback: typeof listener) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    subscribeTranscriptReplacements: () => () => {},
    switchSession: async () => ({ summary: { id: 'session', cwd: '/workspace' }, messages: [] }),
    readMessages: async () => [],
    preparePrompt: async () => ({
      sessionId: 'session',
      turnId: 'turn',
      runId: 'run',
      events: events(),
    }),
    respondToSandboxBoundary,
  } as unknown as RuntimeHostMakaSessionDriver;
  const context = createRuntimeHostRunContext(
    {} as RuntimeHostConnection,
    {
      revision: 1,
      defaultTarget: { connectionId: 'connection', modelId: 'model' },
      connections: [
        {
          connectionId: 'connection',
          revision: 1,
          slug: 'fake',
          name: 'Fake',
          providerType: 'openai',
          enabled: true,
          enabledModelIds: ['model'],
          catalogEntries: [],
          models: [{ id: 'model' }],
        },
      ],
    },
    { cwd: '/workspace', workspaceRoot: '/workspace', enableAgentGraph: true },
    { createDriver: () => driver },
  );
  return {
    context,
    nextTurn: () =>
      context.runtime
        .sendMessage('session', { text: 'fake', turnId: 'turn' })
        [Symbol.asyncIterator](),
    notify: (pending: InteractionPendingSnapshot) => listener?.(pending),
  };
}

export async function publicRunWaitMemoryProbe(): Promise<void> {
  assert.equal(typeof global.gc, 'function');
  const refs: WeakRef<SessionEvent>[] = [];
  let count = 0;
  const fixture = runWaitFixture(async function* () {
    for (let index = 0; index < count; index++) {
      const event: SessionEvent = {
        type: 'text_delta',
        id: `event-${refs.length}`,
        turnId: 'turn',
        ts: 0,
        messageId: 'message',
        text: randomBytes(2048).toString('hex'),
      };
      refs.push(new WeakRef(event));
      yield event;
    }
  });
  async function sample(stage: string) {
    for (let pass = 0; pass < 4; pass++) {
      await setImmediate();
      global.gc!();
    }
    const alive = refs.filter((ref) => ref.deref() !== undefined).length;
    console.log(JSON.stringify({ stage, events: refs.length, alive }));
    assert.equal(alive, 0, `${stage}: consumed events retained by live run context`);
  }
  for (count of [1000, 3000]) {
    const events = fixture.nextTurn();
    while (!(await events.next()).done) {
      /* Consume without retaining event payloads. */
    }
    await sample(`after-${refs.length}`);
  }
  await fixture.context.close();
  await sample('closed-context-retained');
  // Keep the public context reachable across every collection, including after close.
  assert.ok(fixture.context.runtime);
}
