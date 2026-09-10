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
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { SessionEvent } from '@maka/core/events';
import type { InteractionPendingSnapshot } from '@maka/runtime-host/protocol';
import { runWaitFixture } from './runtime-host-run-wait-fixture.js';

test('public run context releases consumed events while the context remains reachable', () => {
  const fixtureUrl = new URL('./runtime-host-run-wait-fixture.js', import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '--eval',
      `const { publicRunWaitMemoryProbe } = await import(${JSON.stringify(fixtureUrl)});
     await publicRunWaitMemoryProbe();`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.deepEqual(
    output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [
      { stage: 'after-1000', events: 1000, alive: 0 },
      { stage: 'after-4000', events: 4000, alive: 0 },
      { stage: 'closed-context-retained', events: 4000, alive: 0 },
    ],
  );
});

test('public run context preserves event results and can retry after an iterator rejection', async () => {
  const operationError = new Error('fake iterator failure');
  const event: SessionEvent = {
    type: 'text_delta',
    id: 'event',
    turnId: 'turn',
    ts: 0,
    messageId: 'message',
    text: 'fake output',
  };
  let fail = true;
  const fixture = runWaitFixture(async function* () {
    if (fail) throw operationError;
    yield event;
  });
  try {
    await assert.rejects(fixture.nextTurn().next(), (error) => error === operationError);
    fail = false;
    const retry = fixture.nextTurn();
    assert.deepEqual(await retry.next(), { done: false, value: event });
    assert.equal((await retry.next()).done, true);
  } finally {
    await fixture.context.close();
  }
});

test('interaction failure rejects concurrent event waits and later graph waits with the first error', async () => {
  const operations = [deferred<void>(), deferred<void>()];
  const started = deferred<void>();
  const firstError = new Error('first fake sandbox failure');
  const laterError = new Error('later fake sandbox failure');
  let eventStarts = 0;
  let responses = 0;
  const fixture = runWaitFixture(
    async function* () {
      const operation = operations[eventStarts++];
      if (!operation) return;
      if (eventStarts === 2) started.resolve();
      await operation.promise;
    },
    async () => {
      throw responses++ === 0 ? firstError : laterError;
    },
  );
  try {
    const waits = [fixture.nextTurn().next(), fixture.nextTurn().next()];
    const rejected = waits.map((wait) => assert.rejects(wait, (error) => error === firstError));
    await started.promise;
    fixture.notify(sandboxPending('first'));
    await Promise.all(rejected);
    fixture.notify(sandboxPending('later'));
    // A losing operation can still reject; its rejection must remain observed.
    operations[0]!.reject(new Error('late fake operation rejection'));
    operations[1]!.resolve();
    await setImmediate();
    await assert.rejects(fixture.nextTurn().next(), (error) => error === firstError);
    await assert.rejects(
      fixture.context.agentGraph!.waitForCompletion('session'),
      (error) => error === firstError,
    );
  } finally {
    await fixture.context.close();
  }
});

function sandboxPending(interactionId: string): InteractionPendingSnapshot {
  // Only the interaction identity and kind are read by this fake driver's consumer.
  return { interactionId, request: { kind: 'sandbox_boundary' } } as InteractionPendingSnapshot;
}
