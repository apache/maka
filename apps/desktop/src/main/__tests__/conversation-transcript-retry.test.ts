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
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { act, createElement, Fragment } from 'react';
import { LocaleProvider, ToastProvider, useToast } from '@maka/ui';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { StoredMessage } from '@maka/core/session';
import type { DesktopTranscriptHandle } from '../../preload/transcript-contract.js';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';
import { parseDesktopSessionKey } from '../../shared/runtime-host-identity.js';
import { encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';
import { getDesktopConversationCopy } from '../../renderer/application/contracts/conversation-copy.js';
import { transcriptRefreshTitle } from '../../renderer/application/contracts/transcript-copy.js';
import { createSessionCatalogController, SessionCatalogContext } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import { ConversationProvider, ConversationServicesProvider, ConversationLifecycle, ConversationTranscriptRegion, useAppShellSessionUiState } from '../../renderer/features/conversation/index.js';
import { stubConversationServices, useConversationOwner } from '../../renderer/features/conversation/testing.js';
import { createDesktopTranscriptRangeController, DesktopTranscriptRangeStore, openDesktopTranscriptHistory } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { withComposerSubmission } from './composer-submission-fixture.js';

const A = JSON.stringify(['host', 'A']);
const B = JSON.stringify(['host', 'B']);
const row = (id: string): DesktopSessionSummary => ({
  id, name: id, isFlagged: false, isArchived: false, labels: [], hasUnread: false,
  status: 'active', backend: 'ai-sdk', revision: 1, runtimeHostId: 'host',
  profileId: 'local', profileName: 'Local', profileKind: 'local',
  llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask',
});

type TranscriptRead = {
  sessionId: string;
  cancelled: boolean;
  closed: boolean;
  /** A `cached` answer is the snapshot Main serves while the Host reconnects. */
  succeed(text: string, source?: 'live' | 'cached'): void;
  fail(): void;
};
type TranscriptView = {
  messages: readonly StoredMessage[];
  messageLoadError?: string;
  messageLoadRetryPending: boolean;
  onRetryMessages?: () => void;
};

function harness() {
  const { root } = installReactRenderer();
  const catalog = createSessionCatalogController();
  catalog.commitSessions([A, B].map(row));
  const reads: TranscriptRead[] = [];
  /** Error toasts, as title then description. */
  const toastErrors: [string, string | undefined][] = [];
  const recordedToasts = new WeakSet<object>();
  const services = stubConversationServices();
  services.observation.openTranscript = (sessionKey, onError) => {
    const store = new DesktopTranscriptRangeStore(sessionKey);
    return createDesktopTranscriptRangeController(store,
      openDesktopTranscriptHistory((_sessionKey, accept, registerCancellation) => {
        const result = deferred<DesktopTranscriptHandle>();
        const { sessionId } = parseDesktopSessionKey(sessionKey);
        const index = reads.length;
        const read: TranscriptRead = {
          sessionId: sessionKey, cancelled: false, closed: false,
          succeed(text, source = 'live') {
            const generation = `${source === 'cached' ? 'cached:' : ''}read-${index}`;
            let deliverySequence = 0;
            for (const batch of encodeDesktopTranscriptSnapshot({
              sessionId, generation, hostEpoch: 'epoch', durableThrough: 1,
              beginsAtTurnBoundary: true, hasOlder: false,
              durable: [{ sequence: 1, message: { type: 'user', id: generation, text, turnId: generation, ts: 1 } }],
            })) accept({ ...batch, deliverySequence: ++deliverySequence });
            result.resolve({
              sessionId, generation, hostEpoch: 'epoch', readThroughMessageId: null,
              close: async () => { read.closed = true; },
              acknowledgeTail: async () => {}, loadEarlier: async () => {},
            });
          },
          fail() { result.reject(new Error('transient transcript read failure')); },
        };
        registerCancellation?.(() => { read.cancelled = true; });
        reads.push(read);
        return result.promise;
      }, sessionKey, (batch) => { store.accept(batch); }), { onError });
  };
  services.observation.subscribeEvents = (_sessionId, _event, phase) => {
    phase('ready');
    return () => {};
  };
  let owner!: ReturnType<typeof useConversationOwner>;
  let target!: ReturnType<typeof useAppShellSessionUiState>;
  let transcript!: TranscriptView;
  function Transcript(props: TranscriptView) { transcript = props; return null; }
  function Shell() {
    const toast = useToast();
    if (!recordedToasts.has(toast)) {
      recordedToasts.add(toast);
      const error = toast.error;
      toast.error = (title, description, ...rest) => {
        toastErrors.push([title, description]);
        return error(title, description, ...rest);
      };
    }
    target = useAppShellSessionUiState();
    owner = useConversationOwner();
    return createElement(Fragment, null,
      createElement(ConversationLifecycle, {
        refreshSessions: async () => [], onExecutionBoundaryChanged() {},
        showModelSetupToast() {}, onTurnCompleted() {}, searchTarget: null, clearSearchTarget() {},
      }),
      createElement(ConversationTranscriptRegion<TranscriptView>, { surface: Transcript, localInteractionAvailable: true }),
    );
  }
  act(() => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(ToastProvider, { children:
      createElement(SessionCatalogContext.Provider, { value: catalog, children:
        createElement(ConversationServicesProvider, { services, children:
          createElement(ConversationProvider, { children: withComposerSubmission(createElement(Shell)) }),
        }),
      }),
    }),
  })));
  return {
    root, catalog, reads, toastErrors,
    get owner() { return owner; }, get target() { return target; }, get transcript() { return transcript; },
    async failInitialReads() {
      await act(async () => target.setActiveId(A));
      await act(async () => reads[0]!.fail());
      assert.equal(reads.length, 2, 'observation readiness permits one automatic recovery');
      await act(async () => reads[1]!.fail());
      assert.ok(transcript.messageLoadError);
      assert.deepEqual(transcript.messages, []);
      assert.equal(owner.workspace.transcriptRangeRef.current, undefined);
    },
  };
}

describe('Conversation transcript retry', () => {
  beforeEach(() => { mock.method(console, 'error', () => undefined); });
  afterEach(() => mock.restoreAll());
  afterEach(cleanupFakeDom);

  it('recovers through the reader Retry after the initial read and automatic recovery fail', async () => {
    const h = harness();
    await h.failInitialReads();
    await act(async () => h.transcript.onRetryMessages?.());
    assert.equal(h.reads.length, 3, 'Retry must issue another transcript read before any publication');
    assert.equal(h.transcript.messageLoadRetryPending, true);
    assert.equal(h.owner.workspace.transcriptRangeRef.current, undefined, 'Retry does not publish an unreadable controller');
    await act(async () => h.reads[2]!.succeed('restored A'));
    assert.deepEqual(h.transcript.messages.map((message) => message.type === 'user' ? message.text : undefined), ['restored A']);
    assert.equal(h.transcript.messageLoadError, undefined);
    assert.equal(h.transcript.messageLoadRetryPending, false);
  });

  it('keeps automatic recovery after one initial failure', async () => {
    const h = harness();
    await act(async () => h.target.setActiveId(A));
    await act(async () => h.reads[0]!.fail());
    assert.equal(h.reads.length, 2);
    await act(async () => h.reads[1]!.succeed('automatic recovery'));
    assert.deepEqual(h.transcript.messages.map((message) => message.type === 'user' ? message.text : undefined), ['automatic recovery']);
    assert.equal(h.transcript.messageLoadError, undefined);
  });

  it('coalesces repeated Retry clicks and permits another attempt after rejection', async () => {
    const h = harness();
    await h.failInitialReads();
    const readError = h.transcript.messageLoadError;
    const reported = h.toastErrors.length;
    await act(async () => { h.transcript.onRetryMessages?.(); h.transcript.onRetryMessages?.(); });
    assert.equal(h.reads.length, 3);
    await act(async () => h.reads[2]!.fail());
    assert.deepEqual(h.toastErrors.slice(reported), [[getDesktopConversationCopy('en').actions.messageReadFailedTitle, readError]],
      'a failed Retry is reported once');
    assert.equal(h.transcript.messageLoadError, readError, 'a failed Retry keeps the read error');
    assert.equal(h.transcript.messageLoadRetryPending, false);
    await act(async () => h.transcript.onRetryMessages?.());
    assert.equal(h.reads.length, 4);
    await act(async () => h.reads[3]!.succeed('manual recovery'));
    assert.deepEqual(h.transcript.messages.map((message) => message.type === 'user' ? message.text : undefined), ['manual recovery']);
    assert.equal(h.transcript.messageLoadError, undefined);
    assert.equal(h.toastErrors.length, reported + 1, 'a successful Retry reports nothing');
  });

  it('reports a failed Retry once while the cached transcript is shown', async () => {
    const h = harness();
    await act(async () => h.target.setActiveId(A));
    await act(async () => h.reads[0]!.succeed('cached A', 'cached'));
    assert.equal(h.reads.length, 2, 'a cached answer still asks for the live transcript');
    await act(async () => h.reads[1]!.fail());
    assert.deepEqual(h.toastErrors, [], 'the controller withholds failures over the cached transcript');
    let refreshed: boolean | undefined;
    await act(async () => { refreshed = await h.owner.commands.refreshMessages(A); });
    assert.equal(refreshed, false, 'a later refresh meets the failed live read');
    const refreshError = h.transcript.messageLoadError;
    assert.ok(refreshError);
    const reported = h.toastErrors.length;
    await act(async () => h.transcript.onRetryMessages?.());
    assert.equal(h.reads.length, 3);
    await act(async () => h.reads[2]!.fail());
    assert.deepEqual(h.toastErrors.slice(reported), [[transcriptRefreshTitle('en'), refreshError]],
      'a failed Retry over the cached transcript is reported once');
    assert.equal(h.transcript.messageLoadError, refreshError);
    assert.equal(h.transcript.messageLoadRetryPending, false);
    assert.deepEqual(h.transcript.messages.map((message) => message.type === 'user' ? message.text : undefined), ['cached A']);
    await act(async () => h.transcript.onRetryMessages?.());
    await act(async () => h.reads[3]!.succeed('live A'));
    assert.deepEqual(h.transcript.messages.map((message) => message.type === 'user' ? message.text : undefined), ['live A']);
    assert.equal(h.transcript.messageLoadError, undefined);
    assert.equal(h.toastErrors.length, reported + 1);
  });

  it('does not retry the published Session after another Session is requested', async () => {
    const h = harness();
    await act(async () => h.target.setActiveId(A));
    await act(async () => h.reads[0]!.succeed('published A'));
    const retryA = h.transcript.onRetryMessages;
    await act(async () => { h.target.setActiveId(B); retryA?.(); });
    assert.deepEqual(h.reads.map((read) => read.sessionId), [A, B]);
    assert.deepEqual(h.transcript.messages.map((message) => message.type === 'user' ? message.text : undefined), ['published A']);
    assert.equal(h.reads[0]!.cancelled, true);
    await act(async () => h.reads[1]!.succeed('published B'));
    assert.deepEqual(h.transcript.messages.map((message) => message.type === 'user' ? message.text : undefined), ['published B']);
  });

  for (const outcome of ['success', 'failure'] as const) {
    it(`ignores a late ${outcome} from Retry after switching Sessions`, async () => {
      const h = harness();
      await h.failInitialReads();
      await act(async () => h.transcript.onRetryMessages?.());
      assert.equal(h.reads.length, 3);
      await act(async () => h.target.setActiveId(B));
      assert.equal(h.reads[2]!.cancelled, true);
      await act(async () => h.reads[3]!.succeed('current B'));
      await act(async () => outcome === 'success' ? h.reads[2]!.succeed('late A') : h.reads[2]!.fail());
      assert.equal(h.target.activeId, B);
      assert.deepEqual(h.transcript.messages.map((message) => message.type === 'user' ? message.text : undefined), ['current B']);
      assert.equal(h.transcript.messageLoadError, undefined);
      assert.equal(h.transcript.messageLoadRetryPending, false);
      await act(async () => h.transcript.onRetryMessages?.());
      assert.equal(h.reads[4]!.sessionId, B);
      await act(async () => h.reads[4]!.succeed('refreshed B'));
      assert.deepEqual(h.transcript.messages.map((message) => message.type === 'user' ? message.text : undefined), ['refreshed B']);
    });
  }

  for (const outcome of ['success', 'failure'] as const) {
    it(`ignores a late ${outcome} from an observation replaced within the same Session`, async () => {
      const h = harness();
      await h.failInitialReads();
      await act(async () => h.transcript.onRetryMessages?.());
      assert.equal(h.reads.length, 3);
      await act(async () => h.catalog.commitSessions([{ ...row(A), profileId: 'replacement' }, row(B)]));
      assert.equal(h.reads.length, 4, 'a changed observation authority opens a new controller');
      assert.equal(h.reads[2]!.cancelled, true);
      await act(async () => h.reads[3]!.succeed('replacement A'));
      await act(async () => outcome === 'success' ? h.reads[2]!.succeed('retired A') : h.reads[2]!.fail());
      assert.deepEqual(h.transcript.messages.map((message) => message.type === 'user' ? message.text : undefined), ['replacement A']);
      assert.equal(h.transcript.messageLoadError, undefined);
      assert.equal(h.transcript.messageLoadRetryPending, false);
      await act(async () => h.transcript.onRetryMessages?.());
      assert.equal(h.reads.length, 5, 'Retry now belongs to the replacement observation');
      await act(async () => h.reads[4]!.succeed('refreshed replacement A'));
      assert.deepEqual(h.transcript.messages.map((message) => message.type === 'user' ? message.text : undefined), ['refreshed replacement A']);
    });
  }

  for (const outcome of ['success', 'failure'] as const) {
    it(`retires the retry controller on unmount and ignores late ${outcome}`, async () => {
      const h = harness();
      await h.failInitialReads();
      await act(async () => h.transcript.onRetryMessages?.());
      assert.equal(h.reads.length, 3);
      const retryA = h.transcript.onRetryMessages;
      await act(async () => h.root.unmount());
      assert.equal(h.reads[2]!.cancelled, true);
      await act(async () => {
        retryA?.();
        if (outcome === 'success') h.reads[2]!.succeed('retired A');
        else h.reads[2]!.fail();
      });
      assert.equal(h.reads.length, 3);
      if (outcome === 'success') assert.equal(h.reads[2]!.closed, true);
    });
  }
});
