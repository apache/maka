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
import {
  CommandCodeBrowserLoginFlow,
  type CommandCodeBrowserLoginBridge,
  type CommandCodeBrowserLoginCredentials,
  type CommandCodeBrowserLoginResult,
  type CommandCodeBrowserLoginStartResult,
} from '../../renderer/features/connection-settings/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const CREDENTIALS: CommandCodeBrowserLoginCredentials = {
  apiKey: 'user_k',
  userName: 'joobin',
  keyName: 'cli-1',
};
const STARTED: CommandCodeBrowserLoginStartResult = {
  ok: true,
  attemptId: 'a1',
  authUrl: 'https://commandcode.ai/studio/auth/cli?state=s',
};

function harness() {
  const starts: ReturnType<typeof deferred<CommandCodeBrowserLoginStartResult>>[] = [];
  const completes: ReturnType<typeof deferred<CommandCodeBrowserLoginResult>>[] = [];
  const cancelled: (string | undefined)[] = [];
  const bridge: CommandCodeBrowserLoginBridge = {
    start: () => {
      const next = deferred<CommandCodeBrowserLoginStartResult>();
      starts.push(next);
      return next.promise;
    },
    complete: () => {
      const next = deferred<CommandCodeBrowserLoginResult>();
      completes.push(next);
      return next.promise;
    },
    cancel: async (attemptId) => {
      cancelled.push(attemptId);
    },
  };
  const delivered: CommandCodeBrowserLoginCredentials[] = [];
  const phases: string[] = [];
  const flow = new CommandCodeBrowserLoginFlow(bridge, (credentials) => delivered.push(credentials));
  flow.subscribe(() => phases.push(flow.getState().phase));
  return { flow, starts, completes, cancelled, delivered, phases };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CommandCodeBrowserLoginFlow', () => {
  test('walks idle → starting → waiting → filled and hands the credentials out once', async () => {
    const { flow, starts, completes, delivered, phases } = harness();
    const run = flow.start({ baseUrl: 'https://api.commandcode.ai/provider/v1' });
    assert.equal(flow.getState().phase, 'starting');
    starts[0]!.resolve(STARTED);
    await settle();
    assert.deepEqual(flow.getState(), { phase: 'waiting', attemptId: 'a1', authUrl: STARTED.authUrl });
    completes[0]!.resolve({ ok: true, credentials: CREDENTIALS });
    await run;
    assert.deepEqual(flow.getState(), { phase: 'filled', userName: 'joobin' });
    assert.deepEqual(delivered, [CREDENTIALS]);
    assert.deepEqual(phases, ['starting', 'waiting', 'filled']);
  });

  test('a second start while one is live is ignored', async () => {
    const { flow, starts } = harness();
    void flow.start();
    void flow.start();
    starts[0]!.resolve(STARTED);
    await settle();
    void flow.start();
    assert.equal(starts.length, 1);
  });

  test('a failed start reports its reason', async () => {
    const { flow, starts } = harness();
    const run = flow.start();
    starts[0]!.resolve({ ok: false, reason: 'port_unavailable' });
    await run;
    assert.deepEqual(flow.getState(), { phase: 'failed', reason: 'port_unavailable' });
  });

  test('a bridge that throws is reported as unavailable, on start and on complete', async () => {
    const first = harness();
    const run = first.flow.start();
    first.starts[0]!.reject(new Error('ipc gone'));
    await run;
    assert.deepEqual(first.flow.getState(), { phase: 'failed', reason: 'unavailable' });

    const second = harness();
    const run2 = second.flow.start();
    second.starts[0]!.resolve(STARTED);
    await settle();
    second.completes[0]!.reject(new Error('ipc gone'));
    await run2;
    assert.deepEqual(second.flow.getState(), { phase: 'failed', reason: 'unavailable' });
  });

  test('denied / timeout end in failed; a user cancel from the main side returns to idle', async () => {
    for (const reason of ['denied', 'timeout', 'superseded'] as const) {
      const { flow, starts, completes } = harness();
      const run = flow.start();
      starts[0]!.resolve(STARTED);
      await settle();
      completes[0]!.resolve({ ok: false, reason });
      await run;
      assert.deepEqual(flow.getState(), { phase: 'failed', reason });
    }
    const { flow, starts, completes } = harness();
    const run = flow.start();
    starts[0]!.resolve(STARTED);
    await settle();
    completes[0]!.resolve({ ok: false, reason: 'cancelled' });
    await run;
    assert.deepEqual(flow.getState(), { phase: 'idle' });
  });

  test('cancel drops a late success instead of typing it into the field', async () => {
    const { flow, starts, completes, cancelled, delivered } = harness();
    const run = flow.start();
    starts[0]!.resolve(STARTED);
    await settle();
    flow.cancel();
    assert.deepEqual(flow.getState(), { phase: 'idle' });
    assert.deepEqual(cancelled, ['a1']);
    completes[0]!.resolve({ ok: true, credentials: CREDENTIALS });
    await run;
    assert.deepEqual(delivered, [], 'a cancelled attempt must never fill the key');
    assert.deepEqual(flow.getState(), { phase: 'idle' });
  });

  test('cancel during start releases the listener the bridge bound meanwhile', async () => {
    const { flow, starts, cancelled } = harness();
    const run = flow.start();
    flow.cancel();
    starts[0]!.resolve(STARTED);
    await run;
    assert.deepEqual(cancelled, ['a1']);
    assert.deepEqual(flow.getState(), { phase: 'idle' });
  });

  test('a failed attempt can be retried', async () => {
    const { flow, starts, completes } = harness();
    const run = flow.start();
    starts[0]!.resolve(STARTED);
    await settle();
    completes[0]!.resolve({ ok: false, reason: 'timeout' });
    await run;
    const retry = flow.start();
    starts[1]!.resolve({ ...STARTED, attemptId: 'a2' });
    await settle();
    completes[1]!.resolve({ ok: true, credentials: CREDENTIALS });
    await retry;
    assert.equal(flow.getState().phase, 'filled');
  });

  test('dispose cancels the live attempt and silences listeners', async () => {
    const { flow, starts, completes, cancelled, delivered, phases } = harness();
    const run = flow.start();
    starts[0]!.resolve(STARTED);
    await settle();
    flow.dispose();
    assert.deepEqual(cancelled, ['a1']);
    const seen = phases.length;
    completes[0]!.resolve({ ok: true, credentials: CREDENTIALS });
    await run;
    assert.deepEqual(delivered, [], 'a disposed flow must never fill the key');
    assert.equal(phases.length, seen, 'no state change may be published after dispose');
    void flow.start();
    assert.equal(starts.length, 1, 'a disposed flow never starts again');
  });
});
