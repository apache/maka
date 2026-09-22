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
import { afterEach, test } from 'node:test';
import { act, createElement, createRef, type ComponentProps } from 'react';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { StoredMessage } from '@maka/core/session';
import type { DesktopTranscriptHandle } from '../../preload/transcript-contract.js';
import { encodeDesktopTranscriptBatches, encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';
import { createDesktopTranscriptRangeController, DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import {
  createAppShellSessionUiStateController,
  TranscriptReadingPositionController,
  type TranscriptReadingPositionCommands,
} from '../../renderer/features/conversation/index.js';
import {
  createTranscriptRestoreLifecycle,
  prepareTranscriptForSend,
  restoreSessionTranscriptRange,
} from '../../renderer/features/conversation/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

const SESSION_ID = JSON.stringify(['host-1', 'session-1']);
const IDENTITY = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function answer(turnId: string): StoredMessage {
  return { type: 'assistant', id: `answer-${turnId}`, turnId, text: turnId, ts: 1, modelId: 'fixture' };
}

function handle(overrides: Partial<DesktopTranscriptHandle> = {}): DesktopTranscriptHandle {
  return {
    sessionId: SESSION_ID, generation: 'generation-1', hostEpoch: 'host-1', readThroughMessageId: null,
    acknowledgeTail: async () => {},
    loadEarlier: async () => assert.fail('unexpected earlier history read'),
    close: async () => {},
    ...overrides,
  };
}

async function restoreFromEarlierHistory(lookupTurn?: (sessionId: string, turnId: string) => Promise<number | undefined>) {
  const store = new DesktopTranscriptRangeStore(SESSION_ID);
  for (const batch of encodeDesktopTranscriptSnapshot({
    beginsAtTurnBoundary: true,
    ...IDENTITY, durableThrough: 30, durable: [{ sequence: 30, message: answer('c') }], hasOlder: true,
  })) store.accept(batch);
  const reads: (number | undefined)[] = [];
  const controller = createDesktopTranscriptRangeController(store, async () => handle({
    async loadEarlier(throughSequence) {
      reads.push(throughSequence);
      for (const batch of encodeDesktopTranscriptBatches(IDENTITY, {
        durableThrough: 30,
        durable: [{ sequence: 10, message: answer('a') }, { sequence: 20, message: answer('b') }],
        hasOlder: false, earlierThan: 30, reset: false, ready: true,
      })) store.accept(batch);
    },
  }), { onError: (error) => assert.fail(String(error)) });
  let anchor: { turnId: string } | undefined = { turnId: 'a' };
  const unavailable: string[] = [];
  const lifecycle = createTranscriptRestoreLifecycle();
  const restore = () => restoreSessionTranscriptRange({
    lifecycle, sessionId: SESSION_ID, controller, readingAnchor: { turnId: 'a' },
    isCurrent: () => true,
    lookupTurn,
    setReadingAnchor: (_sessionId, next) => { anchor = next; },
    onRestoreUnavailable: (_sessionId, turnId) => { unavailable.push(turnId); },
    onError: (error) => assert.fail(String(error)),
  });
  try {
    await controller.ready();
    restore();
    for (let tick = 0; tick < 4; tick += 1) await settle();
    restore();
    await settle();
    return { reads, anchor, unavailable, turns: store.snapshot().messages.map(({ turnId }) => turnId) };
  } finally {
    await controller.close();
  }
}

test('a bookmark older than the loaded history is read down to in one request located by the Turn index', async () => {
  const lookups: string[] = [];
  const result = await restoreFromEarlierHistory(async (_sessionId, turnId) => {
    lookups.push(turnId);
    return 10;
  });
  assert.deepEqual(lookups, ['a']);
  assert.deepEqual(result.reads, [10], 'a restored bookmark reads nothing more');
  assert.deepEqual(result.turns, ['a', 'b', 'c']);
  assert.deepEqual(result.anchor, { turnId: 'a' });
  assert.deepEqual(result.unavailable, []);
});

test('a bookmark the Turn index does not know, or cannot be asked about, is unavailable without reading history', async () => {
  for (const lookupTurn of [async () => undefined, undefined]) {
    const result = await restoreFromEarlierHistory(lookupTurn);
    assert.deepEqual(result.reads, []);
    assert.equal(result.anchor, undefined);
    assert.deepEqual(result.unavailable, ['a']);
  }
});

test('a cached transcript keeps a stored bookmark pending until the live answer replaces it', async () => {
  const store = new DesktopTranscriptRangeStore(SESSION_ID);
  for (const batch of encodeDesktopTranscriptSnapshot({
    beginsAtTurnBoundary: true,
    ...IDENTITY, generation: 'cached:generation', durableThrough: 30,
    durable: [{ sequence: 30, message: answer('c') }], hasOlder: true,
  })) store.accept(batch);
  const reads: (number | undefined)[] = [];
  const lookups: string[] = [];
  const controller = createDesktopTranscriptRangeController(store, async () => handle({
    async loadEarlier(throughSequence) {
      reads.push(throughSequence);
      for (const batch of encodeDesktopTranscriptBatches(IDENTITY, {
        durableThrough: 30,
        durable: [{ sequence: 10, message: answer('a') }, { sequence: 20, message: answer('b') }],
        hasOlder: false, earlierThan: 30, reset: false, ready: true,
      })) store.accept(batch);
    },
  }), { onError: (error) => assert.fail(String(error)) });
  let anchor: { turnId: string } | undefined = { turnId: 'a' };
  const unavailable: string[] = [];
  const lifecycle = createTranscriptRestoreLifecycle();
  const restore = () => restoreSessionTranscriptRange({
    lifecycle, sessionId: SESSION_ID, controller, readingAnchor: { turnId: 'a' },
    isCurrent: () => true,
    lookupTurn: async (_sessionId, turnId) => { lookups.push(turnId); return 10; },
    setReadingAnchor: (_sessionId, next) => { anchor = next; },
    onRestoreUnavailable: (_sessionId, turnId) => { unavailable.push(turnId); },
    onError: (error) => assert.fail(String(error)),
  });
  try {
    await controller.ready();
    restore();
    for (let tick = 0; tick < 4; tick += 1) await settle();
    restore();
    await settle();
    assert.deepEqual(lookups, []);
    assert.deepEqual(reads, []);
    assert.deepEqual(anchor, { turnId: 'a' });
    assert.deepEqual(unavailable, []);
    for (const batch of encodeDesktopTranscriptSnapshot({
      beginsAtTurnBoundary: true,
      ...IDENTITY, durableThrough: 30,
      durable: [{ sequence: 30, message: answer('c') }], hasOlder: true,
    })) store.accept(batch);
    restore();
    for (let tick = 0; tick < 4; tick += 1) await settle();
    restore();
    await settle();
    assert.deepEqual(lookups, ['a']);
    assert.deepEqual(reads, [10]);
    assert.deepEqual(store.snapshot().messages.map(({ turnId }) => turnId), ['a', 'b', 'c']);
    assert.deepEqual(anchor, { turnId: 'a' });
    assert.deepEqual(unavailable, []);
  } finally {
    await controller.close();
  }
});

test('sending before transcript open completes cancels the queued bookmark without delaying admission', { timeout: 5_000 }, async () => {
  const store = new DesktopTranscriptRangeStore(SESSION_ID);
  const opening = deferred<DesktopTranscriptHandle>();
  const controller = createDesktopTranscriptRangeController(store, () => opening.promise, {
    onError: (error) => assert.fail(String(error)),
  });
  const lifecycle = createTranscriptRestoreLifecycle();
  let reads = 0;
  const restore = () => restoreSessionTranscriptRange({
    lifecycle, sessionId: SESSION_ID, controller, readingAnchor: { turnId: 'a' },
    isCurrent: () => true,
    setReadingAnchor: () => assert.fail('the cancelled bookmark must not be settled'),
    onError: (error) => assert.fail(String(error)),
  });
  try {
    restore();
    assert.throws(() => store.range(), /not initialized/);
    let pins = 0;
    assert.equal(prepareTranscriptForSend({
      sessionId: SESSION_ID, currentSessionId: { current: SESSION_ID },
      cancel: (target) => lifecycle.cancel(target), followLatest: () => { pins += 1; },
    }), true, 'local admission must finish while transcript open is still pending');
    assert.equal(pins, 1);
    opening.resolve(handle({ loadEarlier: async () => { reads += 1; } }));
    for (const batch of encodeDesktopTranscriptSnapshot({
      beginsAtTurnBoundary: true,
      ...IDENTITY, durableThrough: 20, durable: [{ sequence: 20, message: answer('b') }], hasOlder: true,
    })) store.accept(batch);
    await settle();
    restore();
    await settle();
    assert.equal(reads, 0, 'the cancelled bookmark must not load earlier history');
  } finally {
    await controller.close();
  }
});

test('loading earlier history only reaches the current Session controller', async () => {
  const fixture = controllerFixture();
  let first = 0;
  let second = 0;
  fixture.controller.loadEarlier = async () => { first += 1; };
  await fixture.render();
  await fixture.commands.current!.loadEarlier();
  assert.equal(first, 1);

  fixture.props.currentSessionId.current = 'session-2';
  await fixture.commands.current!.loadEarlier();
  assert.equal(first, 1, 'a superseded Session cannot load history');

  fixture.props.sessionId = 'session-2';
  fixture.props.rangeController.current = {
    ...fixture.controller,
    store: { ...fixture.controller.store, range: () => ({ sessionId: 'session-2', hasOlder: true, ready: true }) },
    loadEarlier: async () => { second += 1; },
  };
  await fixture.render();
  await fixture.commands.current!.loadEarlier();
  assert.deepEqual([first, second], [1, 1]);
});

test('captured reading anchors belong to the current Session and preparing a send clears them', async () => {
  const fixture = controllerFixture();
  let followed: string[] = [];
  fixture.props.sessionUi.transcriptViewportNavigation.subscribe((sessionId) => { followed = [...followed, sessionId]; });
  await fixture.render();
  const anchors = fixture.props.sessionUi.transcriptReadingAnchorBySessionRef;

  fixture.commands.current!.captureAnchor('turn-1');
  assert.deepEqual(anchors.current['session-1'], { turnId: 'turn-1' });

  assert.equal(fixture.commands.current!.prepareSend('session-2'), false);
  assert.deepEqual(followed, []);
  assert.equal(fixture.commands.current!.prepareSend('session-1'), true);
  assert.deepEqual(followed, ['session-1']);
  assert.equal(anchors.current['session-1'], undefined);

  fixture.props.currentSessionId.current = 'session-2';
  fixture.commands.current!.captureAnchor('turn-2');
  assert.equal(anchors.current['session-1'], undefined, 'a superseded Session cannot capture an anchor');
});

test('a Turn index read that failed is read again when the transcript reopens', async () => {
  const fixture = controllerFixture();
  let generation = 'generation-1';
  fixture.controller.store.range = () => ({ sessionId: 'session-1', hasOlder: true, ready: true, generation });
  let reads = 0;
  const indexes: unknown[] = [];
  fixture.props.listTurnLandmarks = async () => {
    reads += 1;
    if (reads === 1) throw new Error('Host reconnecting');
    return { landmarks: [{ turnId: 'turn-1', sequence: 10, lastSequence: 19, label: 'First' }] };
  };
  fixture.props.setTurnIndex = (index) => { indexes.push(index); };
  await fixture.render();
  await act(settle);
  assert.deepEqual(indexes, []);

  generation = 'generation-2';
  await fixture.render();
  await act(settle);
  assert.equal(reads, 2);
  assert.deepEqual(indexes, [{
    sessionId: 'session-1',
    turns: [{ turnId: 'turn-1', sequence: 10, lastSequence: 19, label: 'First' }],
  }]);
});

function controllerFixture() {
  const { root } = installReactRenderer();
  const commands = createRef<TranscriptReadingPositionCommands>();
  const controller = {
    loadEarlier: async () => {},
    store: {
      range: () => ({ sessionId: 'session-1', hasOlder: true, ready: true }),
      snapshot: () => ({ messages: [] as StoredMessage[] }),
    },
  };
  const props: ComponentProps<typeof TranscriptReadingPositionController> = {
    commands,
    sessionId: 'session-1',
    currentSessionId: { current: 'session-1' },
    rangeController: { current: controller },
    messages: [],
    searchTarget: undefined,
    clearSearchTarget: () => {},
    sessionUi: createAppShellSessionUiStateController(),
    landmarkSessionId: 'session-1',
    listTurnLandmarks: async () => ({ landmarks: [] }),
    setTurnIndex: () => {},
    onRestoreError: (error) => assert.fail(String(error)),
  };
  return {
    commands, controller, props,
    render: () => act(() => root.render(createElement(TranscriptReadingPositionController, props))),
  };
}
