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
      await options.accept();
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
    { kind: 'client.capability.accepted', invocationId: 'service_invocation' },
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
