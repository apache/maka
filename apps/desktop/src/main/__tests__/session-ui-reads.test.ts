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
import { describe, it } from 'node:test';
import { act, createElement, useSyncExternalStore } from 'react';
import { LocaleProvider, ToastProvider, type LiveTurnBuffer } from '@maka/ui';
import type { SandboxBoundaryRequestEvent } from '@maka/core/events';
import {
  ConversationServicesProvider,
  useAppShellSessionUiState,
  type AppShellSessionUiStateController,
} from '../../renderer/features/conversation/index.js';
import * as conversation from '../../renderer/features/conversation/index.js';
import {
  createProductionSessionUiStateController as createController,
  stubConversationServices,
} from '../../renderer/features/conversation/testing.js';
import { useAppShellSessionUiReads } from '../../renderer/use-app-shell-session-ui-reads.js';
import { createSessionCatalogController } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

function interaction(requestId: string): SandboxBoundaryRequestEvent {
  return {
    type: 'sandbox_boundary_request', id: requestId, turnId: 'turn', ts: 1,
    requestId, toolUseId: requestId, justification: 'Read a file.',
    expansion: { filesystem: { entries: [{ path: '/file', access: 'read', scope: 'exact' }] } },
  };
}

const changes = [
  ['queue', 'queue', (c: AppShellSessionUiStateController, id: string) =>
    c.setMessageQueueBySession((s) => ({ ...s, [id]: { ts: 1, entries: [] } }))],
  ['interaction', 'interaction', (c: AppShellSessionUiStateController, id: string) =>
    c.setInteractionBySession((s) => ({ ...s, [id]: [interaction(id)] }))],
  ['retry', 'retry', (c: AppShellSessionUiStateController, id: string) => c.messageRetryPending.claim(id)],
  ['stop', 'stop', (c: AppShellSessionUiStateController, id: string) => c.stopPending.claim(id)],
  ['load', 'load error', (c: AppShellSessionUiStateController, id: string) =>
    c.setMessageLoadErrorBySession((s) => ({ ...s, [id]: 'failed' }))],
  ['load', 'restore unavailable', (c: AppShellSessionUiStateController, id: string) =>
    c.setTranscriptRestoreUnavailable(id, 'missing-turn')],
] as const;

function live(text: string): LiveTurnBuffer {
  return [{
    turnId: 'turn',
    steps: [{ stepId: 'message', tools: [], text: { text, complete: false, truncated: false } }],
  }];
}

function start(c: AppShellSessionUiStateController, id: string) {
  c.setExecution(id, {
    type: 'host_execution', available: true,
    rootTurn: { sessionId: id, turnId: 'turn', runId: 'run', status: 'running' },
  });
  c.setLiveTurnBySession((s) => ({ ...s, [id]: live('first') }));
}

describe('Session UI public read capabilities', () => {
  it('has no whole-state getter/subscription or public construction/selector exports', () => {
    const controller = createController();
    assert.equal('getState' in controller, false);
    assert.equal('subscribe' in controller, false);
    for (const name of ['createAppShellSessionUiStateController', 'createSessionUiState', 'sessionUiSelectors', 'selectLiveTurns']) {
      assert.equal(name in conversation, false, name);
    }
    const queue = controller.reads.queue('A');
    assert.deepEqual(Object.keys(queue).sort(), ['getSnapshot', 'subscribe']);
  });

  for (const [kind, label, change] of changes) {
    it(`publishes ${label} only to its target and projection`, () => {
      const c = createController();
      const a = c.reads[kind]('A');
      const b = c.reads[kind]('B');
      const other = c.reads.shellRuns('A');
      let aCount = 0;
      let bCount = 0;
      let otherCount = 0;
      const before = a.getSnapshot();
      a.subscribe(() => { aCount += 1; });
      b.subscribe(() => { bCount += 1; });
      other.subscribe(() => { otherCount += 1; });
      change(c, 'B');
      assert.equal(aCount, 0);
      assert.equal(bCount, 1);
      assert.equal(otherCount, 0);
      assert.equal(a.getSnapshot(), before);
      change(c, 'A');
      assert.equal(aCount, 1);
      assert.equal(bCount, 1);
      assert.equal(otherCount, 0);
      assert.notEqual(a.getSnapshot(), before);
    });
  }

  it('separates token content, low-entropy chrome and global streaming membership', () => {
    const c = createController();
    start(c, 'A');
    const content = c.reads.liveTurns('A');
    const summary = c.reads.summary('A');
    const queue = c.reads.queue('A');
    const counts = { content: 0, summary: 0, queue: 0, pulse: 0 };
    content.subscribe(() => { counts.content += 1; });
    summary.subscribe(() => { counts.summary += 1; });
    queue.subscribe(() => { counts.queue += 1; });
    c.reads.streaming.subscribe(() => { counts.pulse += 1; });
    const summaryBefore = summary.getSnapshot();
    const pulseBefore = c.reads.streaming.getSnapshot();
    for (let i = 0; i < 20; i += 1) {
      c.setLiveTurnBySession((s) => ({ ...s, A: live(`first ${i}`) }));
    }
    assert.deepEqual(counts, { content: 20, summary: 0, queue: 0, pulse: 0 });
    assert.equal(summary.getSnapshot(), summaryBefore);
    assert.equal(c.reads.streaming.getSnapshot(), pulseBefore);
    start(c, 'B');
    assert.deepEqual([...c.reads.streaming.getSnapshot()], ['A', 'B']);
    assert.deepEqual(counts, { content: 20, summary: 0, queue: 0, pulse: 1 });
    c.setExecution('B', undefined);
    assert.deepEqual([...c.reads.streaming.getSnapshot()], ['A']);
    assert.deepEqual(counts, { content: 20, summary: 0, queue: 0, pulse: 2 });
  });

  it('clears all projections before notifying and leaves other sessions unchanged', () => {
    const c = createController();
    for (const [, , change] of changes) {
      change(c, 'A');
      change(c, 'B');
    }
    start(c, 'A');
    const queue = c.reads.queue('A');
    const load = c.reads.load('A');
    const stop = c.reads.stop('A');
    const otherQueue = c.reads.queue('B');
    let notifications = 0;
    let otherNotifications = 0;
    otherQueue.subscribe(() => { otherNotifications += 1; });
    for (const reader of [queue, load, stop, c.reads.streaming]) {
      reader.subscribe(() => {
        notifications += 1;
        assert.equal(queue.getSnapshot(), undefined);
        assert.deepEqual(load.getSnapshot(), { messageLoadError: undefined, unavailableTranscriptRestore: undefined });
        assert.equal(stop.getSnapshot(), false);
        assert.equal(c.reads.streaming.getSnapshot().has('A'), false);
      });
    }
    c.clearSessionUiState('A');
    assert.equal(notifications, 4);
    assert.equal(otherNotifications, 0);
    assert.ok(otherQueue.getSnapshot());
  });

  it('releases registrations, refreshes after inactivity and permits duplicate listeners', () => {
    const c = createController();
    const reader = c.reads.stop('A');
    let count = 0;
    const listener = () => { count += 1; };
    const first = reader.subscribe(listener);
    const second = reader.subscribe(listener);
    first();
    first();
    c.stopPending.claim('A');
    assert.equal(count, 1);
    second();
    c.stopPending.release('A');
    assert.equal(count, 1);
    assert.equal(reader.getSnapshot(), false);
    const third = reader.subscribe(listener);
    c.stopPending.claim('A');
    assert.equal(count, 2);
    third();
  });

  it('keeps another reader current during a reentrant publication', () => {
    const c = createController();
    const a = c.reads.stop('A');
    const b = c.reads.stop('B');
    a.subscribe(() => {
      c.stopPending.claim('B');
      assert.equal(b.getSnapshot(), true);
    });
    const seen: boolean[] = [];
    b.subscribe(() => seen.push(b.getSnapshot()));
    c.stopPending.claim('A');
    assert.deepEqual(seen, [true]);
  });
});

describe('production Session UI consumers', () => {
  it('keeps background state and pulse out of the shell, while respecting owner Session identity', async () => {
    const { root } = installReactRenderer();
    const c = createController();
    let renders = 0;
    let pulseRenders = 0;
    let value!: ReturnType<typeof useAppShellSessionUiReads>;
    let pulse!: ReadonlySet<string>;
    function Shell(props: { activeId?: string; ownerId?: string }) {
      renders += 1;
      value = useAppShellSessionUiReads(c.reads, props.activeId, props.ownerId);
      return null;
    }
    function Rail() {
      pulseRenders += 1;
      pulse = useSyncExternalStore(c.reads.streaming.subscribe, c.reads.streaming.getSnapshot, c.reads.streaming.getSnapshot);
      return null;
    }
    const render = (activeId?: string, ownerId?: string) =>
      createElement('div', null, createElement(Shell, { activeId, ownerId }), createElement(Rail));
    try {
      await act(async () => root.render(render('A', 'owner-A')));
      const initial = renders;
      for (const [, , change] of changes) {
        await act(async () => { change(c, 'B'); });
        assert.equal(renders, initial);
      }
      await act(async () => { start(c, 'B'); });
      assert.equal(renders, initial);
      assert.equal(pulseRenders, 2);
      assert.equal(pulse.has('B'), true);
      await act(async () => {
        c.setInteractionBySession((s) => ({ ...s, 'owner-A': [interaction('owner-request')] }));
      });
      assert.equal(value.activeInteraction?.requestId, 'owner-request');
      assert.equal(value.stopPending, false);
      await act(async () => { c.stopPending.claim('A'); });
      assert.equal(value.stopPending, true);
      await act(async () => root.render(render('B', 'B')));
      assert.equal(value.messageLoadError, 'failed');
      assert.equal(value.messageRetryPending, true);
      assert.equal(value.activeInteraction?.requestId, 'B');
      assert.ok(value.activeMessageQueue);
      assert.equal(value.unavailableTranscriptRestore, 'missing-turn');
      await act(async () => root.render(render(undefined, undefined)));
      assert.equal(value.messageLoadError, undefined);
      assert.equal(value.activeInteraction, undefined);
      assert.equal(value.activeMessageQueue, undefined);
      assert.equal(value.stopPending, false);
    } finally {
      cleanupFakeDom();
    }
  });

  it('scopes the workspace publication hook queue read to its published Session', async () => {
    const { root } = installReactRenderer();
    const catalog = createSessionCatalogController();
    const activeId = { current: 'A' as string | undefined };
    let value!: ReturnType<typeof useAppShellSessionUiState>;
    let renders = 0;
    function Workspace() {
      renders += 1;
      value = useAppShellSessionUiState(catalog, 'A', activeId, () => true);
      return null;
    }
    try {
      await act(async () => root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(ToastProvider, {
          children: createElement(ConversationServicesProvider, {
            services: stubConversationServices(), children: createElement(Workspace),
          }),
        }),
      })));
      await act(async () => { value.publication.setMessagesState([]); });
      const initial = renders;
      const c = value.controller;
      await act(async () => { c.setMessageQueueBySession((s) => ({ ...s, B: { ts: 1, entries: [] } })); });
      assert.equal(renders, initial);
      await act(async () => { c.setMessageQueueBySession((s) => ({ ...s, A: { ts: 2, entries: [] } })); });
      assert.equal(renders, initial + 1);
    } finally {
      cleanupFakeDom();
    }
  });
});
