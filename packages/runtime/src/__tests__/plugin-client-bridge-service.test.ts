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
