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
import { encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';
import { createDesktopTranscriptRangeController, DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import {
  createAppShellSessionUiStateController,
  TranscriptReadingPositionController,
  type TranscriptReadingPositionCommands,
  TranscriptReadSupersededError,
} from '../../renderer/features/conversation/index.js';
import {
  createTranscriptRestoreLifecycle,
  prepareTranscriptForSend,
  restoreSessionTranscriptRange,
} from '../../renderer/features/conversation/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

test('sending before transcript open completes supersedes the queued bookmark without delaying admission', { timeout: 5_000 }, async () => {
  const sessionId = JSON.stringify(['host-1', 'session-1']);
  const store = new DesktopTranscriptRangeStore(sessionId);
  const opening = deferred<DesktopTranscriptHandle>();
  const controller = createDesktopTranscriptRangeController(store, () => opening.promise);
  const lifecycle = createTranscriptRestoreLifecycle();
  const requests: Array<{ sequence: number | null; navigation: number }> = [];
  const publish = (sequence: number | null, navigation: number) => {
    requests.push({ sequence, navigation });
    const turnId = sequence === null ? 'b' : 'a';
    for (const batch of encodeDesktopTranscriptSnapshot({
      sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1',
      durableThrough: 20,
      durable: [{ sequence: sequence ?? 20, message: {
        type: 'assistant', id: `answer-${turnId}`, turnId, text: turnId, ts: 1, modelId: 'fixture',
      } }], overlay: [], hasOlder: true, hasNewer: sequence !== null,
    }, navigation)) store.accept(batch);
  };
  const handle: DesktopTranscriptHandle = {
    sessionId, generation: 'generation-1', hostEpoch: 'host-1', readThroughMessageId: null,
    acknowledgeTail: async () => {},
    loadBefore: async () => {}, loadAfter: async () => {}, close: async () => {},
    async loadAround(sequence, _maxBytes, navigation) { publish(sequence, navigation); },
    async loadLatest(navigation) { publish(null, navigation); },
  };
  const restore = () => restoreSessionTranscriptRange({
    lifecycle, sessionId, controller, readingAnchor: { turnId: 'a', sequence: 10 },
    isCurrent: () => true,
    setReadingAnchor: () => assert.fail('the cancelled bookmark must not be restored'),
    onError: (error) => assert.fail(String(error)),
  });
  try {
    restore();
    assert.throws(() => store.range(), /not initialized/);
    let pins = 0;
    assert.equal(await prepareTranscriptForSend({
      sessionId, currentSessionId: { current: sessionId }, controller: { current: controller },
      cancel: (target) => lifecycle.cancel(target), followLatest: () => { pins += 1; },
    }), true, 'local admission must finish while transcript open is still pending');
    assert.equal(pins, 1);
    assert.equal(requests.length, 0);
    opening.resolve(handle);
    await new Promise((resolve) => setImmediate(resolve));
    restore();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests.map(({ sequence, navigation }) =>
      [sequence, navigation]), [[null, 2]]);
    assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['answer-b']);
    const latest = store.snapshot();
    for (const batch of encodeDesktopTranscriptSnapshot({
      sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1',
      durableThrough: 20,
      durable: [{ sequence: 10, message: {
        type: 'assistant', id: 'answer-a', turnId: 'a', text: 'a', ts: 1, modelId: 'fixture',
      } }], overlay: [], hasOlder: false, hasNewer: true,
    }, 1)) assert.equal(store.accept(batch), false);
    assert.strictEqual(store.snapshot(), latest, 'a late history response must not replace the latest range');
  } finally {
    opening.resolve(handle);
    await controller.close();
  }
});

test('an overlay-only bookmark stays available without loading another range', async () => {
  const sessionId = JSON.stringify(['host-1', 'session-1']);
  const store = new DesktopTranscriptRangeStore(sessionId);
  const overlay: StoredMessage = {
    type: 'assistant', id: 'answer-b', turnId: 'b', text: 'partial B', ts: 1, modelId: 'fixture',
  };
  for (const batch of encodeDesktopTranscriptSnapshot({
    sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1',
    durableThrough: null, durable: [], overlay: [overlay], hasOlder: false, hasNewer: false,
  })) store.accept(batch);
  const controller = createDesktopTranscriptRangeController(store, async () => ({
    sessionId, generation: 'generation-1', hostEpoch: 'host-1', readThroughMessageId: null,
    acknowledgeTail: async () => {},
    loadBefore: async () => {}, loadAfter: async () => {}, close: async () => {},
    loadAround: async () => assert.fail('an overlay-only bookmark has no page to load'),
    loadLatest: async () => assert.fail('an overlay-only bookmark has no page to load'),
  }));
  const lifecycle = createTranscriptRestoreLifecycle();
  let unavailable = 0;
  let cleared = 0;
  const restore = () => restoreSessionTranscriptRange({
    lifecycle, sessionId, controller, readingAnchor: { turnId: 'b' },
    isCurrent: () => true,
    setReadingAnchor: (_sessionId, anchor) => { if (!anchor) cleared += 1; },
    onRestoreUnavailable: () => { unavailable += 1; }, onError: (error) => assert.fail(String(error)),
  });
  try {
    restore();
    await new Promise((resolve) => setImmediate(resolve));
    restore();
    assert.equal(store.sequenceForTurn('b'), null);
    assert.equal(unavailable, 0);
    assert.equal(cleared, 0);
  } finally {
    await controller.close();
  }
});

test('a failed return to the tail reports to its own Session', async () => {
  const fixture = controllerFixture();
  const errors: string[] = [];
  fixture.props.onNavigationError = (error) => { errors.push(String(error)); };
  fixture.controller.loadLatest = async () => { throw new Error('tail read failed'); };
  await fixture.render();

  await fixture.commands.current!.returnToLatest();
  assert.deepEqual(errors, ['Error: tail read failed']);
});

test('an old Session return to the tail cannot report against the new Session', async () => {
  const fixture = controllerFixture();
  const first = deferred<void>();
  fixture.props.onNavigationError = () => assert.fail('a superseded Session must not report');
  fixture.controller.loadLatest = () => first.promise;
  await fixture.render();
  const returningFirst = fixture.commands.current!.returnToLatest();

  fixture.props.currentSessionId.current = 'session-2';
  fixture.props.sessionId = 'session-2';
  fixture.props.rangeController.current = {
    ...fixture.controller,
    store: { ...fixture.controller.store, sessionId: 'session-2', range: () => ({ sessionId: 'session-2' }) },
    loadLatest: async () => {},
  };
  await fixture.render();
  await fixture.commands.current!.returnToLatest();

  first.reject(new Error('superseded tail request failed'));
  await returningFirst;
});

test('filling an edge leaves an outstanding jump alone', async () => {
  const fixture = controllerFixture();
  let cleared = 0;
  fixture.props.searchTarget = { sessionId: 'session-1', nonce: 1, turnId: 'turn-1' } as never;
  fixture.props.clearSearchTarget = () => { cleared += 1; };
  const failure = new Error('the older read failed');
  fixture.controller.loadBefore = async () => { throw failure; };
  await fixture.render();

  // The jump is still in flight; the band asking for the edge it is scrolling
  // towards decides nothing, so it must not answer for the reader.
  await assert.rejects(fixture.commands.current!.prefetchHistory('older'), failure);
  assert.equal(cleared, 0);
});

for (const known of [true, false]) {
test(`a bookmark ${known ? 'survives' : 'cannot outlive'} a Host epoch change`, async () => {
  const fixture = controllerFixture();
  const landmarks = known ? [{ turnId: 'turn-t', sequence: 77, label: 'T' }] : [];
  let range = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
  fixture.controller.store.range = () => range;
  fixture.props.listTurnLandmarks = async () => ({ throughSequence: 80, landmarks });
  const loaded: number[] = [];
  fixture.controller.loadAround = async (sequence: number) => { loaded.push(sequence); };
  await fixture.render();
  fixture.props.sessionUi.setTranscriptReadingAnchor('session-1', { turnId: 'turn-t', sequence: 10 });

  range = { sessionId: 'session-1', generation: 'generation-2', hostEpoch: 'host-2' };
  fixture.props.messages = [];
  await fixture.render();
  await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });

  // The old epoch's sequence names a different row, so only the Turn resolved
  // in the new epoch may be navigated to.
  assert.deepEqual(loaded, known ? [77] : []);
  assert.deepEqual(
    fixture.props.sessionUi.transcriptReadingAnchorBySessionRef.current['session-1'],
    { turnId: 'turn-t', sequence: known ? 77 : 10 },
  );
});
}

test('a read superseded by a Host epoch change leaves the bookmark alone', async () => {
  const sessionId = 'session-1';
  const lifecycle = createTranscriptRestoreLifecycle();
  const controller = {
    store: {
      sessionId,
      range: () => ({ sessionId }),
      sequenceForTurn: () => null,
      newestDurableUserSequence: () => null,
      snapshot: () => ({ messages: [] }),
    },
    loadAround: async () => {
      throw new TranscriptReadSupersededError('Desktop transcript host epoch changed; reopen the transcript');
    },
  };
  restoreSessionTranscriptRange({
    lifecycle, sessionId, controller, readingAnchor: { turnId: 'turn-t', sequence: 10 },
    isCurrent: () => true,
    setReadingAnchor: () => assert.fail('a superseded read must not clear the bookmark'),
    onRestoreUnavailable: () => assert.fail('a superseded read decides nothing about the bookmark'),
    onError: (error) => assert.fail(String(error)),
  });
  await new Promise((resolve) => setImmediate(resolve));
});

test('retaining the reader window trims the store to the visible Turns', async () => {
  const fixture = controllerFixture();
  const retained: Array<[number | null, number | null]> = [];
  fixture.controller.store.sequenceForTurn = (turnId: string, edge?: 'first' | 'last') =>
    turnId === 'first' ? 10 : turnId === 'last' ? (edge === 'last' ? 21 : 20) : null;
  fixture.controller.store.retain = (oldest, newest) => {
    retained.push([oldest, newest]);
    return true;
  };
  await fixture.render();

  fixture.commands.current!.retainWindow({ firstTurnId: 'first', lastTurnId: 'last' });
  assert.deepEqual(retained, [[10, 21]]);
});

function controllerFixture() {
  const { root } = installReactRenderer();
  const commands = createRef<TranscriptReadingPositionCommands>();
  const controller = {
    loadAround: async (_sequence: number) => {},
    loadBefore: async () => true,
    loadAfter: async () => true,
    loadLatest: async () => {},
    store: {
      sessionId: 'session-1',
      range: () => ({ sessionId: 'session-1' }),
      retain: (_oldest: number | null, _newest: number | null) => false,
      sequenceForTurn: (_turnId: string, _edge?: 'first' | 'last'): number | null => null,
      newestDurableUserSequence: () => null,
      snapshot: () => ({ messages: [] }),
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
    turnIndex: undefined,
    setTurnIndex: () => {},
    listTurnLandmarks: async () => ({ throughSequence: null, landmarks: [] }),
    onRestoreError: (error) => assert.fail(String(error)),
    onNavigationError: (error) => assert.fail(String(error)),
  };
  return {
    commands, controller, props,
    render: () => act(() => root.render(createElement(TranscriptReadingPositionController, props))),
  };
}
