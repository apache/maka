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
import { afterEach, describe, it } from 'node:test';
import { act, createElement, Fragment, Profiler, useEffect, useState, type ComponentProps } from 'react';
import { LocaleProvider, ToastProvider, type TransientUserMessageProjection } from '@maka/ui';
import type { StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';
import { createSessionCatalogController, SessionCatalogContext } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import { ConversationProvider, ConversationServicesProvider, ConversationLifecycle, ConversationTranscriptRegion, ConversationComposerRegion, useAppShellSessionUiState, type ConversationObservationServices } from '../../renderer/features/conversation/index.js';
import { stubConversationServices, useConversationOwner } from '../../renderer/features/conversation/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

const row = (id: string): DesktopSessionSummary => ({
  id, name: id, isFlagged: false, isArchived: false, labels: [], hasUnread: false,
  status: 'active', backend: 'ai-sdk', revision: 1, runtimeHostId: 'local',
  profileId: 'local', profileName: 'Local', profileKind: 'local',
  llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask',
});
const message = (id: string): StoredMessage => ({ type: 'user', id, text: id, turnId: id, ts: 1 });

function harness(options: {
  locale?: UiLocale;
  hasOlder?: boolean;
  listTurnLandmarks?: ComponentProps<typeof ConversationLifecycle>['listTurnLandmarks'];
} = {}) {
  const { root } = installReactRenderer();
  const catalog = createSessionCatalogController();
  catalog.commitSessions(['A', 'B', 'C'].map(row));
  const opened: Array<{
    sessionId: string; closed: boolean; listeners: Set<() => void>;
    publish(messages: StoredMessage[]): void; error(error: unknown): void;
  }> = [];
  const observations: Array<{ sessionId: string; closed: boolean; phase: Parameters<ConversationObservationServices['subscribeEvents']>[2]; fail: () => void }> = [];
  const services = stubConversationServices();
  services.observation.openTranscript = (sessionId, error) => {
    let messages: StoredMessage[] = [];
    let ready = false;
    const listeners = new Set<() => void>();
    const resource = {
      sessionId, closed: false, listeners, error,
      publish(next: StoredMessage[]) { messages = next; ready = true; for (const listener of listeners) listener(); },
    };
    opened.push(resource);
    return {
      store: {
        range: () => ({ sessionId, hasOlder: options.hasOlder ?? false, ready, generation: 'range' }),
        snapshot: () => {
          if (!ready) throw new Error('Desktop transcript range is not initialized');
          return { sessionId, messages, ready };
        },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        hasDurableMessage: (id) => messages.some((message) => message.id === id),
      },
      ready: async () => {}, waitForDurableMessage: async () => true,
      reload: async () => {}, loadEarlier: async () => {}, observationChanged: () => {},
      close: async () => { resource.closed = true; },
    };
  };
  services.observation.subscribeEvents = (sessionId, _event, phase, fail) => {
    const observation = { sessionId, closed: false, phase, fail };
    observations.push(observation);
    // Host seeding may finish before the transcript read; both orders are valid.
    phase('ready');
    return () => { observation.closed = true; };
  };
  let owner!: ReturnType<typeof useConversationOwner>;
  let target!: ReturnType<typeof useAppShellSessionUiState>;
  let transcript: { activeSessionId: string | undefined; messages: StoredMessage[]; liveContentSeedGeneration: number } | undefined;
  let shellRenders = 0;
  let transcriptRenders = 0;
  let composerRenders = 0;
  let composerMounts = 0;
  let composerUnmounts = 0;
  let lifecycleCommits = 0;
  let setVisible!: (visible: boolean) => void;
  function Transcript(props: NonNullable<typeof transcript>) { transcript = props; transcriptRenders += 1; return null; }
  function Composer(_props: { processing: boolean; pendingMessages?: readonly TransientUserMessageProjection[]; latestRequestUsageTokens?: number }) {
    composerRenders += 1;
    useEffect(() => { composerMounts += 1; return () => { composerUnmounts += 1; }; }, []);
    return null;
  }
  function Shell() {
    shellRenders += 1;
    target = useAppShellSessionUiState();
    owner = useConversationOwner();
    const [visible, updateVisible] = useState(true);
    setVisible = updateVisible;
    return createElement(Fragment, null,
      createElement(Profiler, { id: 'conversation-lifecycle', onRender: () => { lifecycleCommits += 1; } }, createElement(ConversationLifecycle, {
        refreshSessions: async () => [], onExecutionBoundaryChanged() {},
        onContextCompactionOutcome() {}, showModelSetupToast() {}, onTurnCompleted() {},
        searchTarget: null, clearSearchTarget() {}, listTurnLandmarks: options.listTurnLandmarks ?? (async () => ({ landmarks: [] })),
      })),
      visible ? createElement(ConversationTranscriptRegion<Parameters<typeof Transcript>[0]>, { surface: Transcript }) : null,
      createElement(ConversationComposerRegion<Parameters<typeof Composer>[0]>, { surface: Composer }),
    );
  }
  act(() => root.render(createElement(LocaleProvider, { locale: options.locale ?? 'en', children:
    createElement(ToastProvider, { children:
      createElement(SessionCatalogContext.Provider, { value: catalog, children:
        createElement(ConversationServicesProvider, { services, children:
          createElement(ConversationProvider, { children: createElement(Shell) }),
        }),
      }),
    }),
  })));
  return {
    root, catalog, opened, observations,
    get owner() { return owner; }, get target() { return target; }, get transcript() { return transcript; },
    get counts() { return { shellRenders, transcriptRenders, composerRenders, composerMounts, composerUnmounts, lifecycleCommits }; },
    showTranscript(visible: boolean) { setVisible(visible); },
  };
}

describe('Conversation ownership', () => {
  afterEach(cleanupFakeDom);
  it('ignores catalog bookkeeping for both requested and displayed rows while retaining lifecycle updates', async () => {
    const h = harness();
    const patchRow = (id: string, patch: Partial<DesktopSessionSummary>) => h.catalog.commitSessions(
      h.catalog.getState().sessions.map((session) => session.id === id
        ? { ...session, ...patch, revision: session.revision + 1 }
        : session),
    );
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.opened[0]!.publish([message('a')]));
    await act(async () => h.target.setActiveId('B'));
    const before = h.counts.lifecycleCommits;
    for (const id of ['A', 'B']) {
      await act(async () => patchRow(id, { activityAt: 2, lastMessagePreview: 'streaming', hasUnread: true }));
      assert.equal(h.counts.lifecycleCommits, before, `${id}: rail bookkeeping does not render the lifecycle`);
    }
    assert.equal(h.opened.length, 2);
    await act(async () => patchRow('A', { status: 'running' }));
    assert.ok(h.counts.lifecycleCommits > before, 'displayed status remains observable to health recovery');
    await act(async () => patchRow('B', { profileId: 'replacement-profile' }));
    assert.equal(h.opened.length, 3, 'requested profile replacement reopens observation');
    assert.ok(h.opened[1]!.closed);
    await act(async () => h.root.unmount());
  });

  for (const [locale, fallback] of [
    ['en', 'The task action failed. Try again later.'],
    ['zh-CN', '任务操作失败，请稍后重试。'],
    ['zh-TW', '任務操作失敗，請稍後重試。'],
  ] as const) {
    it(`preserves the reading-position failure copy and desktop diagnostic scope (${locale})`, async (context) => {
      const errors = context.mock.method(console, 'error', () => undefined);
      const h = harness({ locale, hasOlder: true, listTurnLandmarks: async (_sessionId, turnId) => {
        if (turnId) throw new Error('opaque landmark failure');
        return { landmarks: [] };
      } });
      await act(async () => {
        h.owner.workspace.ui.setTranscriptReadingAnchor('A', { turnId: 'older' });
        h.target.setActiveId('A');
      });
      await act(async () => h.opened[0]!.publish([message('a')]));
      assert.equal(h.owner.workspace.ui.reads.load('A').getSnapshot().messageLoadError, fallback);
      assert.equal(errors.mock.callCount(), 1);
      assert.equal(errors.mock.calls[0]!.arguments[0], '[desktop] operation failed:');
      await act(async () => h.root.unmount());
    });
  }

  it('publishes only to regional readers and preserves the persistent composer across transcript remounts', async () => {
    const h = harness();
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.opened[0]!.publish([message('one')]));
    assert.equal(h.transcript?.activeSessionId, 'A');
    assert.ok(h.transcript!.liveContentSeedGeneration > 0, 'seed survives publication arriving after event seeding');
    const before = h.counts;
    await act(async () => h.opened[0]!.publish([message('one'), message('two')]));
    assert.equal(h.counts.shellRenders, before.shellRenders, 'durable content does not revisit Shell');
    assert.equal(h.counts.composerRenders, before.composerRenders, 'ordinary content does not revisit Composer');
    assert.ok(h.counts.transcriptRenders > before.transcriptRenders);
    assert.deepEqual(h.transcript?.messages.map((row) => row.id), ['one', 'two']);
    await act(async () => h.showTranscript(false));
    await act(async () => h.opened[0]!.publish([message('three')]));
    await act(async () => h.showTranscript(true));
    assert.equal(h.counts.composerMounts, 1);
    assert.equal(h.counts.composerUnmounts, 0);
    assert.equal(h.opened.length, 1, 'conditional readers do not own observation lifetime');
    assert.equal(h.transcript?.messages[0]?.id, 'three');
    assert.equal('commitTranscript' in h.target, false);
    assert.equal('sessionUiController' in h.target, false);
    assert.throws(() => { (h.target.activeIdRef as { current: string }).current = 'B'; });
  });

  it('closes superseded readers and rejects late publication, read errors and seed completion', async () => {
    const h = harness();
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.opened[0]!.publish([message('a')]));
    await act(async () => h.target.setActiveId('B'));
    assert.equal(h.target.activeId, 'A', 'requested B does not relabel the published A');
    assert.equal(h.target.switchingSession, true);
    await act(async () => h.target.setActiveId('C'));
    await act(async () => {
      h.opened[1]!.publish([message('stale-b')]);
      h.opened[1]!.error(new Error('late B read'));
      h.observations[1]!.phase('ready');
      h.opened[2]!.publish([message('c')]);
    });
    assert.equal(h.target.activeId, 'C');
    assert.equal(h.transcript?.messages[0]?.id, 'c');
    assert.equal(h.owner.workspace.ui.reads.load('C').getSnapshot().messageLoadError, undefined);
    assert.ok(h.opened.slice(0, 2).every((item) => item.closed && item.listeners.size === 0));
    await act(async () => h.root.unmount());
    assert.ok(h.opened.every((item) => item.closed && item.listeners.size === 0));
    assert.ok(h.observations.every((item) => item.closed));
  });

  it('retries observation on the existing transcript controller and cancels scheduled retries on disposal', async () => {
    const h = harness();
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.opened[0]!.publish([message('a')]));
    const firstGeneration = h.transcript!.liveContentSeedGeneration;
    await act(async () => { h.observations[0]!.fail(); await new Promise((resolve) => setTimeout(resolve, 120)); });
    assert.equal(h.opened.length, 1);
    assert.equal(h.observations.length, 2);
    assert.ok(h.observations[0]!.closed);
    assert.ok(h.transcript!.liveContentSeedGeneration > firstGeneration);
    await act(async () => { h.observations[1]!.fail(); h.root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(h.observations.length, 2);
    assert.ok(h.opened[0]!.closed);
  });
});
