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
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act, createElement, Fragment } from 'react';
import type { StoredMessage } from '@maka/core/session';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider, type ComposerHandle, type TurnPresentation, type TurnViewModel } from '@maka/ui';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';
import {
  createSessionCatalogController,
  SessionCatalogContext,
} from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import { getDesktopConversationCopy } from '../../renderer/application/contracts/conversation-copy.js';
import * as Conversation from '../../renderer/features/conversation/index.js';
import {
  ComposerSubmissionProvider,
  ComposerSubmissionServicesProvider,
  ConversationComposerRegion,
  ConversationLifecycle,
  ConversationProvider,
  ConversationServicesProvider,
  ConversationTranscriptRegion,
  createComposerStagingCommands,
  createComposerSubmissionCommands,
  useAppShellSessionUiState,
  type ComposerSubmissionServices,
} from '../../renderer/features/conversation/index.js';
import { stubConversationServices, useConversationOwner } from '../../renderer/features/conversation/testing.js';
import {
  createDesktopComposerSubmissionServices,
  type DesktopComposerSubmissionBridge,
} from '../../renderer/platform/desktop/create-composer-submission-services.js';
import {
  stubNewTaskSubmission,
  stubSubmissionServices,
  stubSubmissionShell,
} from './composer-submission-fixture.js';
import { ComposerStagingFixture } from './composer-staging-fixture.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

type Owner = { sessionId: string | undefined };
type ProviderProps = Parameters<typeof ComposerSubmissionProvider<Owner>>[0];

interface RegionProps {
  composerRef: { current: Partial<ComposerHandle> | null };
  onSend(text: string, metadata?: { followUpMode?: 'steer' | 'queue' }): Promise<boolean | void>;
  newTaskSendPending: boolean;
  revisionNotice?: { title: string; detail: string; cancelLabel: string; onCancel(): void };
  contextPickEnabled: boolean;
  directoryPickerEnabled: boolean;
  respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion(response: UserQuestionResponse): Promise<void>;
  respondToUserForm(response: { requestId: string }): Promise<void>;
  stop(): void;
  onStop(): void;
  stopPending: boolean;
  pendingMessages: ReadonlyArray<{ id: string }>;
  resumeAction?: { pending: boolean; onResume(): void };
}

interface TranscriptProps {
  deriveTurnPresentation(turns: readonly TurnViewModel[]): TurnPresentation;
  safeResumeAction?: { pending: boolean; detail: string | undefined; onResume(): void };
}

const row = (id: string): DesktopSessionSummary => ({
  id, name: id, isFlagged: false, isArchived: false, labels: [], hasUnread: false,
  status: 'active', backend: 'ai-sdk', revision: 1, runtimeHostId: 'local',
  profileId: 'local', profileName: 'Local', profileKind: 'local',
  llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask',
});
const userTurn = (turnId: string, text: string): StoredMessage => ({ type: 'user', id: `message-${turnId}`, text, turnId, ts: 1 });

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

/** The real Conversation, staging and submission owners, as AppShell mounts them. */
function harness(options: {
  services?: Partial<ComposerSubmissionServices>;
  shell?: Partial<ProviderProps['shell']>;
  newTask?: Partial<ProviderProps['newTask']>;
  sharedSessionActive?: boolean;
  ownerSessionId?: string;
  listMessages?: ReturnType<typeof stubConversationServices>['listMessages'];
  resume?: ReturnType<typeof stubConversationServices>['resume'];
} = {}) {
  const { root } = installReactRenderer();
  const catalog = createSessionCatalogController();
  catalog.commitSessions(['A', 'B'].map(row));
  const published: Array<(messages: StoredMessage[]) => void> = [];
  const conversationServices = stubConversationServices({
    ...(options.listMessages ? { listMessages: options.listMessages } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
  });
  conversationServices.observation.openTranscript = (sessionId) => {
    let messages: StoredMessage[] = [];
    let ready = false;
    const listeners = new Set<() => void>();
    published.push((next) => { messages = next; ready = true; for (const listener of listeners) listener(); });
    return {
      store: {
        range: () => ({ sessionId, hasOlder: false, ready, generation: 'range' }),
        snapshot: () => {
          if (!ready) throw new Error('Desktop transcript range is not initialized');
          return { sessionId, messages, ready };
        },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        hasDurableMessage: (id) => messages.some((message) => message.id === id),
      },
      ready: async () => {}, waitForDurableMessage: async () => true,
      reload: async () => {}, loadEarlier: async () => {}, observationChanged: () => {},
      close: async () => {},
    };
  };
  conversationServices.observation.subscribeEvents = (_sessionId, _event, phase) => {
    phase('ready');
    return () => {};
  };
  const commands = createComposerSubmissionCommands();
  const staging = createComposerStagingCommands();
  const services = stubSubmissionServices(options.services);
  let target!: ReturnType<typeof useAppShellSessionUiState>;
  let conversation!: ReturnType<typeof useConversationOwner>;
  let region: RegionProps | undefined;
  let transcript: TranscriptProps | undefined;
  function Composer(props: RegionProps) { region = props; return null; }
  function Transcript(props: TranscriptProps) { transcript = props; return null; }
  function Shell() {
    target = useAppShellSessionUiState();
    conversation = useConversationOwner();
    return createElement(Fragment, null,
      createElement(ConversationLifecycle, {
        refreshSessions: async () => [], onExecutionBoundaryChanged() {},
        showModelSetupToast() {}, onTurnCompleted() {},
        searchTarget: null, clearSearchTarget() {},
      }),
      createElement(ConversationTranscriptRegion<TranscriptProps>, { surface: Transcript }),
      createElement(ConversationComposerRegion<RegionProps>, {
        surface: Composer, contextPickEnabled: true, directoryPickerEnabled: true,
      }),
    );
  }
  act(() => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(AstryxLocaleProvider, { children: createElement(ToastProvider, { children:
    createElement(SessionCatalogContext.Provider, { value: catalog, children:
      createElement(ConversationServicesProvider, { services: conversationServices, children:
        createElement(ConversationProvider, { children:
          createElement(ComposerStagingFixture, { draftKey: 'staging', commands: staging, children:
            createElement(ComposerSubmissionServicesProvider, { services, children:
              createElement(ComposerSubmissionProvider<Owner>, {
                commands,
                staging,
                shell: stubSubmissionShell(options.shell),
                newTask: stubNewTaskSubmission(options.newTask),
                sharedSessionActive: options.sharedSessionActive ?? false,
                ownerSessionId: options.ownerSessionId,
                children: createElement(Shell),
              }),
            }),
          }),
        }),
      }),
    }),
    }) }),
  })));
  return {
    root, commands, published,
    get target() { return target; },
    get conversation() { return conversation; },
    get region() { assert.ok(region, 'the Composer slot rendered'); return region; },
    get transcript() { assert.ok(transcript, 'the transcript region rendered'); return transcript; },
    notice: () => region?.revisionNotice,
  };
}

describe('ComposerSubmissionProvider', () => {
  test('holds send-pending for the whole send and submits into the active Session through its port', async () => {
    const submitted: unknown[] = [];
    const admission = deferred<Awaited<ReturnType<ComposerSubmissionServices['submitMessage']>>>();
    const h = harness({
      services: {
        submitMessage: (sessionId, placement, command) => {
          submitted.push({ sessionId, placement, text: command.text });
          return admission.promise;
        },
      },
    });
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.published[0]!([userTurn('turn-1', 'earlier')]));
    assert.equal(h.region.newTaskSendPending, false);

    let sending!: Promise<boolean | void>;
    await act(async () => { sending = h.region.onSend('hello'); });
    assert.equal(h.region.newTaskSendPending, true, 'the flag is the owner\'s, read by the Composer slot');
    assert.deepEqual(submitted, [{ sessionId: 'A', placement: 'next_turn', text: 'hello' }]);

    await act(async () => {
      admission.resolve({
        ok: true, disposition: 'turn_started', turnId: 'turn-2', attachments: [], inlineReferences: [],
        skillInvocation: { loaded: [], failed: [], receipts: [] },
      });
      assert.equal(await sending, true);
    });
    assert.equal(h.region.newTaskSendPending, false);
  });

  test('steers into the running Host Turn: the pending row names that Turn before the Host answers', async () => {
    const submitted: unknown[] = [];
    const admission = deferred<Awaited<ReturnType<ComposerSubmissionServices['submitMessage']>>>();
    const h = harness({
      services: {
        submitMessage: (sessionId, placement, command) => {
          submitted.push({ sessionId, placement, text: command.text });
          return admission.promise;
        },
      },
    });
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.published[0]!([userTurn('turn-1', 'running')]));
    await act(async () => h.conversation.workspace.ui.setExecution('A', {
      type: 'host_execution', available: true,
      rootTurn: { sessionId: 'A', turnId: 'host-turn-1', runId: 'run-1', status: 'running' },
    }));

    let sending!: Promise<boolean | void>;
    await act(async () => { sending = h.region.onSend('steer here', { followUpMode: 'steer' }); });
    assert.deepEqual(submitted, [{ sessionId: 'A', placement: 'current_turn', text: 'steer here' }]);
    const pending = h.conversation.workspace.publication.getSnapshot().transientMessages
      .find((message) => message.text === 'steer here');
    assert.equal(pending?.hostTurnId, 'host-turn-1');

    await act(async () => {
      admission.resolve({
        ok: true, disposition: 'steering', turnId: 'host-turn-1', attachments: [], inlineReferences: [],
        skillInvocation: { loaded: [], failed: [], receipts: [] },
      });
      assert.equal(await sending, true);
    });
  });

  test('creates a new task with the new-task settings it was given and keeps an unconsumed choice', async () => {
    const created: unknown[] = [];
    let cleared = 0;
    const h = harness({
      services: {
        createNewTask: async (taskTarget, input) => {
          created.push({ taskTarget, input });
          throw new Error('Host unavailable');
        },
      },
      newTask: {
        permissionChoice: 'ask',
        collaborationMode: 'plan',
        orchestrationMode: 'swarm',
        clearPermissionChoice: () => { cleared += 1; },
      },
    });
    let sent: boolean | void = true;
    await act(async () => { sent = await h.region.onSend('start a task'); });
    assert.equal(sent, false);
    assert.equal(created.length, 1);
    const [{ taskTarget, input }] = created as Array<{ taskTarget: unknown; input: Record<string, unknown> }>;
    assert.deepEqual(taskTarget, { profileId: 'local', hostId: 'host-local', projectId: null });
    assert.equal(input.permissionMode, 'ask');
    assert.equal(input.collaborationMode, 'plan');
    assert.equal(input.orchestrationMode, 'swarm');
    assert.equal(cleared, 0, 'a send that created nothing leaves the choice for the retry');
    assert.equal(h.region.newTaskSendPending, false);
  });

  test('a shared Session cannot submit', async () => {
    const calls: string[] = [];
    const h = harness({
      sharedSessionActive: true,
      services: {
        submitMessage: async () => { calls.push('submitMessage'); throw new Error('must not submit'); },
        createNewTask: async () => { calls.push('createNewTask'); throw new Error('must not create'); },
      },
    });
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.published[0]!([userTurn('turn-1', 'theirs')]));
    let sent: boolean | void = true;
    await act(async () => { sent = await h.region.onSend('not mine'); });
    assert.equal(sent, false);
    assert.deepEqual(calls, []);
  });

  test('owns the edit-and-resend draft: the shell starts it, the Composer slot shows and cancels it', async () => {
    const copy = getDesktopConversationCopy('en').actions;
    const h = harness();
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.published[0]!([userTurn('turn-1', 'original prompt')]));
    assert.equal(h.notice(), undefined);

    await act(async () => h.commands.beginEditUserMessage('turn-1'));
    assert.equal(h.notice()?.title, copy.revisionBannerTitle);
    assert.equal(h.region.contextPickEnabled, false, 'the edited draft cannot stage new context');
    assert.equal(h.region.directoryPickerEnabled, false);

    // The Composer follows the published Session, which switches once B's transcript arrives.
    await act(async () => h.target.setActiveId('B'));
    await act(async () => h.published.at(-1)!([userTurn('turn-b', 'other')]));
    assert.equal(h.notice(), undefined, 'the notice belongs to the draft\'s Session');
    assert.equal(h.region.contextPickEnabled, true);
    assert.equal(h.region.directoryPickerEnabled, false, 'any open draft still blocks directory staging');

    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.published.at(-1)!([userTurn('turn-1', 'original prompt')]));
    const notice = h.notice();
    assert.ok(notice);
    await act(async () => notice.onCancel());
    assert.equal(h.notice(), undefined);
    assert.equal(h.region.contextPickEnabled, true);
    assert.equal(h.region.directoryPickerEnabled, true);
  });

  test('answers interactions for the active Session through the port and the shell\'s form command', async () => {
    const calls: unknown[] = [];
    const h = harness({
      services: {
        respondToUserQuestion: async (sessionId, response) => { calls.push(['question', sessionId, response.requestId]); },
        respondToSandboxBoundary: async (sessionId, response) => { calls.push(['boundary', sessionId, response.requestId]); },
      },
      shell: {
        reloadExecutionBoundary: (sessionId) => { calls.push(['reload-boundary', sessionId]); },
        respondToUserForm: async (sessionId, response) => { calls.push(['form', sessionId, response.requestId]); },
      },
    });
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.region.respondToUserQuestion({ requestId: 'q-1' } as UserQuestionResponse));
    await act(async () => h.region.respondToSandboxBoundary({ requestId: 'b-1' } as SandboxBoundaryResponse));
    await act(async () => h.region.respondToUserForm({ requestId: 'f-1' }));
    assert.deepEqual(calls, [
      ['question', 'A', 'q-1'],
      ['boundary', 'A', 'b-1'],
      ['reload-boundary', 'A'],
      ['form', 'A', 'f-1'],
    ]);
  });

  test('owns Stop: claims it for the published Session and drops the rows the Host retracts', async () => {
    const stopping = deferred<Awaited<ReturnType<ComposerSubmissionServices['stop']>>>();
    const calls: unknown[] = [];
    const h = harness({
      services: {
        stop: (sessionId, input) => { calls.push([sessionId, input]); return stopping.promise; },
      },
    });
    const pendingIds = () => h.conversation.workspace.publication.getSnapshot().transientMessages.map((message) => message.id);
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.published[0]!([userTurn('turn-1', 'running')]));
    await act(async () => h.conversation.commands.addTransientMessage('A', {
      id: 'queued-1', text: 'queued', ts: 1, transientPlacement: 'transcript',
    }));
    assert.deepEqual(pendingIds(), ['queued-1']);

    await act(async () => h.region.onStop());
    assert.deepEqual(calls, [['A', { source: 'stop_button' }]]);
    assert.equal(h.region.stopPending, true, 'the Stop claim is read in the Composer slot');
    await act(async () => h.region.stop());
    assert.equal(calls.length, 1, 'a question prompt\'s Stop shares the claim, so no second request is sent');

    await act(async () => stopping.resolve({ kind: 'interrupted', retractedMessageIds: ['queued-1'] }));
    assert.equal(h.region.stopPending, false);
    assert.deepEqual(pendingIds(), [], 'the retracted row leaves the transcript');
  });

  test('branches a Turn for the shell through its port and opens the copy', async () => {
    const calls: unknown[] = [];
    const h = harness({
      services: {
        branchFromTurn: async (sessionId, input) => {
          calls.push(['branch', sessionId, input.sourceTurnId, typeof input.copyId]);
          return { ...row('C'), name: 'Copy' };
        },
      },
      shell: {
        refreshSessions: async () => { calls.push(['refresh']); return []; },
        openSession: (sessionId) => { calls.push(['open', sessionId]); },
      },
    });
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.published[0]!([userTurn('turn-1', 'source')]));
    await act(async () => h.commands.handleTurnFooterAction('turn-1', 'branch'));
    assert.deepEqual(calls, [['branch', 'A', 'turn-1', 'string'], ['refresh'], ['open', 'C']]);
  });

  test('marks a running Turn action in the transcript it owns and drops it on Session cleanup', async () => {
    const branches: Array<ReturnType<typeof deferred<DesktopSessionSummary>>> = [];
    const h = harness({
      services: { branchFromTurn: () => { const next = deferred<DesktopSessionSummary>(); branches.push(next); return next.promise; } },
    });
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.published[0]!([userTurn('turn-1', 'source')]));
    const turns: TurnViewModel[] = [{ turnId: 'turn-1', status: 'completed', tools: [], timeline: [], notes: [], startedAt: 1 }];
    const branchPending = () => h.transcript.deriveTurnPresentation(turns)
      .footerActionsByTurn['turn-1']?.find((action) => action.id === 'branch')?.pending === true;
    assert.equal(branchPending(), false);

    const settled: Array<Promise<void>> = [];
    await act(async () => { settled.push(h.commands.handleTurnFooterAction('turn-1', 'branch')); });
    assert.equal(branchPending(), true, 'the mark the owner sets reaches the transcript\'s footer');
    await act(async () => h.commands.clearPendingTurnActions('B'));
    assert.equal(branchPending(), true, 'another Session\'s cleanup keeps it');
    await act(async () => h.commands.clearPendingTurnActions('A'));
    assert.equal(branchPending(), false, 'the retired Session\'s mark is dropped');

    await act(async () => { settled.push(h.commands.handleTurnFooterAction('turn-1', 'branch')); });
    assert.equal(branches.length, 2, 'a dropped mark no longer swallows the next click');
    assert.equal(branchPending(), true);
    await act(async () => h.commands.clearPendingTurnActions());
    assert.equal(branchPending(), false, 'a Host change drops every mark');
    await act(async () => {
      for (const branch of branches) branch.resolve({ ...row('C'), name: 'Copy' });
      await Promise.all(settled);
    });
  });

  test('a shared Session\'s transcript offers no Branch', async () => {
    const h = harness({ sharedSessionActive: true });
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.published[0]!([userTurn('turn-1', 'source')]));
    const turn: TurnViewModel = { turnId: 'turn-1', status: 'completed', tools: [], timeline: [], notes: [], startedAt: 1 };
    assert.deepEqual(h.transcript.deriveTurnPresentation([turn]).footerActionsByTurn['turn-1']?.map((action) => action.id), ['copy']);
    assert.equal(h.transcript.safeResumeAction, undefined);
  });

  test('reads the owner Session\'s resume offer into the Composer slot and the transcript banner', async () => {
    const calls: unknown[] = [];
    const started = deferred<Awaited<ReturnType<ReturnType<typeof stubConversationServices>['resume']['start']>>>();
    const h = harness({
      ownerSessionId: 'A',
      resume: {
        queryPlan: async (sessionId) => {
          calls.push(['plan', sessionId]);
          return { disposition: 'ready' } as Awaited<ReturnType<ReturnType<typeof stubConversationServices>['resume']['queryPlan']>>;
        },
        start: (sessionId) => { calls.push(['start', sessionId]); return started.promise; },
        subscribeChanges: () => () => undefined,
      },
    });
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.published[0]!([userTurn('turn-1', 'interrupted')]));
    assert.deepEqual(calls, [['plan', 'A']]);
    assert.equal(h.region.resumeAction?.pending, false, 'the Host\'s ready plan offers Resume in the send slot');
    assert.equal(h.transcript.safeResumeAction?.pending, false);
    const offer = h.region.resumeAction;
    await act(async () => h.commands.beginEditUserMessage('turn-1'));
    assert.ok(h.notice(), 'the owner rendered again');
    assert.equal(h.region.resumeAction, offer, 'the offer keeps its identity while nothing it shows changes');
    await act(async () => h.notice()!.onCancel());

    await act(async () => h.region.resumeAction!.onResume());
    await act(async () => h.transcript.safeResumeAction!.onResume());
    assert.deepEqual(calls, [['plan', 'A'], ['start', 'A']], 'one instance behind both, so the banner cannot race the slot');
    assert.equal(h.transcript.safeResumeAction?.pending, true);
    await act(async () => started.resolve({ disposition: 'started', runId: 'run-1', turnId: 'turn-2' }));
    assert.equal(h.region.resumeAction, undefined, 'a started resume retracts the offer');
    assert.equal(h.transcript.safeResumeAction?.pending, false);
  });

  test('runs local delivery recovery for the published Session below the owner', async () => {
    const listed: string[] = [];
    const h = harness({
      listMessages: async (sessionId) => {
        listed.push(sessionId);
        return sessionId === 'A'
          ? [{
              sessionId: 'A', messageId: 'saved-follow-up', createdAt: 1, state: 'unknown', canCancel: false,
              placement: 'next_turn', text: 'queued while offline', attachments: [], inlineReferences: [],
            }]
          : [];
      },
    });
    await act(async () => h.target.setActiveId('A'));
    await act(async () => h.published[0]!([userTurn('turn-1', 'earlier')]));
    assert.deepEqual(listed, ['A']);
    assert.deepEqual(h.region.pendingMessages.map((message) => message.id), ['saved-follow-up']);
  });

  test('the Composer slot holds the editor handle; the shell edits it only through named intents', async () => {
    const h = harness();
    assert.deepEqual(Object.keys(h.target.queueSurface).sort(), [
      'deleteQueuedEntry', 'editing', 'promoteQueuedEntry', 'reorderQueuedEntries', 'updateQueuedEntry',
    ], 'no editor handle, draft restore or restorer slot reaches the shell');
    const calls: unknown[] = [];
    const editor = (name: string) => ({
      appendText: (text: string) => { calls.push([name, 'append', text]); },
      setText: (text: string) => { calls.push([name, 'set', text]); },
      setDraft: (key: string, text: string) => { calls.push([name, 'setDraft', key, text]); },
      clearDraft: (key: string) => { calls.push([name, 'clearDraft', key]); },
      focus: () => { calls.push([name, 'focus']); },
      openModelPicker: () => { calls.push([name, 'picker']); },
    });
    const { editing } = h.target.queueSurface;
    h.region.composerRef.current = editor('first');
    editing.appendText('suggested');
    editing.replaceText('maka://compose text');
    editing.seedDraft('new-task:board', 'board draft');
    editing.discardDraft('session-A');
    editing.focus();
    editing.openModelPicker();
    const claim = editing.claimVisibleDraft();
    assert.ok(claim);
    assert.equal(claim.isCurrent(), true);
    h.region.composerRef.current = editor('second');
    assert.equal(claim.isCurrent(), false, 'a claim ends when another editor mounts');
    claim.append('late');
    assert.deepEqual(calls, [
      ['first', 'append', 'suggested'],
      ['first', 'set', 'maka://compose text'],
      ['first', 'setDraft', 'new-task:board', 'board draft'],
      ['first', 'clearDraft', 'session-A'],
      ['first', 'focus'],
      ['first', 'picker'],
      ['first', 'append', 'late'],
    ]);
    h.region.composerRef.current = null;
    assert.equal(editing.claimVisibleDraft(), undefined);
  });

  test('the shell\'s command handle works only while the owner is mounted', async () => {
    const unmounted = createComposerSubmissionCommands();
    assert.throws(() => unmounted.beginEditUserMessage('turn-1'), /ComposerSubmissionProvider is not mounted/);
    assert.throws(() => unmounted.handleTurnFooterAction('turn-1', 'branch'), /ComposerSubmissionProvider is not mounted/);
    const h = harness();
    await act(async () => h.root.unmount());
    assert.throws(() => h.commands.beginEditUserMessage('turn-1'), /ComposerSubmissionProvider is not mounted/);
  });
});

describe('Desktop Composer submission adapter', () => {
  test('maps each named operation onto its bridge call', async () => {
    const calls: unknown[] = [];
    const record = (name: string) => async (...args: unknown[]) => { calls.push([name, ...args]); return {} as never; };
    const bridge = {
      sessions: {
        submitMessage: record('sessions.submitMessage'),
        remove: record('sessions.remove'),
        reviseBeforeTurn: record('sessions.reviseBeforeTurn'),
        abandonSessionCopy: record('sessions.abandonSessionCopy'),
        stop: record('sessions.stop'),
        branchFromTurn: record('sessions.branchFromTurn'),
        respondToSandboxBoundary: record('sessions.respondToSandboxBoundary'),
        respondToUserQuestion: record('sessions.respondToUserQuestion'),
      },
      newTasks: { create: record('newTasks.create') },
    } as unknown as DesktopComposerSubmissionBridge;
    const services = createDesktopComposerSubmissionServices(bridge);
    const target = { profileId: 'local', hostId: 'host', projectId: null };
    await services.submitMessage('s', 'next_turn', { messageId: 'm', text: 't' }, { waitForHostAdmission: true });
    await services.createNewTask(target, { name: 'New' });
    await services.removeUnsentSession('s');
    await services.reviseBeforeTurn('s', { sourceTurnId: 'turn', copyId: 'copy' });
    await services.abandonSessionCopy('s', 'copy');
    await services.stop('s', { source: 'stop_button' });
    await services.branchFromTurn('s', { sourceTurnId: 'turn', copyId: 'copy' });
    await services.respondToSandboxBoundary('s', { requestId: 'b' } as SandboxBoundaryResponse);
    await services.respondToUserQuestion('s', { requestId: 'q' } as UserQuestionResponse);
    assert.deepEqual(calls, [
      ['sessions.submitMessage', 's', 'next_turn', { messageId: 'm', text: 't' }, { waitForHostAdmission: true }],
      ['newTasks.create', target, { name: 'New' }],
      ['sessions.remove', 's'],
      ['sessions.reviseBeforeTurn', 's', { sourceTurnId: 'turn', copyId: 'copy' }],
      ['sessions.abandonSessionCopy', 's', 'copy'],
      ['sessions.stop', 's', { source: 'stop_button' }],
      ['sessions.branchFromTurn', 's', { sourceTurnId: 'turn', copyId: 'copy' }],
      ['sessions.respondToSandboxBoundary', 's', { requestId: 'b' }],
      ['sessions.respondToUserQuestion', 's', { requestId: 'q' }],
    ]);
  });
});

describe('Composer submission ownership', () => {
  const rendererRoot = resolve(fileURLToPath(new URL('../../../src/renderer/', import.meta.url)));

  function productionSources(root: string): string[] {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'stories' ? [] : productionSources(path);
      return /\.tsx?$/.test(entry.name) && entry.name !== 'testing.ts' ? [path] : [];
    });
  }

  function sourcesMatching(pattern: RegExp): string[] {
    return productionSources(rendererRoot)
      .filter((path) => pattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(rendererRoot, path).replace(/\\/g, '/'))
      .sort();
  }

  test('mounts one owner and reaches the Host through one adapter', () => {
    assert.deepEqual(sourcesMatching(/<(?:Conversation\.)?ComposerSubmissionProvider\b/), ['app-shell.tsx']);
    assert.deepEqual(sourcesMatching(/create-composer-submission-services/), ['composition/desktop-feature-services.tsx']);
    // Workbar and WorkHub keep their own adapters for their own Composers.
    const hostCalls = sourcesMatching(
      /\bsessions\s*\.\s*(?:submitMessage|reviseBeforeTurn|abandonSessionCopy|respondToSandboxBoundary|respondToUserQuestion|stop|branchFromTurn)\b|\bnewTasks\s*\.\s*create\b/,
    );
    assert.ok(hostCalls.includes('platform/desktop/create-composer-submission-services.ts'));
    assert.deepEqual(hostCalls.filter((path) => !path.startsWith('platform/desktop/')), []);
    assert.deepEqual(sourcesMatching(/\bcreateRevisionAwareOnSend\b/), [
      'features/conversation/controller/composer-submit.ts',
      'features/conversation/controller/use-composer-submission.ts',
    ]);
  });

  test('AppShell holds no submission state and the public entry no submit construction', () => {
    const shell = readFileSync(join(rendererRoot, 'app-shell.tsx'), 'utf8');
    assert.doesNotMatch(shell, /composerRef/, 'the shell keeps no editor handle');
    assert.doesNotMatch(
      shell,
      /revisionDraft|newTaskSendPending|stopPending|createRevisionAwareOnSend|createStagedFollowUp|SessionLocalMessages|createAppShell(?:Chat|Revision|Turn)Actions|createAppShellStopAction/,
    );
    assert.doesNotMatch(
      shell,
      /useTurnActionRegistry|useShellResume|useAppShellTurnPresentation|deriveTurnPresentation|ResumeAction/,
      'pending Turn marks, the resume offer and the footer derivation stay below the owner',
    );
    for (const name of [
      'createRevisionAwareOnSend', 'createStagedFollowUp', 'useComposerSubmission', 'createChatActions',
      'createRevisionActions', 'createStopAction', 'createTurnActions', 'SessionLocalMessages',
      'useShellResume', 'useTurnActionRegistry',
    ]) {
      assert.equal(name in Conversation, false, `${name} is not a public Conversation capability`);
    }
  });
});
