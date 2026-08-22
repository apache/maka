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

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { SessionEvent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionContinuitySnapshot,
  type SessionTranscriptPage,
  type SubscriptionFrame,
} from "@maka/runtime-host/protocol";
import { RuntimeHostSubscriptionError } from "@maka/runtime-host/client";
import type { DesktopRuntimeHostSession } from "../runtime-host-client.js";
import {
  DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  type DesktopTranscriptBatch,
} from '../../preload/transcript-contract.js';
import { RuntimeHostSessionObservationRegistry } from "../runtime-host-session-observation-registry.js";
import {
  RuntimeHostSessionObserver,
  type RuntimeHostRendererTarget,
  type RuntimeHostSessionObserverTarget,
  type RuntimeHostTranscriptTarget,
} from "../runtime-host-session-observer.js";
import { RuntimeHostSessionSubscriptionOwner } from '../runtime-host-session-subscription-owner.js';
import { runtimeHostSessionFixture } from "./runtime-host-session-test-fixture.js";

test("joins an active Turn without losing or replaying assistant text", async () => {
  const transcript = deferred<StoredMessage[]>();
  const events = new AsyncFrameQueue();
  const finishedTurns: Array<[string, "completed" | "abandoned"]> = [];
  let closeCount = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    activeAssistantStreams: [activeText('message-1')],
    transcript: transcript.promise,
    events,
    async close() {
      closeCount += 1;
      events.end();
    },
  });
  const observer = new RuntimeHostSessionObserver({
    client: { openSession: async () => handle },
    emitSessionsChanged() {},
    onWatchedTurnFinished: (sessionId, outcome) => {
      finishedTurns.push([sessionId, outcome]);
    },
    now: () => 50,
  });
  const target = eventTarget(1);

  const watching = observer.watchTurn("session-1", "turn-1");
  const observing = observer.observe("session-1", "observer-1", target);
  events.push(deltaFrame(1, 5, " world"));
  transcript.resolve([
    {
      type: "assistant",
      id: "message-1",
      turnId: "turn-1",
      ts: 10,
      text: "Hello",
      modelId: "test-model",
    },
  ]);
  await Promise.all([watching, observing]);
  await waitFor(() => target.events.length === 2);

  assert.deepEqual(
    target.events.map((event) => [
      event.type,
      "text" in event ? event.text : undefined,
      "startOffset" in event ? event.startOffset : undefined,
    ]),
    [
      ["text_delta", "Hello", 0],
      ["text_delta", " world", 5],
    ],
  );

  events.push({
    kind: "subscription.session_projection",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 2,
    snapshot: continuitySnapshot({
      rootTurn: {
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        status: "completed",
        terminalEventId: "terminal-1",
      },
    }),
  });
  await waitFor(() => target.events.some((event) => event.type === "complete"));

  assert.deepEqual(
    target.events.filter(
      (event): event is Extract<SessionEvent, { type: "text_complete" }> =>
        event.type === "text_complete",
    ),
    [
      {
        type: "text_complete",
        id: "terminal-1:text:message-1",
        turnId: "turn-1",
        messageId: "message-1",
        ts: 50,
        text: "Hello world",
      },
    ],
  );
  assert.deepEqual(finishedTurns, [["session-1", "completed"]]);

  await observer.unobserve("observer-1");
  assert.equal(closeCount, 1);
});

test("restores renderer observation after the Host connection is replaced", async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const firstObserver = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events: firstEvents,
        async close() {
          firstEvents.end();
        },
      }),
    },
    emitSessionsChanged() {},
  });
  const secondObserver = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(),
        activeAssistantStreams: [activeText('message-1')],
        transcript: Promise.resolve([
          {
            type: "assistant",
            id: "message-1",
            turnId: "turn-1",
            ts: 10,
            text: "Hello",
            modelId: "test-model",
          },
        ]),
        events: secondEvents,
        async close() {
          secondEvents.end();
        },
      }),
    },
    emitSessionsChanged() {},
    now: () => 50,
  });
  const observations = new RuntimeHostSessionObservationRegistry();
  const target = eventTarget(10);

  assert.deepEqual(await observations.attach(firstObserver), []);
  await observations.observe("session-1", "observer-1", target);
  observations.detach(firstObserver);
  await firstObserver.close();
  assert.deepEqual(await observations.attach(secondObserver), ["session-1"]);
  await waitFor(() => target.events.length === 1);

  secondEvents.push(deltaFrame(1, 5, " again"));
  secondEvents.push({
    kind: "subscription.session_projection",
    hostEpoch: "host-2",
    subscriptionId: "subscription-2",
    sequence: 2,
    snapshot: continuitySnapshot({
      rootTurn: {
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        status: "completed",
        terminalEventId: "terminal-1",
      },
    }),
  });
  await waitFor(() =>
    target.events.some((event) => event.type === "complete"),
  );

  assert.deepEqual(
    target.events.map((event) => [
      event.type,
      "text" in event ? event.text : undefined,
    ]),
    [
      ["text_delta", "Hello"],
      ["text_delta", " again"],
      ["text_complete", "Hello again"],
      ["complete", undefined],
    ],
  );

  await observations.close();
  await secondObserver.close();
});

test("rebinds a restored renderer observation to the current target scope", async () => {
  const observations = new RuntimeHostSessionObservationRegistry();
  const sent: unknown[][] = [];
  const renderer: RuntimeHostSessionObserverTarget = {
    id: 11,
    send: (...args: unknown[]) => sent.push(args),
    once() {},
    off() {},
  };
  let firstTarget: RuntimeHostSessionObserverTarget | undefined;
  let secondTarget: RuntimeHostSessionObserverTarget | undefined;
  const firstSource = {
    async observe(
      _sessionId: string,
      _observerId: string,
      target: RuntimeHostSessionObserverTarget,
    ) {
      firstTarget = target;
    },
    async unobserve() {},
  };
  const secondSource = {
    async observe(
      _sessionId: string,
      _observerId: string,
      target: RuntimeHostSessionObserverTarget,
    ) {
      secondTarget = target;
    },
    async unobserve() {},
  };
  const bind = (targetEpoch: string) => <Payload>(target: RuntimeHostRendererTarget<Payload>) => ({
    ...target,
    send: (channel: string, payload: unknown) =>
      (target.send as (channel: string, ...args: unknown[]) => void)(
        channel,
        { targetEpoch },
        payload,
      ),
  });

  await observations.attach(firstSource, bind('target-a'));
  await observations.observe('session-1', 'observer-1', renderer);
  observations.detach(firstSource);
  await observations.attach(secondSource, bind('target-b'));

  const firstEvent: SessionEvent = {
    type: 'abort',
    id: 'event-a',
    turnId: 'turn-1',
    ts: 1,
    reason: 'user_stop',
  };
  const secondEvent: SessionEvent = {
    type: 'complete',
    id: 'event-b',
    turnId: 'turn-2',
    ts: 2,
    stopReason: 'end_turn',
  };
  firstTarget?.send('sessions:event:observer-1', firstEvent);
  secondTarget?.send('sessions:event:observer-1', secondEvent);
  assert.deepEqual(sent, [
    ['sessions:event:observer-1', { targetEpoch: 'target-a' }, firstEvent],
    ['sessions:event:observer-1', { targetEpoch: 'target-b' }, secondEvent],
  ]);
  await observations.close();
});

test("does not report an observation ready before its source has seeded", async () => {
  const observations = new RuntimeHostSessionObservationRegistry();
  const staleSeeded = deferred<void>();
  const staleSource = {
    async observe() {
      await staleSeeded.promise;
    },
    async unobserve() {},
  };
  let ready = false;

  const observing = observations.observe(
    "session-1",
    "observer-1",
    eventTarget(12),
  ).then(() => {
    ready = true;
  });
  await Promise.resolve();
  assert.equal(ready, false);

  const staleAttach = observations.attach(staleSource);
  await Promise.resolve();
  assert.equal(ready, false);

  observations.detach(staleSource);
  staleSeeded.resolve();
  await staleAttach;
  assert.equal(ready, false);

  const seeded = deferred<void>();
  const source = {
    async observe() {
      await seeded.promise;
    },
    async unobserve() {},
  };
  const attaching = observations.attach(source);
  await Promise.resolve();
  assert.equal(ready, false);

  seeded.resolve();
  await Promise.all([observing, attaching]);
  assert.equal(ready, true);
  await observations.close();
});

test("rejects a pending observation when its first seed fails", async () => {
  const observations = new RuntimeHostSessionObservationRegistry();
  const observing = observations.observe(
    "session-1",
    "observer-1",
    eventTarget(12),
  );

  assert.deepEqual(await observations.attach({
    async observe() {
      throw new Error("seed failed");
    },
    async unobserve() {},
  }), []);
  await assert.rejects(observing, /ended before it became ready/);
  await observations.close();
});

test("keeps an active observation across a failed Host replacement", async () => {
  const observations = new RuntimeHostSessionObservationRegistry();
  const target = eventTarget(12);
  const firstSource = {
    async observe() {},
    async unobserve() {},
  };
  let recovered = 0;
  const recoveredSource = {
    async observe() {
      recovered++;
    },
    async unobserve() {},
  };
  const failingSource = {
    async observe() {
      throw new Error("replacement seed failed");
    },
    async unobserve() {},
  };

  await observations.attach(firstSource);
  await observations.observe("session-1", "observer-1", target);
  observations.detach(firstSource);
  assert.deepEqual(await observations.attach(failingSource), []);
  observations.detach(failingSource);

  assert.deepEqual(await observations.attach(recoveredSource), ["session-1"]);
  assert.equal(recovered, 1);
  await observations.close();
});

test('restores transcript consumers across Host replacement', async () => {
  const observations = new RuntimeHostSessionObservationRegistry();
  const batches: DesktopTranscriptBatch[] = [];
  const scopes: string[] = [];
  const target: RuntimeHostTranscriptTarget = {
    id: 18,
    send(_channel, ...args: unknown[]) {
      const [scope, batch] = args as [{ targetEpoch: string }, DesktopTranscriptBatch];
      scopes.push(scope.targetEpoch);
      batches.push(batch);
    },
    once() {},
    off() {},
  };
  const bind = (targetEpoch: string) => <Payload>(target: RuntimeHostRendererTarget<Payload>) => ({
    ...target,
    send: (channel: string, payload: Payload) =>
      (target.send as (channel: string, ...args: unknown[]) => void)(
        channel,
        { targetEpoch },
        payload,
      ),
  });
  const opens: string[] = [];
  const source = (generation: string) => ({
    async observe() {},
    async unobserve() {},
    async openTranscript(
      sessionId: string,
      consumerId: string,
      consumer: RuntimeHostTranscriptTarget,
    ) {
      opens.push(`${generation}:${sessionId}:${consumerId}`);
      consumer.send(`sessions:transcript:${consumerId}`, {
        deliverySequence: 1,
        sessionId,
        generation,
        hostEpoch: `host-${generation}`,
        durableThrough: null,
        fragments: [],
        evictedDurableSequences: [],
        completedOverlayMessageIds: [],
        hasOlder: false,
        hasNewer: false,
        reset: true,
        ready: true,
      });
      return {
        sessionId,
        generation,
        hostEpoch: `host-${generation}`,
        readThroughMessageId: null,
      };
    },
    async loadTranscriptBefore() {},
    async loadTranscriptAround() {},
    async closeTranscript() {},
  });
  const first = source('first');
  await observations.attach(first, bind('first'));
  await observations.openTranscript('session-1', 'consumer-1', target);
  observations.detach(first);
  assert.doesNotThrow(() => observations.acknowledgeTranscript('consumer-1', 'first', 1, 18));
  const second = source('second');
  await observations.attach(second, bind('second'));
  observations.detach(second);
  await observations.closeTranscript('consumer-1');
  const pending = observations.openTranscript('session-1', 'consumer-2', target);
  let pendingSettled = false;
  void pending.finally(() => {
    pendingSettled = true;
  });
  await Promise.resolve();
  assert.equal(pendingSettled, false);
  await observations.attach(source('third'), bind('third'));
  assert.equal((await pending).generation, 'third');

  assert.deepEqual(opens, [
    'first:session-1:consumer-1',
    'second:session-1:consumer-1',
    'third:session-1:consumer-2',
  ]);
  assert.deepEqual(
    batches.map((batch) => batch.generation),
    ['first', 'second', 'third'],
  );
  assert.deepEqual(scopes, ['first', 'second', 'third']);
  await observations.close();
});

test('fences transcript range failures to the current registration and Host source', async () => {
  const observations = new RuntimeHostSessionObservationRegistry();
  const target: RuntimeHostTranscriptTarget = {
    id: 19,
    send() {},
    once() {},
    off() {},
  };
  const source = (
    generation: string,
    loadTranscriptBefore: () => Promise<void>,
  ) => ({
    async observe() {},
    async unobserve() {},
    async openTranscript(sessionId: string) {
      return {
        sessionId,
        generation,
        hostEpoch: `host-${generation}`,
        readThroughMessageId: null,
      };
    },
    loadTranscriptBefore,
    async loadTranscriptAround() {},
    async closeTranscript() {},
  });
  const request = (consumerId: string, generation: string) => ({
    consumerId,
    generation,
    anchorSequence: null,
    maxBytes: DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  });

  const closedFailure = deferred<void>();
  const first = source('first', () => closedFailure.promise);
  await observations.attach(first);
  await observations.openTranscript('session-1', 'consumer-closed', target);
  const closedRange = observations.loadTranscriptBefore(
    request('consumer-closed', 'first'),
    target.id,
  );
  await observations.closeTranscript('consumer-closed', target.id);
  closedFailure.reject(new Error('closed source rejected its range'));
  await assert.doesNotReject(closedRange);
  observations.detach(first);

  const replacedFailure = deferred<void>();
  const second = source('second', () => replacedFailure.promise);
  await observations.attach(second);
  await observations.openTranscript('session-1', 'consumer-replaced', target);
  const replacedRange = observations.loadTranscriptBefore(
    request('consumer-replaced', 'second'),
    target.id,
  );
  observations.detach(second);

  const currentFailure = new Error('current source failed its range');
  const third = source('third', async () => {
    throw currentFailure;
  });
  await observations.attach(third);
  replacedFailure.reject(new Error('replaced source rejected its range'));
  await assert.doesNotReject(replacedRange);
  await assert.rejects(
    observations.loadTranscriptBefore(
      request('consumer-replaced', 'third'),
      target.id,
    ),
    (error) => error === currentFailure,
  );
  await observations.close();
});

test('fences transcript range failures across same-source replica recovery', async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const staleRange = deferred<SessionTranscriptPage>();
  const currentFailure = new Error('current replica failed its range');
  const message: StoredMessage = {
    type: 'assistant',
    id: 'assistant-1',
    turnId: 'turn-1',
    ts: 1,
    text: 'current',
    modelId: 'test-model',
  };
  let opens = 0;
  let staleRangeStarted = false;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        opens += 1;
        const first = opens === 1;
        const events = first ? firstEvents : secondEvents;
        const bootstrap: SessionTranscriptPage = {
          kind: 'page',
          sessionId: 'session-1',
          source: 'durable',
          direction: 'older',
          throughSequence: 1,
          rawBytes: 1,
          fragments: [],
          nextCursor: 'older',
        };
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          transcript: Promise.resolve([]),
          events,
          transcriptBootstrap: {
            throughSequence: 1,
            overlayMessageCount: 0,
            durable: bootstrap,
            overlay: { ...bootstrap, source: 'overlay', nextCursor: null },
          },
          decodeTranscriptPage: async (page) => ({
            messages: page === bootstrap ? [{ identity: 1, message }] : [],
            nextCursor: page === bootstrap ? 'older' : null,
          }),
          loadTranscriptPage: first
            ? () => {
                staleRangeStarted = true;
                return staleRange.promise;
              }
            : async () => {
                throw currentFailure;
              },
          async close() {
            events.end();
          },
        });
      },
    },
    emitSessionsChanged() {},
  });
  const observations = new RuntimeHostSessionObservationRegistry();
  const batches: DesktopTranscriptBatch[] = [];
  const consumerId = 'consumer-replica-recovery';
  const request = (generation: string) => ({
    consumerId,
    generation,
    anchorSequence: 1,
    maxBytes: DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  });
  const target: RuntimeHostTranscriptTarget = {
    id: 20,
    send(_channel, batch) {
      batches.push(batch);
      queueMicrotask(() =>
        observations.acknowledgeTranscript(
          consumerId,
          batch.generation,
          batch.deliverySequence,
          20,
        ),
      );
    },
    once() {},
    off() {},
  };
  await observations.attach(observer);
  const opened = await observations.openTranscript('session-1', consumerId, target);
  const staleLoad = observations.loadTranscriptBefore(request(opened.generation), target.id);
  await waitFor(() => staleRangeStarted);

  firstEvents.push({
    kind: 'subscription.closed',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sequence: 1,
    reason: 'slow_consumer',
  });
  await waitFor(() => batches.at(-1)?.generation !== opened.generation);
  staleRange.reject(new Error('stale replica rejected its range'));
  await assert.doesNotReject(staleLoad);

  const generation = batches.at(-1)!.generation;
  await assert.rejects(
    observations.loadTranscriptBefore(request(generation), target.id),
    (error) => error === currentFailure,
  );
  await observations.close();
  await observer.close();
});

test('cancels a transcript consumer while its replica is still preparing', async () => {
  const transcript = deferred<StoredMessage[]>();
  const events = new AsyncFrameQueue();
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          transcript: transcript.promise,
          events,
          async close() {
            events.end();
          },
        }),
    },
    emitSessionsChanged() {},
  });
  const opening = observer.openTranscript('session-1', 'consumer-pending', {
    id: 20,
    send() {},
    once() {},
    off() {},
  });
  await Promise.resolve();

  await observer.closeTranscript('consumer-pending', 20);
  await assert.rejects(() => opening, /cancelled/);
  transcript.resolve([]);
  await observer.close();
});

test('broadcasts transcript changes to every consumer and advances the read marker', async () => {
  const events = new AsyncFrameQueue();
  const markers: string[] = [];
  const message: StoredMessage = {
    type: 'assistant',
    id: 'assistant-1',
    turnId: 'turn-1',
    ts: 2,
    text: 'Hi',
    modelId: 'test-model',
  };
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          transcript: Promise.resolve([]),
          events,
          loadTranscriptPage: async () => ({
            kind: 'page',
            sessionId: 'session-1',
            source: 'durable',
            direction: 'newer',
            throughSequence: 0,
            rawBytes: 1,
            fragments: [],
            nextCursor: null,
          }),
          decodeTranscriptPage: async () => ({
            messages: [{ identity: 0, message }],
            nextCursor: null,
          }),
          async close() {
            events.end();
          },
        }),
      setSessionReadMarker: async (_sessionId, messageId) => {
        markers.push(messageId);
        return undefined as never;
      },
    },
    emitSessionsChanged() {},
  });
  const transcriptBatches: DesktopTranscriptBatch[][] = [[], []];
  for (const [index, batches] of transcriptBatches.entries()) {
    const consumerId = `consumer-${index}`;
    await observer.openTranscript('session-1', consumerId, {
      id: 19 + index,
      send(_channel, batch) {
        batches.push(batch);
        queueMicrotask(() =>
          observer.acknowledgeTranscript(
            consumerId,
            batch.generation,
            batch.deliverySequence!,
            19 + index,
          ),
        );
      },
      once() {},
      off() {},
    });
    batches.splice(0);
  }
  markers.splice(0);
  events.push({
    kind: 'subscription.transcript_advanced',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sessionId: 'session-1',
    sequence: 1,
    throughSequence: 0,
  });
  await waitFor(() =>
    markers.length === 1 && transcriptBatches.every((batches) => batches.length > 0),
  );

  assert.deepEqual(markers, ['assistant-1']);
  assert.deepEqual(transcriptBatches[1], transcriptBatches[0]);
  await observer.close();
});

test('keeps a bounded transcript batch window in flight until the renderer acknowledges it', async () => {
  const events = new AsyncFrameQueue();
  const message: StoredMessage = {
    type: 'assistant',
    id: 'assistant-large',
    turnId: 'turn-1',
    ts: 2,
    text: 'x'.repeat(DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES * 6),
    modelId: 'test-model',
  };
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          transcript: Promise.resolve([message]),
          events,
          async close() {
            events.end();
          },
        }),
    },
    emitSessionsChanged() {},
  });
  const batches: DesktopTranscriptBatch[] = [];
  const opening = observer.openTranscript('session-1', 'consumer-ack', {
    id: 21,
    send(_channel, batch) {
      batches.push(batch);
    },
    once() {},
    off() {},
  });

  await waitFor(() => batches.length === 4);
  assert.equal(batches.some((batch) => batch.ready), false);
  const second = batches[1]!;
  observer.acknowledgeTranscript(
    'consumer-ack',
    second.generation,
    second.deliverySequence,
    21,
  );
  await waitFor(() => batches.length === 5);

  const acknowledged = new Set([second.deliverySequence]);
  for (let attempt = 0; !batches.some((batch) => batch.ready) && attempt < 100; attempt += 1) {
    for (const batch of batches) {
      if (acknowledged.has(batch.deliverySequence)) continue;
      acknowledged.add(batch.deliverySequence);
      observer.acknowledgeTranscript(
        'consumer-ack',
        batch.generation,
        batch.deliverySequence,
        21,
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(batches.some((batch) => batch.ready));
  for (const batch of batches) {
    if (acknowledged.has(batch.deliverySequence)) continue;
    observer.acknowledgeTranscript(
      'consumer-ack',
      batch.generation,
      batch.deliverySequence,
      21,
    );
  }
  await opening;
  await observer.close();
});

test('finishes transcript open against a replacement that arrives while reset delivery waits', async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const message: StoredMessage = {
    type: 'assistant',
    id: 'assistant-large',
    turnId: 'turn-1',
    ts: 2,
    text: 'x'.repeat(DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES * 6),
    modelId: 'test-model',
  };
  let opens = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        opens += 1;
        const events = opens === 1 ? firstEvents : secondEvents;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          transcript: Promise.resolve([message]),
          events,
          async close() {
            events.end();
          },
        });
      },
    },
    emitSessionsChanged() {},
  });
  const batches: DesktopTranscriptBatch[] = [];
  const opening = observer.openTranscript('session-1', 'consumer-recovery', {
    id: 22,
    send(_channel, batch) {
      batches.push(batch);
    },
    once() {},
    off() {},
  });
  const result = opening.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );

  await waitFor(() => batches.length === 4);
  firstEvents.push({
    kind: 'subscription.closed',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sequence: 1,
    reason: 'slow_consumer',
  });
  await waitFor(() => opens === 2);

  const acknowledged = new Set<string>();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const batch of batches) {
      const key = `${batch.generation}:${batch.deliverySequence}`;
      if (acknowledged.has(key)) continue;
      acknowledged.add(key);
      observer.acknowledgeTranscript(
        'consumer-recovery',
        batch.generation,
        batch.deliverySequence,
        22,
      );
    }
    const settled = await Promise.race([
      result.then(() => true),
      new Promise<false>((resolve) => setImmediate(() => resolve(false))),
    ]);
    if (settled) break;
  }

  const opened = await result;
  assert.equal(opened.error, undefined);
  assert.equal(opened.value?.generation, batches.at(-1)?.generation);
  await observer.close();
});

test('coalesces transcript changes into one bounded delta while renderer delivery is backpressured', async () => {
  const events = new AsyncFrameQueue();
  let decoded = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          transcript: Promise.resolve([]),
          events,
          loadTranscriptPage: async (input) => ({
            kind: 'page',
            sessionId: 'session-1',
            source: 'durable',
            direction: 'newer',
            throughSequence: input.throughSequence,
            rawBytes: 1,
            fragments: [],
            nextCursor: null,
          }),
          decodeTranscriptPage: async (page) => {
            if (page.throughSequence === null) return { messages: [], nextCursor: null };
            decoded += 1;
            const identity = page.throughSequence;
            return {
              messages: [{
                identity,
                message: {
                  type: 'assistant',
                  id: `a-${identity}`,
                  turnId: 'turn-1',
                  ts: identity,
                  text: String(identity),
                  modelId: 'test-model',
                },
              }],
              nextCursor: null,
            };
          },
          async close() {
            events.end();
          },
        }),
    },
    emitSessionsChanged() {},
  });
  const batches: DesktopTranscriptBatch[] = [];
  const consumerId = 'consumer-coalesced';
  await observer.openTranscript('session-1', consumerId, {
    id: 22,
    send(_channel, batch) {
      batches.push(batch);
      if (batch.reset) {
        queueMicrotask(() =>
          observer.acknowledgeTranscript(
            consumerId,
            batch.generation,
            batch.deliverySequence,
            22,
          ),
        );
      }
    },
    once() {},
    off() {},
  });
  batches.splice(0);

  for (let sequence = 0; sequence < 5; sequence += 1) {
    events.push({
      kind: 'subscription.transcript_advanced',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sessionId: 'session-1',
      sequence: sequence + 1,
      throughSequence: sequence,
    });
    await waitFor(() => decoded === sequence + 1);
  }
  await waitFor(() => batches.length === 1);
  assert.equal(batches[0]!.reset, false);
  observer.acknowledgeTranscript(
    consumerId,
    batches[0]!.generation,
    batches[0]!.deliverySequence,
    22,
  );
  await waitFor(() => batches.length === 2);
  assert.equal(batches[1]!.reset, false);
  assert.equal(batches[1]!.durableThrough, 4);
  assert.equal(batches[1]!.fragments.length, 4);
  observer.acknowledgeTranscript(
    consumerId,
    batches[1]!.generation,
    batches[1]!.deliverySequence,
    22,
  );
  await observer.close();
});

test('does not let one backpressured transcript consumer block another', async () => {
  const events = new AsyncFrameQueue();
  let decoded = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          transcript: Promise.resolve([]),
          events,
          loadTranscriptPage: async (input) => ({
            kind: 'page',
            sessionId: 'session-1',
            source: 'durable',
            direction: 'newer',
            throughSequence: input.throughSequence,
            rawBytes: 1,
            fragments: [],
            nextCursor: null,
          }),
          decodeTranscriptPage: async (page) => {
            if (page.throughSequence === null) return { messages: [], nextCursor: null };
            decoded += 1;
            return {
              messages: [{
                identity: page.throughSequence,
                message: {
                  type: 'assistant',
                  id: `a-${page.throughSequence}`,
                  turnId: 'turn-1',
                  ts: page.throughSequence,
                  text: String(page.throughSequence),
                  modelId: 'test-model',
                },
              }],
              nextCursor: null,
            };
          },
          async close() {
            events.end();
          },
        }),
    },
    emitSessionsChanged() {},
  });
  const received = new Map<string, DesktopTranscriptBatch[]>([
    ['slow', []],
    ['healthy', []],
  ]);
  let blockSlow = false;
  for (const [consumerId, targetId] of [['slow', 23], ['healthy', 24]] as const) {
    await observer.openTranscript('session-1', consumerId, {
      id: targetId,
      send(_channel, batch) {
        received.get(consumerId)!.push(batch);
        if (consumerId !== 'slow' || !blockSlow) {
          queueMicrotask(() =>
            observer.acknowledgeTranscript(
              consumerId,
              batch.generation,
              batch.deliverySequence,
              targetId,
            ),
          );
        }
      },
      once() {},
      off() {},
    });
    received.get(consumerId)!.splice(0);
  }
  blockSlow = true;
  const slow = received.get('slow')!;
  const healthy = received.get('healthy')!;

  events.push({
    kind: 'subscription.transcript_advanced',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sessionId: 'session-1',
    sequence: 1,
    throughSequence: 0,
  });
  await waitFor(() => decoded === 1);
  await waitFor(() => slow.length === 1 && healthy.length >= 2);
  const healthyBeforeSecondAdvance = healthy.length;
  events.push({
    kind: 'subscription.transcript_advanced',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sessionId: 'session-1',
    sequence: 2,
    throughSequence: 1,
  });
  await waitFor(() => decoded === 2 && healthy.length > healthyBeforeSecondAdvance);
  assert.equal(slow.length, 1);
  observer.acknowledgeTranscript(
    'slow',
    slow[0]!.generation,
    slow[0]!.deliverySequence,
    23,
  );
  await observer.close();
});

test('releases an idle session when transcript delivery fails', async () => {
  const events = new AsyncFrameQueue();
  let closeCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          transcript: Promise.resolve([]),
          events,
          loadTranscriptPage: async (input) => ({
            kind: 'page',
            sessionId: 'session-1',
            source: 'durable',
            direction: 'newer',
            throughSequence: input.throughSequence,
            rawBytes: 1,
            fragments: [],
            nextCursor: null,
          }),
          decodeTranscriptPage: async (page) => ({
            messages: page.throughSequence === null ? [] : [{
              identity: page.throughSequence,
              message: {
                type: 'assistant',
                id: 'assistant-1',
                turnId: 'turn-1',
                ts: 1,
                text: 'done',
                modelId: 'test-model',
              },
            }],
            nextCursor: null,
          }),
          async close() {
            closeCount += 1;
            events.end();
          },
        }),
    },
    emitSessionsChanged() {},
  });
  let opened = false;
  const consumerId = 'consumer-failing';
  await observer.openTranscript('session-1', consumerId, {
    id: 25,
    send(_channel, batch) {
      if (opened) throw new Error('renderer unavailable');
      queueMicrotask(() =>
        observer.acknowledgeTranscript(
          consumerId,
          batch.generation,
          batch.deliverySequence,
          25,
        ),
      );
    },
    once() {},
    off() {},
  });
  opened = true;
  events.push({
    kind: 'subscription.transcript_advanced',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sessionId: 'session-1',
    sequence: 1,
    throughSequence: 0,
  });

  await waitFor(() => closeCount === 1);
  await observer.close();
});

test("ignores a stale seed failure after its replacement succeeds", async () => {
  const observations = new RuntimeHostSessionObservationRegistry();
  let rejectStale!: (error: Error) => void;
  const replacementSeed = deferred<void>();
  const staleSeed = new Promise<void>((_resolve, reject) => {
    rejectStale = reject;
  });
  const staleSource = {
    observe: () => staleSeed,
    async unobserve() {},
  };
  const replacementSource = {
    observe: () => replacementSeed.promise,
    async unobserve() {},
  };
  let ready = false;

  await observations.attach(staleSource);
  const observing = observations.observe(
    "session-1",
    "observer-1",
    eventTarget(12),
  ).then(() => {
    ready = true;
  });
  observations.detach(staleSource);
  const attaching = observations.attach(replacementSource);

  rejectStale(new Error("stale seed failed"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ready, false);

  replacementSeed.resolve(undefined);
  assert.deepEqual(await attaching, ["session-1"]);
  await observing;
  assert.equal(ready, true);
  assert.deepEqual(observations.observedSessionIds(), ["session-1"]);
  await observations.close();
});

test("does not publish a terminal error while an owner-managed connection is replaced", async () => {
  let rejectFrame!: (error: Error) => void;
  let closeCount = 0;
  const events: AsyncIterable<SubscriptionFrame> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<SubscriptionFrame>>((_resolve, reject) => {
          rejectFrame = reject;
        }),
    }),
  };
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          closeCount += 1;
        },
      }),
    },
    emitSessionsChanged() {},
    recoverConnectionClosed: true,
  });
  const target = eventTarget(11);
  await observer.observe("session-1", "observer-1", target);

  rejectFrame(new RuntimeHostSubscriptionError("connection_closed", "Host restarted"));
  await waitFor(() => closeCount === 1);
  assert.equal(target.events.some((event) => event.type === "error"), false);
  await observer.close();
});

test("keeps a native Turn watched without a renderer and releases it at terminal", async () => {
  const events = new AsyncFrameQueue();
  const finishedTurns: Array<[string, "completed" | "abandoned"]> = [];
  let closeCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          closeCount += 1;
          events.end();
        },
      }),
    },
    emitSessionsChanged() {},
    onWatchedTurnFinished: (sessionId, outcome) => {
      finishedTurns.push([sessionId, outcome]);
    },
  });

  await observer.watchTurn("session-1", "turn-1");
  events.push({
    kind: "subscription.session_projection",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    snapshot: continuitySnapshot({
      rootTurn: {
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        status: "completed",
        terminalEventId: "terminal-1",
      },
    }),
  });

  await waitFor(() => closeCount === 1);
  assert.deepEqual(finishedTurns, [["session-1", "completed"]]);
  await observer.close();
});

test("does not let an older terminal projection finish a newer watched Turn", async () => {
  const transcript = deferred<StoredMessage[]>();
  const events = new AsyncFrameQueue();
  const finishedTurns: Array<[string, "completed" | "abandoned"]> = [];
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(),
        activeAssistantStreams: [],
        transcript: transcript.promise,
        events,
        async close() {
          events.end();
        },
      }),
    },
    emitSessionsChanged() {},
    onWatchedTurnFinished: (sessionId, outcome) => {
      finishedTurns.push([sessionId, outcome]);
    },
  });

  const first = observer.watchTurn("session-1", "turn-1");
  events.push({
    kind: "subscription.session_projection",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    snapshot: continuitySnapshot({
      rootTurn: {
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
        status: "completed",
        terminalEventId: "terminal-1",
      },
    }),
  });
  const second = observer.watchTurn("session-1", "turn-2");
  events.push({
    kind: "subscription.session_projection",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 2,
    snapshot: continuitySnapshot({
      rootTurn: {
        sessionId: "session-1",
        turnId: "turn-2",
        runId: "run-2",
        status: "running",
      },
    }),
  });
  transcript.resolve([]);
  await Promise.all([first, second]);
  assert.deepEqual(finishedTurns, []);

  events.push({
    kind: "subscription.session_projection",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 3,
    snapshot: continuitySnapshot({
      rootTurn: {
        sessionId: "session-1",
        turnId: "turn-2",
        runId: "run-2",
        status: "completed",
        terminalEventId: "terminal-2",
      },
    }),
  });

  await waitFor(() => finishedTurns.length === 1);
  assert.deepEqual(finishedTurns, [["session-1", "completed"]]);
  await observer.close();
});

test("invalidates the transcript when another client starts a Turn", async () => {
  const events = new AsyncFrameQueue();
  const sessionChanges: Array<{
    reason: string;
    sessionId: string;
    turnId?: string;
  }> = [];
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot({
          rootTurn: {
            sessionId: "session-1",
            turnId: "turn-1",
            runId: "run-1",
            status: "completed",
            terminalEventId: "terminal-1",
          },
        }),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          events.end();
        },
      }),
    },
    emitSessionsChanged: (reason, sessionId, extra) =>
      sessionChanges.push({ reason, sessionId, turnId: extra?.turnId }),
  });
  await observer.observe("session-1", "observer-1", eventTarget(2));

  events.push({
    kind: "subscription.session_projection",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    snapshot: continuitySnapshot({
      projectionRevision: 2,
      rootTurn: {
        sessionId: "session-1",
        turnId: "turn-2",
        runId: "run-2",
        status: "running",
      },
    }),
  });

  await waitFor(() => sessionChanges.length === 2);
  assert.deepEqual(sessionChanges, [
    { reason: "status-change", sessionId: "session-1", turnId: "turn-2" },
    { reason: "message-appended", sessionId: "session-1", turnId: "turn-2" },
  ]);
  await observer.close();
});

test("abandons a watched Turn when the initial Host subscription fails", async () => {
  const finishedTurns: Array<[string, "completed" | "abandoned"]> = [];
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        throw new Error("Host subscription unavailable");
      },
    },
    emitSessionsChanged() {},
    onWatchedTurnFinished: (sessionId, outcome) => {
      finishedTurns.push([sessionId, outcome]);
    },
  });

  await assert.rejects(
    observer.watchTurn("session-1", "turn-1"),
    /subscription unavailable/u,
  );
  assert.deepEqual(finishedTurns, [["session-1", "abandoned"]]);
  await observer.close();
});

test("abandons a watched Turn when the Session is removed", async () => {
  const events = new AsyncFrameQueue();
  const finishedTurns: Array<[string, "completed" | "abandoned"]> = [];
  let closeCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          closeCount += 1;
          events.end();
        },
      }),
    },
    emitSessionsChanged() {},
    onWatchedTurnFinished: (sessionId, outcome) => {
      finishedTurns.push([sessionId, outcome]);
    },
  });

  await observer.watchTurn("session-1", "turn-1");
  events.push({
    kind: "subscription.closed",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    reason: "session_removed",
  });

  await waitFor(() => closeCount === 1);
  assert.deepEqual(finishedTurns, [["session-1", "abandoned"]]);
  await observer.close();
});

test("reopens an evicted active subscription without a renderer resubscribe", async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const sessionChanges: Array<{ reason: string; sessionId: string }> = [];
  let openCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        openCount += 1;
        const events = openCount === 1 ? firstEvents : secondEvents;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          activeAssistantStreams:
            openCount === 1 ? [] : [activeText('message-1')],
          transcript: Promise.resolve(
            openCount === 1
              ? []
              : [
                  {
                    type: "assistant" as const,
                    id: "message-1",
                    turnId: "turn-1",
                    ts: 10,
                    text: "Hello",
                    modelId: "test-model",
                  },
                ],
          ),
          events,
          async close() {
            events.end();
          },
        });
      },
    },
    emitSessionsChanged: (reason, sessionId) =>
      sessionChanges.push({ reason, sessionId }),
  });
  const target = eventTarget(12);
  await observer.observe("session-1", "observer-1", target);

  firstEvents.push(deltaFrame(1, 0, "Hel"));
  firstEvents.push({
    kind: "subscription.closed",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 2,
    reason: "slow_consumer",
  });
  await waitFor(() => openCount === 2 && target.events.length === 2);

  secondEvents.push(deltaFrame(1, 5, " world"));
  await waitFor(() => target.events.length === 3);
  assert.deepEqual(
    target.events.map((event) => [
      event.type,
      "text" in event ? event.text : undefined,
      "startOffset" in event ? event.startOffset : undefined,
    ]),
    [
      ["text_delta", "Hel", 0],
      ["text_delta", "Hello", 0],
      ["text_delta", " world", 5],
    ],
  );
  assert.equal(target.events.some((event) => event.type === "error"), false);
  assert.ok(
    sessionChanges.some(
      (change) =>
        change.reason === "message-appended" &&
        change.sessionId === "session-1",
    ),
  );

  await observer.unobserve("observer-1");
  await observer.close();
});

test('does not activate a refresh candidate that fails during commit preparation', async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const activation = deferred<() => void>();
  const accepted: SubscriptionFrame[] = [];
  let opens = 0;
  let preparations = 0;
  let activated = false;
  let firstCloses = 0;
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () => {
        opens += 1;
        const first = opens === 1;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          transcript: Promise.resolve([]),
          events: first ? firstEvents : secondEvents,
          async close() {
            if (first) firstCloses += 1;
            (first ? firstEvents : secondEvents).end();
          },
        });
      },
    },
    sessionId: 'session-1',
    now: () => 0,
    async prepareActivation() {
      preparations += 1;
      if (preparations === 1) return () => undefined;
      return activation.promise;
    },
    acceptFrame: (frame) => {
      accepted.push(frame);
    },
    recoveryStarted() {},
    recoveryCompleted() {},
    recoveryFailed() {},
    terminalFailure(error) {
      throw error;
    },
  });
  owner.start();
  await owner.waitUntilReady();

  const refresh = owner.refresh();
  await waitFor(() => preparations === 2);
  secondEvents.push({
    kind: 'subscription.closed',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-2',
    sequence: 1,
    reason: 'slow_consumer',
  });
  await assert.rejects(refresh, /slow consumer/);
  activation.resolve(() => {
    activated = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(activated, false);
  assert.equal(firstCloses, 0);
  firstEvents.push(deltaFrame(1, 0, 'still live'));
  await waitFor(() => accepted.length === 1);
  await owner.close();
});

test('lets an active recovery supersede a concurrent cold refresh', async () => {
  const firstEvents = new AsyncFrameQueue();
  const candidateEvents = new AsyncFrameQueue();
  const recoveredEvents = new AsyncFrameQueue();
  const candidateTranscript = deferred<StoredMessage[]>();
  const accepted: SubscriptionFrame[] = [];
  let preparationBytes = 0;
  let sawCandidateBytes = false;
  let opens = 0;
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () => {
        opens += 1;
        const events =
          opens === 1 ? firstEvents : opens === 2 ? candidateEvents : recoveredEvents;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          transcript: opens === 2 ? candidateTranscript.promise : Promise.resolve([]),
          events,
          async close() {
            events.end();
          },
        });
      },
    },
    sessionId: 'session-1',
    now: () => 0,
    transcriptReplicaOptions: {
      accountPreparationBytes(deltaBytes) {
        preparationBytes += deltaBytes;
        if (preparationBytes > 0) sawCandidateBytes = true;
      },
    },
    async prepareActivation() {
      return () => undefined;
    },
    acceptFrame: (frame) => {
      accepted.push(frame);
    },
    recoveryStarted() {},
    recoveryCompleted() {},
    recoveryFailed() {},
    terminalFailure(error) {
      throw error;
    },
  });
  owner.start();
  await owner.waitUntilReady();

  const refresh = owner.refresh();
  await waitFor(() => opens === 2);
  firstEvents.push({
    kind: 'subscription.closed',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    reason: 'slow_consumer',
  });
  await refresh;

  assert.equal(opens, 3);
  candidateTranscript.resolve([
    {
      type: 'assistant',
      id: 'candidate-message',
      turnId: 'candidate-turn',
      ts: 1,
      text: 'late candidate',
      modelId: 'test-model',
    },
  ]);
  await waitFor(() => sawCandidateBytes && preparationBytes === 0);
  recoveredEvents.push(deltaFrame(1, 0, 'recovered'));
  await waitFor(() => accepted.length === 1);
  await owner.close();
});

test("retries an initial subscription closed before commit and resyncs once", async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const firstTranscript = deferred<StoredMessage[]>();
  const secondTranscript = deferred<StoredMessage[]>();
  const recoveredSessions: string[] = [];
  let openCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        openCount += 1;
        const first = openCount === 1;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          activeAssistantStreams: [],
          transcript: first ? firstTranscript.promise : secondTranscript.promise,
          events: first ? firstEvents : secondEvents,
          async close() {
            (first ? firstEvents : secondEvents).end();
          },
        });
      },
    },
    emitSessionsChanged() {},
    emitSubscriptionRecovered: (sessionId) => {
      recoveredSessions.push(sessionId);
    },
  });
  let observingSettled = false;
  const observing = observer.observe("session-1", "observer-1", eventTarget(16));
  void observing.then(
    () => {
      observingSettled = true;
    },
    () => {
      observingSettled = true;
    },
  );
  firstEvents.push({
    kind: "subscription.closed",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    reason: "slow_consumer",
  });
  firstTranscript.resolve([]);
  await waitFor(() => openCount === 2);
  assert.equal(observingSettled, false);
  assert.deepEqual(recoveredSessions, []);

  secondTranscript.resolve([]);
  await observing;
  assert.deepEqual(recoveredSessions, ["session-1"]);
  await observer.close();
});

test("finishes a watched predecessor after initial catch-up recovery", async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const firstTranscript = deferred<StoredMessage[]>();
  const finishedTurns: Array<[string, "completed" | "abandoned"]> = [];
  let openCount = 0;
  let replacementCloseCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        openCount += 1;
        if (openCount === 1) {
          return runtimeHostSessionFixture({
            snapshot: continuitySnapshot(),
            activeAssistantStreams: [],
            transcript: firstTranscript.promise,
            events: firstEvents,
            async close() {
              firstEvents.end();
            },
          });
        }
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot({
            projectionRevision: 2,
            rootTurn: {
              sessionId: "session-1",
              turnId: "turn-2",
              runId: "run-2",
              status: "running",
            },
          }),
          activeAssistantStreams: [],
          transcript: Promise.resolve([
            {
              type: "turn_state" as const,
              id: "terminal-1",
              turnId: "turn-1",
              ts: 20,
              status: "completed" as const,
              partialOutputRetained: true,
            },
          ]),
          events: secondEvents,
          async close() {
            replacementCloseCount += 1;
            secondEvents.end();
          },
        });
      },
    },
    emitSessionsChanged() {},
    onWatchedTurnFinished: (sessionId, outcome) => {
      finishedTurns.push([sessionId, outcome]);
    },
  });
  const watching = observer.watchTurn("session-1", "turn-1");
  firstEvents.push({
    kind: "subscription.closed",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    reason: "slow_consumer",
  });
  firstTranscript.resolve([]);
  await watching;
  await waitFor(() => replacementCloseCount === 1);

  assert.deepEqual(finishedTurns, [["session-1", "completed"]]);
  await observer.close();
});

test("keeps a joining observer pending across repeated catch-up eviction", async () => {
  const firstEvents = new AsyncFrameQueue();
  const replacementEvents = new AsyncFrameQueue();
  const finalEvents = new AsyncFrameQueue();
  const replacementTranscript = deferred<StoredMessage[]>();
  const finalTranscript = deferred<StoredMessage[]>();
  let openCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        openCount += 1;
        if (openCount === 1) {
          return runtimeHostSessionFixture({
            snapshot: continuitySnapshot(),
            activeAssistantStreams: [],
            transcript: Promise.resolve([]),
            events: firstEvents,
            async close() {
              firstEvents.end();
            },
          });
        }
        if (openCount === 2) {
          return runtimeHostSessionFixture({
            snapshot: continuitySnapshot(),
            activeAssistantStreams: [],
            transcript: replacementTranscript.promise,
            events: replacementEvents,
            async close() {
              replacementEvents.end();
            },
          });
        }
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          activeAssistantStreams: [activeText('message-1')],
          transcript: finalTranscript.promise,
          events: finalEvents,
          async close() {
            finalEvents.end();
          },
        });
      },
    },
    emitSessionsChanged() {},
  });
  const firstTarget = eventTarget(13);
  const joiningTarget = eventTarget(14);
  await observer.observe("session-1", "observer-1", firstTarget);

  firstEvents.push({
    kind: "subscription.closed",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    reason: "slow_consumer",
  });
  await waitFor(() => openCount === 2);

  const joining = observer.observe(
    "session-1",
    "observer-2",
    joiningTarget,
  );
  let joiningSettled = false;
  void joining.then(
    () => {
      joiningSettled = true;
    },
    () => {
      joiningSettled = true;
    },
  );
  replacementEvents.push({
    kind: "subscription.closed",
    hostEpoch: "host-1",
    subscriptionId: "subscription-2",
    sequence: 1,
    reason: "slow_consumer",
  });
  replacementTranscript.resolve([]);
  await waitFor(() => openCount === 3);
  await Promise.resolve();
  assert.equal(joiningSettled, false);
  finalTranscript.resolve([
    {
      type: "assistant" as const,
      id: "message-1",
      turnId: "turn-1",
      ts: 10,
      text: "Hello",
      modelId: "test-model",
    },
  ]);
  await joining;

  assert.equal(firstTarget.events.some((event) => event.type === "error"), false);
  assert.equal(joiningTarget.events.some((event) => event.type === "error"), false);
  assert.deepEqual(
    joiningTarget.events.map((event) =>
      event.type === "text_delta" ? event.text : event.type,
    ),
    ["Hello"],
  );
  await observer.close();
});

test("reconciles terminal, Goal, interaction, and sidecar state after subscription recovery", async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const finishedTurns: Array<[string, "completed" | "abandoned"]> = [];
  const interactionSnapshots: Array<readonly { requestId: string }[]> = [];
  const recoveredSessions: string[] = [];
  const seedTimeline: string[] = [];
  const sessionChanges: string[] = [];
  const firstInteraction = pendingQuestion("interaction-1", "turn-1", "run-1");
  const secondInteraction = pendingQuestion("interaction-2", "turn-2", "run-2");
  let openCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      listSessionTurns: async () => [{
        turnId: 'turn-1',
        status: 'completed' as const,
        statusSource: 'recorded' as const,
        partialOutputRetained: true,
      }],
      openSession: async () => {
        openCount += 1;
        if (openCount === 1) {
          return runtimeHostSessionFixture({
            snapshot: continuitySnapshot({
              interactions: { pending: [firstInteraction] },
            }),
            activeAssistantStreams: [],
            transcript: Promise.resolve([]),
            events: firstEvents,
            async close() {
              firstEvents.end();
            },
          });
        }
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot({
            projectionRevision: 3,
            goal: activeGoal(),
            rootTurn: {
              sessionId: "session-1",
              turnId: "turn-2",
              runId: "run-2",
              status: "running",
            },
            interactions: { pending: [secondInteraction] },
          }),
          activeAssistantStreams: [activeText('message-2', 'turn-2')],
          transcript: Promise.resolve([
            {
              type: "assistant" as const,
              id: "message-2",
              turnId: "turn-2",
              ts: 30,
              text: "Second answer",
              modelId: "test-model",
            },
          ]),
          events: secondEvents,
          async close() {
            secondEvents.end();
          },
        });
      },
    },
    emitSessionsChanged(reason) {
      sessionChanges.push(reason);
    },
    onWatchedTurnFinished: (sessionId, outcome) => {
      finishedTurns.push([sessionId, outcome]);
    },
    emitActiveInteractionsChanged: (_sessionId, interactions) => {
      interactionSnapshots.push(interactions);
    },
    emitSubscriptionRecovered: (sessionId) => {
      recoveredSessions.push(sessionId);
    },
    emitObservationSeed: (sessionId, phase) => {
      seedTimeline.push(`${phase}:${sessionId}`);
    },
    now: () => 50,
  });
  const target = eventTarget(15);
  const originalSend = target.send.bind(target);
  target.send = (channel, event) => {
    seedTimeline.push(`event:${event.type}`);
    originalSend(channel, event);
  };
  await observer.observe("session-1", "observer-1", target);
  await observer.watchTurn("session-1", "turn-1");

  firstEvents.push({
    kind: "subscription.closed",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    reason: "slow_consumer",
  });
  await waitFor(() => recoveredSessions.length === 1);

  assert.deepEqual(finishedTurns, [["session-1", "completed"]]);
  assert.deepEqual(recoveredSessions, ["session-1"]);
  const pendingAt = seedTimeline.indexOf("pending:session-1");
  const readyAt = seedTimeline.indexOf("ready:session-1");
  assert.ok(pendingAt >= 0);
  assert.ok(readyAt > pendingAt);
  assert.ok(
    seedTimeline.slice(pendingAt + 1, readyAt).some((entry) => entry.startsWith("event:")),
  );
  assert.ok(sessionChanges.includes("goal-change"));
  assert.deepEqual(
    interactionSnapshots.at(-1)?.map((interaction) => interaction.requestId),
    ["interaction-2"],
  );
  assert.ok(
    target.events.some(
      (event) => event.type === "complete" && event.turnId === "turn-1",
    ),
  );
  assert.ok(
    target.events.some(
      (event) =>
        event.type === "text_delta" &&
        event.turnId === "turn-2" &&
        event.text === "Second answer",
    ),
  );
  assert.ok(
    target.events.some(
      (event) =>
        event.type === "user_question_request" && event.requestId === "interaction-2",
    ),
  );
  await observer.close();
});

test("shares one Host subscription and one delivery per renderer target", async () => {
  const events = new AsyncFrameQueue();
  let openCount = 0;
  let closeCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        openCount += 1;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          activeAssistantStreams: [],
          transcript: Promise.resolve([]),
          events,
          async close() {
            closeCount += 1;
            events.end();
          },
        });
      },
    },
    emitSessionsChanged() {},
  });
  const target = eventTarget(7);

  await Promise.all([
    observer.observe("session-1", "observer-1", target),
    observer.observe("session-1", "observer-2", target),
  ]);
  events.push(deltaFrame(1, 0, "one"));
  await waitFor(() => target.events.length === 1);

  assert.equal(openCount, 1);
  assert.equal(target.events.length, 1);
  await observer.unobserve("observer-1");
  assert.equal(closeCount, 0);
  await observer.unobserve("observer-2");
  assert.equal(closeCount, 1);
});

test("releases the renderer destroyed listener when its last observer leaves", async () => {
  const events = new AsyncFrameQueue();
  const destroyed = new EventEmitter();
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          events.end();
        },
      }),
    },
    emitSessionsChanged() {},
  });
  const target: RuntimeHostSessionObserverTarget = {
    id: 10,
    send() {},
    once: (event, listener) => destroyed.once(event, listener),
    off: (event, listener) => destroyed.off(event, listener),
  };

  await observer.observe("session-1", "observer-1", target);
  assert.equal(destroyed.listenerCount("destroyed"), 1);
  await observer.unobserve("observer-1");
  assert.equal(destroyed.listenerCount("destroyed"), 0);
});

test("closes a Host handle that arrives after the observer is closed", async () => {
  const opened = deferred<DesktopRuntimeHostSession>();
  let closeCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: { openSession: () => opened.promise },
    emitSessionsChanged() {},
  });
  const observing = observer.observe("session-1", "observer-1", eventTarget(8));

  await observer.close();
  opened.resolve(runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    activeAssistantStreams: [],
    transcript: Promise.resolve([]),
    events: new AsyncFrameQueue(),
    async close() {
      closeCount += 1;
    },
  }));

  await assert.rejects(observing, /closed while opening/);
  assert.equal(closeCount, 1);
});

test("rehydrates pending interactions and publishes answer acknowledgements", async () => {
  const pending = {
    schemaVersion: 1 as const,
    interactionId: "interaction-1",
    sessionId: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    revision: 1 as const,
    status: "pending" as const,
    outcome: null,
    request: {
      kind: "question" as const,
      toolUseId: "tool-1",
      questions: [
        {
          question: "Proceed?",
          options: [{ label: "Yes", description: "Continue." }],
        },
      ],
    },
  };
  const events = new AsyncFrameQueue();
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
          snapshot: continuitySnapshot({
            interactions: { pending: [pending] },
          }),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          events.end();
        },
      }),
    },
    emitSessionsChanged() {},
    now: () => 75,
  });
  const target = eventTarget(2);
  await observer.observe("session-1", "observer-1", target);

  assert.deepEqual(
    await observer.readActiveInteractions("session-1"),
    target.events,
  );
  observer.publishInteractionAnswer(
    {
      ...pending,
      revision: 2,
      status: "answered",
      outcome: { kind: "question_answer", answers: ["Yes"], committedAt: 75 },
    },
    pending,
  );

  assert.equal(target.events.at(-1)?.type, "user_question_answer_ack");
  await observer.close();
});

test("projects Host queue revisions and newly delivered steering messages", async () => {
  const events = new AsyncFrameQueue();
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          events.end();
        },
      }),
    },
    emitSessionsChanged() {},
    now: () => 90,
  });
  const target = eventTarget(3);
  await observer.observe("session-1", "observer-1", target);
  const queued = {
    entryId: "entry-1",
    messageId: "message-steer",
    content: { text: "Change direction" },
    placement: "current_turn" as const,
    state: "queued" as const,
  };

  events.push({
    kind: "subscription.session_projection",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    snapshot: continuitySnapshot({
      projectionRevision: 2,
      queue: {
        hostEpoch: "host-1",
        queueRevision: 1,
        steering: [queued],
        followup: [],
      },
    }),
  });
  await waitFor(() => target.events.length === 1);
  events.push({
    kind: "subscription.session_projection",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 2,
    snapshot: continuitySnapshot({
      projectionRevision: 3,
      queue: {
        hostEpoch: "host-1",
        queueRevision: 2,
        steering: [{ ...queued, state: "in_flight" }],
        followup: [],
      },
    }),
  });
  await waitFor(() => target.events.length === 3);

  assert.deepEqual(
    target.events.map((event) => event.type),
    ["queue_update", "steering_message", "queue_update"],
  );
  assert.deepEqual(target.events[1], {
    type: "steering_message",
    id: "host-queue:host-1:2:entry-1",
    turnId: "turn-1",
    messageId: "message-steer",
    ts: 90,
    content: { text: "Change direction" },
  });
  await observer.close();
});

test("publishes Host sidecar and graph invalidations without inventing Session status changes", async () => {
  const events = new AsyncFrameQueue();
  const sessionChanges: Array<{ reason: string; sessionId: string }> = [];
  const domainChanges: Array<{ sessionId: string; domain: string }> = [];
  const ptyData: unknown[] = [];
  const graphChanges: unknown[] = [];
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(),
        activeAssistantStreams: [],
        transcript: Promise.resolve([]),
        events,
        async close() {
          events.end();
        },
      }),
    },
    emitSessionsChanged: (reason, sessionId) =>
      sessionChanges.push({ reason, sessionId }),
    emitSessionDomainChanged: (change) => domainChanges.push(change),
    emitRuntimeResourcePtyData: (event) => ptyData.push(event),
    emitAgentGraphChanged: (event) => graphChanges.push(event),
  });
  await observer.observe("session-1", "observer-1", eventTarget(11));

  events.push({
    kind: "subscription.session_projection",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    snapshot: continuitySnapshot({
      projectionRevision: 2,
      goal: {
        goalId: "goal-1",
        revision: 1,
        sessionId: "session-1",
        condition: "Finish the adapter",
        status: "active",
        setAt: 1,
        iterations: 0,
        maxIterations: 20,
        consecutiveNoProgress: 0,
        blockCap: 8,
        tokenBudget: null,
        tokensSpent: 0,
        lastReason: null,
        achievedAt: null,
        pausedAt: null,
      },
    }),
  });
  events.push({
    kind: "subscription.session_domain_changed",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 2,
    sessionId: "session-1",
    domain: "plan",
  });
  events.push({
    kind: "subscription.runtime_resource_pty_data",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 3,
    sessionId: "session-1",
    ref: "maka://runtime/background-tasks/shell-1",
    ptySequence: 7,
    data: "ready",
  });
  events.push({
    kind: "subscription.agent_graph_changed",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 4,
    rootSessionId: "session-1",
    graphId: "graph-1",
    reason: "runtime_activity",
  });
  await waitFor(() => graphChanges.length === 1);

  assert.deepEqual(domainChanges, [{ sessionId: "session-1", domain: "plan" }]);
  assert.deepEqual(ptyData, [{
    sessionId: "session-1",
    ref: "maka://runtime/background-tasks/shell-1",
    sequence: 7,
    data: "ready",
  }]);
  assert.ok(
    sessionChanges.some(
      (change) =>
        change.reason === "goal-change" && change.sessionId === "session-1",
    ),
  );
  assert.deepEqual(graphChanges, [
    {
      schemaVersion: 1,
      rootSessionId: "session-1",
      graphId: "graph-1",
      reason: "runtime_activity",
    },
  ]);
  await observer.close();
});

function continuitySnapshot(
  overrides: Partial<SessionContinuitySnapshot> = {},
): SessionContinuitySnapshot {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: "session-1",
      metadataRevision: 1,
      status: "running",
      createdAt: 1,
      lastUsedAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: {
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
      status: "running",
    },
    goal: null,
    queue: {
      hostEpoch: "host-1",
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: { pending: [] },
    ...overrides,
  };
}

function activeText(messageId: string, turnId = 'turn-1') {
  return { kind: 'text' as const, turnId, messageId };
}

function activeGoal() {
  return {
    goalId: "goal-1",
    revision: 1,
    sessionId: "session-1",
    condition: "Finish the recovery",
    status: "active" as const,
    setAt: 1,
    iterations: 0,
    maxIterations: 20,
    consecutiveNoProgress: 0,
    blockCap: 8,
    tokenBudget: null,
    tokensSpent: 0,
    lastReason: null,
    achievedAt: null,
    pausedAt: null,
  };
}

function deltaFrame(
  sequence: number,
  startOffset: number,
  text: string,
): SubscriptionFrame {
  return {
    kind: "subscription.session_delta",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence,
    sessionId: "session-1",
    delta: {
      kind: "text",
      turnId: "turn-1",
      runId: "run-1",
      messageId: "message-1",
      startOffset,
      text,
    },
  };
}

function pendingQuestion(interactionId: string, turnId: string, runId: string) {
  return {
    schemaVersion: 1 as const,
    interactionId,
    sessionId: "session-1",
    turnId,
    runId,
    revision: 1 as const,
    status: "pending" as const,
    outcome: null,
    request: {
      kind: "question" as const,
      toolUseId: `tool-${interactionId}`,
      questions: [
        {
          question: "Proceed?",
          options: [{ label: "Yes", description: "Continue." }],
        },
      ],
    },
  };
}

function eventTarget(
  id: number,
): RuntimeHostSessionObserverTarget & { events: SessionEvent[] } {
  const events: SessionEvent[] = [];
  return {
    id,
    events,
    send(_channel, event) {
      events.push(event);
    },
    once() {},
    off() {},
  };
}

class AsyncFrameQueue implements AsyncIterable<SubscriptionFrame> {
  readonly #frames: SubscriptionFrame[] = [];
  readonly #waiters: Array<
    (result: IteratorResult<SubscriptionFrame>) => void
  > = [];
  nextCount = 0;
  #ended = false;

  push(frame: SubscriptionFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: frame, done: false });
    else this.#frames.push(frame);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return {
      next: () => {
        this.nextCount += 1;
        const frame = this.#frames.shift();
        if (frame) return Promise.resolve({ value: frame, done: false });
        if (this.#ended)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, rejectPromise) => {
    resolve = settle;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for observer state");
}
