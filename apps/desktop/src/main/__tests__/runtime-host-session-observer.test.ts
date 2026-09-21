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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { SessionEvent } from '@maka/core/events';
import type { SessionObservationMessage } from '../../shared/session-execution-projection.js';
import type { StoredMessage } from '@maka/core/session';
import {
  type SessionContinuitySnapshot,
  type SessionTranscriptPage,
  type SubscriptionFrame,
} from "@maka/runtime-host/protocol";
import {
  RuntimeHostOperationError,
  RuntimeHostSubscriptionError,
} from "@maka/runtime-host/client";
import type { DesktopRuntimeHostSession } from "../runtime-host-client.js";
import {
  DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  type DesktopTranscriptBatch,
  type DesktopTranscriptOpenResult,
} from '../../preload/transcript-contract.js';
import { RuntimeHostSessionObservationRegistry } from "../runtime-host-session-observation-registry.js";
import {
  RuntimeHostSessionObserver,
  type RuntimeHostRendererTarget,
  type RuntimeHostSessionObserverTarget,
  type RuntimeHostTranscriptTarget,
} from "../runtime-host-session-observer.js";
import { RuntimeHostSessionSubscriptionOwner } from '../runtime-host-session-subscription-owner.js';
import {
  AsyncFrameQueue,
  continuitySnapshot,
  runtimeHostSessionFixture,
  transcriptPage,
} from "./runtime-host-session-test-fixture.js";
import { waitFor as pollFor } from '@maka/core/test-only/async-primitives';

test('projects root lifecycle without fabricating content events', async (t) => {
  const events = new AsyncFrameQueue();
  const observer = new RuntimeHostSessionObserver({
    client: { openSession: async () => runtimeHostSessionFixture({
      snapshot: continuitySnapshot({ rootTurn: null }),
      events, async close() { events.end(); },
    }) },
    emitSessionsChanged() {},
  });
  const messages: Parameters<RuntimeHostSessionObserverTarget['send']>[1][] = [];
  t.after(() => observer.close());
  await observer.observe('session-1', 'execution-observer', {
    id: 99, send(_channel, message) { messages.push(message); }, once() {}, off() {},
  });
  assert.ok(messages.length > 0);
  assert.equal(messages.length, 1);
  const seed = messages[0];
  assert.equal(seed?.type, 'host_observation_seed');
  if (seed?.type === 'host_observation_seed') {
    assert.deepEqual(seed.observerIds, ['execution-observer']);
    assert.equal(seed.execution.rootTurn, null);
    assert.deepEqual(seed.events, []);
  }
  const seededCount = messages.length;
  events.push({
    kind: 'subscription.session_projection', hostEpoch: 'host-1', subscriptionId: 'subscription-1', sequence: 1,
    snapshot: continuitySnapshot({ projectionRevision: 2 }),
  });
  await waitFor(() => messages.length > seededCount);
  const started = messages.at(-1);
  assert.equal(started?.type, 'host_execution');
  if (started?.type === 'host_execution') {
    assert.equal(started.rootTurn?.turnId, 'turn-1');
    assert.equal(started.rootTurn?.status, 'running');
    assert.equal(started.available, true);
  }
  await observer.close();
});

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
      mode?: string,
    ) {
      opens.push(`${generation}:${sessionId}:${consumerId}:${mode}`);
      consumer.send(`sessions:transcript:${consumerId}`, {
        deliverySequence: 1,
        sessionId,
        generation,
        hostEpoch: `host-${generation}`,
        durableThrough: null,
        fragments: [],
        hasOlder: false,
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
    async loadEarlierTranscript() {},
    async readTranscriptTurn() { return []; },
    acknowledgeTranscriptTail() {},
    async closeTranscript() {},
  });
  const first = source('first');
  await observations.attach(first, bind('first'));
  await observations.openTranscript('session-1', 'consumer-1', target, 'history');
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
    'first:session-1:consumer-1:history',
    'second:session-1:consumer-1:history',
    'third:session-1:consumer-2:tail',
  ]);
  assert.deepEqual(
    batches.map((batch) => batch.generation),
    ['first', 'second', 'third'],
  );
  assert.deepEqual(scopes, ['first', 'second', 'third']);
  await observations.close();
});

test('does not hold Host observation recovery on transcript replay', async () => {
  const observations = new RuntimeHostSessionObservationRegistry();
  const target = eventTarget(18);
  const transcriptTarget: RuntimeHostTranscriptTarget = {
    id: 19,
    send() {},
    once() {},
    off() {},
  };
  const transcriptResult = (generation: string) => ({
    sessionId: 'session-1',
    generation,
    hostEpoch: `host-${generation}`,
    readThroughMessageId: null,
  });
  const source = (generation: string) => ({
    async observe() {},
    async unobserve() {},
    async openTranscript() {
      return transcriptResult(generation);
    },
    async loadEarlierTranscript() {},
    async readTranscriptTurn() { return []; },
    acknowledgeTranscriptTail() {},
    async closeTranscript() {},
  });
  const first = source('first');
  await observations.attach(first);
  await observations.observe('session-1', 'observer-1', target);
  await observations.openTranscript('session-1', 'consumer-1', transcriptTarget);
  observations.detach(first);

  const observationSeed = deferred<void>();
  const transcriptReplay = deferred<DesktopTranscriptOpenResult>();
  let transcriptReplayStarted = false;
  let transcriptReplayCompleted = false;
  let transcriptEarlierStarted = false;
  let transcriptAcknowledged = false;
  const replacement = {
    async observe() {
      await observationSeed.promise;
    },
    async unobserve() {},
    async openTranscript() {
      transcriptReplayStarted = true;
      const result = await transcriptReplay.promise;
      transcriptReplayCompleted = true;
      return result;
    },
    async loadEarlierTranscript() {
      transcriptEarlierStarted = true;
    },
    async readTranscriptTurn() { return []; },
    acknowledgeTranscriptTail() {},
    acknowledgeTranscript() {
      transcriptAcknowledged = true;
    },
    async closeTranscript() {},
  };
  const attaching = observations.attach(replacement);
  let attached = false;
  void attaching.then(() => {
    attached = true;
  });
  await waitFor(() => transcriptReplayStarted);
  assert.equal(attached, false);

  observationSeed.resolve();
  assert.deepEqual(await attaching, ['session-1']);
  assert.equal(attached, true);

  const earlier = observations.loadEarlierTranscript('consumer-1', transcriptTarget.id);
  observations.acknowledgeTranscript('consumer-1', 'second', 1, transcriptTarget.id);
  await Promise.resolve();
  assert.equal(transcriptEarlierStarted, false);
  assert.equal(transcriptAcknowledged, true);

  transcriptReplay.resolve(transcriptResult('second'));
  await earlier;
  assert.equal(transcriptEarlierStarted, true);
  await waitFor(() => transcriptReplayCompleted);
  await observations.close();
});

test('fences earlier transcript failures to the current registration and Host source', async () => {
  const observations = new RuntimeHostSessionObservationRegistry();
  const target: RuntimeHostTranscriptTarget = {
    id: 19,
    send() {},
    once() {},
    off() {},
  };
  const source = (
    generation: string,
    loadEarlierTranscript: () => Promise<void>,
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
    loadEarlierTranscript,
    async readTranscriptTurn() { return []; },
    acknowledgeTranscriptTail() {},
    async closeTranscript() {},
  });

  const closedFailure = deferred<void>();
  const first = source('first', () => closedFailure.promise);
  await observations.attach(first);
  await observations.openTranscript('session-1', 'consumer-closed', target, 'history');
  const closedRead = observations.loadEarlierTranscript('consumer-closed', target.id);
  await observations.closeTranscript('consumer-closed', target.id);
  closedFailure.reject(new Error('closed source rejected its read'));
  await assert.doesNotReject(closedRead);
  observations.detach(first);

  const replacedFailure = deferred<void>();
  const second = source('second', () => replacedFailure.promise);
  await observations.attach(second);
  await observations.openTranscript('session-1', 'consumer-replaced', target, 'history');
  const replacedRead = observations.loadEarlierTranscript('consumer-replaced', target.id);
  observations.detach(second);

  const currentFailure = new Error('current source failed its read');
  const third = source('third', async () => {
    throw currentFailure;
  });
  await observations.attach(third);
  replacedFailure.reject(new Error('replaced source rejected its read'));
  await assert.doesNotReject(replacedRead);
  await assert.rejects(
    observations.loadEarlierTranscript('consumer-replaced', target.id),
    (error) => error === currentFailure,
  );
  await observations.close();
});

test('fences earlier transcript failures across same-source replica recovery', async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const staleRead = deferred<SessionTranscriptPage>();
  const currentFailure = new Error('current replica failed its read');
  let opens = 0;
  let staleReadStarted = false;
  let currentReadStarted = false;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        opens += 1;
        const first = opens === 1;
        const events = first ? firstEvents : secondEvents;
        // One row per page, each its own Turn. The recovery reset reads back down
        // to the row the consumer was last given (cursor '4'); cursor '3' is
        // reached only by a later load earlier.
        const host = historyHost([0, 1, 2, 3, 4].map((index) => turnRow(index, `turn-${index}`)), { pageRows: 1 });
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: host.bootstrap,
          decodeTranscriptPage: host.decodeTranscriptPage,
          loadTranscriptPage: async (input) => {
            if (first) {
              if (input.cursor !== '3') return host.loadTranscriptPage(input);
              staleReadStarted = true;
              return staleRead.promise;
            }
            if (input.cursor !== '3') return host.loadTranscriptPage(input);
            currentReadStarted = true;
            throw currentFailure;
          },
          async close() {
            events.end();
          },
        });
      },
    },
    emitSessionsChanged() {},
    transcriptHistoryBytes: 1,
  });
  const observations = new RuntimeHostSessionObservationRegistry();
  const batches: DesktopTranscriptBatch[] = [];
  const consumerId = 'consumer-replica-recovery';
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
  const opened = await observations.openTranscript('session-1', consumerId, target, 'history');
  // One answer deeper, so the recovery reset has more than the bootstrap page to walk back down.
  await observations.loadEarlierTranscript(consumerId, target.id);
  const staleLoad = observations.loadEarlierTranscript(consumerId, target.id);
  await waitFor(() => staleReadStarted);

  firstEvents.push({
    kind: 'subscription.closed',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sequence: 1,
    reason: 'slow_consumer',
  });
  await waitFor(() => opens === 2);
  staleRead.reject(new Error('stale replica rejected its read'));
  await assert.doesNotReject(staleLoad);
  // Recovery resets the consumer onto the replacement replica; the abandoned read is not replayed.
  await waitFor(() => batches.some((batch) => batch.ready && batch.generation !== opened.generation));
  assert.equal(currentReadStarted, false);

  await assert.rejects(
    observations.loadEarlierTranscript(consumerId, target.id),
    (error) => error === currentFailure,
  );
  assert.equal(currentReadStarted, true);
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

test('broadcasts durable admission and transcript changes from the same message', async () => {
  const events = new AsyncFrameQueue();
  const markers: string[] = [];
  const message: StoredMessage = {
    type: 'user',
    id: 'ticket-1',
    turnId: 'turn-1',
    ts: 2,
    text: 'Continue here',
  };
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          loadTranscriptPage: async () => ({
            kind: 'page',
            sessionId: 'session-1',
            direction: 'newer',
            throughSequence: 0,
            rawBytes: 1,
            fragments: [],
            nextCursor: null,
            endsAtTurnBoundary: true,
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
  const eventConsumer = eventTarget(21);
  await observer.observe('session-1', 'observer-1', eventConsumer, true);
  const transcriptBatches: DesktopTranscriptBatch[][] = [[], []];
  for (const [index, batches] of transcriptBatches.entries()) {
    const consumerId = `consumer-${index}`;
    await observer.openTranscript('session-1', consumerId, {
      id: 19 + index,
      send(_channel, batch) {
        batches.push(batch);
        queueMicrotask(() => {
          observer.acknowledgeTranscript(
            consumerId,
            batch.generation,
            batch.deliverySequence!,
            19 + index,
          );
          // Stand in for a Renderer window that installs what it is sent.
          if (batch.ready && batch.durableThrough !== null) {
            observer.acknowledgeTranscriptTail(
              {
                consumerId,
                sessionId: 'session-1',
                hostEpoch: batch.hostEpoch,
                through: batch.durableThrough,
              },
              19 + index,
            );
          }
        });
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
    markers.length > 0 && transcriptBatches.every((batches) => batches.length > 0),
  );

  assert.deepEqual([...new Set(markers)], ['ticket-1']);
  assert.deepEqual(transcriptBatches[1], transcriptBatches[0]);
  assert.deepEqual(
    eventConsumer.events
      .filter((event) => event.type === 'message_admission')
      .map((event) => ({ turnId: event.turnId, messageId: event.messageId })),
    [{ turnId: 'turn-1', messageId: 'ticket-1' }],
  );
  await observer.close();
});

for (const resolution of ['owned', 'cancelled', 'not_admitted', 'pending', 'unavailable'] as const) {
  test(`proves a removed follow-up is ${resolution} before successor content`, async (t) => {
    const events = new AsyncFrameQueue();
    const queries: string[][] = [];
    const observer = new RuntimeHostSessionObserver({
      client: {
        openSession: async () => runtimeHostSessionFixture({
          snapshot: continuitySnapshot({
            queue: {
              hostEpoch: 'host-1', queueRevision: 1, steering: [],
              followup: [{
                entryId: 'entry-1', messageId: 'followup-1', content: { text: 'Next question' },
                placement: 'next_turn', state: 'queued',
              }],
            },
          }),
          events, async close() { events.end(); },
        }),
        queryMessageExecutions: async ({ messageIds }) => {
          queries.push([...messageIds]);
          if (resolution === 'unavailable') throw new Error('Host proof unavailable');
          return { resolutions: messageIds.map((messageId) => resolution === 'owned'
            ? { messageId, state: 'owned' as const, turnId: 'turn-2', runId: 'run-2' }
            : { messageId, state: resolution }) };
        },
      },
      emitSessionsChanged() {},
    });
    t.after(() => observer.close());
    const target = eventTarget(25);
    await observer.observe('session-1', 'observer-followup', target, true);
    target.events.splice(0);
    events.push({
      kind: 'subscription.session_projection', hostEpoch: 'host-1',
      subscriptionId: 'subscription-1', sequence: 1,
      snapshot: continuitySnapshot({
        projectionRevision: 2,
        rootTurn: { sessionId: 'session-1', turnId: 'turn-2', runId: 'run-2', status: 'running' },
        queue: { hostEpoch: 'host-1', queueRevision: 2, steering: [], followup: [] },
      }),
    });
    events.push({
      kind: 'subscription.session_delta', hostEpoch: 'host-1',
      subscriptionId: 'subscription-1', sessionId: 'session-1', sequence: 2,
      delta: { kind: 'text', turnId: 'turn-2', runId: 'run-2', messageId: 'answer-2', startOffset: 0, text: 'Next answer' },
    });
    await waitFor(() => target.events.some((event) => event.type === 'text_delta'));

    assert.deepEqual(queries, [['followup-1']]);
    const admissions = target.events.filter((event) => event.type === 'message_admission');
    assert.deepEqual(admissions.map((event) => ({
      messageId: event.messageId, turnId: event.turnId, outcome: event.outcome,
    })), resolution === 'owned' || resolution === 'cancelled' || resolution === 'not_admitted' ? [{
      messageId: 'followup-1', turnId: 'turn-2',
      outcome: resolution === 'owned' ? 'admitted' : 'retracted',
    }] : []);
    if (admissions.length > 0) {
      assert.ok(target.events.indexOf(admissions[0]!)
        < target.events.findIndex((event) => event.type === 'text_delta'));
    }
  });
}

test('moves the read marker only as far as the Renderer window reports reaching', async () => {
  const events = new AsyncFrameQueue();
  const markers: string[] = [];
  const rows: StoredMessage[] = [
    { type: 'assistant', id: 'answer-1', turnId: 'turn-1', ts: 1, text: 'One', modelId: 'test-model' },
    { type: 'assistant', id: 'answer-2', turnId: 'turn-2', ts: 2, text: 'Two', modelId: 'test-model' },
  ];
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          loadTranscriptPage: async (input) => ({
            kind: 'page',
            sessionId: 'session-1',
            direction: 'newer',
            throughSequence: input.throughSequence ?? null,
            rawBytes: 1,
            fragments: [],
            nextCursor: null,
            endsAtTurnBoundary: true,
          }),
          // One durable row per catch-up target; the bootstrap page carries none.
          decodeTranscriptPage: async (page) => {
            const identity = page.throughSequence;
            return identity === null
              ? { messages: [], nextCursor: null }
              : { messages: [{ identity, message: rows[identity]! }], nextCursor: null };
          },
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
  const batches: DesktopTranscriptBatch[] = [];
  const consumer: RuntimeHostTranscriptTarget = {
    id: 31,
    send(_channel, batch) {
      batches.push(batch);
      queueMicrotask(() =>
        observer.acknowledgeTranscript(
          'consumer-parked',
          batch.generation,
          batch.deliverySequence!,
          31,
        ),
      );
    },
    once() {},
    off() {},
  };
  const opened = await observer.openTranscript('session-1', 'consumer-parked', consumer);
  const acknowledgeTail = (through: number) =>
    observer.acknowledgeTranscriptTail(
      { consumerId: 'consumer-parked', sessionId: 'session-1', hostEpoch: opened.hostEpoch, through },
      31,
    );
  const advance = async (sequence: number, throughSequence: number) => {
    const delivered = batches.length;
    events.push({
      kind: 'subscription.transcript_advanced',
      hostEpoch: 'host-1',
      subscriptionId: 'subscription-1',
      sessionId: 'session-1',
      sequence,
      throughSequence,
    });
    await waitFor(() => batches.length > delivered);
  };

  await advance(1, 0);
  assert.deepEqual(markers, [], 'delivery alone is not proof the reader reached the tail');
  acknowledgeTail(0);
  assert.deepEqual(markers, ['answer-1']);

  // The reader is parked off the tail: the change is broadcast, but the window
  // it names never joins, so nothing acknowledges the new watermark.
  await advance(2, 1);
  acknowledgeTail(0);
  assert.deepEqual(markers, ['answer-1'], 'an unread Turn stays unread while the reader is parked');

  acknowledgeTail(1);
  assert.deepEqual(markers, ['answer-1', 'answer-2']);
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
          transcriptBootstrap: {
            durable: {
              kind: 'page',
              sessionId: 'session-1',
              direction: 'older',
              throughSequence: 0,
              rawBytes: 1,
              fragments: [],
              nextCursor: null,
              endsAtTurnBoundary: true,
            },
          },
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

test('finishes transcript open on the replacement replica after recovery', async () => {
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
          transcriptBootstrap: {
            durable: {
              kind: 'page',
              sessionId: 'session-1',
              direction: 'older',
              throughSequence: 0,
              rawBytes: 1,
              fragments: [],
              nextCursor: 'older',
              endsAtTurnBoundary: true,
            },
          },
          decodeTranscriptPage: async (page) => ({
            messages: page.rawBytes === 1 ? [{ identity: 0, message }] : [],
            nextCursor: page.nextCursor,
          }),
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
  const staleGeneration = batches[0]!.generation;
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
  assert.notEqual(opened.value?.generation, staleGeneration);
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
          events,
          loadTranscriptPage: async (input) => ({
            kind: 'page',
            sessionId: 'session-1',
            direction: 'newer',
            throughSequence: input.throughSequence,
            rawBytes: 1,
            fragments: [],
            nextCursor: null,
            endsAtTurnBoundary: true,
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
  assert.equal(batches[1]!.hasOlder, undefined);
  observer.acknowledgeTranscript(
    consumerId,
    batches[1]!.generation,
    batches[1]!.deliverySequence,
    22,
  );
  await observer.close();
});

test('delivers history in whole Turns within the budget and continues exactly on load earlier', async () => {
  const events = new AsyncFrameQueue();
  // Oldest first: a (3 rows), b (1 huge row), c (2 rows), d (1 huge row). The budget is one and a half
  // small rows and pages hold two rows, so Turns cross both the budget and the Host page edges.
  // Where a page leaves a Turn half-read the answer keeps going, so an answer ends only on a page
  // the Host marked as stopping at a Turn boundary.
  const huge = 'x'.repeat(4096);
  const rows = [
    turnRow(10, 'turn-a'), turnRow(20, 'turn-a'), turnRow(30, 'turn-a'),
    turnRow(40, 'turn-b', huge),
    turnRow(50, 'turn-c'), turnRow(60, 'turn-c'),
    turnRow(70, 'turn-d', huge),
  ];
  const smallRowBytes = Buffer.byteLength(JSON.stringify(rows[0]!.message), 'utf8');
  const host = historyHost(rows, { pageRows: 2 });
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: host.bootstrap,
          loadTranscriptPage: host.loadTranscriptPage,
          decodeTranscriptPage: host.decodeTranscriptPage,
          async close() {
            events.end();
          },
        }),
    },
    emitSessionsChanged() {},
    transcriptHistoryBytes: Math.floor(smallRowBytes * 1.5),
  });
  const batches: DesktopTranscriptBatch[] = [];
  const consumerId = 'consumer-history';
  await observer.openTranscript('session-1', consumerId, ackingTranscriptTarget(observer, consumerId, 26, batches), 'history');

  const answer = () => {
    const taken = batches.splice(0);
    assert.ok(taken.at(-1)?.ready, 'an answer ends with its ready batch');
    assert.equal(taken.filter((batch) => batch.ready).length, 1);
    return {
      taken,
      sequences: taken.flatMap((batch) => durableSequences(batch)).sort((left, right) => left - right),
      hasOlder: taken.at(-1)!.hasOlder,
    };
  };

  // The first page (60, 70) is over the budget on its own but cuts Turn c in half, so the read
  // continues to the page below it, which the Host marks as whole.
  const reset = answer();
  assert.equal(reset.taken[0]!.reset, true);
  assert.equal(reset.taken.some((batch) => batch.earlierThan !== undefined), false);
  assert.equal(reset.taken.at(-1)!.durableThrough, 70);
  assert.deepEqual(reset.sequences, [40, 50, 60, 70]);
  assert.equal(reset.hasOlder, true);

  // Turn a spans both remaining pages, so the rest of the history comes back as one answer.
  await observer.loadEarlierTranscript(consumerId, 26);
  const second = answer();
  assert.equal(second.taken.some((batch) => batch.reset), false);
  assert.equal(second.taken[0]!.earlierThan, 40);
  assert.deepEqual(second.sequences, [10, 20, 30]);
  assert.equal(second.hasOlder, false);

  assert.deepEqual(
    [...second.sequences, ...reset.sequences],
    rows.map((row) => row.identity),
  );
  await observer.loadEarlierTranscript(consumerId, 26);
  assert.equal(batches.length, 0, 'nothing older remains to deliver');
  await observer.close();
});

test('reads earlier history past its budget down to the requested Turn in one answer', async () => {
  const events = new AsyncFrameQueue();
  const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((turn, index) =>
    turnRow((index + 1) * 10, `turn-${turn}`),
  );
  const smallRowBytes = Buffer.byteLength(JSON.stringify(rows[0]!.message), 'utf8');
  const host = historyHost(rows, { pageRows: 1 });
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: host.bootstrap,
          loadTranscriptPage: host.loadTranscriptPage,
          decodeTranscriptPage: host.decodeTranscriptPage,
          async close() {
            events.end();
          },
        }),
    },
    emitSessionsChanged() {},
    transcriptHistoryBytes: Math.floor(smallRowBytes * 1.5),
  });
  const batches: DesktopTranscriptBatch[] = [];
  const consumerId = 'consumer-located';
  await observer.openTranscript('session-1', consumerId, ackingTranscriptTarget(observer, consumerId, 26, batches), 'history');
  const answer = () => {
    const taken = batches.splice(0);
    assert.equal(taken.filter((batch) => batch.ready).length, 1);
    return taken.flatMap((batch) => durableSequences(batch)).sort((left, right) => left - right);
  };
  assert.deepEqual(answer(), [50, 60]);

  await observer.loadEarlierTranscript(consumerId, 26, 20);
  assert.deepEqual(answer(), [20, 30, 40], 'one budget alone would stop at 30');
  await observer.close();
});

/**
 * Recovery rebuilds what the reader was holding from the number of reads they
 * had made, not from the boundary those reads actually reached. A read runs
 * past its budget to finish a Turn, so the sum of the budgets buys less than
 * the reads delivered, and the difference is history the renderer had and no
 * longer has.
 */
test('keeps the history already delivered across a same-session recovery', async () => {
  const huge = 'x'.repeat(4096);
  const rows = [
    turnRow(10, 'turn-a'), turnRow(20, 'turn-a'), turnRow(30, 'turn-a'),
    turnRow(40, 'turn-b', huge),
    turnRow(50, 'turn-c'), turnRow(60, 'turn-c'),
    turnRow(70, 'turn-d', huge),
  ];
  const smallRowBytes = Buffer.byteLength(JSON.stringify(rows[0]!.message), 'utf8');
  const host = historyHost(rows, { pageRows: 2 });
  const queues: AsyncFrameQueue[] = [];
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        const events = new AsyncFrameQueue();
        queues.push(events);
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: host.bootstrap,
          loadTranscriptPage: host.loadTranscriptPage,
          decodeTranscriptPage: host.decodeTranscriptPage,
          async close() {
            events.end();
          },
        });
      },
    },
    emitSessionsChanged() {},
    transcriptHistoryBytes: Math.floor(smallRowBytes * 1.5),
  });
  const batches: DesktopTranscriptBatch[] = [];
  const consumerId = 'consumer-recovered-history';
  await observer.openTranscript('session-1', consumerId, ackingTranscriptTarget(observer, consumerId, 26, batches), 'history');
  const answer = () => {
    const taken = batches.splice(0);
    assert.ok(taken.at(-1)?.ready, 'an answer ends with its ready batch');
    return taken.flatMap((batch) => durableSequences(batch)).sort((left, right) => left - right);
  };

  const delivered = [...answer()];
  await observer.loadEarlierTranscript(consumerId, 26);
  delivered.push(...answer());
  delivered.sort((left, right) => left - right);
  assert.deepEqual(delivered, rows.map((row) => row.identity), 'the reader is holding every row before anything fails');

  // The Host drops the subscription and the same Session is reopened over the
  // same rows: nothing was added, nothing was removed.
  queues[0]!.push({
    kind: 'subscription.closed',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sequence: 1,
    reason: 'slow_consumer',
  });
  await waitFor(() => batches.some((batch) => batch.reset === true) && batches.at(-1)?.ready === true);

  assert.deepEqual(answer(), delivered, 'recovery handed back less history than the reader had');
  await observer.close();
});

/**
 * A consumer belongs to the connection that made it, and a replacement makes a
 * new one. The reader behind it is the same reader, holding the same history,
 * so what the registration carries across is where that history reaches.
 */
test('keeps the history already delivered across a replacement of the Host connection', async () => {
  const rows = [10, 20, 30, 40].map((identity) => turnRow(identity, `turn-${identity}`));
  const smallRowBytes = Buffer.byteLength(JSON.stringify(rows[0]!.message), 'utf8');
  const sources = () =>
    new RuntimeHostSessionObserver({
      client: {
        openSession: async () => {
          const events = new AsyncFrameQueue();
          const host = historyHost(rows, { pageRows: 1 });
          return runtimeHostSessionFixture({
            snapshot: continuitySnapshot(),
            events,
            transcriptBootstrap: host.bootstrap,
            loadTranscriptPage: host.loadTranscriptPage,
            decodeTranscriptPage: host.decodeTranscriptPage,
            async close() {
              events.end();
            },
          });
        },
      },
      emitSessionsChanged() {},
      transcriptHistoryBytes: Math.floor(smallRowBytes * 1.5),
    });
  const first = sources();
  const second = sources();
  const observations = new RuntimeHostSessionObservationRegistry();
  const batches: DesktopTranscriptBatch[] = [];
  const consumerId = 'consumer-connection-replacement';
  const target: RuntimeHostTranscriptTarget = {
    id: 31,
    send(_channel, batch) {
      batches.push(batch);
      queueMicrotask(() =>
        observations.acknowledgeTranscript(consumerId, batch.generation, batch.deliverySequence, 31),
      );
    },
    once() {},
    off() {},
  };
  const answer = () => {
    const taken = batches.splice(0);
    assert.ok(taken.at(-1)?.ready, 'an answer ends with its ready batch');
    return taken.flatMap((batch) => durableSequences(batch)).sort((left, right) => left - right);
  };

  await observations.attach(first);
  await observations.openTranscript('session-1', consumerId, target, 'history');
  const delivered = [...answer()];
  await observations.loadEarlierTranscript(consumerId, target.id);
  delivered.push(...answer());
  delivered.sort((left, right) => left - right);
  assert.ok(delivered.length > 1, 'the reader asked for more than its first budget');

  observations.detach(first);
  await first.close();
  await observations.attach(second);
  await waitFor(() => batches.some((batch) => batch.reset === true) && batches.at(-1)?.ready === true);

  assert.deepEqual(answer(), delivered, 'the replacement handed back less history than the reader had');
  await observations.close();
  await second.close();
});

test('a tail transcript consumer still receives the replica snapshot', async () => {
  const events = new AsyncFrameQueue();
  const rows = [turnRow(10, 'turn-a'), turnRow(20, 'turn-b')];
  const host = historyHost(rows, { pageRows: 1 });
  let pageReads = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: host.bootstrap,
          loadTranscriptPage: async (input) => {
            pageReads += 1;
            return host.loadTranscriptPage(input);
          },
          decodeTranscriptPage: host.decodeTranscriptPage,
          async close() {
            events.end();
          },
        }),
    },
    emitSessionsChanged() {},
    transcriptHistoryBytes: 1,
  });
  const batches: DesktopTranscriptBatch[] = [];
  await observer.openTranscript('session-1', 'consumer-tail', ackingTranscriptTarget(observer, 'consumer-tail', 27, batches));

  assert.equal(pageReads, 0, 'a tail consumer is answered from the replica, not history reads');
  assert.equal(batches[0]!.reset, true);
  assert.equal(batches.at(-1)!.ready, true);
  assert.equal(batches.at(-1)!.durableThrough, 20);
  assert.equal(batches.at(-1)!.hasOlder, false);
  assert.deepEqual(batches.flatMap((batch) => durableSequences(batch)), [10, 20]);
  await assert.rejects(
    observer.loadEarlierTranscript('consumer-tail', 27),
    /history consumer does not exist/,
  );
  await observer.close();
});

test('reads every row of one Turn through the Host Turn index', async () => {
  const events = new AsyncFrameQueue();
  const rows = [
    turnRow(10, 'turn-a'),
    turnRow(20, 'turn-b'), turnRow(30, 'turn-b'), turnRow(40, 'turn-b'),
    turnRow(50, 'turn-c'),
  ];
  const host = historyHost(rows, { pageRows: 2 });
  const reads: Array<number | null> = [];
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: host.bootstrap,
          loadTranscriptPage: async (input) => {
            if (input.direction === 'newer') reads.push(input.throughSequence);
            return host.loadTranscriptPage(input);
          },
          decodeTranscriptPage: host.decodeTranscriptPage,
          async close() {
            events.end();
          },
        }),
      listSessionTurnLandmarks: async (sessionId, turnId) => ({
        sessionId,
        throughSequence: 50,
        landmarks:
          turnId === 'turn-b' ? [{ turnId, sequence: 20, lastSequence: 40, label: '' }] : [],
      }),
    },
    emitSessionsChanged() {},
  });

  assert.deepEqual(
    (await observer.readTranscriptTurn('session-1', 'turn-b')).map((message) => message.id),
    ['row-20', 'row-30', 'row-40'],
  );
  assert.deepEqual(
    reads.filter((through) => through !== 40),
    [],
    'the read stops where the Turn index says the Turn ends',
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
          events,
          loadTranscriptPage: async (input) => ({
            kind: 'page',
            sessionId: 'session-1',
            direction: 'newer',
            throughSequence: input.throughSequence,
            rawBytes: 1,
            fragments: [],
            nextCursor: null,
            endsAtTurnBoundary: true,
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

test('keeps a transcript consumer available after a delivery fails', async () => {
  const events = new AsyncFrameQueue();
  let closeCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: settledSnapshot(),
          events,
          loadTranscriptPage: async (input) => ({
            kind: 'page',
            sessionId: 'session-1',
            direction: 'newer',
            throughSequence: input.throughSequence,
            rawBytes: 1,
            fragments: [],
            nextCursor: null,
            endsAtTurnBoundary: true,
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
  let failDelivery = false;
  let failedDeliveries = 0;
  let successfulDeliveries = 0;
  const consumerId = 'consumer-failing';
  const opened = await observer.openTranscript('session-1', consumerId, {
    id: 25,
    send(_channel, batch) {
      if (failDelivery) {
        failedDeliveries += 1;
        throw new Error('renderer unavailable');
      }
      successfulDeliveries += 1;
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
  failDelivery = true;
  events.push({
    kind: 'subscription.transcript_advanced',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sessionId: 'session-1',
    sequence: 1,
    throughSequence: 0,
  });

  await waitFor(() => failedDeliveries === 1);
  failDelivery = false;
  const delivered = successfulDeliveries;
  events.push({
    kind: 'subscription.transcript_advanced',
    hostEpoch: opened.hostEpoch,
    subscriptionId: 'subscription-1',
    sessionId: 'session-1',
    sequence: 2,
    throughSequence: 1,
  });
  await waitFor(() => successfulDeliveries > delivered);
  assert.equal(closeCount, 0);
  await observer.closeTranscript(consumerId, 25);
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

test("abandons a watched Turn and removes it from the catalog when Guest access ends", async () => {
  const events = new AsyncFrameQueue();
  const finishedTurns: Array<[string, "completed" | "abandoned"]> = [];
  const sessionChanges: string[] = [];
  let closeCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(),
        events,
        async close() {
          closeCount += 1;
          events.end();
        },
      }),
    },
    emitSessionsChanged(reason) {
      sessionChanges.push(reason);
    },
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
    reason: "access_revoked",
  });

  await waitFor(() => closeCount === 1);
  assert.deepEqual(finishedTurns, [["session-1", "abandoned"]]);
  assert.deepEqual(sessionChanges, ["deleted"]);
  await observer.close();
});

test("reopens an evicted active subscription without a renderer resubscribe", async () => {
  const reopen = deferred<void>();
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const sessionChanges: Array<{ reason: string; sessionId: string }> = [];
  let openCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        openCount += 1;
        if (openCount === 2) await reopen.promise;
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
  await waitFor(() => openCount === 2);
  assert.equal(target.observations.at(-1)?.type, 'host_observation_pending',
    'observation is invalidated while reopen is still waiting');
  assert.equal(target.events.length, 1, 'no replacement content is accepted before reopen completes');
  reopen.resolve();
  await waitFor(() => target.events.length === 2);
  assert.equal(target.observations.at(-1)?.type, 'host_observation_seed');

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

test("recovers when transcript paging loses the active subscription", async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const target = eventTarget(12);
  let openCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        openCount += 1;
        const first = openCount === 1;
        const events = first ? firstEvents : secondEvents;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          loadTranscriptPage: async () => {
            if (first) {
              throw new RuntimeHostOperationError(
                "session.transcript.page",
                "not_found",
                "Session subscription was not found",
              );
            }
            return {
              kind: "page",
              sessionId: "session-1",
              direction: "newer",
              throughSequence: 0,
              rawBytes: 0,
              fragments: [],
              nextCursor: null,
              endsAtTurnBoundary: true,
            };
          },
          async close() {
            events.end();
          },
        });
      },
    },
    emitSessionsChanged() {},
  });

  await observer.observe("session-1", "observer-1", target);
  firstEvents.push({
    kind: "subscription.transcript_advanced",
    hostEpoch: "host-1",
    subscriptionId: "subscription-session-1",
    sessionId: "session-1",
    sequence: 1,
    throughSequence: 0,
  });
  await waitFor(() => openCount === 2);

  secondEvents.push(deltaFrame(1, 0, "recovered"));
  await waitFor(() => target.events.some((event) => event.type === "text_delta"));
  assert.equal(target.events.some((event) => event.type === "error"), false);
  await observer.close();
});

test("retries an initial subscription evicted before readiness and resyncs once", async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
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
          transcript: first ? Promise.resolve([]) : secondTranscript.promise,
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
  // The Host evicts a subscriber that has not declared readiness by queueing
  // this frame; it is released the moment readiness arrives.
  firstEvents.push({
    kind: "subscription.closed",
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sequence: 1,
    reason: "slow_consumer",
  });
  const observing = observer.observe("session-1", "observer-1", eventTarget(16));
  await waitFor(() => openCount === 2);
  assert.deepEqual(recoveredSessions, []);

  secondTranscript.resolve([]);
  await waitFor(() => recoveredSessions.length === 1);
  await observing;
  assert.deepEqual(recoveredSessions, ["session-1"]);
  assert.equal(openCount, 2);
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
          transcript: Promise.resolve([
            {
              type: "turn_state" as const,
              id: "terminal-1",
              turnId: "turn-1",
              ts: 20,
              status: "completed" as const,
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
  await waitFor(() => finishedTurns.length === 1);

  assert.deepEqual(finishedTurns, [["session-1", "completed"]]);
  // turn-2 is still running on the Host, so the replacement subscription stays.
  assert.equal(replacementCloseCount, 0);
  await observer.close();
});

test("seeds a joining observer from the attempt that survives repeated catch-up eviction", async () => {
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
            events: firstEvents,
            async close() {
              firstEvents.end();
            },
          });
        }
        if (openCount === 2) {
          return runtimeHostSessionFixture({
            snapshot: continuitySnapshot(),
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
  // Held until the replacement declares readiness, which it only does once its
  // transcript lands — so the observer joins an attempt already evicted.
  replacementEvents.push({
    kind: "subscription.closed",
    hostEpoch: "host-1",
    subscriptionId: "subscription-2",
    sequence: 1,
    reason: "slow_consumer",
  });
  replacementTranscript.resolve([]);
  await waitFor(() => openCount === 3);
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
  await waitFor(() =>
    joiningTarget.events.some(
      (event) => event.type === "text_delta" && event.text === "Hello",
    ),
  );

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
      }],
      openSession: async () => {
        openCount += 1;
        if (openCount === 1) {
          return runtimeHostSessionFixture({
            snapshot: continuitySnapshot({
              interactions: { pending: [firstInteraction] },
            }),
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
  const pendingAt = seedTimeline.indexOf('event:host_observation_pending');
  const readyAt = seedTimeline.lastIndexOf('event:host_observation_seed');
  assert.ok(pendingAt >= 0);
  assert.ok(readyAt > pendingAt);
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

test('replays durable admission before a terminal successor on subscription recovery', async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const recoveredSessions: string[] = [];
  const terminalTranscript: StoredMessage[] = [
    {
      type: 'user',
      id: 'follow-up-message',
      turnId: 'turn-2',
      ts: 20,
      text: 'Continue',
    },
    {
      type: 'assistant',
      id: 'assistant-2',
      turnId: 'turn-2',
      ts: 30,
      text: 'Done',
      modelId: 'test-model',
    },
    {
      type: 'turn_state',
      id: 'terminal-2',
      turnId: 'turn-2',
      ts: 40,
      status: 'completed',
    },
  ];
  let openCount = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      listSessionTurns: async () => [{
        turnId: 'turn-1',
        status: 'completed' as const,
        statusSource: 'recorded' as const,
      }],
      openSession: async () => {
        openCount += 1;
        if (openCount === 1) {
          return runtimeHostSessionFixture({
            snapshot: continuitySnapshot(),
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
              sessionId: 'session-1',
              turnId: 'turn-2',
              runId: 'run-2',
              status: 'completed',
              terminalEventId: 'terminal-2',
            },
          }),
          transcript: Promise.resolve(terminalTranscript),
          events: secondEvents,
          async close() {
            secondEvents.end();
          },
        });
      },
    },
    emitSessionsChanged() {},
    emitSubscriptionRecovered: (sessionId) => {
      recoveredSessions.push(sessionId);
    },
    now: () => 50,
  });
  const target = eventTarget(23);
  await observer.observe('session-1', 'observer-1', target, true);

  firstEvents.push({
    kind: 'subscription.closed',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    reason: 'slow_consumer',
  });
  await waitFor(() => recoveredSessions.length === 1);

  assert.deepEqual(
    target.events
      .filter((event) => event.turnId === 'turn-2')
      .map((event) => event.type),
    ['message_admission', 'queue_update', 'text_complete', 'complete'],
  );
  const admission = target.events.find(
    (event): event is Extract<SessionEvent, { type: 'message_admission' }> =>
      event.type === 'message_admission',
  );
  assert.deepEqual(
    admission && { messageId: admission.messageId, turnId: admission.turnId },
    { messageId: 'follow-up-message', turnId: 'turn-2' },
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
          // Settled: releasing an idle subscription is only correct once the
          // Host has nothing left to send.
          snapshot: settledSnapshot(),
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

test("publishes form answer acknowledgements for renderer queue retirement", async () => {
  const pending = {
    schemaVersion: 1 as const,
    interactionId: "form-1",
    sessionId: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    revision: 1 as const,
    status: "pending" as const,
    outcome: null,
    request: {
      kind: "form" as const,
      toolUseId: "tool-1",
      message: "Configure deployment",
      requester: { name: "deploy" },
      fields: [{ kind: "boolean" as const, name: "confirm", label: "Confirm", required: true }],
    },
  };
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot({ interactions: { pending: [pending] } }),
        events: new AsyncFrameQueue(),
        async close() {},
      }),
    },
    emitSessionsChanged() {},
    now: () => 80,
  });
  const target = eventTarget(2);
  await observer.observe("session-1", "observer-1", target);
  observer.publishInteractionAnswer({
    ...pending,
    revision: 2,
    status: "answered",
    outcome: { kind: "form_answer", action: "accept", values: { confirm: true }, committedAt: 80 },
  }, pending);

  assert.deepEqual(target.events.at(-1), {
    type: "form_answer_ack",
    id: "host-interaction:form-1:2",
    turnId: "turn-1",
    ts: 80,
    requestId: "form-1",
    toolUseId: "tool-1",
  });
  await observer.close();
});

test("projects Host queue revisions and newly delivered steering messages", async () => {
  const events = new AsyncFrameQueue();
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => runtimeHostSessionFixture({
        snapshot: continuitySnapshot(),
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
  assert.deepEqual(target.events[0], {
    type: "queue_update",
    id: "host-queue:host-1:1",
    turnId: "turn-1",
    ts: 90,
    queueRevision: 1,
    steering: ["Change direction"],
    followup: [],
    steeringEntries: [queued],
    followupEntries: [],
  });
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

test('reseeds an evicted replica on the live subscription when a transcript opens', async () => {
  const firstEvents = new AsyncFrameQueue();
  const opensBy = new Map<string, number>();
  let tailReads = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async (sessionId: string) => {
        opensBy.set(sessionId, (opensBy.get(sessionId) ?? 0) + 1);
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events: sessionId === 'session-1' ? firstEvents : new AsyncFrameQueue(),
          transcriptBootstrap: {
            durable: transcriptPage('older', sessionId === 'session-1' ? 2 : 0),
          },
          transcriptWatermark: () => 2,
          decodeTranscriptPage: async (page) => ({
            messages: rowsThrough(
              page.throughSequence,
              sessionId === 'session-1' ? 20 : 2000,
            ),
            nextCursor: page.nextCursor,
          }),
          loadTranscriptPage: async (input) => {
            if (sessionId === 'session-1') tailReads += 1;
            return transcriptPage(input.direction, input.throughSequence ?? 2);
          },
          async close() {},
        });
      },
    },
    emitSessionsChanged() {},
    // session-2's preparation bytes alone exceed the budget: the accounting
    // trims and then discards session-1's unprotected replica, then fails.
    transcriptGlobalCacheMaxBytes: 1500,
  });
  await observer.observe('session-1', 'observer-1', eventTarget(1));
  await assert.rejects(
    observer.observe('session-2', 'observer-2', eventTarget(2)),
    /global cache limit/,
  );

  const batches: DesktopTranscriptBatch[] = [];
  const opened = await observer.openTranscript('session-1', 'consumer-1', {
    id: 7,
    send(_channel, batch) {
      batches.push(batch);
      queueMicrotask(() =>
        observer.acknowledgeTranscript(
          'consumer-1',
          batch.generation,
          batch.deliverySequence!,
          7,
        ),
      );
    },
    once() {},
    off() {},
  });

  assert.equal(
    opensBy.get('session-1'),
    1,
    'the reseed must reuse the live subscription',
  );
  assert.equal(tailReads, 1);
  await waitFor(() => batches.some((batch) => batch.reset));
  const reset = batches.find((batch) => batch.reset)!;
  assert.equal(reset.generation, opened.generation);
  await observer.close();
});

test('trims around a replica that recovery already closed', async () => {
  const firstEvents = new AsyncFrameQueue();
  const reopen = deferred<void>();
  let reopenRequested = false;
  let firstOpens = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async (sessionId: string) => {
        if (sessionId === 'session-1') {
          firstOpens += 1;
          if (firstOpens === 2) {
            reopenRequested = true;
            await reopen.promise;
          }
        }
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events: sessionId === 'session-1' ? firstEvents : new AsyncFrameQueue(),
          transcriptBootstrap: {
            durable: transcriptPage('older', sessionId === 'session-1' ? 2 : 0),
          },
          transcriptWatermark: () => 2,
          decodeTranscriptPage: async (page) => ({
            messages: rowsThrough(
              page.throughSequence,
              sessionId === 'session-1' ? 20 : 2000,
            ),
            nextCursor: page.nextCursor,
          }),
          async close() {},
        });
      },
    },
    emitSessionsChanged() {},
    transcriptGlobalCacheMaxBytes: 1500,
  });
  await observer.observe('session-1', 'observer-1', eventTarget(1));

  firstEvents.push({
    kind: 'subscription.closed',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sequence: 1,
    reason: 'slow_consumer',
  });
  // Recovery has already closed the failed attempt's replica and is parked on
  // the reopen: a budget pass from an unrelated session must meet the closed
  // replica as a no-op, not throw through it.
  await waitFor(() => reopenRequested);
  await assert.rejects(
    observer.observe('session-2', 'observer-2', eventTarget(2)),
    /global cache limit/,
  );

  reopen.resolve(undefined);
  await observer.close();
});

test('feeds the surviving projector rows that went durable while the replica was evicted', async () => {
  const firstEvents = new AsyncFrameQueue();
  const target = eventTarget(1);
  let watermark = 2;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async (sessionId: string) =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events:
            sessionId === 'session-1' ? firstEvents : new AsyncFrameQueue(),
          transcriptBootstrap: {
            durable: transcriptPage('older', sessionId === 'session-1' ? 2 : 0),
          },
          transcriptWatermark: () =>
            sessionId === 'session-1' ? watermark : 0,
          loadTranscriptPage: async (input) =>
            transcriptPage(input.direction, input.throughSequence ?? 3),
          decodeTranscriptPage: async (page) => {
            const rows = rowsThrough(
              page.throughSequence,
              sessionId === 'session-1' ? 20 : 2000,
            );
            if (sessionId === 'session-1' && (page.throughSequence ?? 0) >= 3) {
              rows[3] = {
                identity: 3,
                message: {
                  type: 'user',
                  id: 'gap-user',
                  turnId: 'turn-1',
                  ts: 3,
                  text: 'steer while evicted',
                },
              };
            }
            return { messages: rows, nextCursor: page.nextCursor };
          },
          async close() {},
        }),
    },
    emitSessionsChanged() {},
    transcriptGlobalCacheMaxBytes: 1800,
  });
  await observer.observe('session-1', 'observer-1', target, true);
  await assert.rejects(
    observer.observe('session-2', 'observer-2', eventTarget(2)),
    /global cache limit/,
  );

  // session-1's replica is evicted. A user message goes durable on the Host
  // while it is gone — the frame resolves quietly on the husk, so the row can
  // only reach the surviving projector's durable map through the reseed
  // install.
  watermark = 3;
  firstEvents.push({
    kind: 'subscription.transcript_advanced',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sessionId: 'session-1',
    sequence: 1,
    throughSequence: 3,
  });

  const batches: DesktopTranscriptBatch[] = [];
  await observer.openTranscript('session-1', 'consumer-1', {
    id: 7,
    send(_channel, batch) {
      batches.push(batch);
      queueMicrotask(() =>
        observer.acknowledgeTranscript(
          'consumer-1',
          batch.generation,
          batch.deliverySequence!,
          7,
        ),
      );
    },
    once() {},
    off() {},
  });

  await waitFor(() =>
    target.events.some(
      (event) =>
        event.type === 'message_admission' && event.messageId === 'gap-user',
    ),
  );
  const admission = target.events.find(
    (
      event,
    ): event is Extract<SessionEvent, { type: 'message_admission' }> =>
      event.type === 'message_admission' && event.messageId === 'gap-user',
  )!;
  assert.equal(admission.outcome, 'admitted');
  assert.equal(admission.turnId, 'turn-1');
  await observer.close();
});

test('keeps the subscription alive when a catch-up decode hits the cache capacity gate', async () => {
  const firstEvents = new AsyncFrameQueue();
  const target = eventTarget(1);
  let watermark = 2;
  let failDecode = false;
  let decodeAttempts = 0;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async (_sessionId: string) =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events: firstEvents,
          transcriptBootstrap: { durable: transcriptPage('older', 2) },
          transcriptWatermark: () => watermark,
          loadTranscriptPage: async (input) =>
            transcriptPage(input.direction, input.throughSequence ?? 3),
          decodeTranscriptPage: async (page) => {
            decodeAttempts += 1;
            if (failDecode) {
              throw new RangeError(
                'Desktop transcript preparation exceeds the global cache limit',
              );
            }
            return {
              messages:
                page.direction === 'newer'
                  ? rowsThrough(page.throughSequence, 20).slice(3)
                  : rowsThrough(page.throughSequence, 20),
              nextCursor: page.nextCursor,
            };
          },
          async close() {},
        }),
    },
    emitSessionsChanged() {},
  });
  await observer.observe('session-1', 'observer-1', target);

  // The pump's catch-up decode hits the capacity gate: the charge was already
  // rolled back, so the only thing a failure report could do is tear down a
  // healthy subscription. The frame is consumed and the subscription lives.
  failDecode = true;
  watermark = 3;
  firstEvents.push({
    kind: 'subscription.transcript_advanced',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sessionId: 'session-1',
    sequence: 1,
    throughSequence: 3,
  });
  await waitFor(() => decodeAttempts >= 2);

  failDecode = false;
  watermark = 4;
  firstEvents.push({
    kind: 'subscription.transcript_advanced',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sessionId: 'session-1',
    sequence: 2,
    throughSequence: 4,
  });

  const batches: DesktopTranscriptBatch[] = [];
  await observer.openTranscript('session-1', 'consumer-1', {
    id: 7,
    send(_channel, batch) {
      batches.push(batch);
      queueMicrotask(() =>
        observer.acknowledgeTranscript(
          'consumer-1',
          batch.generation,
          batch.deliverySequence!,
          7,
        ),
      );
    },
    once() {},
    off() {},
  });
  await waitFor(() =>
    batches.some((batch) => durableSequences(batch).includes(4)),
  );
  assert.ok(
    !target.observations.some(
      (event) => event.type === 'host_observation_error',
    ),
  );
  await observer.close();
});

test('does not cache a snapshot published before the replica is installed', async () => {
  const firstEvents = new AsyncFrameQueue();
  const cachedGenerations: unknown[] = [];
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async (sessionId: string) =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events: sessionId === 'session-1' ? firstEvents : new AsyncFrameQueue(),
          transcriptBootstrap: {
            durable: transcriptPage('older', sessionId === 'session-1' ? 2 : 0),
          },
          transcriptWatermark: () => 2,
          decodeTranscriptPage: async (page) => ({
            // The catch-up page covers only rows past the lagging tail, so it
            // carries identity 2 alone.
            messages:
              page.direction === 'newer'
                ? rowsThrough(page.throughSequence, 20).slice(2)
                : rowsThrough(
                    page.throughSequence,
                    sessionId === 'session-1' ? 20 : 2000,
                  ),
            nextCursor: page.nextCursor,
          }),
          // The tail page lags the live watermark, so the reseed's catch-up
          // publishes once before the replica is installed.
          loadTranscriptPage: async (input) =>
            transcriptPage(input.direction, input.direction === 'older' ? 1 : 2),
          async close() {},
        }),
    },
    emitSessionsChanged() {},
    cacheTranscript: (snapshot) => cachedGenerations.push(snapshot.generation),
    transcriptGlobalCacheMaxBytes: 1500,
  });
  await observer.observe('session-1', 'observer-1', eventTarget(1));
  await assert.rejects(
    observer.observe('session-2', 'observer-2', eventTarget(2)),
    /global cache limit/,
  );

  const opened = await observer.openTranscript('session-1', 'consumer-1', {
    id: 7,
    send(_channel, batch) {
      queueMicrotask(() =>
        observer.acknowledgeTranscript(
          'consumer-1',
          batch.generation,
          batch.deliverySequence!,
          7,
        ),
      );
    },
    once() {},
    off() {},
  });

  assert.equal(
    cachedGenerations.filter((generation) => generation === opened.generation)
      .length,
    1,
    'only the installed snapshot may be cached',
  );
  await observer.close();
});

function rowsThrough(
  throughSequence: number | null,
  textBytes: number,
): { identity: number; message: StoredMessage }[] {
  const rows: { identity: number; message: StoredMessage }[] = [];
  for (let identity = 0; identity <= (throughSequence ?? 0); identity += 1) {
    rows.push({
      identity,
      message: {
        type: 'assistant',
        id: `row-${identity}`,
        turnId: 'turn-1',
        ts: identity,
        text: 'x'.repeat(textBytes),
        modelId: 'test-model',
      },
    });
  }
  return rows;
}

function activeText(messageId: string, turnId = 'turn-1') {
  return { kind: 'text' as const, turnId, messageId };
}

/** A Session whose root Turn has ended, so nothing holds the subscription open. */
function settledSnapshot(): SessionContinuitySnapshot {
  return continuitySnapshot({
    rootTurn: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'completed',
      terminalEventId: 'terminal-1',
    },
  });
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
): RuntimeHostSessionObserverTarget & { events: SessionEvent[]; observations: SessionObservationMessage[] } {
  const events: SessionEvent[] = [];
  const observations: SessionObservationMessage[] = [];
  return {
    id,
    events,
    observations,
    send(_channel, event) {
      if (event.type === 'host_observation_seed') {
        observations.push(event);
        events.push(...event.events);
      } else if (event.type === 'host_execution' || event.type === 'host_observation_error'
        || event.type === 'host_observation_pending') observations.push(event);
      else events.push(event);
    },
    once() {},
    off() {},
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  await pollFor(predicate, { attempts: 100, message: 'Timed out waiting for observer state' });
}

interface TranscriptRow {
  readonly identity: number;
  readonly message: StoredMessage;
}

function turnRow(identity: number, turnId: string, text = `row ${identity}`): TranscriptRow {
  return {
    identity,
    message: { type: 'assistant', id: `row-${identity}`, turnId, ts: identity, text, modelId: 'test-model' },
  };
}

/**
 * A durable Host transcript cut into pages of `pageRows` rows. Older cursors
 * name the index a page starts at; newer cursors are prefixed with `n`.
 */
function historyHost(rows: readonly TranscriptRow[], options: { readonly pageRows: number }) {
  const decoded = new Map<SessionTranscriptPage, { messages: TranscriptRow[]; nextCursor: string | null }>();
  const throughSequence = rows.at(-1)?.identity ?? null;
  const page = (messages: TranscriptRow[], nextCursor: string | null, endsAtTurnBoundary = true) => {
    const value: SessionTranscriptPage = {
      kind: 'page',
      sessionId: 'session-1',
      direction: 'older',
      throughSequence,
      rawBytes: 1,
      fragments: [],
      nextCursor,
      endsAtTurnBoundary,
    };
    decoded.set(value, { messages, nextCursor });
    return value;
  };
  return {
    bootstrap: { durable: page([...rows], null) },
    loadTranscriptPage: async (input: {
      readonly direction: 'older' | 'newer';
      readonly cursor: string | null;
      readonly anchorSequence: number | null;
    }): Promise<SessionTranscriptPage> => {
      if (input.direction === 'older') {
        const end = input.cursor === null ? rows.length : Number(input.cursor);
        const start = Math.max(0, end - options.pageRows);
        // The Host hands over mutually overlapping Turns together, so a page
        // ends on a boundary only where the row below it starts another Turn.
        const whole =
          start === 0 || rows[start - 1]!.message.turnId !== rows[start]!.message.turnId;
        return page(rows.slice(start, end), start > 0 ? String(start) : null, whole);
      }
      const start = input.cursor !== null
        ? Number(input.cursor.slice(1))
        : rows.findIndex((row) => input.anchorSequence === null || row.identity > input.anchorSequence);
      const end = Math.min(rows.length, start + options.pageRows);
      return page(rows.slice(start, end), end < rows.length ? `n${end}` : null);
    },
    decodeTranscriptPage: async (value: SessionTranscriptPage) => {
      const answer = decoded.get(value);
      assert.ok(answer, 'decoded a page this Host did not serve');
      return answer;
    },
  };
}

function ackingTranscriptTarget(
  observer: RuntimeHostSessionObserver,
  consumerId: string,
  id: number,
  batches: DesktopTranscriptBatch[],
): RuntimeHostTranscriptTarget {
  return {
    id,
    send(_channel, batch) {
      batches.push(batch);
      queueMicrotask(() => observer.acknowledgeTranscript(consumerId, batch.generation, batch.deliverySequence, id));
    },
    once() {},
    off() {},
  };
}

function durableSequences(batch: DesktopTranscriptBatch): number[] {
  return batch.fragments
    .filter((fragment) => fragment.byteOffset === 0)
    .map((fragment) => fragment.sequence);
}

// #5365: leaving the conversation used to drop the subscription to a Turn the
// Host was still running, so coming back made it stream the whole answer again.
test('a running Turn keeps its subscription after the last viewer leaves', async () => {
  const events = new AsyncFrameQueue();
  let opens = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    activeAssistantStreams: [activeText('message-1')],
    events,
    async close() { events.end(); },
  });
  const observer = new RuntimeHostSessionObserver({
    client: { openSession: async () => { opens += 1; return handle; } },
    emitSessionsChanged() {},
  });
  const target = eventTarget(1);
  await observer.observe('session-1', 'conversation', target);
  assert.equal(opens, 1);

  await observer.unobserve('conversation');
  // The Host keeps producing while nobody looks; the subscription has to be
  // there to receive it, or the text below is lost and must be re-sent.
  events.push(deltaFrame(1, 0, 'Written while away'));
  await observer.observe('session-1', 'conversation-again', target);

  assert.equal(opens, 1);
  const seed = target.observations.at(-1);
  assert.equal(seed?.type, 'host_observation_seed');
  if (seed?.type === 'host_observation_seed') {
    assert.ok(seed.events.some((event) =>
      event.type === 'text_delta' && event.text === 'Written while away'));
  }
  await observer.close();
});

test('the subscription is released once the running Turn ends with no viewer', async () => {
  const events = new AsyncFrameQueue();
  let closed = false;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    events,
    async close() { closed = true; events.end(); },
  });
  const observer = new RuntimeHostSessionObserver({
    client: { openSession: async () => handle },
    emitSessionsChanged() {},
  });
  await observer.observe('session-1', 'conversation', eventTarget(1));
  await observer.unobserve('conversation');
  assert.equal(closed, false);

  events.push({
    kind: 'subscription.session_projection',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    snapshot: continuitySnapshot({
      rootTurn: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'completed',
        terminalEventId: 'terminal-1',
      },
    }),
  });
  await waitFor(() => closed);
  await observer.close();
});

test('a later observer in the same renderer receives the accumulated active stream', async () => {
  const events = new AsyncFrameQueue();
  let opens = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    activeAssistantStreams: [activeText('message-1')],
    transcript: Promise.resolve([{ type: 'assistant', id: 'message-1', turnId: 'turn-1', ts: 1, text: 'Hello', modelId: 'test-model' }]),
    events,
    async close() { events.end(); },
  });
  const observer = new RuntimeHostSessionObserver({
    client: { openSession: async () => { opens += 1; return handle; } },
    emitSessionsChanged() {},
  });
  const target = eventTarget(1);
  await observer.observe('session-1', 'feature-first', target);
  events.push(deltaFrame(1, 5, ' world'));
  await waitFor(() => target.events.some((event) => 'text' in event && event.text === ' world'));
  await observer.observe('session-1', 'conversation-later', target);
  assert.equal(opens, 1);
  const seed = target.observations.at(-1);
  assert.equal(seed?.type, 'host_observation_seed');
  if (seed?.type === 'host_observation_seed') {
    assert.deepEqual(seed.observerIds, ['conversation-later']);
    assert.equal(seed.execution.rootTurn?.turnId, 'turn-1');
    assert.ok(seed.events.some((event) =>
      event.type === 'text_delta' && event.startOffset === 0 && event.text === 'Hello world'));
  }
  await observer.close();
});

test('acknowledging the tail of a latched replica is a quiet no-op', async () => {
  const events = new AsyncFrameQueue();
  const fetchGate = deferred<void>();
  const markers: string[] = [];
  let fetches = 0;
  let watermark = 2;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: { durable: transcriptPage('older', 2) },
          transcriptWatermark: () => watermark,
          decodeTranscriptPage: async (page) => ({
            messages:
              page.direction === 'newer'
                ? rowsThrough(page.throughSequence, 20).slice(3)
                : rowsThrough(page.throughSequence, 20),
            nextCursor: page.nextCursor,
          }),
          loadTranscriptPage: async () => {
            fetches += 1;
            if (fetches === 1) {
              await fetchGate.promise;
              return transcriptPage('newer', 4);
            }
            throw new RuntimeHostOperationError(
              'session.transcript.page',
              'not_found',
              'subscription transcript context was lost',
            );
          },
          async close() { events.end(); },
        }),
      setSessionReadMarker: async (_sessionId, messageId) => {
        markers.push(messageId);
        return undefined as never;
      },
    },
    emitSessionsChanged() {},
  });
  await observer.observe('session-1', 'observer-1', eventTarget(1));
  const opened = await observer.openTranscript('session-1', 'consumer-1', {
    id: 7,
    send(_channel, batch) {
      queueMicrotask(() =>
        observer.acknowledgeTranscript('consumer-1', batch.generation, batch.deliverySequence!, 7),
      );
    },
    once() {},
    off() {},
  });

  // Gate the first catch-up read, then land the next watermark move between
  // the read loop's last check and its settle check so the failure hits the
  // swallowed post-settle re-arm rather than the pump's advance.
  watermark = 4;
  events.push({
    kind: 'subscription.transcript_advanced',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sessionId: 'session-1',
    sequence: 1,
    throughSequence: 4,
  });
  await pollFor(() => fetches === 1);
  void fetchGate.promise.then(() => {
    watermark = 6;
  });
  fetchGate.resolve(undefined);
  // The re-armed read latches the replica; its rejection is swallowed, so the
  // replica stays installed with only resident flipped.
  await pollFor(() => fetches === 2);

  assert.doesNotThrow(() =>
    observer.acknowledgeTranscriptTail(
      {
        consumerId: 'consumer-1',
        sessionId: 'session-1',
        hostEpoch: opened.hostEpoch,
        through: 6,
      },
      7,
    ),
  );
  assert.deepEqual(markers, []);
  await observer.close();
});

test('a latched replica reseeds through recovery for the next reader', async () => {
  const firstEvents = new AsyncFrameQueue();
  const fetchGate = deferred<void>();
  let opens = 0;
  let fetches = 0;
  let watermark = 2;
  const observer = new RuntimeHostSessionObserver({
    client: {
      openSession: async () => {
        opens += 1;
        const first = opens === 1;
        const events = first ? firstEvents : new AsyncFrameQueue();
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: { durable: transcriptPage('older', 2) },
          transcriptWatermark: () => watermark,
          decodeTranscriptPage: async (page) => ({
            messages:
              page.direction === 'newer'
                ? rowsThrough(page.throughSequence, 20).slice(3)
                : rowsThrough(page.throughSequence, 20),
            nextCursor: page.nextCursor,
          }),
          loadTranscriptPage: first
            ? async () => {
                fetches += 1;
                if (fetches === 1) {
                  await fetchGate.promise;
                  return transcriptPage('newer', 4);
                }
                throw new RuntimeHostOperationError(
                  'session.transcript.page',
                  'not_found',
                  'subscription transcript context was lost',
                );
              }
            : undefined,
          async close() { events.end(); },
        });
      },
    },
    emitSessionsChanged() {},
  });
  await observer.observe('session-1', 'observer-1', eventTarget(1));

  // Same re-arm window as above: the watermark moves after the read loop's
  // last check but before the settle check, so the dead-context failure is
  // swallowed by the post-settle re-arm and the replica stays installed.
  watermark = 4;
  firstEvents.push({
    kind: 'subscription.transcript_advanced',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sessionId: 'session-1',
    sequence: 1,
    throughSequence: 4,
  });
  await pollFor(() => fetches === 1);
  void fetchGate.promise.then(() => {
    watermark = 6;
  });
  fetchGate.resolve(undefined);
  await pollFor(() => fetches === 2);

  // The replica is latched and installed but reports resident === false, so
  // the next reader takes the reseed path; its fetch hits the same dead
  // transcript context, which routes through owner recovery onto a fresh
  // subscription.
  const batches: DesktopTranscriptBatch[] = [];
  await observer.openTranscript('session-1', 'consumer-1', {
    id: 7,
    send(_channel, batch) {
      batches.push(batch);
      queueMicrotask(() =>
        observer.acknowledgeTranscript('consumer-1', batch.generation, batch.deliverySequence!, 7),
      );
    },
    once() {},
    off() {},
  });
  assert.equal(opens, 2);
  await pollFor(() => batches.some((batch) => batch.fragments.length > 0));
  await observer.close();
});
