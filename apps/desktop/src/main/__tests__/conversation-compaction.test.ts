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
import { act, createElement, Fragment } from 'react';
import { LocaleProvider, ToastProvider, type ToastApi } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import type { ContextCompactResult } from '@maka/runtime-host/protocol';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';
import { createSessionCatalogController, SessionCatalogContext } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import { localizedShellErrorMessage } from '../../renderer/locales/shell-copy.js';
import {
  ConversationLifecycle,
  ConversationProvider,
  ConversationServicesProvider,
  useAppShellSessionUiState,
  type ConversationObservationServices,
} from '../../renderer/features/conversation/index.js';
import { createContextCompactionCommands, stubConversationServices } from '../../renderer/features/conversation/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

type CompactionToast = Pick<ToastApi, 'toast' | 'dismiss' | 'success' | 'info' | 'error'>;

const turn = { sessionId: 'A', turnId: 'compact-1', runId: 'run-1', status: 'running' } as const;
const started: ContextCompactResult = { kind: 'started', turn };

function recordingFeedback(locale: UiLocale = 'en') {
  const calls: string[] = [];
  let seed = 0;
  const toast: CompactionToast = {
    toast(input) { calls.push(`running:${input.title}:${input.duration}`); return `toast-${++seed}`; },
    dismiss(id) { calls.push(`dismiss:${id}`); },
    success(title) { calls.push(`success:${title}`); return 'success'; },
    info(title) { calls.push(`info:${title}`); return 'info'; },
    error(title, description, _details, target) {
      calls.push(`error:${title}:${description}:${target?.sessionId}`);
      return 'error';
    },
  };
  return { calls, feedback: { current: { locale, toast } } };
}

describe('Conversation context compaction commands', () => {
  it('opens the running notice from /compact and settles it from the Host outcome', async () => {
    const { calls, feedback } = recordingFeedback();
    const requested: string[] = [];
    const commands = createContextCompactionCommands({
      compact: async (sessionId) => { requested.push(sessionId); return started; },
      isCurrentSession: () => true,
      feedback,
    });

    assert.equal(await commands.compactSession('A'), true);
    commands.finishContextCompaction('A', 'compact-1', { kind: 'compacted', checkpointId: 'checkpoint-1' });
    commands.finishContextCompaction('A', 'compact-1', { kind: 'compacted', checkpointId: 'checkpoint-1' });

    assert.deepEqual(requested, ['A']);
    assert.deepEqual(calls, ['running:Compacting context:0', 'dismiss:toast-1', 'success:Context compacted']);
  });

  it('refuses a finished failure and presents it against its Session', async () => {
    const { calls, feedback } = recordingFeedback();
    const commands = createContextCompactionCommands({
      compact: async () => ({ kind: 'finished', turn, outcome: { kind: 'failed', reason: 'write_failed' } }),
      isCurrentSession: () => true,
      feedback,
    });

    assert.equal(await commands.compactSession('A'), false);
    assert.deepEqual(calls, ['error:Compaction failed:The task could not be compacted. Try again later.:A']);
  });

  it('reports a rejected request only while its Session is still current', async () => {
    const unavailable = new Error('SESSION_WORKSPACE_UNAVAILABLE: Working directory does not exist or is not accessible.');
    const failure = new Error('connection reset');
    for (const [error, current, expected] of [
      [unavailable, true, ['error:Working directory unavailable:The working directory does not exist or cannot be accessed. Select a valid folder for a new task.:A']],
      [failure, true, [`error:Compaction failed:${localizedShellErrorMessage(failure, 'The task could not be compacted. Try again later.', 'en')}:A`]],
      [unavailable, false, []],
      [failure, false, []],
    ] as const) {
      const { calls, feedback } = recordingFeedback();
      const commands = createContextCompactionCommands({
        compact: async () => { throw error; },
        isCurrentSession: () => current,
        feedback,
      });
      assert.equal(await commands.compactSession('A'), false);
      assert.deepEqual(calls, expected, `${error.message} current=${current}`);
    }
  });

  it('presents each step in the locale that is current when it is shown', async () => {
    const { calls, feedback } = recordingFeedback('en');
    const commands = createContextCompactionCommands({
      compact: async () => started,
      isCurrentSession: () => true,
      feedback,
    });

    await commands.compactSession('A');
    feedback.current = { ...feedback.current, locale: 'zh-CN' };
    commands.finishContextCompaction('A', 'compact-1', { kind: 'unchanged', reason: 'already_compacted' });

    assert.deepEqual(calls, ['running:Compacting context:0', 'dismiss:toast-1', 'info:无需压缩']);
  });
});

const row = (id: string): DesktopSessionSummary => ({
  id, name: id, isFlagged: false, isArchived: false, labels: [], hasUnread: false,
  status: 'active', backend: 'ai-sdk', revision: 1, runtimeHostId: 'local',
  profileId: 'local', profileName: 'Local', profileKind: 'local',
  llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask',
});

describe('Conversation owner context compaction', () => {
  afterEach(cleanupFakeDom);

  it('routes /compact and the Host outcome through the one Conversation presentation', async () => {
    const { root, container } = installReactRenderer();
    const catalog = createSessionCatalogController();
    catalog.commitSessions([row('A')]);
    const requested: string[] = [];
    let reply: ContextCompactResult = started;
    const services = stubConversationServices({
      sessions: { compact: async (sessionId) => { requested.push(sessionId); return reply; } },
    });
    let deliver!: Parameters<ConversationObservationServices['subscribeEvents']>[1];
    services.observation.openTranscript = (sessionId) => ({
      store: {
        range: () => ({ sessionId, hasOlder: false, ready: true, generation: 'range' }),
        snapshot: () => ({ sessionId, messages: [], ready: true }),
        subscribe: () => () => {},
        hasDurableMessage: () => false,
      },
      ready: async () => {}, waitForDurableMessage: async () => true,
      reload: async () => {}, loadEarlier: async () => {}, observationChanged: () => {},
      close: async () => {},
    });
    services.observation.subscribeEvents = (_sessionId, onEvent, phase) => {
      deliver = onEvent;
      phase('ready');
      return () => {};
    };
    let target!: ReturnType<typeof useAppShellSessionUiState>;
    function Shell() {
      target = useAppShellSessionUiState();
      return createElement(Fragment, null, createElement(ConversationLifecycle, {
        refreshSessions: async () => [], onExecutionBoundaryChanged() {},
        showModelSetupToast() {}, onTurnCompleted() {},
        searchTarget: null, clearSearchTarget() {}, listTurnLandmarks: async () => ({ landmarks: [] }),
      }));
    }
    act(() => root.render(createElement(LocaleProvider, { locale: 'en', children:
      createElement(ToastProvider, { children:
        createElement(SessionCatalogContext.Provider, { value: catalog, children:
          createElement(ConversationServicesProvider, { services, children:
            createElement(ConversationProvider, { children: createElement(Shell) }),
          }),
        }),
      }),
    })));
    await act(async () => target.setActiveId('A'));

    const text = () => container.textContent ?? '';
    let accepted: boolean | undefined;
    await act(async () => { accepted = await target.compactSession('A'); });
    assert.equal(accepted, true);
    assert.deepEqual(requested, ['A']);
    assert.match(text(), /Compacting context/);

    await act(async () => deliver({
      type: 'complete', id: 'complete-1', turnId: 'compact-1', ts: 1, stopReason: 'end_turn',
      contextCompactionOutcome: { kind: 'compacted', checkpointId: 'checkpoint-1' },
    }));
    assert.match(text(), /Context compacted/);

    // The Host settles compact-2 before the command's reply arrives. The one
    // owned presentation already holds that terminal, so the reply adds none.
    await act(async () => deliver({
      type: 'complete', id: 'complete-2', turnId: 'compact-2', ts: 2, stopReason: 'end_turn',
      contextCompactionOutcome: { kind: 'unchanged', reason: 'already_compacted' },
    }));
    reply = { kind: 'finished', turn: { ...turn, turnId: 'compact-2' }, outcome: { kind: 'failed', reason: 'write_failed' } };
    await act(async () => { await target.compactSession('A'); });
    assert.match(text(), /Nothing to compact/);
    assert.doesNotMatch(text(), /Compaction failed/);
  });
});
