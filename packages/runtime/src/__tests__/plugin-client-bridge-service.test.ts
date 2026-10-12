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
import { Context, type StandardSchema } from '../plugin-kernel.js';
import {
  PluginClientBridgeError,
  PluginClientBridgeService,
} from '../plugin-client-bridge-service.js';

test('Client Remote resolves Session handlers over Profile handlers', async () => {
  const root = new Context();
  const service = new PluginClientBridgeService(root);
  plugin(root, 'profile', 'profile-entry', 1).clientBridge.rpc({
    name: 'fixture.echo',
    invoke: (input) => `profile:${String(input)}`,
  });
  plugin(root, 'session:session-a', 'session-entry', 1).clientBridge.rpc({
    name: 'fixture.echo',
    invoke: (input) => `session:${String(input)}`,
  });

  assert.equal(
    await service.invoke({ extensionId: 'fixture' }, 'fixture.echo', 'hello'),
    'profile:hello',
  );
  assert.equal(
    await service.invoke(
      { extensionId: 'fixture', sessionId: 'session-a' },
      'fixture.echo',
      'hello',
    ),
    'session:hello',
  );
  await root.fiber.dispose();
});

test('Client Remote validates input and retires active streams with their Fiber', async () => {
  const root = new Context();
  const service = new PluginClientBridgeService(root);
  const owner = plugin(root, 'profile', 'entry', 1);
  owner.clientBridge.rpc({
    name: 'fixture.validated',
    input: stringSchema,
    invoke: (input) => input,
  });
  await assert.rejects(
    () => service.invoke({ extensionId: 'fixture' }, 'fixture.validated', 42),
    (error) => error instanceof PluginClientBridgeError && error.code === 'invalid_input',
  );

  let observedSignal: AbortSignal | undefined;
  const dispose = owner.clientBridge.stream({
    name: 'fixture.watch',
    open: async (_input, context) => {
      observedSignal = context.signal;
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve()),
          );
        },
      };
    },
  });
  const stream = await service.open({ extensionId: 'fixture' }, 'fixture.watch', null);
  const next = stream.next();
  await dispose();
  assert.equal(observedSignal?.aborted, true);
  assert.equal((await next).done, true);
  await assert.rejects(() => stream.next(), PluginClientBridgeError);
  await root.fiber.dispose();
});

const stringSchema: StandardSchema = {
  '~standard': {
    validate: (value) =>
      typeof value === 'string' ? { value } : { issues: [{ message: 'Expected a string' }] },
  },
};

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

test('retiring an idle stream does not wait for another pull', { timeout: 1000 }, async () => {
  const root = new Context();
  const service = new PluginClientBridgeService(root);
  const dispose = plugin(root, 'profile', 'idle', 1).clientBridge.stream({
    name: 'fixture.idle',
    open: async function* () {
      yield 1;
      yield 2;
    },
  });
  const stream = await service.open({ extensionId: 'fixture' }, 'fixture.idle', null);
  assert.equal((await stream.next()).value, 1);
  await dispose();
  await assert.rejects(stream.next(), PluginClientBridgeError);
  await root.fiber.dispose();
});

test('closing a non-cooperative producer releases an outstanding pull', {
  timeout: 1000,
}, async () => {
  const root = new Context();
  const service = new PluginClientBridgeService(root);
  let aborted = false;
  plugin(root, 'profile', 'quiet', 1).clientBridge.stream({
    name: 'fixture.quiet',
    open: (_input, { signal }) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
          yield 'stale';
        },
      };
    },
  });
  const stream = await service.open({ extensionId: 'fixture' }, 'fixture.quiet', null);
  const pending = stream.next();
  await stream.close();
  assert.equal(aborted, true);
  assert.equal((await pending).done, true);
  await root.fiber.dispose();
});

test('retirement interrupts non-cooperative stream item validation', {
  timeout: 1000,
}, async () => {
  const root = new Context();
  const service = new PluginClientBridgeService(root);
  let validating!: () => void;
  const validationStarted = new Promise<void>((resolve) => {
    validating = resolve;
  });
  const dispose = plugin(root, 'profile', 'validated-stream', 1).clientBridge.stream({
    name: 'fixture.validated-stream',
    item: {
      '~standard': {
        validate: () => {
          validating();
          return new Promise(() => {});
        },
      },
    },
    open: async function* () {
      yield 'item';
    },
  });
  const stream = await service.open({ extensionId: 'fixture' }, 'fixture.validated-stream', null);
  const pending = stream.next();
  await validationStarted;
  await dispose();
  assert.equal((await pending).done, true);
  await root.fiber.dispose();
});

test('retirement cancels uncooperative RPC and stream opens, and prepared calls never switch registrations', {
  timeout: 2000,
}, async () => {
  const root = new Context();
  const service = new PluginClientBridgeService(root);
  const owner = plugin(root, 'profile', 'entry', 1);
  let invoked = 0;
  const dispose = owner.clientBridge.rpc({
    name: 'fixture.hang',
    invoke() {
      invoked++;
      return new Promise(() => {});
    },
  });
  const target = { extensionId: 'fixture' };
  const prepared = service.prepareInvoke(target, 'fixture.hang', null);
  const pending = prepared();
  const rejected = assert.rejects(pending, PluginClientBridgeError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(invoked, 1);
  await dispose();
  await rejected;
  owner.clientBridge.rpc({
    name: 'fixture.hang',
    invoke() {
      invoked++;
      return 'replacement';
    },
  });
  await assert.rejects(prepared, PluginClientBridgeError);
  assert.equal(invoked, 1);

  let resolveOpen!: (value: AsyncIterable<unknown>) => void;
  const disposeStream = owner.clientBridge.stream({
    name: 'fixture.late',
    open: () =>
      new Promise<AsyncIterable<unknown>>((resolve) => {
        resolveOpen = resolve;
      }),
  });
  const opened = service.open(target, 'fixture.late', null);
  const rejectedOpen = assert.rejects(opened, PluginClientBridgeError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await disposeStream();
  await rejectedOpen;
  let returned = 0;
  resolveOpen({
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined }),
        return: async () => {
          returned++;
          return { done: true, value: undefined };
        },
      };
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(returned, 1);
  await root.fiber.dispose();
});
