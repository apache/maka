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
import { setImmediate } from 'node:timers/promises';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { StoredMessage } from '@maka/core/session';
import {
  RuntimeHostSubscriptionError,
  type DecodedSessionTranscriptPage,
  type RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  SESSION_TRANSCRIPT_RANGE_MAX_BYTES,
  type SessionContinuitySnapshot,
  type SessionTranscriptBootstrap,
  type SessionTranscriptPage,
  type SessionTranscriptPageInput,
  type SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import { RuntimeHostSessionChannel } from '../runtime-host-session-channel.js';

test('prompt transcript pages on its existing subscription, preserves sparse cuts and waits for its consumer', async () => {
  const subscription = new TranscriptSubscription('first', 7);
  let opens = 0;
  const channel = await openChannel(async () => {
    opens += 1;
    return subscription;
  });
  const transcript = channel.trackPromptTranscript('turn');
  subscription.advance(63);
  await setImmediate();
  subscription.readPage = async (input) =>
    input.cursor === null
      ? subscription.page(input, [{ identity: 16, message: result('tool-1', 'first') }], 'next')
      : subscription.page(input, [
          { identity: 40, message: result('tool-2', 'second') },
          { identity: 56, message: terminal() },
        ]);
  const pending = deferred<void>();
  const batches: readonly StoredMessage[][] = [];
  let delivered = false;
  const reading = transcript
    .reconcile(async (messages) => {
      (batches as StoredMessage[][]).push([...messages]);
      await pending.promise;
    })
    .then(() => {
      delivered = true;
    });
  await setImmediate();
  assert.equal(delivered, false);
  assert.equal(subscription.pages.length, 1);
  pending.resolve();
  await reading;
  assert.equal(opens, 1);
  assert.equal(subscription.bootstrapReads, 1);
  assert.deepEqual(
    subscription.pages.map(({ cursor, anchorSequence, throughSequence }) => ({
      cursor,
      anchorSequence,
      throughSequence,
    })),
    [
      { cursor: null, anchorSequence: 7, throughSequence: 63 },
      { cursor: 'next', anchorSequence: null, throughSequence: 63 },
    ],
  );
  assert.equal(batches.flat().length, 3);
  transcript.dispose();
  await channel.close();
});

test('every reconciliation rereads its immutable pre-turn cut and ignores unrelated turns', async () => {
  const subscription = new TranscriptSubscription('first', 7);
  const channel = await openChannel(async () => subscription);
  const transcript = channel.trackPromptTranscript('turn');
  subscription.advance(63);
  await setImmediate();
  let text = 'original';
  subscription.readPage = async (input) =>
    subscription.page(
      input,
      [
        { identity: 16, message: result('tool', text) },
        {
          identity: 24,
          message: { ...result('unrelated', 'not for this prompt'), turnId: 'nested-turn' },
        },
        { identity: 56, message: terminal() },
      ],
      'unrelated-history-after-terminal',
    );
  const observed: StoredMessage[] = [];
  await transcript.reconcile(async (messages) => {
    observed.push(...messages);
  });
  text = 'authoritative archived projection';
  await transcript.reconcile(async (messages) => {
    observed.push(...messages);
  });
  assert.equal(subscription.pages.length, 2);
  assert.deepEqual(
    subscription.pages.map(({ anchorSequence }) => anchorSequence),
    [7, 7],
  );
  assert.ok(observed.every((message) => message.turnId === 'turn'));
  assert.equal(
    observed.filter((message) => message.type === 'tool_result').at(-1)?.content.kind,
    'text',
  );
  const last = observed.filter((message) => message.type === 'tool_result').at(-1)!;
  assert.equal(last.content.kind === 'text' && last.content.text, text);
  transcript.dispose();
  await channel.close();
});

test('cancel and channel close release a stalled read without waiting for missing results', async () => {
  for (const action of ['cancel', 'dispose', 'close'] as const) {
    const subscription = new TranscriptSubscription('first', 7);
    const channel = await openChannel(async () => subscription);
    const transcript = channel.trackPromptTranscript('turn');
    subscription.advance(31);
    await setImmediate();
    const stalled = deferred<SessionTranscriptPage>();
    subscription.readPage = () => stalled.promise;
    const abort = new AbortController();
    const observed: StoredMessage[] = [];
    const reading = transcript.reconcile(async (messages) => {
      observed.push(...messages);
    }, abort.signal);
    await setImmediate();
    if (action === 'cancel') abort.abort(new Error('cancelled'));
    else if (action === 'dispose') transcript.dispose();
    else await channel.close();
    await assert.rejects(reading);
    stalled.resolve(
      subscription.page(subscription.pages[0]!, [
        { identity: 16, message: result('late', 'must not publish') },
      ]),
    );
    await setImmediate();
    assert.equal(observed.length, 0);
    transcript.dispose();
    await channel.close();
  }
});

test('recovery across root turns rereads the old prompt below the new bootstrap cut and drops stale pages', async () => {
  const first = new TranscriptSubscription('first', 7);
  const second = new TranscriptSubscription('second', 95);
  second.snapshot.rootTurn = runningTurn('next-turn');
  second.initialTranscript = [terminal()];
  let opens = 0;
  const channel = await openChannel(async () => (++opens === 1 ? first : second));
  const transcript = channel.trackPromptTranscript('turn');
  first.setRoot(runningTurn('turn'));
  first.advance(31);
  await setImmediate();
  const stale = deferred<SessionTranscriptPage>();
  first.readPage = () => stale.promise;
  second.readPage = async (input) =>
    second.page(input, [
      { identity: 16, message: result('tool', 'recovered') },
      { identity: 56, message: terminal() },
    ]);
  const observed: StoredMessage[] = [];
  const reading = transcript.reconcile(async (messages) => {
    observed.push(...messages);
  });
  await setImmediate();
  first.fail(new RuntimeHostSubscriptionError('connection_closed', 'recover'));
  await reading;
  stale.resolve(first.page(first.pages[0]!, [{ identity: 16, message: result('stale', 'old') }]));
  await setImmediate();
  assert.equal(opens, 2);
  assert.equal(second.pages[0]?.anchorSequence, 7);
  assert.equal(second.pages[0]?.throughSequence, 95);
  assert.equal(channel.snapshot.rootTurn?.turnId, 'next-turn');
  assert.equal(observed.filter((message) => message.type === 'tool_result').length, 1);
  assert.equal(observed[0]?.type === 'tool_result' && observed[0].toolUseId, 'tool');
  transcript.dispose();
  await channel.close();
});

test('prompt transcript rejects nonadvancing cursors and propagates consumer failures', async () => {
  for (const failure of ['cursor', 'consumer'] as const) {
    const subscription = new TranscriptSubscription('first', 7);
    const channel = await openChannel(async () => subscription);
    const transcript = channel.trackPromptTranscript('turn');
    subscription.advance(63);
    await setImmediate();
    subscription.readPage = async (input) =>
      subscription.page(
        input,
        [{ identity: 16, message: result('tool', 'result') }],
        failure === 'cursor' ? 'same' : null,
      );
    await assert.rejects(
      transcript.reconcile(async () => {
        if (failure === 'consumer') throw new Error('notification rejected');
      }),
      failure === 'cursor' ? /cursor did not advance/ : /notification rejected/,
    );
    transcript.dispose();
    await channel.close();
  }
});

async function openChannel(
  openSessionSubscription: () => Promise<RuntimeHostSessionSubscription>,
): Promise<RuntimeHostSessionChannel> {
  const connection = { reconnecting: true as const, openSessionSubscription };
  const { channel } = await RuntimeHostSessionChannel.open({
    connection,
    sessionId: 'session',
    now: () => 1,
    onTurnStarted: () => {},
    onRuntimeResourceChanged: () => {},
    onInteractionPending: () => {},
    onInteractionResolved: () => {},
    onTranscriptSettlement: () => {},
    onTranscriptReplaced: () => {},
    onGoalChanged: () => {},
    onRecovered: () => {},
  });
  channel.activate();
  return channel;
}

class TranscriptSubscription
  implements RuntimeHostSessionSubscription, AsyncIterator<SubscriptionFrame>
{
  readonly hostEpoch = 'host';
  readonly activeAssistantStreams = [];
  snapshot: SessionContinuitySnapshot = {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: 'session',
      metadataRevision: 1,
      status: 'active',
      createdAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: null,
    goal: null,
    queue: { hostEpoch: 'host', queueRevision: 0, steering: [], followup: [] },
    interactions: { pending: [] },
  };
  readonly transcriptBootstrap: SessionTranscriptBootstrap;
  readonly pages: Omit<SessionTranscriptPageInput, 'subscriptionId'>[] = [];
  readonly #decoded = new WeakMap<
    SessionTranscriptPage,
    readonly { identity: number; message: StoredMessage }[]
  >();
  readonly #frames: SubscriptionFrame[] = [];
  #waiting?: {
    resolve: (result: IteratorResult<SubscriptionFrame>) => void;
    reject: (error: Error) => void;
  };
  #closed = false;
  #sequence = 0;
  bootstrapReads = 0;
  initialTranscript: StoredMessage[] = [];
  readPage: (
    input: Omit<SessionTranscriptPageInput, 'subscriptionId'>,
  ) => Promise<SessionTranscriptPage> = async (input) => this.page(input, []);

  constructor(
    readonly subscriptionId: string,
    throughSequence: number,
  ) {
    const durable = this.page(
      {
        source: 'durable',
        direction: 'older',
        throughSequence,
        cursor: null,
        anchorSequence: null,
        maxBytes: 16384,
      },
      [],
    );
    this.transcriptBootstrap = {
      throughSequence,
      durable,
      overlay: { ...durable, source: 'overlay' },
      overlayMessageCount: 0,
    };
  }
  subscribePtyData(): () => void {
    return () => {};
  }
  subscribeSessionDomainChanges(): () => void {
    return () => {};
  }
  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return this;
  }
  next(): Promise<IteratorResult<SubscriptionFrame>> {
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve({ value: frame, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }
  advance(throughSequence: number): void {
    const frame: SubscriptionFrame = {
      kind: 'subscription.transcript_advanced',
      sessionId: 'session',
      subscriptionId: this.subscriptionId,
      hostEpoch: this.hostEpoch,
      sequence: ++this.#sequence,
      throughSequence,
    };
    this.push(frame);
  }
  setRoot(rootTurn: SessionContinuitySnapshot['rootTurn']): void {
    this.snapshot = {
      ...this.snapshot,
      projectionRevision: this.snapshot.projectionRevision + 1,
      rootTurn,
    };
    this.push({
      kind: 'subscription.session_projection',
      subscriptionId: this.subscriptionId,
      hostEpoch: this.hostEpoch,
      sequence: ++this.#sequence,
      snapshot: structuredClone(this.snapshot),
    });
  }
  push(frame: SubscriptionFrame): void {
    if (this.#waiting) {
      this.#waiting.resolve({ done: false, value: frame });
      this.#waiting = undefined;
    } else this.#frames.push(frame);
  }
  fail(error: Error): void {
    this.#waiting?.reject(error);
    this.#waiting = undefined;
  }
  async loadTranscript<T>(decodeMessage: (value: unknown) => T): Promise<T[]> {
    this.bootstrapReads += 1;
    return this.initialTranscript.map(decodeMessage);
  }
  async loadTranscriptOverlay<T>(): Promise<T[]> {
    return [];
  }
  async loadTranscriptPage(
    input: Omit<SessionTranscriptPageInput, 'subscriptionId'>,
  ): Promise<SessionTranscriptPage> {
    this.pages.push(input);
    return this.readPage(input);
  }
  async decodeTranscriptPage<T>(
    page: SessionTranscriptPage,
    decodeMessage: (value: unknown) => T,
    maxMessageBytes?: number,
  ): Promise<DecodedSessionTranscriptPage<T>> {
    assert.equal(maxMessageBytes, SESSION_TRANSCRIPT_RANGE_MAX_BYTES);
    return {
      messages: (this.#decoded.get(page) ?? []).map(({ identity, message }) => ({
        identity,
        message: decodeMessage(message),
      })),
      nextCursor: page.nextCursor,
    };
  }
  page(
    input: Omit<SessionTranscriptPageInput, 'subscriptionId'>,
    messages: readonly { identity: number; message: StoredMessage }[],
    nextCursor: string | null = null,
  ): SessionTranscriptPage {
    const page: SessionTranscriptPage = {
      kind: 'page',
      sessionId: 'session',
      source: input.source,
      direction: input.direction,
      throughSequence: input.throughSequence,
      rawBytes: 0,
      fragments: [],
      rangeBoundarySequence: null,
      protectedTurnSequence: null,
      nextCursor,
    };
    this.#decoded.set(page, messages);
    return page;
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#waiting?.resolve({ value: undefined, done: true });
    this.#waiting = undefined;
  }
}

function result(toolUseId: string, text: string): StoredMessage {
  return {
    type: 'tool_result',
    id: `result-${toolUseId}`,
    turnId: 'turn',
    ts: 2,
    toolUseId,
    isError: false,
    content: { kind: 'text', text },
  };
}
function terminal(): StoredMessage {
  return { type: 'turn_state', id: 'terminal', turnId: 'turn', ts: 3, status: 'completed' };
}

function runningTurn(turnId: string) {
  return { sessionId: 'session', turnId, runId: `run-${turnId}`, status: 'running' as const };
}
