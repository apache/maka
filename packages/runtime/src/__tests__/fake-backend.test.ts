import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader } from '@maka/core/session';
import { FAKE_ASK_USER_QUESTION_PROMPT, FakeBackend } from '../fake-backend.js';
import {
  RuntimeInteractionInvariantError,
  bindRuntimeInteractionRun,
  type RuntimeUserQuestionContinuation,
} from '../interaction-authority.js';
import type { SessionStore } from '../session-manager.js';

test('Fake question publication waits for exact hosted admission', async () => {
  const admissionStarted = deferred<void>();
  const allowAdmission = deferred<void>();
  let continuation: RuntimeUserQuestionContinuation | undefined;
  const binding = await bindRuntimeInteractionRun(
    {
      bindRun: (identity) => ({
        ...identity,
        acceptSandboxBoundaryRequest: async () => {},
        acceptUserQuestionRequest: async ({ continuation: admitted }) => {
          continuation = admitted;
          admissionStarted.resolve();
          await allowAdmission.promise;
        },
        close: async () => {},
        release: () => {},
      }),
    },
    { sessionId: 'session-1', turnId: 'turn-1', runId: 'run-1' },
  );
  const backend = new FakeBackend({
    sessionId: 'session-1',
    header: { model: 'fake-model' } as SessionHeader,
    store: {} as SessionStore,
    appendMessage: async () => {},
  });
  const iterator = backend
    .send({
      turnId: 'turn-1',
      runId: 'run-1',
      text: FAKE_ASK_USER_QUESTION_PROMPT,
      context: [],
      hostedInteraction: binding,
    })
    [Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value?.type, 'tool_start');
  let published = false;
  const requestEvent = iterator.next().then((result) => {
    published = true;
    return result;
  });
  await admissionStarted.promise;
  await Promise.resolve();
  assert.equal(published, false);

  allowAdmission.resolve();
  const request = (await requestEvent).value;
  assert.equal(request?.type, 'user_question_request');
  if (request?.type !== 'user_question_request') assert.fail('expected hosted fake question');
  binding.assertPendingAdmission(request);
  await assert.rejects(
    backend.respondToUserQuestion({
      requestId: request.requestId,
      answers: ['邀请制', null, '本周'],
    }),
    RuntimeInteractionInvariantError,
  );
  await continuation!.applyAnswer({ answers: ['邀请制', null, '本周'] });
  for await (const _event of { [Symbol.asyncIterator]: () => iterator }) {
    // Drain the real Fake question result and terminal path.
  }

  await binding.close('turn_terminal');
  await binding.settleLocalClosures();
  binding.release();
});

test('pullSteering drains queued messages at step boundaries as steering events', async () => {
  const backend = new FakeBackend({
    sessionId: 'session-1',
    header: { model: 'fake-model' } as SessionHeader,
    store: {} as SessionStore,
    appendMessage: async () => {},
  });
  // Queue two steering messages, delivered one per step boundary, then dry up.
  const pending = [
    { id: 'lease-1', messageId: 'message-1', content: { text: 'do X' } },
    { id: 'lease-2', messageId: 'message-2', content: { text: 'and Y' } },
  ];
  const acked: string[] = [];
  const steered: string[] = [];
  let completedText = '';
  for await (const event of backend.send({
    turnId: 'turn-1',
    text: 'hello',
    context: [],
    pullSteering: () => (pending.length > 0 ? [pending.shift()!] : []),
    ackSteering: (leaseIds) => acked.push(...leaseIds),
  })) {
    if (event.type === 'steering_message') steered.push(event.content.text);
    if (event.type === 'text_complete') completedText = event.text;
  }
  assert.deepEqual(steered, ['do X', 'and Y']);
  // Delivery is acknowledged lease by lease.
  assert.deepEqual(acked, ['lease-1', 'lease-2']);
  // The fake acknowledges the steering it saw, proving it reached the model side.
  assert.match(completedText, /Acknowledged steering: do X \| and Y/);
});

test('a batch of leases settles per lease: delivered ones ack, undelivered ones nack', async () => {
  // Round-6 R1: one pull may return several leases, but settlement is per
  // LEASE, not per batch. Here the consumer receives A and B and detaches
  // while suspended at B's yield: A crossed its yield (delivered — the
  // consumer pulled past it), B did not. Batch settlement would nack both,
  // redelivering the already-delivered A.
  const backend = new FakeBackend({
    sessionId: 'session-1',
    header: { model: 'fake-model' } as SessionHeader,
    store: {} as SessionStore,
    appendMessage: async () => {},
  });
  let pulled = false;
  const acked: string[] = [];
  const nacked: string[] = [];
  const iterator = backend
    .send({
      turnId: 'turn-1',
      text: 'hello',
      context: [],
      pullSteering: () => {
        if (pulled) return [];
        pulled = true;
        return [
          { id: 'lease-a', messageId: 'message-a', content: { text: 'A' } },
          { id: 'lease-b', messageId: 'message-b', content: { text: 'B' } },
        ];
      },
      ackSteering: (leaseIds) => acked.push(...leaseIds),
      nackSteering: (leaseIds) => nacked.push(...leaseIds),
    })
    [Symbol.asyncIterator]();

  const steered: string[] = [];
  for (let i = 0; i < 20 && steered.length < 2; i += 1) {
    const result = await iterator.next();
    if (result.done) break;
    if (result.value.type === 'steering_message') steered.push(result.value.content.text);
  }
  assert.deepEqual(steered, ['A', 'B']);

  await iterator.return?.(undefined);
  assert.deepEqual(acked, ['lease-a']);
  assert.deepEqual(nacked, ['lease-b']);
});

test('a lease is acked only after its event is consumed, and nacked when the consumer detaches', async () => {
  // Round-4 V3: the lease contract — ack means DELIVERED. The fake has no
  // durable ledger, so its delivery boundary is the consumer receiving the
  // echoed event; acking at pull time marked messages delivered that a
  // detaching consumer never saw, silently dropping them.
  const backend = new FakeBackend({
    sessionId: 'session-1',
    header: { model: 'fake-model' } as SessionHeader,
    store: {} as SessionStore,
    appendMessage: async () => {},
  });
  const pending = [{ id: 'lease-1', messageId: 'message-1', content: { text: 'do X' } }];
  const acked: string[] = [];
  const nacked: string[] = [];
  const iterator = backend
    .send({
      turnId: 'turn-1',
      text: 'hello',
      context: [],
      pullSteering: () => pending.splice(0),
      ackSteering: (leaseIds) => acked.push(...leaseIds),
      nackSteering: (leaseIds) => nacked.push(...leaseIds),
    })
    [Symbol.asyncIterator]();

  let received: SessionEvent | undefined;
  for (let i = 0; i < 10 && received?.type !== 'steering_message'; i += 1) {
    received = (await iterator.next()).value;
  }
  assert.equal(received?.type, 'steering_message');
  // The consumer holds the event but the generator has not resumed past its
  // yield: the lease is pulled, not yet delivered.
  assert.deepEqual(acked, []);

  // Detach before consuming further: the undelivered lease is returned.
  await iterator.return?.(undefined);
  assert.deepEqual(acked, []);
  assert.deepEqual(nacked, ['lease-1']);
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
