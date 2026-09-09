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
import type { ClientCapabilityHostFrame } from '../protocol/index.js';
import { ClientCapabilityInvocationBroker } from '../server/client-capability-invocation-broker.js';

interface Registration {
  readonly connectionId: string;
  readonly registrationId: string;
}

const registration: Registration = {
  connectionId: 'connection-a',
  registrationId: 'registration-a',
};

const binding = {
  offerId: 'desktop-browser',
  hostPathAccess: 'none' as const,
  descriptor: {
    serverId: 'desktop_browser',
    name: 'browser_snapshot',
    inputSchema: { type: 'object' },
  },
};

const context = {
  sessionId: 'session-a',
  turnId: 'turn-a',
  toolCallId: 'tool-call-a',
  cwd: '/tmp',
};

describe('ClientCapabilityInvocationBroker', () => {
  test('keeps provider acceptance paused until explicit admission', async () => {
    const sent: ClientCapabilityHostFrame[] = [];
    let broker!: ClientCapabilityInvocationBroker<Registration>;
    broker = new ClientCapabilityInvocationBroker({
      senderFor: () => ({
        send: async (frame) => {
          sent.push(frame);
          if (frame.kind === 'client.capability.call') {
            queueMicrotask(() =>
              broker.accept('connection-a', {
                kind: 'client.capability.accepted',
                invocationId: frame.invocationId,
                admissionEvidence: { kind: 'none' },
              }),
            );
          }
          if (frame.kind === 'client.capability.admitted') {
            queueMicrotask(() =>
              broker.accept('connection-a', {
                kind: 'client.capability.result',
                invocationId: frame.invocationId,
                result: { content: [{ type: 'text', text: 'ok' }] },
              }),
            );
          }
        },
      }),
      onRegistrationIdle: () => {},
    });

    const prepared = broker.prepare(registration, binding, {}, context, undefined, 20);
    await prepared.waitUntilAccepted();
    await delay(40);
    assert.equal(
      sent.some((frame) => frame.kind === 'client.capability.admitted'),
      false,
    );

    assert.deepEqual(await prepared.admit(), { content: [{ type: 'text', text: 'ok' }] });
    assert.equal(sent.filter((frame) => frame.kind === 'client.capability.admitted').length, 1);
    broker.close();
  });

  test('cancels accepted work without crossing admission', async () => {
    const sent: ClientCapabilityHostFrame[] = [];
    let broker!: ClientCapabilityInvocationBroker<Registration>;
    broker = new ClientCapabilityInvocationBroker({
      senderFor: () => ({
        send: async (frame) => {
          sent.push(frame);
          if (frame.kind === 'client.capability.call') {
            broker.accept('connection-a', {
              kind: 'client.capability.accepted',
              invocationId: frame.invocationId,
              admissionEvidence: { kind: 'none' },
            });
          }
        },
      }),
      onRegistrationIdle: () => {},
    });

    const prepared = broker.prepare(registration, binding, {}, context, undefined, 1_000);
    await prepared.waitUntilAccepted();
    prepared.cancel();
    await assert.rejects(() => prepared.admit(), /cancelled before admission/u);
    assert.deepEqual(
      sent.map((frame) => frame.kind),
      ['client.capability.call', 'client.capability.cancel', 'client.capability.release'],
    );
    broker.close();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
