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
import { encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';
import { createDesktopTranscriptRangeController, DesktopTranscriptRangeStore } from '../../renderer/desktop-transcript-range-store.js';
import {
  createAppShellSessionUiStateController,
  TranscriptReadingPositionController,
  type TranscriptReadingPositionCommands,
  type TranscriptHistoryPending,
  transcriptReadingPosition,
} from '../../renderer/features/conversation/index.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

test('a resident search admits history before an older latest response can evict its target', async () => {
  const sessionId = JSON.stringify(['host-1', 'session-1']);
  const store = new DesktopTranscriptRangeStore(sessionId);
  const latestStarted = deferred<void>();
  const releaseLatest = deferred<void>();
  const readingAdmitted = deferred<void>();
  const admissions: Array<{ sequence: number | null; version: number; preserveRange?: boolean }> = [];
  const publish = (turnId: string, sequence: number, navigationVersion: number) => {
    const message: StoredMessage = {
      type: 'assistant', id: `answer-${turnId}`, turnId, text: turnId, ts: 1, modelId: 'fixture',
    };
    for (const batch of encodeDesktopTranscriptSnapshot({
      sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1', navigationVersion,
      durableThrough: 20, durable: [{ sequence, message }], overlay: [], hasOlder: false, hasNewer: turnId === 'a',
    })) store.accept(batch);
  };
  publish('a', 10, 0);
  const controller = createDesktopTranscriptRangeController(store, async () => ({
    sessionId, generation: 'generation-1', hostEpoch: 'host-1', readThroughMessageId: null,
    loadBefore: async () => {}, loadAfter: async () => {},
    async loadAround(sequence, _maxBytes, navigation) {
      const version = navigation!.navigationVersion;
      admissions.push({ sequence, version, preserveRange: navigation!.preserveRange });
      if (sequence === null) {
        latestStarted.resolve();
        await releaseLatest.promise;
        publish('b', 20, version);
      } else {
        publish('a', 10, version);
        readingAdmitted.resolve();
      }
    },
    close: async () => {},
  }));
  try {
    const latest = controller.loadLatest();
    await latestStarted.promise;
    const lifecycle = transcriptReadingPosition.createRestoreLifecycle();
    const restore = () => transcriptReadingPosition.restoreRange({
      lifecycle, sessionId, controller,
      searchTarget: { sessionId, turnId: 'a', sequence: 10, nonce: 1 },
      isCurrent: () => true, setMessages: () => {}, setReadingAnchor: () => {},
      onError: (error) => assert.fail(String(error)),
    });
    restore();
    await readingAdmitted.promise;
    releaseLatest.resolve();
    await latest;
    await new Promise((resolve) => setImmediate(resolve));
    restore();
    assert.deepEqual(admissions, [
      { sequence: null, version: 1, preserveRange: undefined },
      { sequence: 10, version: 2, preserveRange: true },
    ]);
    assert.equal(store.sequenceForTurn('a'), 10);
    assert.equal(store.sequenceForTurn('b'), null);
  } finally {
    releaseLatest.resolve();
    await controller.close();
  }
});

for (const source of ['bootstrap overlay', 'live projection'] as const) {
test(`a ${source} bookmark admits its Turn once and retains it across range reload`, async () => {
  const sessionId = JSON.stringify(['host-1', 'session-1']);
  const store = new DesktopTranscriptRangeStore(sessionId);
  const overlay: StoredMessage = {
    type: 'assistant', id: 'answer-b', turnId: 'b', text: 'partial B', ts: 1, modelId: 'fixture',
  };
  const publish = (navigationVersion: number) => {
    for (const batch of encodeDesktopTranscriptSnapshot({
      sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1', navigationVersion,
      durableThrough: null, durable: [], overlay: source === 'bootstrap overlay' ? [overlay] : [],
      hasOlder: false, hasNewer: false,
    })) store.accept(batch);
  };
  publish(0);
  const admissions: Array<{ sequence: number | null; turnId?: string; version: number; preserveRange?: boolean }> = [];
  const controller = createDesktopTranscriptRangeController(store, async () => ({
    sessionId, generation: 'generation-1', hostEpoch: 'host-1', readThroughMessageId: null,
    loadBefore: async () => {}, loadAfter: async () => {}, close: async () => {},
    async loadAround(sequence, _maxBytes, navigation) {
      admissions.push({ sequence, turnId: navigation!.readingTurnId,
        version: navigation!.navigationVersion, preserveRange: navigation!.preserveRange });
      publish(navigation!.navigationVersion);
    },
  }));
  const lifecycle = transcriptReadingPosition.createRestoreLifecycle();
  let unavailable = 0;
  let cleared = 0;
  const restore = () => transcriptReadingPosition.restoreRange({
    lifecycle, sessionId, controller, readingAnchor: { turnId: 'b' },
    isCurrent: () => true, setMessages: () => {},
    isLiveTurn: (candidateSessionId, turnId) => source === 'live projection' &&
      candidateSessionId === sessionId && turnId === 'b',
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
    assert.deepEqual(admissions, [{ sequence: null, turnId: 'b', version: 1, preserveRange: true }]);
    await controller.reload();
    assert.deepEqual(admissions[1], { sequence: null, turnId: 'b', version: 1, preserveRange: false });
  } finally {
    await controller.close();
  }
});
}

test('both paging directions retain an overlay-only Turn identity and admit a fresh intent', async () => {
  const sessionId = JSON.stringify(['host-1', 'session-1']);
  const store = new DesktopTranscriptRangeStore(sessionId);
  const message = (turnId: string): StoredMessage => ({
    type: 'assistant', id: `answer-${turnId}`, turnId, text: turnId, ts: 1, modelId: 'fixture',
  });
  for (const batch of encodeDesktopTranscriptSnapshot({
    sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1', navigationVersion: 0,
    durableThrough: 40, durable: [{ sequence: 10, message: message('a') }],
    overlay: [message('b')], hasOlder: true, hasNewer: true,
  })) store.accept(batch);
  const calls: Array<{ operation: string; sequence: number | null; turnId?: string; version?: number }> = [];
  const record = (operation: string) => async (sequence: number | null, _maxBytes?: number,
    navigation?: import('../../preload/transcript-contract.js').DesktopTranscriptNavigation) => {
    calls.push({ operation, sequence, turnId: navigation?.readingTurnId, version: navigation?.navigationVersion });
  };
  const controller = createDesktopTranscriptRangeController(store, async () => ({
    sessionId, generation: 'generation-1', hostEpoch: 'host-1', readThroughMessageId: null,
    loadBefore: record('before'), loadAfter: record('after'), loadAround: record('around'), close: async () => {},
  }));
  try {
    await controller.setReadingAnchor(null, 'b');
    await controller.loadBefore(undefined, 'b');
    await controller.loadAfter(undefined, 'b');
    await controller.loadBefore(undefined, 'a');
    await controller.loadAfter(undefined, 'a');
    assert.deepEqual(calls, [
      { operation: 'around', sequence: null, turnId: 'b', version: 1 },
      { operation: 'around', sequence: null, turnId: 'b', version: 2 },
      { operation: 'around', sequence: null, turnId: 'b', version: 3 },
      { operation: 'before', sequence: 10, turnId: 'a', version: 4 },
      { operation: 'after', sequence: 10, turnId: 'a', version: 5 },
    ]);
  } finally {
    await controller.close();
  }
});

test('returning to latest supersedes pending history without letting its completion clear the new pending state', async () => {
  const fixture = controllerFixture();
  const older = deferred<void>();
  const latest = deferred<void>();
  const calls: string[] = [];
  fixture.controller.loadBefore = async () => { calls.push('older'); await older.promise; };
  fixture.controller.loadLatest = async () => { calls.push('latest'); await latest.promise; };
  await fixture.render();

  const loadingOlder = fixture.commands.current!.loadHistory('earlier');
  await fixture.commands.current!.loadHistory('earlier');
  const loadingLatest = fixture.commands.current!.loadHistory('latest');
  assert.deepEqual(calls, ['older', 'latest']);

  older.reject(new Error('superseded history request failed'));
  await loadingOlder;
  assert.equal(fixture.pending(), 'session-1');
  latest.resolve();
  await loadingLatest;
  assert.equal(fixture.pending(), undefined);
});

test('a new Session can load history while the previous Session request is still pending', async () => {
  const fixture = controllerFixture();
  const first = deferred<void>();
  const second = deferred<void>();
  fixture.controller.loadBefore = () => first.promise;
  await fixture.render();
  const loadingFirst = fixture.commands.current!.loadHistory('earlier');

  const secondController = { ...fixture.controller,
    store: { ...fixture.controller.store, range: () => ({ sessionId: 'session-2' }) },
    loadBefore: () => second.promise,
  };
  fixture.props.currentSessionId.current = 'session-2';
  fixture.props.rangeController.current = secondController;
  fixture.props.sessionId = 'session-2';
  await fixture.render();
  const loadingSecond = fixture.commands.current!.loadHistory('earlier');
  assert.equal(fixture.pending(), 'session-2');

  first.resolve();
  await loadingFirst;
  assert.equal(fixture.pending(), 'session-2');
  second.resolve();
  await loadingSecond;
  assert.equal(fixture.pending(), undefined);
});

test('a new earlier request supersedes pending return-to-latest navigation', async () => {
  const fixture = controllerFixture();
  const latest = deferred<void>();
  const earlier = deferred<void>();
  const calls: string[] = [];
  fixture.controller.loadLatest = async () => { calls.push('latest'); await latest.promise; };
  fixture.controller.loadBefore = async () => { calls.push('earlier'); await earlier.promise; };
  await fixture.render();

  const loadingLatest = fixture.commands.current!.loadHistory('latest');
  const loadingEarlier = fixture.commands.current!.loadHistory('earlier');
  assert.deepEqual(calls, ['latest', 'earlier']);
  latest.resolve();
  await loadingLatest;
  assert.equal(fixture.pending(), 'session-1');
  earlier.resolve();
  await loadingEarlier;
  assert.equal(fixture.pending(), undefined);
});

test('an old Session controller cannot clear pending history after returning to the same Session', async () => {
  const fixture = controllerFixture();
  const first = deferred<void>();
  const replacement = deferred<void>();
  fixture.controller.loadBefore = () => first.promise;
  await fixture.render();
  const loadingFirst = fixture.commands.current!.loadHistory('earlier');

  fixture.props.currentSessionId.current = 'session-2';
  fixture.props.sessionId = 'session-2';
  fixture.props.rangeController.current = {
    ...fixture.controller,
    store: { ...fixture.controller.store, range: () => ({ sessionId: 'session-2' }) },
  };
  await fixture.render();
  fixture.props.currentSessionId.current = 'session-1';
  fixture.props.sessionId = 'session-1';
  fixture.props.rangeController.current = {
    ...fixture.controller,
    loadBefore: () => replacement.promise,
  };
  await fixture.render();
  const loadingReplacement = fixture.commands.current!.loadHistory('earlier');
  assert.equal(fixture.pending(), 'session-1');

  first.resolve();
  await loadingFirst;
  assert.equal(fixture.pending(), 'session-1');
  replacement.resolve();
  await loadingReplacement;
  assert.equal(fixture.pending(), undefined);
});

function controllerFixture() {
  const { root } = installReactRenderer();
  const commands = createRef<TranscriptReadingPositionCommands>();
  const controller = {
    ready: async () => {},
    loadAround: async () => {},
    loadBefore: async () => {},
    loadAfter: async () => {},
    loadLatest: async () => {},
    setReadingAnchor: async () => {},
    store: {
      range: () => ({ sessionId: 'session-1' }),
      sequenceForTurn: () => null,
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
    setMessages: () => {},
    setHistoryPending: (next) => { pending = typeof next === 'function' ? next(pending) : next; },
    historyPageBytes: 512 * 1024,
    onRestoreError: (error) => assert.fail(String(error)),
    onNavigationError: (error) => assert.fail(String(error)),
  };
  return {
    commands, controller, props, pending: () => pending?.sessionId,
    render: () => act(() => root.render(createElement(TranscriptReadingPositionController, props))),
  };
}
