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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement } from 'react';
import { LocaleProvider } from '@maka/ui';
import type { StoredMessage } from '@maka/core/session';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { useAppShellSessionWorkspace } from '../../renderer/use-app-shell-session-workspace.js';
import { createRecoveringDesktopTranscriptRangeController, DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import { encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';

/**
 * The session workspace hands its actions to consumers that put them in
 * dependency arrays and pass them down as props. When `setActiveId` was a
 * function declaration in the hook body it changed identity every render, which
 * rebuilt the whole Session rail command chain and defeated `SessionNavRow`'s
 * `memo` on every commit — measured at 20 full re-renders of a 32-row sidebar
 * for a single session switch. Identity is a contract, not an implementation
 * detail, so it is asserted here rather than left to review.
 */
type Workspace = ReturnType<typeof useAppShellSessionWorkspace>;

/**
 * Every function the hook returns, read off the first render rather than
 * listed here. A hand-kept list covers what someone remembered on the day it
 * was written and silently stops covering whatever is added later, which is
 * the opposite of what a contract test is for.
 */
function actionKeys(workspace: Workspace): string[] {
  return Object.keys(workspace).filter(
    (key) => typeof (workspace as Record<string, unknown>)[key] === 'function',
  );
}

describe('session workspace action identity', () => {
  afterEach(cleanupFakeDom);

  it('hands over identity and rows together and rejects superseded reads', async () => {
    const sessionA = JSON.stringify(['local', 'a']);
    const sessionB = JSON.stringify(['local', 'b']);
    const sessionC = JSON.stringify(['local', 'c']);
    const { root } = installReactRenderer();
    let workspace!: Workspace;
    const displays: Array<{ id: string | undefined; messages: StoredMessage[] }> = [];
    function Probe(): null {
      workspace = useAppShellSessionWorkspace({ error: () => {} });
      displays.push({ id: workspace.activeId, messages: workspace.messages });
      return null;
    }
    act(() => root.render(createElement(LocaleProvider, {
      locale: 'en', children: createElement(Probe),
    })));
    act(() => workspace.seedSessions([sessionA, sessionB, sessionC].map((id) => ({
      id, name: id, isFlagged: false, isArchived: false, labels: [],
      hasUnread: false, status: 'active' as const, backend: 'ai-sdk' as const,
      revision: 1, runtimeHostId: 'local', profileId: 'local', profileName: 'Local',
      llmConnectionSlug: 'test', connectionLocked: false, model: 'test',
      permissionMode: 'ask' as const, profileKind: 'local' as const,
    }))));
    const row = (id: string): StoredMessage => ({ id, type: 'user', text: id, turnId: id, ts: 1 });
    const a = [row('a-message')];
    const c = [row('c-message')];
    const reader = (id: string) => createRecoveringDesktopTranscriptRangeController(
      new DesktopTranscriptRangeStore(id), async () => { throw new Error('unexpected read'); }, { onError() {} },
    );
    const readerA = reader(sessionA);
    const readerC = reader(sessionC);
    act(() => { workspace.setActiveId(sessionA); workspace.commitTranscript(sessionA, a, readerA); });
    assert.equal(workspace.transcriptRangeRef.current, readerA);
    assert.equal(workspace.isSessionSelected(sessionA), true);
    displays.length = 0;
    act(() => workspace.setActiveId(sessionB));
    assert.equal(workspace.requestedSessionId, sessionB);
    assert.equal(workspace.activeId, sessionA);
    assert.equal(workspace.messages, a);
    assert.equal(workspace.isSessionSelected(sessionA), false);
    assert.equal(workspace.isSessionSelected(sessionB), false);
    assert.equal(workspace.transcriptRangeRef.current, undefined, 'the old picture has no reader during handoff');
    act(() => workspace.setActiveId(sessionC));
    act(() => workspace.commitTranscript(sessionB, [row('b-message')]));
    assert.equal(workspace.activeId, sessionA);
    act(() => workspace.commitTranscript(sessionC, c, readerC));
    assert.equal(workspace.transcriptRangeRef.current, readerC);
    assert.equal(workspace.isSessionSelected(sessionC), true);
    assert.equal(workspace.activeId, sessionC);
    assert.equal(workspace.messageLoadPending, false);
    assert.ok(displays.every((display) =>
      (display.id === sessionA && display.messages === a) ||
      (display.id === sessionC && display.messages === c)));

    act(() => workspace.setActiveId(sessionB));
    act(() => workspace.startNewSession());
    act(() => workspace.commitTranscript(sessionB, [row('b-message')]));
    assert.equal(workspace.activeId, undefined);
    assert.deepEqual(workspace.messages, []);
    // A first-send task has no readable Host history yet; it must activate
    // immediately rather than waiting for its own first message to be sent.
    act(() => workspace.setActiveId('new-local-task'));
    assert.equal(workspace.activeId, 'new-local-task');

    // Retiring the old display must not cancel a newer navigation intent.
    act(() => { workspace.setActiveId(sessionA); workspace.commitTranscript(sessionA, a); });
    const selectionIsCurrent = workspace.captureSelection();
    act(() => workspace.setActiveId(sessionB));
    assert.equal(selectionIsCurrent(), false);
    act(() => workspace.clearOwnedSessionState(sessionA));
    assert.equal(workspace.requestedSessionId, sessionB);
    assert.equal(workspace.activeId, undefined);
    act(() => workspace.commitTranscript(sessionB, [row('b-message')]));
    assert.equal(workspace.activeId, sessionB);

    // Retiring the destination revokes its read and falls back to the display.
    act(() => workspace.setActiveId(sessionC));
    act(() => workspace.clearOwnedSessionState(sessionC));
    act(() => workspace.commitTranscript(sessionC, c));
    assert.equal(workspace.requestedSessionId, sessionB);
    assert.equal(workspace.activeId, sessionB);
    assert.equal(workspace.switchingSession, false);
    act(() => workspace.setActiveId(sessionA));
    assert.deepEqual(workspace.retiredSessionIds([{ id: sessionB }]), [sessionA]);

    // The real publication scheduler may hold a ready source while the reader
    // is interacting. A retired queued source may not replace the displayed
    // Session or publish its reader.
    act(() => workspace.setActiveId(sessionC));
    for (const batch of encodeDesktopTranscriptSnapshot({
      sessionId: 'c', generation: 'publication', hostEpoch: 'host',
      durableThrough: null, durable: [], overlay: c, hasOlder: false, hasNewer: false,
    })) readerC.store.accept(batch);
    let blocked = true;
    let idle!: () => void;
    const detach = workspace.sessionUiController.transcriptViewportNavigation.attachCommitScheduler(sessionC, {
      commitIfIdle: (commit) => { if (blocked) return false; commit(); return true; },
      subscribeToIdle: (listener) => { idle = listener; return () => {}; },
    });
    let publications = 0;
    await act(async () => workspace.publishTranscript(
      sessionC, readerC, workspace.captureSelection(), () => { publications += 1; },
    ));
    assert.equal(workspace.activeId, sessionB);
    act(() => workspace.clearOwnedSessionState(sessionC));
    await act(async () => { blocked = false; idle(); });
    assert.equal(publications, 0, 'retirement revokes queued publication');
    assert.equal(workspace.activeId, sessionB);
    assert.equal(workspace.transcriptRangeRef.current, undefined);
    await act(async () => {
      workspace.setActiveId(sessionC);
      workspace.publishTranscript(sessionC, readerC, workspace.captureSelection(), () => { publications += 1; });
    });
    assert.equal(publications, 1);
    assert.equal(workspace.activeId, sessionC);
    assert.equal((workspace.messages as StoredMessage[])[0]?.id, 'c-message');
    assert.equal(workspace.publishedTranscriptRange?.sessionId, sessionC);
    assert.equal(workspace.transcriptRangeRef.current, readerC);
    await act(async () => detach());
  });

  it('keeps every action identity fixed across re-renders', () => {
    const { root } = installReactRenderer();
    const reads: Workspace[] = [];

    function Probe(): null {
      reads.push(useAppShellSessionWorkspace({ error: () => {} }));
      return null;
    }

    act(() => {
      root.render(
        createElement(LocaleProvider, { locale: 'en', children: createElement(Probe) }),
      );
    });
    assert.equal(reads.length, 1);

    // Three unrelated state changes, each of which re-renders the hook.
    act(() => reads[0]!.setActiveId('session-a'));
    act(() => reads[0]!.setMessages([]));
    act(() => reads[0]!.setMessageLoadPending(true));
    assert.ok(reads.length > 1, 'the probe should have re-rendered');

    const first = reads[0]!;
    const keys = actionKeys(first);
    // A guard on the guard: if the hook's shape ever collapses, the loop below
    // would pass by having nothing to check.
    assert.ok(keys.length > 10, `expected the workspace to expose actions, saw ${keys.length}`);
    for (const key of keys) {
      for (const later of reads.slice(1)) {
        assert.equal(
          (later as Record<string, unknown>)[key],
          (first as Record<string, unknown>)[key],
          `${key} changed identity between renders`,
        );
      }
    }
  });
});
