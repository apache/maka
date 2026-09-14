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
import { Context } from '../plugin-kernel.js';
import { PluginExecutorService } from '../plugin-executor-service.js';
import { MakaPluginTransactionBuffer } from '../plugin-runtime.js';

test('executors are scoped and pass black-box output without an Agent invocation', async () => {
  const root = new Context();
  const service = new PluginExecutorService(root);
  const profile = plugin(root, 'profile', 'profile-provider', 1);
  const session = plugin(root, 'session:session-a', 'session-provider', 1);
  profile.executors.register({
    id: 'remote',
    displayName: 'Remote',
    execute: async (request, context) => {
      context.emit({ type: 'output_delta', text: 'working' });
      return { status: 'completed', text: `${request.sessionId}:${request.text}` };
    },
  });
  session.executors.register({
    id: 'private',
    execute: async () => ({ status: 'completed', text: 'private' }),
  });

  const output: string[] = [];
  assert.deepEqual(
    await service.execute('remote', request('session-b'), {
      onEvent: (event) => {
        if (event.type === 'output_delta') output.push(event.text);
      },
    }),
    { status: 'completed', text: 'session-b:hello' },
  );
  assert.deepEqual(output, ['working']);
  assert.deepEqual(
    service.list('session-a').map((item) => item.id),
    ['private', 'remote'],
  );
  assert.deepEqual(
    service.list('session-b').map((item) => item.id),
    ['remote'],
  );
  await assert.rejects(() => service.execute('private', request('session-b')), /unavailable/u);
  await root.fiber.dispose();
});

test('executor registration is transactional across hot reload', async () => {
  const root = new Context();
  const service = new PluginExecutorService(root);
  const previous = plugin(root, 'profile', 'provider', 1);
  const disposePrevious = previous.executors.register(provider('previous'));
  const candidateOwner = plugin(root, 'profile', 'provider', 2);
  const transaction = new MakaPluginTransactionBuffer(candidateOwner);
  const candidate = candidateOwner.extend({ makaTransaction: transaction });
  const disposeCandidate = candidate.executors.register(provider('candidate'));

  assert.equal(await executeText(service), 'previous');
  await transaction.commit();
  assert.equal(await executeText(service), 'candidate');
  await disposePrevious();
  assert.equal(await executeText(service), 'candidate');
  await disposeCandidate();
  await assert.rejects(() => executeText(service), /unavailable/u);
  await root.fiber.dispose();
});

test('retiring an executor aborts and drains its active calls', async () => {
  const root = new Context();
  const service = new PluginExecutorService(root);
  const owner = plugin(root, 'profile', 'provider', 1);
  let observed: AbortSignal | undefined;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const dispose = owner.executors.register({
    id: 'remote',
    execute: async (_request, context) => {
      observed = context.signal;
      started();
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve()),
      );
      return { status: 'cancelled' };
    },
  });
  const execution = service.execute('remote', request('session-a'));
  await startedPromise;
  await dispose();
  assert.equal(observed?.aborted, true);
  assert.deepEqual(await execution, {
    status: 'cancelled',
    source: 'executor_retired',
    reason: 'Executor was retired: remote',
  });
  await root.fiber.dispose();
});

test('executor registration binds prototype methods to the provider instance', async () => {
  class ClassExecutor {
    readonly id = 'remote';
    readonly prefix = 'class';

    async execute() {
      return { status: 'completed' as const, text: `${this.prefix}:ok` };
    }
  }

  const root = new Context();
  const service = new PluginExecutorService(root);
  plugin(root, 'profile', 'provider', 1).executors.register(new ClassExecutor());
  assert.equal(await executeText(service), 'class:ok');
  await root.fiber.dispose();
});

test('executor bindings pin one provider generation', async () => {
  const root = new Context();
  const service = new PluginExecutorService(root);
  const previous = plugin(root, 'profile', 'provider', 1);
  const disposePrevious = previous.executors.register(provider('previous'));
  const previousBinding = service.bind('session-a', 'remote');
  const candidateOwner = plugin(root, 'profile', 'provider', 2);
  const transaction = new MakaPluginTransactionBuffer(candidateOwner);
  const candidate = candidateOwner.extend({ makaTransaction: transaction });
  candidate.executors.register(provider('candidate'));
  await transaction.commit();

  assert.equal((await previousBinding.execute(request('session-a'))).status, 'completed');
  assert.equal(await executeText(service), 'candidate');
  await disposePrevious();
  assert.deepEqual(await previousBinding.execute(request('session-a')), {
    status: 'cancelled',
    source: 'executor_retired',
    reason: 'Executor was retired: remote',
  });
  await root.fiber.dispose();
});

test('executor completion after caller cancellation is normalized to cancelled', async () => {
  const root = new Context();
  const service = new PluginExecutorService(root);
  const owner = plugin(root, 'profile', 'provider', 1);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  owner.executors.register({
    id: 'remote',
    execute: async (_request, context) => {
      started();
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve()),
      );
      return { status: 'completed', text: 'late success' };
    },
  });
  const abort = new AbortController();
  const execution = service.execute('remote', request('session-a'), { signal: abort.signal });
  await ready;
  abort.abort(new Error('redirect'));
  assert.deepEqual(await execution, { status: 'cancelled', source: 'caller', reason: 'redirect' });
  await root.fiber.dispose();
});

test('executor rich events require an explicitly declared capability', async () => {
  const root = new Context();
  const service = new PluginExecutorService(root);
  plugin(root, 'profile', 'provider', 1).executors.register({
    id: 'remote',
    execute: async (_request, context) => {
      context.emit({ type: 'thinking_delta', text: 'undeclared' });
      return { status: 'completed', text: 'unreachable' };
    },
  });

  await assert.rejects(
    () => service.execute('remote', request('session-a')),
    /invalid or undeclared/u,
  );
  await root.fiber.dispose();
});

function plugin(
  root: Context,
  rootId: 'profile' | `session:${string}`,
  entryId: string,
  generation: number,
) {
  return root.extend({
    maka: { rootId, packageId: 'fixture', entryId, generation },
  });
}

function provider(text: string) {
  return {
    id: 'remote',
    execute: async () => ({ status: 'completed' as const, text }),
  };
}

function request(sessionId: string) {
  return {
    sessionId,
    turnId: 'turn-a',
    conversationKey: sessionId,
    text: 'hello',
    cwd: '/workspace',
  };
}

async function executeText(service: PluginExecutorService): Promise<string> {
  const result = await service.execute('remote', request('session-a'));
  assert.equal(result.status, 'completed');
  return result.text;
}
