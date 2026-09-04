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
import { ToolOutcomeUnknownError } from '@maka/core/events';
import type { ClientCapabilityHostFrame } from '../protocol/index.js';
import {
  ClientCapabilityInvocationBroker,
  ClientCapabilityInvocationError,
  type ClientCapabilityInvocationBinding,
  type ClientCapabilityInvocationRegistration,
} from '../server/client-capability-invocation-broker.js';

const REGISTRATION: ClientCapabilityInvocationRegistration = {
  connectionId: 'connection-a',
  registrationId: 'registration-a',
};

const BINDING: ClientCapabilityInvocationBinding = {
  offerId: 'offer-a',
  hostPathAccess: 'none',
  descriptor: {
    serverId: 'fixture',
    name: 'deploy',
    inputSchema: { type: 'object' },
  },
};

const CONTEXT = {
  sessionId: 'session-a',
  turnId: 'turn-a',
  toolCallId: 'tool-call-a',
  cwd: '/tmp',
};

test('Client Capability nested interaction pauses and rearms the execution timeout', async () => {
  const sent: ClientCapabilityHostFrame[] = [];
  const timers = createTimerHarness();
  let answer!: (value: { action: 'accept'; values: { target: string } }) => void;
  const broker = new ClientCapabilityInvocationBroker({
    senderFor: () => ({ send: async (frame) => void sent.push(frame) }),
    onRegistrationIdle: () => {},
    scheduleTimeout: timers.schedule,
  });
  const result = broker.invoke(
    REGISTRATION,
    BINDING,
    {},
    CONTEXT,
    undefined,
    1_000,
    undefined,
    async (_form, options) => {
      assert.equal(options?.cancellationSignal?.aborted, false);
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  );
  await flush();
  const invocationId = callInvocationId(sent);
  assert.equal(timers.activeCount(), 1);

  broker.accept('connection-a', {
    kind: 'client.capability.accepted',
    invocationId,
    admissionEvidence: { kind: 'none' },
  });
  await flush();
  broker.accept('connection-a', {
    kind: 'client.capability.interaction_request',
    invocationId,
    interactionId: 'interaction-a',
    request: {
      message: 'Choose a target',
      requester: { name: 'deploy' },
      fields: [{ kind: 'string', name: 'target', label: 'Target', required: true, maxLength: 256 }],
    },
  });
  assert.equal(timers.activeCount(), 0);

  answer({ action: 'accept', values: { target: 'staging' } });
  await flush();
  assert.deepEqual(sent.at(-1), {
    kind: 'client.capability.interaction_result',
    invocationId,
    interactionId: 'interaction-a',
    result: { action: 'accept', values: { target: 'staging' } },
  });
  assert.equal(timers.activeCount(), 1);

  timers.fireActive();
  await assert.rejects(result, (error: unknown) => error instanceof ToolOutcomeUnknownError);
  assert.equal(timers.activeCount(), 0);
  broker.close();
});

test('Client Capability accepts a final result while interaction delivery is still flushing', async () => {
  const sent: ClientCapabilityHostFrame[] = [];
  let broker!: ClientCapabilityInvocationBroker<ClientCapabilityInvocationRegistration>;
  const brokerOptions = {
    senderFor: () => ({
      send: async (frame: ClientCapabilityHostFrame) => {
        sent.push(frame);
        if (frame.kind !== 'client.capability.interaction_result') return;
        broker.accept('connection-a', {
          kind: 'client.capability.result',
          invocationId: frame.invocationId,
          result: { content: [{ type: 'text', text: 'deployed' }] },
        });
        await flush();
      },
    }),
    onRegistrationIdle: () => {},
  };
  broker = new ClientCapabilityInvocationBroker(brokerOptions);
  const result = broker.invoke(
    REGISTRATION,
    BINDING,
    {},
    CONTEXT,
    undefined,
    1_000,
    undefined,
    async () => ({ action: 'accept', values: { target: 'staging' } }),
  );
  await flush();
  const invocationId = callInvocationId(sent);
  broker.accept('connection-a', {
    kind: 'client.capability.accepted',
    invocationId,
    admissionEvidence: { kind: 'none' },
  });
  await flush();
  broker.accept('connection-a', {
    kind: 'client.capability.interaction_request',
    invocationId,
    interactionId: 'interaction-a',
    request: {
      message: 'Choose a target',
      requester: { name: 'deploy' },
      fields: [{ kind: 'string', name: 'target', label: 'Target', required: true, maxLength: 256 }],
    },
  });

  assert.deepEqual(await result, { content: [{ type: 'text', text: 'deployed' }] });
  broker.close();
});

test('Client Capability provider failure waits for pending interaction withdrawal', async () => {
  const sent: ClientCapabilityHostFrame[] = [];
  let finishWithdrawal!: () => void;
  const withdrawal = new Promise<void>((resolve) => {
    finishWithdrawal = resolve;
  });
  let producerCancelled = false;
  const broker = new ClientCapabilityInvocationBroker({
    senderFor: () => ({ send: async (frame) => void sent.push(frame) }),
    onRegistrationIdle: () => {},
  });
  const result = broker.invoke(
    REGISTRATION,
    BINDING,
    {},
    CONTEXT,
    undefined,
    1_000,
    undefined,
    async (_form, options) => {
      const signal = options?.cancellationSignal;
      assert.ok(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            producerCancelled = true;
            resolve();
          },
          { once: true },
        ),
      );
      await withdrawal;
      throw signal.reason;
    },
  );
  await flush();
  const invocationId = callInvocationId(sent);
  broker.accept('connection-a', {
    kind: 'client.capability.accepted',
    invocationId,
    admissionEvidence: { kind: 'none' },
  });
  await flush();
  broker.accept('connection-a', {
    kind: 'client.capability.interaction_request',
    invocationId,
    interactionId: 'interaction-a',
    request: {
      message: 'Confirm',
      requester: { name: 'deploy' },
      fields: [{ kind: 'boolean', name: 'confirm', label: 'Confirm', required: true }],
    },
  });
  broker.accept('connection-a', {
    kind: 'client.capability.failed',
    invocationId,
    message: 'provider stopped',
  });
  await flush();
  assert.equal(producerCancelled, true);
  assert.equal(
    sent.some((frame) => frame.kind === 'client.capability.release'),
    false,
  );

  finishWithdrawal();
  await assert.rejects(
    result,
    (error: unknown) =>
      error instanceof ClientCapabilityInvocationError &&
      error.code === 'provider_failed' &&
      error.message === 'provider stopped',
  );
  assert.equal(sent.at(-1)?.kind, 'client.capability.release');
  broker.close();
});

test('Client Capability connection release waits for pending interaction withdrawal', async () => {
  const sent: ClientCapabilityHostFrame[] = [];
  let finishWithdrawal!: () => void;
  const withdrawal = new Promise<void>((resolve) => {
    finishWithdrawal = resolve;
  });
  const broker = new ClientCapabilityInvocationBroker({
    senderFor: () => ({ send: async (frame) => void sent.push(frame) }),
    onRegistrationIdle: () => {},
  });
  const result = broker.invoke(
    REGISTRATION,
    BINDING,
    {},
    CONTEXT,
    undefined,
    1_000,
    undefined,
    async (_form, options) => {
      const signal = options?.cancellationSignal;
      assert.ok(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await withdrawal;
      throw signal.reason;
    },
  );
  await flush();
  const invocationId = callInvocationId(sent);
  broker.accept('connection-a', {
    kind: 'client.capability.accepted',
    invocationId,
    admissionEvidence: { kind: 'none' },
  });
  await flush();
  broker.accept('connection-a', {
    kind: 'client.capability.interaction_request',
    invocationId,
    interactionId: 'interaction-a',
    request: {
      message: 'Confirm',
      requester: { name: 'deploy' },
      fields: [{ kind: 'boolean', name: 'confirm', label: 'Confirm', required: true }],
    },
  });
  let released = false;
  const release = broker.releaseConnection('connection-a').then(() => {
    released = true;
  });
  await flush();
  assert.equal(released, false);

  finishWithdrawal();
  await release;
  await assert.rejects(result, /disconnected after accepting/);
  broker.close();
});

test('Client Capability cancellation settles only after the nested interaction closes', async () => {
  const sent: ClientCapabilityHostFrame[] = [];
  const invocationController = new AbortController();
  let finishWithdrawal!: () => void;
  const withdrawal = new Promise<void>((resolve) => {
    finishWithdrawal = resolve;
  });
  const broker = new ClientCapabilityInvocationBroker({
    senderFor: () => ({ send: async (frame) => void sent.push(frame) }),
    onRegistrationIdle: () => {},
  });
  const result = broker.invoke(
    REGISTRATION,
    BINDING,
    {},
    CONTEXT,
    invocationController.signal,
    1_000,
    undefined,
    async (_form, options) => {
      const signal = options?.cancellationSignal;
      assert.ok(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await withdrawal;
      throw signal.reason;
    },
  );
  await flush();
  const invocationId = callInvocationId(sent);
  broker.accept('connection-a', {
    kind: 'client.capability.accepted',
    invocationId,
    admissionEvidence: { kind: 'none' },
  });
  await flush();
  broker.accept('connection-a', {
    kind: 'client.capability.interaction_request',
    invocationId,
    interactionId: 'interaction-a',
    request: {
      message: 'Confirm',
      requester: { name: 'deploy' },
      fields: [{ kind: 'boolean', name: 'confirm', label: 'Confirm', required: true }],
    },
  });
  invocationController.abort(new Error('stop'));
  await flush();
  assert.equal(
    sent.some((frame) => frame.kind === 'client.capability.cancel'),
    true,
  );
  assert.equal(
    sent.some((frame) => frame.kind === 'client.capability.release'),
    false,
  );

  finishWithdrawal();
  await assert.rejects(result, (error: unknown) => error instanceof ToolOutcomeUnknownError);
  assert.equal(sent.at(-1)?.kind, 'client.capability.release');
  broker.close();
});

function callInvocationId(frames: readonly ClientCapabilityHostFrame[]): string {
  const call = frames.find((frame) => frame.kind === 'client.capability.call');
  assert.ok(call && call.kind === 'client.capability.call');
  return call.invocationId;
}

function createTimerHarness(): {
  readonly schedule: (callback: () => void) => () => void;
  activeCount(): number;
  fireActive(): void;
} {
  const active = new Set<() => void>();
  return {
    schedule: (callback) => {
      active.add(callback);
      return () => active.delete(callback);
    },
    activeCount: () => active.size,
    fireActive: () => {
      const callback = active.values().next().value;
      assert.ok(callback);
      active.delete(callback);
      callback();
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
