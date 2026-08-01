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
