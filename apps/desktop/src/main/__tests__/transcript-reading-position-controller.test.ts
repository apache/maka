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
import type { DesktopTranscriptHandle, DesktopTranscriptNavigation } from '../../preload/transcript-contract.js';
import { encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';
import { createDesktopTranscriptRangeController, DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import {
  createAppShellSessionUiStateController,
  TranscriptReadingPositionController,
  type TranscriptReadingPositionCommands,
  type TranscriptHistoryPending,
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
  const requests: Array<{ sequence: number | null; navigation?: DesktopTranscriptNavigation }> = [];
  const publish = (sequence: number | null, navigation: DesktopTranscriptNavigation) => {
    requests.push({ sequence, navigation });
    const turnId = sequence === null ? 'b' : 'a';
    for (const batch of encodeDesktopTranscriptSnapshot({
      sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1',
      navigationVersion: navigation.navigationVersion, durableThrough: 20,
      durable: [{ sequence: sequence ?? 20, message: {
        type: 'assistant', id: `answer-${turnId}`, turnId, text: turnId, ts: 1, modelId: 'fixture',
      } }], overlay: [], hasOlder: true, hasNewer: sequence !== null,
    })) store.accept(batch);
  };
  const handle: DesktopTranscriptHandle = {
    sessionId, generation: 'generation-1', hostEpoch: 'host-1', readThroughMessageId: null,
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
      [sequence, navigation?.navigationVersion]), [[null, 2]]);
    assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['answer-b']);
    const latest = store.snapshot();
    for (const batch of encodeDesktopTranscriptSnapshot({
      sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1',
      navigationVersion: 1, durableThrough: 20,
      durable: [{ sequence: 10, message: {
        type: 'assistant', id: 'answer-a', turnId: 'a', text: 'a', ts: 1, modelId: 'fixture',
      } }], overlay: [], hasOlder: false, hasNewer: true,
    })) assert.equal(store.accept(batch), false);
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
    sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1', navigationVersion: 0,
    durableThrough: null, durable: [], overlay: [overlay], hasOlder: false, hasNewer: false,
  })) store.accept(batch);
  const controller = createDesktopTranscriptRangeController(store, async () => ({
    sessionId, generation: 'generation-1', hostEpoch: 'host-1', readThroughMessageId: null,
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

test('a history load holds its pending state until the page settles', async () => {
  const fixture = controllerFixture();
  const older = deferred<void>();
  const calls: string[] = [];
  fixture.controller.loadBefore = async () => { calls.push('older'); await older.promise; };
  await fixture.render();

  const loading = fixture.commands.current!.loadHistory('earlier');
  assert.deepEqual(calls, ['older']);
  assert.equal(fixture.pending(), 'session-1');
  older.resolve();
  await loading;
  assert.equal(fixture.pending(), undefined);
});

test('a failed history load reports to its own Session and clears its pending state', async () => {
  const fixture = controllerFixture();
  const errors: string[] = [];
  fixture.props.onNavigationError = (error) => { errors.push(String(error)); };
  fixture.controller.loadAfter = async () => { throw new Error('later read failed'); };
  await fixture.render();

  await fixture.commands.current!.loadHistory('later');
  assert.deepEqual(errors, ['Error: later read failed']);
  assert.equal(fixture.pending(), undefined);
});

test('an old Session history load cannot report or clear the new Session state', async () => {
  const fixture = controllerFixture();
  const first = deferred<void>();
  fixture.props.onNavigationError = () => assert.fail('a superseded Session must not report');
  fixture.controller.loadBefore = () => first.promise;
  await fixture.render();
  const loadingFirst = fixture.commands.current!.loadHistory('earlier');
  assert.equal(fixture.pending(), 'session-1');

  fixture.props.currentSessionId.current = 'session-2';
  fixture.props.sessionId = 'session-2';
  fixture.props.rangeController.current = {
    ...fixture.controller,
    store: { ...fixture.controller.store, sessionId: 'session-2', range: () => ({ sessionId: 'session-2' }) },
    loadBefore: async () => {},
  };
  await fixture.render();
  const loadingSecond = fixture.commands.current!.loadHistory('earlier');
  await loadingSecond;
  assert.equal(fixture.pending(), undefined);

  first.reject(new Error('superseded history request failed'));
  await loadingFirst;
  assert.equal(fixture.pending(), undefined);
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
    loadAround: async () => {},
    loadBefore: async () => {},
    loadAfter: async () => {},
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
  let pending: TranscriptHistoryPending | undefined;
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
    setHistoryPending: (next) => { pending = typeof next === 'function' ? next(pending) : next; },
    onRestoreError: (error) => assert.fail(String(error)),
    onNavigationError: (error) => assert.fail(String(error)),
  };
  return {
    commands, controller, props, pending: () => pending?.sessionId,
    render: () => act(() => root.render(createElement(TranscriptReadingPositionController, props))),
  };
}
