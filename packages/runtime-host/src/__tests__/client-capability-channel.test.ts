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
import { ClientCapabilityChannel } from '../client/client-capability-channel.js';
import type { ClientCapabilityProvider } from '../client/client-capability.js';

test('Client Capability channel closes a provider after its final registration is released', async () => {
  let closeCalls = 0;
  const replacements: string[] = [];
  const provider: ClientCapabilityProvider = {
    offers: () => [
      {
        offerId: 'fixture',
        version: '0',
        affinity: 'call',
        hostPathAccess: 'cwd',
        label: 'Fixture',
        tools: [
          {
            serverId: 'fixture',
            name: 'inspect',
            inputSchema: { type: 'object' },
          },
        ],
      },
    ],
    call: async () => ({ content: [] }),
    close: () => {
      closeCalls += 1;
    },
  };
  const channel = new ClientCapabilityChannel({
    write: async () => undefined,
    replace: async (input) => {
      assert.equal(Object.hasOwn(input, 'services'), false);
      replacements.push(input.registrationId);
      return { registrationId: input.registrationId, revision: replacements.length };
    },
    unregister: async (input) => ({
      registrationId: input.registrationId,
      revision: replacements.length + 1,
    }),
    onFailure: (error) => {
      throw error;
    },
  });

  await channel.replace(provider, 1_000);
  await channel.replace(provider, 1_000);
  const [firstRegistrationId, secondRegistrationId] = replacements;
  assert.ok(firstRegistrationId);
  assert.ok(secondRegistrationId);
  channel.accept({
    kind: 'client.capability.registration_release',
    registrationId: firstRegistrationId,
  });
  assert.equal(closeCalls, 0);

  await channel.unregister(1_000);
  channel.accept({
    kind: 'client.capability.registration_release',
    registrationId: secondRegistrationId,
  });
  assert.equal(closeCalls, 1);
  channel.close(new Error('test complete'));
  assert.equal(closeCalls, 1);
});

test('Client Capability channel runs a self-described Host service through admission', async () => {
  let registrationId = '';
  let accepted = false;
  const written: unknown[] = [];
  let channel!: ClientCapabilityChannel;
  const provider: ClientCapabilityProvider = {
    offers: () => [],
    services: () => [{ serviceId: 'vendor_service', version: '1' }],
    callService: async (frame, options) => {
      assert.equal(frame.method, 'present');
      assert.equal(accepted, false);
      await options.accept({ kind: 'none' });
      accepted = true;
      return { kind: 'presented' };
    },
  };
  channel = new ClientCapabilityChannel({
    write: async (frame) => {
      written.push(frame);
      if (frame.kind === 'client.capability.accepted') {
        queueMicrotask(() =>
          channel.accept({
            kind: 'client.capability.admitted',
            invocationId: frame.invocationId,
          }),
        );
      }
    },
    replace: async (input) => {
      registrationId = input.registrationId;
      return { registrationId, revision: 1 };
    },
    unregister: async (input) => ({ registrationId: input.registrationId, revision: 2 }),
    onFailure: (error) => {
      throw error;
    },
  });
  await channel.replace(provider, 1_000);
  channel.accept({
    kind: 'client.capability.service_call',
    invocationId: 'service_invocation',
    registrationId,
    serviceId: 'vendor_service',
    version: '1',
    method: 'present',
    input: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted, true);
  assert.deepEqual(written, [
    {
      kind: 'client.capability.accepted',
      invocationId: 'service_invocation',
      admissionEvidence: { kind: 'none' },
    },
    {
      kind: 'client.capability.result',
      invocationId: 'service_invocation',
      result: { content: [], structuredContent: { kind: 'presented' } },
    },
  ]);
  channel.close(new Error('test complete'));
});

test('Client Capability channel rejects Host paths before invoking a path-isolated provider', async () => {
  let registrationId = '';
  let callCount = 0;
  const written: unknown[] = [];
  const provider: ClientCapabilityProvider = {
    offers: () => [
      {
        offerId: 'path-isolated',
        version: '0',
        affinity: 'call',
        hostPathAccess: 'none',
        label: 'Path isolated',
        tools: [
          {
            serverId: 'fixture',
            name: 'inspect',
            inputSchema: { type: 'object' },
          },
        ],
      },
    ],
    call: async () => {
      callCount += 1;
      return { content: [] };
    },
  };
  const channel = new ClientCapabilityChannel({
    write: async (frame) => {
      written.push(frame);
    },
    replace: async (input) => {
      registrationId = input.registrationId;
      return { registrationId, revision: 1 };
    },
    unregister: async (input) => ({ registrationId: input.registrationId, revision: 2 }),
    onFailure: (error) => {
      throw error;
    },
  });

  await channel.replace(provider, 1_000);
  channel.accept({
    kind: 'client.capability.call',
    invocationId: 'remote-path',
    registrationId,
    offerId: 'path-isolated',
    serverId: 'fixture',
    toolName: 'inspect',
    sessionId: 'session',
    turnId: 'turn',
    toolCallId: 'tool-call',
    cwd: '/srv/runtime-host',
    arguments: {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(callCount, 0);
  assert.deepEqual(written, [
    {
      kind: 'client.capability.rejected',
      invocationId: 'remote-path',
      message: 'Client Capability does not allow Runtime Host paths',
    },
  ]);
  channel.close(new Error('test complete'));
});

test('Client Capability channel forwards admitted tool progress before the result', async () => {
  let registrationId = '';
  const written: unknown[] = [];
  let channel!: ClientCapabilityChannel;
  const provider: ClientCapabilityProvider = {
    offers: () => [
      {
        offerId: 'fixture',
        version: '0',
        affinity: 'call',
        hostPathAccess: 'cwd',
        label: 'Fixture',
        tools: [{ serverId: 'fixture', name: 'sequence', inputSchema: { type: 'object' } }],
      },
    ],
    call: async (_frame, options) => {
      await options.accept({ kind: 'none' });
      options.progress?.(1, 3);
      options.progress?.(2, 3);
      return { content: [] };
    },
  };
  channel = new ClientCapabilityChannel({
    write: async (frame) => {
      written.push(frame);
      if (frame.kind === 'client.capability.accepted') {
        queueMicrotask(() =>
          channel.accept({
            kind: 'client.capability.admitted',
            invocationId: frame.invocationId,
          }),
        );
      }
    },
    replace: async (input) => {
      registrationId = input.registrationId;
      return { registrationId, revision: 1 };
    },
    unregister: async (input) => ({ registrationId: input.registrationId, revision: 2 }),
    onFailure: (error) => {
      throw error;
    },
  });

  await channel.replace(provider, 1_000);
  channel.accept({
    kind: 'client.capability.call',
    invocationId: 'progress-invocation',
    registrationId,
    offerId: 'fixture',
    serverId: 'fixture',
    toolName: 'sequence',
    arguments: {},
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    cwd: '/tmp',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(written, [
    {
      kind: 'client.capability.accepted',
      invocationId: 'progress-invocation',
      admissionEvidence: { kind: 'none' },
    },
    {
      kind: 'client.capability.progress',
      invocationId: 'progress-invocation',
      current: 1,
      total: 3,
    },
    {
      kind: 'client.capability.progress',
      invocationId: 'progress-invocation',
      current: 2,
      total: 3,
    },
    {
      kind: 'client.capability.result',
      invocationId: 'progress-invocation',
      result: { content: [] },
    },
  ]);
  channel.close(new Error('test complete'));
});
