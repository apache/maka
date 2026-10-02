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
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
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
  createComposerStagingCommands,
  createComposerSubmissionCommands,
  useAppShellSessionUiState,
  type ComposerSubmissionServices,
} from '../../renderer/features/conversation/index.js';
import { stubConversationServices } from '../../renderer/features/conversation/testing.js';
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
  onSend(text: string): Promise<boolean | void>;
  newTaskSendPending: boolean;
  revisionNotice?: { title: string; detail: string; cancelLabel: string; onCancel(): void };
  contextPickEnabled: boolean;
  directoryPickerEnabled: boolean;
  respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion(response: UserQuestionResponse): Promise<void>;
  respondToUserForm(response: { requestId: string }): Promise<void>;
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
} = {}) {
  const { root } = installReactRenderer();
  const catalog = createSessionCatalogController();
  catalog.commitSessions(['A', 'B'].map(row));
  const published: Array<(messages: StoredMessage[]) => void> = [];
  const conversationServices = stubConversationServices();
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
  let region: RegionProps | undefined;
  function Composer(props: RegionProps) { region = props; return null; }
  function Shell() {
    target = useAppShellSessionUiState();
    return createElement(Fragment, null,
      createElement(ConversationLifecycle, {
        refreshSessions: async () => [], onExecutionBoundaryChanged() {},
        showModelSetupToast() {}, onTurnCompleted() {},
        searchTarget: null, clearSearchTarget() {}, listTurnLandmarks: async () => ({ landmarks: [] }),
      }),
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
    get region() { assert.ok(region, 'the Composer slot rendered'); return region; },
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

  test('the shell\'s command handle works only while the owner is mounted', async () => {
    const unmounted = createComposerSubmissionCommands();
    assert.throws(() => unmounted.beginEditUserMessage('turn-1'), /ComposerSubmissionProvider is not mounted/);
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
    await services.respondToSandboxBoundary('s', { requestId: 'b' } as SandboxBoundaryResponse);
    await services.respondToUserQuestion('s', { requestId: 'q' } as UserQuestionResponse);
    assert.deepEqual(calls, [
      ['sessions.submitMessage', 's', 'next_turn', { messageId: 'm', text: 't' }, { waitForHostAdmission: true }],
      ['newTasks.create', target, { name: 'New' }],
      ['sessions.remove', 's'],
      ['sessions.reviseBeforeTurn', 's', { sourceTurnId: 'turn', copyId: 'copy' }],
      ['sessions.abandonSessionCopy', 's', 'copy'],
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
      /\bsessions\s*\.\s*(?:submitMessage|reviseBeforeTurn|abandonSessionCopy|respondToSandboxBoundary|respondToUserQuestion)\b|\bnewTasks\s*\.\s*create\b/,
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
    assert.doesNotMatch(shell, /revisionDraft|newTaskSendPending|createRevisionAwareOnSend|createStagedFollowUp|ChatActions\b|RevisionActions\b/);
    for (const name of ['createRevisionAwareOnSend', 'createStagedFollowUp', 'useComposerSubmission', 'createChatActions', 'createRevisionActions']) {
      assert.equal(name in Conversation, false, `${name} is not a public Conversation capability`);
    }
  });
});
