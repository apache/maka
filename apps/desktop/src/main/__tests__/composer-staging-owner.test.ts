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
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act, createElement, createRef, Fragment, Profiler, StrictMode, useLayoutEffect, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { ChatSurfaceLayout, LocaleProvider, ToastProvider, type ComposerHandle, type ComposerSendMetadata } from '@maka/ui';
import type { AttachmentRef, DirectoryReference } from '@maka/core/events';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import {
  createComposerStagingCommands, ComposerMentionsProvider, useComposerMentionsContext,
  ConversationProvider, ConversationServicesProvider,
  StagedComposer, StagedQuoteChatView, PlanProvider, PlanServicesProvider,
  type PlanServices, type ComposerStagingServices, type ComposerStagingSubmission,
} from '../../renderer/features/conversation/index.js';
import {
  createRevisionAwareOnSend, createStagedFollowUp, useComposerStaging, type RevisionSendPorts,
  StagedLocalMessages, stubConversationServices, useConversationOwner, useConversationQueue,
} from '../../renderer/features/conversation/testing.js';
import { createChatActions } from '../../renderer/features/conversation/testing.js';
import { createRevisionActions, type TurnRevisionDraft } from '../../renderer/features/conversation/testing.js';
import { createDesktopComposerStagingServices } from '../../renderer/platform/desktop/create-composer-staging-services.js';
import { createActionsDeps, createTransientState, EMPTY_SKILL_INVOCATION, windowSubmissionServices } from './app-shell-chat-actions-fixture.js';
import { ComposerStagingFixture } from './composer-staging-fixture.js';
import { renderTranscriptMarkup } from './transcript-test-dom.js';
import { createSessionCatalogController, SessionCatalogContext } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';
import type { DesktopLocalMessageDraft } from '../../shared/session-local-contract.js';
import {
  SessionSettingsSettlementProvider,
  type SessionSendSettlement,
  type SessionSettingsSettlement,
} from '../../renderer/application/contracts/session-settings-settlement.js';

const saved = Object.fromEntries([
  'window', 'document', 'Element', 'HTMLBRElement', 'sessionStorage', 'HTMLElement', 'HTMLIFrameElement', 'Event', 'Node', 'CSS',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'matchMedia',
  'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const unusedPlanCall = async (): Promise<never> => { throw new Error('No Session Plan should be queried'); };
const planServices: PlanServices = {
  getPlanState: unusedPlanCall, requestPlanRevision: unusedPlanCall,
  approvePlan: unusedPlanCall, resumePlan: unusedPlanCall, abandonPlanExecution: unusedPlanCall,
  subscribeEvents: () => () => {}, subscribePlanChanges: () => () => {},
};
const attachment: AttachmentRef = {
  kind: 'doc', name: 'first.txt', mimeType: 'text/plain', bytes: 3,
  ref: { kind: 'session_file', sessionId: 'source', relativePath: 'first.txt' },
};
const recoverySession = (id: string): DesktopSessionSummary => ({
  id, name: id, isFlagged: false, isArchived: false, labels: [], hasUnread: false,
  status: 'active', backend: 'ai-sdk', revision: 1, activityAt: 1, runtimeHostId: 'host-a',
  profileId: 'local', profileName: 'Local', profileKind: 'local',
  llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask',
});

async function mount(options: {
  onSend?: (
    text: string,
    metadata?: ComposerSendMetadata,
    staging?: ComposerStagingSubmission,
    settlement?: SessionSendSettlement,
  ) => Promise<boolean | void>;
  waitForSessionReference?: () => Promise<boolean>;
  sessionSettings?: SessionSettingsSettlement;
  releaseRecoveryAttachments?: (ids: readonly string[]) => Promise<void>;
} = {}) {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({
    media, matches: false, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  });
  const getSelection = () => ({
    rangeCount: 0, isCollapsed: true, anchorNode: null, focusNode: null,
    removeAllRanges() {}, addRange() {}, getRangeAt() { throw new Error('no range'); },
  }) as unknown as Selection;
  Object.assign(document, { getSelection });
  document.createRange = () => ({
    selectNodeContents() {}, collapse() {}, cloneRange() { return this; },
  }) as unknown as Range;
  const storage = new Map<string, string>();
  Object.assign(window, {
    matchMedia, scrollTo() {}, getSelection,
    getComputedStyle: () => ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' }),
  });
  Object.assign(globalThis, {
    window, document, matchMedia, Element: window.Element, HTMLBRElement: window.HTMLBRElement,
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key) },
    HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event, Node: window.Node, CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root')!;
  root = createRoot(container);
  const commands = createComposerStagingCommands();
  const composer = createRef<ComposerHandle>();
  const conversationServices = stubConversationServices({
    releaseRecoveryAttachments: options.releaseRecoveryAttachments ?? (async () => {}),
  });
  let staging!: ReturnType<typeof useComposerStaging>;
  function StagingProbe() {
    const current = useComposerStaging();
    useLayoutEffect(() => { staging = current; });
    return null;
  }
  let frameRenders = 0;
  let siblingRenders = 0;
  let transcriptCommits = 0;
  function Sibling() {
    siblingRenders += 1;
    return createElement('aside', null, 'unrelated shell chrome');
  }
  function Frame({ draftKey, visible }: { draftKey: string; visible: boolean }) {
    frameRenders += 1;
    return createElement(ChatSurfaceLayout, {
      scrollToBottomLabel: 'Scroll to bottom',
      composer: createElement(StagedComposer, {
        ref: composer, draftKey, hidden: !visible, onSend: options.onSend ?? (() => {}), onStop: () => {},
        waitForSessionReference: options.waitForSessionReference,
        stagingEnabled: true, canStageContext: true, contextPickEnabled: true,
        directoryPickerEnabled: true, allowAttachmentOnlySend: true,
      }),
      children: createElement('div', null, createElement(Sibling), visible && createElement(Profiler, {
        id: 'transcript', onRender: () => { transcriptCommits += 1; },
        children: createElement(StagedQuoteChatView, { messages: [], onNew: () => {}, scrollBehavior: 'auto' }),
      })),
    });
  }
  const render = async (draftKey = 'draft-a', hostId = 'host-a', visible = true) => {
    await act(async () => root!.render(createElement(StrictMode, {
      children: createElement(LocaleProvider, { locale: 'en', children:
        createElement(ComposerStagingFixture, { commands, draftKey, directoryHostId: hostId, conversationServices, children:
          createElement(PlanServicesProvider, { services: planServices, children:
            createElement(PlanProvider, { session: undefined, children: createElement(SessionSettingsSettlementProvider, {
              value: options.sessionSettings,
              children: createElement(Fragment, null,
                createElement(StagingProbe), createElement(Frame, { draftKey, visible }),
              ),
            }) }),
          }),
        }),
      }),
    })));
  };
  await render();
  return { commands, composer, container, render,
    restoreRecovery(approvalId: string) {
      staging.restoreMessageContext(commands.captureSubmission().draftKey, 'host-a', {
        attachments: [], directoryReferences: [],
        stagedAttachments: [{ approvalId, name: 'recovered.txt', mimeType: 'text/plain', size: 3 }],
      });
    },
    removeAttachment: () => staging.removeAttachment(0),
    stage(content: { attachments?: readonly AttachmentRef[]; directoryReferences?: readonly DirectoryReference[] }) {
      const key = commands.captureSubmission().draftKey;
      staging.restoreAttachments(key, content.attachments ?? []);
      staging.restoreDirectories(key, content.directoryReferences ?? []);
    },
    editQuote: (index: number, note: string) => staging.composerQuoteProps(true).onEditQuoteComment!(index, note),
    counts: () => [frameRenders, siblingRenders], transcriptCommits: () => transcriptCommits };
}

test('staged follow-up holds recovered attachments through removal and preserves replacement identity', async () => {
  const released: string[][] = [];
  const view = await mount({ releaseRecoveryAttachments: async (ids) => { released.push([...ids]); } });
  await act(() => view.restoreRecovery('local-recovery:follow-up'));
  let captures = 0;
  let finish!: (accepted: boolean) => void;
  const admission = new Promise<boolean>((resolve) => { finish = resolve; });
  const enqueue = createStagedFollowUp({
    captureStaging: () => { captures++; return view.commands.captureSubmission(); },
    enqueueMessage: async (sessionId, text, placement, pending, context) => {
      assert.equal(sessionId, 'draft-a');
      assert.equal(text, 'edited original');
      assert.equal(placement, 'current_turn');
      assert.equal(context.replacesLocalMessageId, 'paused-original');
      assert.deepEqual(pending?.map((item) => item.source), [{
        type: 'approval', approvalId: 'local-recovery:follow-up', name: 'recovered.txt',
      }]);
      return admission;
    },
    onError: (_sessionId, error) => { assert.fail(String(error)); },
  });
  const sent = enqueue('draft-a', 'edited original', 'steer', { replacesLocalMessageId: 'paused-original' });
  assert.equal(captures, 1);
  await act(() => view.removeAttachment());
  assert.deepEqual(released, [], 'the real staging owner retains the captured approval until admission settles');
  await act(async () => { finish(false); assert.equal(await sent, false); });
  assert.deepEqual(released, [['local-recovery:follow-up']], 'the removed attachment is released after the refused send');
});

test('StagedComposer keeps the submitted recovery attachment while waiting for Session references', async () => {
  const released: string[][] = [];
  let finishReference!: (ready: boolean) => void;
  const reference = new Promise<boolean>((resolve) => { finishReference = resolve; });
  let finishAdmission!: (accepted: boolean) => void;
  const admission = new Promise<boolean>((resolve) => { finishAdmission = resolve; });
  let onSend!: ReturnType<typeof createRevisionAwareOnSend>;
  let sent: Promise<boolean | void> | undefined;
  const view = await mount({
    releaseRecoveryAttachments: async (ids) => { released.push([...ids]); },
    waitForSessionReference: () => reference,
    onSend: (text, metadata, staging) => { sent = onSend(text, metadata, staging); return sent; },
  });
  const submissions: Array<{ sources: unknown[]; replaces?: string }> = [];
  onSend = createRevisionAwareOnSend({
    shellCopy: {
      sideChatUnavailableTitle: '', sideChatUnavailableDescription: '',
      sideChatContextPendingTitle: '', sideChatContextPendingDescription: '',
      swarmModeEnabledTitle: '', swarmModeDisabledTitle: '', swarmModeStatusDescription: '',
      graphModeEnabledTitle: '', graphModeDisabledTitle: '', graphModeStatusDescription: '',
      graphHistoryTitle: '', graphHistoryDescription: '',
    },
    toastApi: { info() {} }, activeIdRef: { current: 'draft-a' }, revisionDraftRef: { current: null },
    composerRef: view.composer, retractedWorkspaceReferencesRef: { current: {} },
    captureStaging: view.commands.captureSubmission,
    send: async (_text, pending, context) => {
      submissions.push({ sources: pending?.map((item) => item.source) ?? [], replaces: context?.replacesLocalMessageId });
      return admission;
    },
    prepareRevisionSend: async () => true, enqueueFollowUp: async () => false,
    settleNewTaskImageNoticeOwner() {}, commitRevisionDraft() {}, completeRevisionCopyAttempt() {},
    parseSlashCommand: () => null, mergeWorkspaceReferences: () => [], rebaseWorkspaceFileReferences: () => [],
    revisionUnavailableCopy: { revisionUnavailableTitle: '', revisionAttachmentsUnsupported: '', revisionCommandUnsupported: '' },
    compactSession: async () => false, resolveNewTaskSessionHandler: () => () => {}, openSideChat() {},
    getActiveOrchestrationMode: () => 'default', setOrchestrationModeActive: async () => false,
    setNewTaskSendPending() {},
  });
  await act(() => {
    view.restoreRecovery('local-recovery:waiting-reference');
    view.composer.current!.appendDraft('draft-a', 'edited original', [], 'paused-original');
  });
  await act(() => {
    const form = view.container.querySelector('form');
    assert.ok(form);
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(() => view.removeAttachment());
  assert.deepEqual(released, [], 'early Composer ownership protects the approval before onSend starts');
  assert.deepEqual(submissions, []);
  await act(async () => { finishReference(true); await Promise.resolve(); });
  assert.deepEqual(submissions, [{
    sources: [{ type: 'approval', approvalId: 'local-recovery:waiting-reference', name: 'recovered.txt' }],
    replaces: 'paused-original',
  }], 'the later factory must submit the content captured by the original send');
  await act(async () => { finishAdmission(false); await sent; });
  assert.deepEqual(released, [['local-recovery:waiting-reference']]);
});

test('StagedLocalMessages restores through the owner slot and guards the same staged attachment draft', async () => {
  const view = await mount();
  const recoveryCommands = createComposerStagingCommands();
  const catalog = createSessionCatalogController();
  catalog.commitSessions([recoverySession('draft-a')]);
  let owner!: ReturnType<typeof useConversationOwner>;
  let queue!: ReturnType<typeof useConversationQueue>;
  let staging!: ReturnType<typeof useComposerStaging>;
  let showRecovery = true;
  let cancellations = 0;
  const sent: Array<ComposerSendMetadata | undefined> = [];
  const services = stubConversationServices({
    listMessages: async () => [{
      sessionId: 'draft-a', messageId: 'original', createdAt: 1, state: 'saved',
      canCancel: true, placement: 'next_turn', text: '', attachments: [], inlineReferences: [],
    }],
    cancelMessage: async (_sessionId, _messageId, options) => {
      cancellations++;
      assert.equal(options?.restoreDraft, true, 'a paused original must not be deleted while its edit remains staged');
      return {
        messageId: 'original', replacesLocalMessageId: 'original', text: '', attachments: [],
        stagedAttachments: [{ approvalId: 'local-recovery:owner-slot', name: 'restored.txt', mimeType: 'text/plain', size: 3 }],
        quotes: [{ text: 'restored quote' }], directoryReferences: [], inlineReferences: [],
      };
    },
  });
  function RecoverySurface() {
    owner = useConversationOwner();
    queue = useConversationQueue();
    staging = useComposerStaging();
    return createElement(Fragment, null,
      createElement(StagedComposer, {
        ref: queue.composer, draftKey: 'draft-a', onSend: async (_text, metadata) => { sent.push(metadata); return false; },
        onStop() {}, stagingEnabled: true, canStageContext: true, contextPickEnabled: true,
        directoryPickerEnabled: true, allowAttachmentOnlySend: true,
      }),
      showRecovery && createElement(StagedLocalMessages, {
        sessionId: 'draft-a', directoryHostId: 'host-a', enabled: true,
        restoreContext: recoveryCommands.restoreContext,
      }),
    );
  }
  const render = () => act(async () => root!.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(ToastProvider, { children:
      createElement(SessionCatalogContext.Provider, { value: catalog, children:
        createElement(ConversationServicesProvider, { services, children:
          createElement(ConversationProvider, { children:
            createElement(ComposerStagingFixture, {
              draftKey: 'draft-a', directoryHostId: 'host-a', conversationServices: services,
              commands: recoveryCommands,
              children: createElement(RecoverySurface),
            }),
          }),
        }),
      }),
    }),
  })));
  await render();
  await act(() => owner.commands.setActiveId('draft-a'));
  const message = () => owner.workspace.composer.getSnapshot().transientMessages.find((entry) => entry.id === 'original')!;
  const action = (label: string) => message().deliveryActions!.find((entry) => entry.label === label)!;
  await act(() => staging.restoreAttachments('draft-a', [attachment]));
  await act(async () => { await action('Edit').onClick(); });
  assert.equal(cancellations, 0, 'recovery reads context from the same staging owner as the Composer');
  await act(() => staging.removeAttachment(0));
  await act(async () => { await action('Edit').onClick(); });
  assert.equal(cancellations, 1);
  assert.equal(queue.composer.current!.getText(), '');
  assert.deepEqual(staging.pendingAttachments.map((item) => item.displayName), ['restored.txt']);
  assert.deepEqual(staging.pendingQuotes, [{ text: 'restored quote' }]);
  await act(async () => { await action('Delete unsent message').onClick(); });
  assert.equal(cancellations, 1);
  assert.match(message().deliveryDetail!, /Unable to delete this paused message/);
  await act(async () => {
    view.container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  assert.equal(sent[0]?.replacesLocalMessageId, 'original', 'bodyless recovery keeps replacement identity through the real composer');
  assert.ok(queue.draftContextRestorer.current);
  showRecovery = false;
  await render();
  assert.equal(queue.draftContextRestorer.current, undefined, 'unmount releases only the wrapper-owned restoration slot');
});

/** Real Composer, keyed staging, local recovery and catalog; only Main I/O is deferred. */
async function mountNavigatingRecovery(text = 'original text') {
  const view = await mount();
  const commands = createComposerStagingCommands();
  const catalog = createSessionCatalogController();
  catalog.commitSessions(['draft-a', 'draft-b'].map(recoverySession));
  let owner!: ReturnType<typeof useConversationOwner>;
  let queue!: ReturnType<typeof useConversationQueue>;
  let staging!: ReturnType<typeof useComposerStaging>;
  let mentions!: NonNullable<ReturnType<typeof useComposerMentionsContext>>;
  let state: 'saved' | 'paused' = 'saved';
  const released: string[] = [];
  const sent: Array<{ text: string; metadata?: ComposerSendMetadata; staging?: ComposerStagingSubmission }> = [];
  const draft: DesktopLocalMessageDraft = {
    messageId: 'original', replacesLocalMessageId: 'original', text, attachments: [],
    stagedAttachments: [{ approvalId: 'local-recovery:navigation', name: 'recovered.txt', mimeType: 'text/plain', size: 3 }],
    directoryReferences: [{ hostId: 'host-a', path: '/work/original' }], quotes: [{ text: 'original quote' }], inlineReferences: [],
  };
  let finish!: (value: DesktopLocalMessageDraft) => void;
  let reject!: (reason: Error) => void;
  const services = stubConversationServices({
    listMessages: async (sessionId) => sessionId === 'draft-a' ? [{
      sessionId, messageId: 'original', createdAt: 1, state, canCancel: true,
      placement: 'next_turn', text, attachments: [], inlineReferences: [],
    }] : [],
    cancelMessage: async (sessionId, messageId, options) => {
      assert.equal(sessionId, 'draft-a'); assert.equal(messageId, 'original');
      assert.equal(options?.restoreDraft, true, 'only pause for Edit, never delete the source');
      state = 'paused';
      return new Promise<DesktopLocalMessageDraft>((resolve, fail) => { finish = resolve; reject = fail; });
    },
    releaseRecoveryAttachments: async (ids) => { released.push(...ids); },
  });
  function Surface({ draftKey, disabled = false, editor = true, recovery = true }: {
    draftKey: string; disabled?: boolean; editor?: boolean; recovery?: boolean;
  }) {
    owner = useConversationOwner(); queue = useConversationQueue(); staging = useComposerStaging();
    mentions = useComposerMentionsContext()!;
    return createElement(Fragment, null,
      editor && createElement(StagedComposer, {
        ref: queue.composer, draftKey, disabled,
        onSend: async (body, metadata, context) => { sent.push({ text: body, metadata, staging: context }); return false; },
        onStop() {}, stagingEnabled: true, canStageContext: true, contextPickEnabled: true,
        directoryPickerEnabled: true, allowAttachmentOnlySend: true,
      }),
      recovery && createElement(StagedLocalMessages, {
        sessionId: draftKey, directoryHostId: 'host-a', enabled: !disabled, restoreContext: commands.restoreContext,
      }),
    );
  }
  async function render(draftKey = 'draft-a', flags: { disabled?: boolean; editor?: boolean; recovery?: boolean } = {}) {
    await act(async () => root!.render(createElement(LocaleProvider, { locale: 'en', children:
      createElement(ToastProvider, { children:
      createElement(SessionCatalogContext.Provider, { value: catalog, children:
        createElement(ConversationServicesProvider, { services, children:
          createElement(ConversationProvider, { children:
            createElement(ComposerStagingFixture, { draftKey, directoryHostId: 'host-a', commands, conversationServices: services, children:
              createElement(ComposerMentionsProvider, { sessionId: draftKey, skillCatalogRevision: 0, children:
                createElement(Surface, { draftKey, ...flags }),
              }),
            }),
          }),
        }),
      }),
      }),
    })));
    await act(() => owner.commands.setActiveId(draftKey));
  }
  await render();
  let pending: void | Promise<void>;
  return {
    ...view, render, catalog, draft, released, sent, commands,
    get composer() { return queue.composer; },
    get staging() { return staging; },
    get mentions() { return mentions; },
    async edit() {
      const action = owner.workspace.composer.getSnapshot().transientMessages.find((entry) => entry.id === 'original')!
        .deliveryActions!.find((entry) => entry.label === 'Edit')!;
      await act(async () => { pending = action.onClick(); });
    },
    async complete() { await act(async () => { finish(draft); await pending; }); assert.equal(state, 'paused'); },
    async fail() { await act(async () => { reject(new Error('read failed')); await pending; }); },
    async submit() {
      await act(async () => view.container.querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    },
    async type(body: string) {
      const input = view.container.querySelector<HTMLElement>('[role="textbox"]')!;
      await act(() => { input.textContent = body; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    },
  };
}

for (const body of ['original text', '', ' \n' + 'long text '.repeat(12_800) + '\n ']) {
  test(`local Edit restores to background A and later sends its replacement: ${body === '' ? 'attachments only' : body.length > 120_000 ? 'long body' : 'text and context'}`, async () => {
    const h = await mountNavigatingRecovery(body);
    await h.edit();
    await h.render('draft-b');
    await h.type('B stays here');
    await act(() => {
      h.staging.restoreAttachments('draft-b', [attachment]);
      h.staging.restoreDirectories('draft-b', [{ hostId: 'host-a', path: '/work/B' }]);
      h.staging.addQuote({ text: 'B quote' });
    });
    await h.render('draft-b', { disabled: true });
    const input = h.container.querySelector<HTMLElement>('[role="textbox"]')!;
    let focuses = 0;
    input.focus = () => { focuses++; };
    await h.complete();
    assert.equal(focuses, 0, 'restoring inactive A must not take focus from B');
    assert.equal(h.composer.current!.getText(), 'B stays here');
    assert.equal(h.composer.current!.getDraft('draft-a'), body, 'restore preserves full text, including whitespace');
    assert.deepEqual(h.staging.pendingAttachments.map((item) => item.displayName), ['first.txt']);
    assert.deepEqual(h.staging.pendingDirectories, [{ hostId: 'host-a', path: '/work/B' }]);
    assert.deepEqual(h.staging.pendingQuotes, [{ text: 'B quote' }]);
    assert.deepEqual(h.released, [], 'A owns the returned approvals');
    await h.render('draft-a');
    assert.equal(h.composer.current!.getText(), body);
    assert.deepEqual(h.staging.pendingAttachments.map((item) => item.displayName), ['recovered.txt']);
    assert.deepEqual(h.staging.pendingDirectories, h.draft.directoryReferences);
    assert.deepEqual(h.staging.pendingQuotes, h.draft.quotes);
    await h.submit();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.metadata?.replacesLocalMessageId, 'original');
    assert.deepEqual(h.sent[0]!.staging?.submittableAttachments?.map((item) => item.source), [
      { type: 'approval', approvalId: 'local-recovery:navigation', name: 'recovered.txt' },
    ]);
    assert.deepEqual(h.released, [], 'a refused send still retains the recovered draft');
  });
}

for (const change of ['text', 'type-then-clear', 'clear-empty', 'attachments', 'directories', 'quotes', 'session-references',
  'clear-all', 'deleted', 'delete-in-progress', 'archived', 'host-changed-back', 'profile-changed-back',
  'editor-unmounted', 'recovery-unmounted', 'entry-unavailable', 'replacement-missing'] as const) {
  test(`local Edit refuses changed A and releases only unused approvals: ${change}`, async () => {
    const h = await mountNavigatingRecovery();
    await h.edit();
    await h.render('draft-b');
    await h.render('draft-a');
    const editor = h.composer.current;
    switch (change) {
      case 'text': await h.type('newer A'); break;
      case 'type-then-clear': await h.type('newer A'); await h.type(''); break;
      case 'clear-empty': await act(() => h.composer.current!.clearDraft('draft-a')); break;
      case 'attachments': await act(() => { h.staging.restoreAttachments('draft-a', [attachment]); h.staging.removeAttachment(0); }); break;
      case 'directories': await act(() => {
        h.staging.restoreDirectories('draft-a', [{ hostId: 'host-a', path: '/work/new' }]);
        h.staging.directoryComposerProps.onRemoveDirectory(0);
      }); break;
      case 'quotes': await act(() => { h.staging.addQuote({ text: 'new' }); h.staging.clearQuotes(); }); break;
      case 'session-references': await act(async () => {
        await h.mentions.onPickSessionReference!({ id: 'draft-b', name: 'B' });
        h.mentions.onRemovePendingSessionReference('draft-b');
      }); break;
      case 'clear-all': await act(() => h.staging.clearAllAttachments()); break;
      case 'deleted': await act(() => h.catalog.commitPatch('draft-a', null)); break;
      case 'delete-in-progress': await act(() => h.catalog.acquireAutomaticQueryBlock(['draft-a'])); break;
      case 'archived': await act(() => h.catalog.commitPatch('draft-a', { ...recoverySession('draft-a'), isArchived: true })); break;
      case 'host-changed-back': case 'profile-changed-back': await act(() => {
        h.catalog.commitPatch('draft-a', { ...recoverySession('draft-a'), ...change === 'host-changed-back'
          ? { runtimeHostId: 'another-host' } : { profileId: 'another-profile' } });
        h.catalog.commitPatch('draft-a', recoverySession('draft-a'));
      }); break;
      case 'editor-unmounted': await h.render('draft-a', { editor: false }); break;
      case 'recovery-unmounted': await h.render('draft-a', { recovery: false }); break;
      case 'entry-unavailable': h.composer.current = null; break;
      case 'replacement-missing': Reflect.deleteProperty(h.draft, 'replacesLocalMessageId'); break;
    }
    await h.render('draft-b');
    await h.type('keep B');
    await h.complete();
    if (change === 'entry-unavailable') h.composer.current = editor;
    assert.deepEqual(h.released, ['local-recovery:navigation']);
    assert.equal(h.composer.current!.getText(), 'keep B');
    assert.equal(h.composer.current!.getDraft('draft-a'), change === 'text' ? 'newer A' : '');
    await h.render('draft-a');
    assert.deepEqual(h.staging.pendingAttachments, []);
    assert.deepEqual(h.staging.pendingDirectories, []);
    assert.deepEqual(h.staging.pendingQuotes, []);
  });
}

test('a failed local Edit read releases its claims so a fresh attempt can restore', async () => {
  const h = await mountNavigatingRecovery();
  await h.edit();
  await h.fail();
  assert.deepEqual(h.released, []);
  await h.edit();
  await h.render('draft-b');
  await h.complete();
  assert.equal(h.composer.current!.getDraft('draft-a'), 'original text');
  assert.deepEqual(h.released, []);
});

test('real staging readers update without rendering shell/frame; Composer survives section and Session switches', async () => {
  const view = await mount();
  const before = view.counts();
  const transcriptBefore = view.transcriptCommits();
  const input = view.container.querySelector('[data-maka-contract="composer-input"] [role="textbox"]');
  assert.ok(input, 'production Composer editor is mounted');
  await act(() => view.composer.current!.setText('unfinished draft'));
  await act(() => view.commands.addQuote({ text: 'quoted passage', label: 'Quote A' }));
  assert.match(view.container.querySelector('.maka-composer-quote-token')?.textContent ?? '', /Quote A/);
  assert.ok(view.transcriptCommits() > transcriptBefore, 'the real transcript quote reader receives updates');
  await act(() => view.stage({
    attachments: [attachment], directoryReferences: [{ hostId: 'host-a', path: '/work/source' }],
  }));
  assert.match([...view.container.querySelectorAll('.maka-composer-attachment-token')].map((node) => node.textContent).join(' '), /first.txt/);
  assert.match(view.container.textContent ?? '', /source/);
  assert.deepEqual(view.counts(), before, 'staging has no subscription in the ancestor or unrelated sibling');
  assert.ok(view.container.querySelector('[data-maka-contract="composer-input"] [role="textbox"]') === input, 'Composer editor node must survive');
  assert.equal(view.composer.current!.getText(), 'unfinished draft');
  await view.render('draft-a', 'host-a', false);
  assert.ok(view.container.querySelector('[data-maka-contract="composer-input"] [role="textbox"]') === input, 'Composer editor node must survive');
  await view.render('draft-b');
  assert.ok(view.container.querySelector('[data-maka-contract="composer-input"] [role="textbox"]') === input, 'Composer editor node must survive');
  assert.equal(view.container.querySelector('.maka-composer-quote-token'), null);
  await view.render('draft-a');
  assert.ok(view.container.querySelector('[data-maka-contract="composer-input"] [role="textbox"]') === input, 'Composer editor node must survive');
  assert.equal(view.composer.current!.getText(), 'unfinished draft');
  assert.match(view.container.querySelector('.maka-composer-quote-token')?.textContent ?? '', /Quote A/);
});

test('captured staging clears its original draft and Host, preserving newer context', async () => {
  const view = await mount();
  await act(() => view.stage({
    attachments: [attachment], directoryReferences: [{ hostId: 'host-a', path: '/work/first' }],
  }));
  let submitted!: ComposerStagingSubmission;
  await act(() => {
    view.commands.addQuote({ text: 'same-tick quote' });
    submitted = view.commands.captureSubmission();
    view.commands.addQuote({ text: 'later quote' });
  });
  assert.deepEqual(submitted.quotesForSend()?.map((quote) => quote.text), ['same-tick quote']);
  await act(() => view.stage({
    attachments: [{ ...attachment, name: 'later.txt', ref: { kind: 'session_file', sessionId: 'source', relativePath: 'later.txt' } }],
    directoryReferences: [{ hostId: 'host-a', path: '/work/later' }],
  }));
  await view.render('draft-b', 'host-b');
  await act(() => view.commands.addQuote({ text: 'other draft' }));
  await act(() => {
    submitted.clearSubmittedContext(submitted.submittableAttachments);
    submitted.clearQuotes();
  });
  assert.deepEqual(view.commands.captureSubmission().quotesForSend()?.map((quote) => quote.text), ['other draft']);
  await view.render('draft-a', 'host-b');
  assert.deepEqual(view.commands.captureSubmission().directoryOptions, {}, 'Host B cannot see Host A directories');
  await view.render('draft-a', 'host-a');
  const remaining = view.commands.captureSubmission();
  assert.deepEqual(remaining.submittableAttachments?.map((item) => item.displayName), ['later.txt']);
  assert.deepEqual(remaining.quotesForSend()?.map((quote) => quote.text), ['later quote']);
  assert.deepEqual(remaining.directoryOptions.directoryReferences?.map((item) => item.path), ['/work/later']);
  await act(() => root!.unmount());
  root = undefined;
  assert.throws(() => view.commands.captureSubmission(), /not mounted/);
});

test('captured staging reads and clears the revision child without changing other drafts', async () => {
  const view = await mount();
  await act(() => view.commands.addQuote({ text: 'selected message quote' }));
  const submitted = view.commands.captureSubmission();
  const source = view.commands.stagedContext();
  await act(() => {
    source.restoreQuotes('revision-child', source.quotes);
    source.clearQuotes('draft-a');
  });
  await view.render('revision-child');
  await act(() => view.editQuote(0, 'edited annotation'));
  await view.render('draft-a');
  await act(() => view.commands.addQuote({ text: 'new source quote' }));
  await view.render('draft-b');
  await act(() => view.commands.addQuote({ text: 'unrelated quote' }));

  assert.deepEqual(submitted.quotesForSend('revision-child'), [
    { text: 'selected message quote', comment: 'edited annotation' },
  ]);
  await act(() => submitted.clearQuotes('revision-child'));
  assert.deepEqual(view.commands.captureSubmission().quotesForSend(), [{ text: 'unrelated quote' }]);
  await view.render('draft-a');
  assert.deepEqual(view.commands.captureSubmission().quotesForSend(), [{ text: 'new source quote' }]);
  await view.render('revision-child');
  assert.equal(view.commands.captureSubmission().quotesForSend(), undefined);
});

for (const accepted of [true, false]) {
  test(`production send captures staging before awaiting; accepted=${accepted}`, async () => {
    const view = await mount();
    await act(() => view.commands.addQuote({ text: 'submitted quote', comment: 'original note' }));
    await act(() => view.commands.addQuote({ text: 'unchanged quote' }));
    let resolve!: (accepted: boolean) => void;
    const sendResult = new Promise<boolean>((done) => { resolve = done; });
    let sentQuotes: readonly { text: string; comment?: string }[] | undefined;
    const ports: RevisionSendPorts<{ sourceSessionId: string; draftSessionId: string }> = {
      shellCopy: {
        sideChatUnavailableTitle: '', sideChatUnavailableDescription: '',
        sideChatContextPendingTitle: '', sideChatContextPendingDescription: '',
        swarmModeEnabledTitle: '', swarmModeDisabledTitle: '', swarmModeStatusDescription: '',
        graphModeEnabledTitle: '', graphModeDisabledTitle: '', graphModeStatusDescription: '',
        graphHistoryTitle: '', graphHistoryDescription: '',
      },
      toastApi: { info() {} }, activeIdRef: { current: 'draft-a' }, revisionDraftRef: { current: null },
      composerRef: view.composer, retractedWorkspaceReferencesRef: { current: {} },
      captureStaging: view.commands.captureSubmission,
      prepareRevisionSend: async () => true,
      send: async (_text, _files, options) => { sentQuotes = options?.quotes; return sendResult; },
      enqueueFollowUp: async () => false, settleNewTaskImageNoticeOwner() {},
      commitRevisionDraft() {}, completeRevisionCopyAttempt() {}, parseSlashCommand: () => null,
      mergeWorkspaceReferences: () => [], rebaseWorkspaceFileReferences: () => [],
      revisionUnavailableCopy: { revisionUnavailableTitle: '', revisionAttachmentsUnsupported: '', revisionCommandUnsupported: '' },
      compactSession: async () => false, resolveNewTaskSessionHandler: () => () => {}, openSideChat() {},
      getActiveOrchestrationMode: () => 'default', setOrchestrationModeActive: async () => false,
    };
    const send = createRevisionAwareOnSend({ ...ports, setNewTaskSendPending() {} });
    const pending = send('message');
    await act(() => { view.editQuote(0, 'edited during send'); view.commands.addQuote({ text: 'later quote' }); });
    await view.render('draft-b');
    await act(() => view.commands.addQuote({ text: 'other draft' }));
    await act(async () => { resolve(accepted); await pending; });
    assert.deepEqual(sentQuotes, [{ text: 'submitted quote', comment: 'original note' }, { text: 'unchanged quote' }]);
    assert.deepEqual(view.commands.captureSubmission().quotesForSend()?.map((quote) => quote.text), ['other draft']);
    await view.render('draft-a');
    assert.deepEqual(view.commands.captureSubmission().quotesForSend(), [
      { text: 'submitted quote', comment: 'edited during send' },
      ...accepted ? [] : [{ text: 'unchanged quote' }],
      { text: 'later quote' },
    ]);
  });
}

for (const mode of ['queue', 'steer'] as const) {
  for (const outcome of ['accepted', 'refused', 'error'] as const) {
    test(`Shell follow-up uses captured staging through production enqueue: ${mode}/${outcome}`, async () => {
      const view = await mount();
      const activeIdRef = { current: 'draft-a' };
      const transient = createTransientState();
      const errors: unknown[] = [];
      const submitted: Array<Parameters<typeof window.maka.sessions.submitMessage>> = [];
      let release!: () => void;
      const admission = new Promise<void>((resolve) => { release = resolve; });
      Object.assign(window, { maka: { sessions: {
        submitMessage: async (...args: Parameters<typeof window.maka.sessions.submitMessage>) => {
          submitted.push(args);
          await admission;
          if (outcome === 'error') throw new Error('Host disconnected');
          if (outcome === 'refused') return { ok: false, reason: 'skill_invocation_failed', skillInvocation: {
            loaded: [], failed: [{ request: 'missing', reason: 'not_found' }], receipts: [],
          } };
          return { ok: true, disposition: mode === 'queue' ? 'followup' : 'steering',
            attachments: [], inlineReferences: [], skillInvocation: EMPTY_SKILL_INVOCATION };
        },
      } } });
      const actions = createChatActions({
        ...createActionsDeps(), ...transient.deps, activeIdRef, getRunningTurnId: () => 'running-turn',
      });
      const enqueue = createStagedFollowUp({
        captureStaging: view.commands.captureSubmission, enqueueMessage: actions.enqueueMessage,
        onError: (sessionId, error) => errors.push({ sessionId, error }),
      });
      await act(() => {
        view.stage({ attachments: [attachment], directoryReferences: [{ hostId: 'host-a', path: '/work/original' }] });
        view.commands.addQuote({ text: 'edited quote', comment: 'sent note' });
        view.commands.addQuote({ text: 'unchanged quote' });
      });
      const pending = enqueue('draft-a', 'read @src/app.ts', mode, {
        workspaceFileReferences: [{ value: '@src/app.ts', start: 5 }],
      });
      assert.equal(submitted.length, 1);
      const [sessionId, placement, command] = submitted[0]!;
      assert.equal(sessionId, 'draft-a');
      assert.equal(placement, mode === 'queue' ? 'next_turn' : 'current_turn');
      assert.deepEqual(command.retainedAttachments, [attachment]);
      assert.deepEqual(command.directoryReferences, [{ hostId: 'host-a', path: '/work/original' }]);
      assert.deepEqual(command.quotes, [{ text: 'edited quote', comment: 'sent note' }, { text: 'unchanged quote' }]);
      assert.deepEqual(command.workspaceFileReferences, [{ value: '@src/app.ts', start: 5 }]);
      await act(() => {
        view.editQuote(0, 'unsent edited note');
        view.commands.addQuote({ text: 'later quote' });
      });
      await view.render('draft-b', 'host-b');
      activeIdRef.current = 'draft-b';
      await act(() => view.commands.addQuote({ text: 'other draft' }));
      await act(async () => {
        release();
        assert.equal(await pending, outcome === 'accepted');
      });
      assert.equal(errors.length, outcome === 'error' ? 1 : 0);
      assert.deepEqual(view.commands.captureSubmission().quotesForSend(), [{ text: 'other draft' }]);
      assert.deepEqual(command.quotes, [{ text: 'edited quote', comment: 'sent note' }, { text: 'unchanged quote' }]);
      await view.render('draft-a', 'host-a');
      const remaining = view.commands.captureSubmission();
      assert.deepEqual(remaining.quotesForSend(), [
        { text: 'edited quote', comment: 'unsent edited note' },
        ...outcome === 'accepted' ? [] : [{ text: 'unchanged quote' }],
        { text: 'later quote' },
      ]);
      assert.equal(remaining.submittableAttachments?.length ?? 0, outcome === 'accepted' ? 0 : 1);
      assert.equal(remaining.directoryOptions.directoryReferences?.length ?? 0, outcome === 'accepted' ? 0 : 1);
      assert.equal(transient.rows.size, outcome === 'accepted' ? 1 : 0);
    });
  }
}

test('Shell follow-up without quotes still submits through the production enqueue action', async () => {
  const view = await mount();
  const submitted: Array<Parameters<typeof window.maka.sessions.submitMessage>> = [];
  Object.assign(window, { maka: { sessions: {
    submitMessage: async (...args: Parameters<typeof window.maka.sessions.submitMessage>) => {
      submitted.push(args);
      return { ok: true, disposition: 'followup', attachments: [], inlineReferences: [], skillInvocation: EMPTY_SKILL_INVOCATION };
    },
  } } });
  const transient = createTransientState();
  const actions = createChatActions({ ...createActionsDeps(), ...transient.deps, activeIdRef: { current: 'draft-a' } });
  const enqueue = createStagedFollowUp({
    captureStaging: view.commands.captureSubmission, enqueueMessage: actions.enqueueMessage,
    onError: (_sessionId, error) => assert.fail(String(error)),
  });
  await act(async () => { assert.equal(await enqueue('draft-a', 'plain follow-up', 'queue'), true); });
  assert.equal(submitted[0]?.[2].quotes, undefined);
  assert.equal([...transient.rows.values()][0]?.quotes, undefined);
  assert.equal(view.commands.captureSubmission().quotesForSend(), undefined);
});

for (const context of ['attachment', 'directory'] as const) {
  test(`revision entry checks the current owner after ${context} staging and draft switches`, async () => {
    const view = await mount();
    const activeIdRef = { current: 'draft-a' };
    const revisionDraftRef = { current: null as TurnRevisionDraft | null };
    const currentRevision = () => revisionDraftRef.current;
    const actions = createRevisionActions({
      services: windowSubmissionServices(),
      uiLocale: 'en', activeIdRef, captureSelection: () => () => true, composerRef: view.composer,
      readMessages: () => [{ type: 'user', id: 'message', turnId: `guard-${context}`, text: 'original', ts: 1 }],
      staging: view.commands,
      openSessionInChat() {}, refreshSessions: async () => [],
      commitRevisionDraft: (draft) => { revisionDraftRef.current = draft; }, revisionDraftRef,
      toastApi: { info() {}, error: () => assert.fail('unexpected revision error') },
    });
    // The same action instance must read staging at invocation, not at construction.
    await act(() => view.stage(context === 'attachment'
      ? { attachments: [attachment] }
      : { directoryReferences: [{ hostId: 'host-a', path: '/work/source' }] }));
    await act(() => actions.beginEditUserMessage(`guard-${context}`));
    assert.equal(revisionDraftRef.current, null, 'pending context blocks revision entry');
    await view.render('draft-b', 'host-b');
    activeIdRef.current = 'draft-b';
    await act(() => actions.beginEditUserMessage(`guard-${context}`));
    assert.equal(currentRevision()?.sourceSessionId, 'draft-b', 'another draft is not blocked');
    revisionDraftRef.current = null;
    await view.render('draft-a', 'host-a');
    activeIdRef.current = 'draft-a';
    await act(() => actions.beginEditUserMessage(`guard-${context}`));
    assert.equal(revisionDraftRef.current, null, 'original draft is still blocked');
    await act(() => {
      const captured = view.commands.captureSubmission();
      captured.clearSubmittedContext(captured.submittableAttachments);
    });
    await act(() => actions.beginEditUserMessage(`guard-${context}`));
    assert.equal(currentRevision()?.sourceSessionId, 'draft-a', 'cleanup releases the guard');
  });
}

test('the transcript reads attachment bytes only through the injected attachment port', async () => {
  const reads: string[] = [];
  const callerReads: string[] = [];
  const services: ComposerStagingServices = {
    pickFiles: async () => ({ ok: false, reason: 'cancelled' }),
    previewApproval: async () => ({ ok: false, reason: 'unavailable' }),
    readBytes: async (sessionId, artifactId) => {
      reads.push(`${sessionId}/${artifactId}`);
      return { ok: true, base64: 'aW1n', mimeType: 'image/png' };
    },
  };
  const activeSession = { id: 'session-1', name: 'Images', status: 'active', labels: [] } as unknown as SessionSummary;
  const message: StoredMessage = {
    type: 'user', id: 'ask', turnId: 'turn-1', ts: 1, text: 'show this',
    attachments: [{
      kind: 'image', name: 'preview.png', mimeType: 'image/png', bytes: 3,
      ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'attachment-123' },
    }],
  };
  // The contract omits the prop; a caller that forces one in is still overridden.
  const transcript = {
    activeSession, messages: [message], onNew: () => {}, scrollBehavior: 'auto',
    onReadAttachmentBytes: async (sessionId: string, artifactId: string) => {
      callerReads.push(`${sessionId}/${artifactId}`);
      return { ok: false, reason: 'not_found' };
    },
  } as ComponentProps<typeof StagedQuoteChatView>;
  const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children:
    createElement(ComposerStagingFixture, { draftKey: 'session-1', services, children:
      createElement(PlanServicesProvider, { services: planServices, children:
        createElement(PlanProvider, { session: undefined, children:
          createElement(ChatSurfaceLayout, { scrollToBottomLabel: 'Scroll to bottom', composer: null, children:
            createElement(StagedQuoteChatView, transcript),
          }),
        }),
      }),
    }),
  }));
  assert.deepEqual([...new Set(reads)], ['session-1/attachment-123']);
  assert.deepEqual(callerReads, []);
  assert.match(markup, /src="data:image\/png;base64,aW1n"/);
});

test('Desktop backs the attachment port with the bridge reader; AppShell no longer reaches it', () => {
  const readBytes: ComposerStagingServices['readBytes'] = async () => ({ ok: false, reason: 'not_found' });
  const bridge = { attachments: { readBytes } } as unknown as Parameters<typeof createDesktopComposerStagingServices>[0];
  assert.equal(createDesktopComposerStagingServices(bridge).readBytes, readBytes);
  const shell = readFileSync(fileURLToPath(new URL('../../../src/renderer/app-shell.tsx', import.meta.url)), 'utf8');
  assert.deepEqual(shell.split('\n').filter((line) => /\battachments\s*\.\s*readBytes\b|\bonReadAttachmentBytes\b/.test(line)), []);
});

test('#4695 review: StagedComposer begins the setting settlement at submit, before Session references load', async () => {
  const events: string[] = [];
  let finishReference!: (ready: boolean) => void;
  const reference = new Promise<boolean>((resolve) => { finishReference = resolve; });
  const begun: SessionSendSettlement[] = [];
  const received: Array<SessionSendSettlement | undefined> = [];
  const view = await mount({
    waitForSessionReference: () => { events.push('wait-reference'); return reference; },
    sessionSettings: {
      settled: async () => true,
      beginSettlement: (sessionId) => {
        events.push(`begin:${sessionId}`);
        const settlement = { settled: async () => false, release: () => { events.push('release'); } };
        begun.push(settlement);
        return settlement;
      },
    },
    onSend: async (_text, _metadata, _staging, settlement) => {
      events.push('send');
      received.push(settlement);
      return false;
    },
  });
  await act(() => { view.composer.current!.appendDraft('draft-a', 'start by submitting a plan', []); });
  await act(() => {
    const form = view.container.querySelector('form');
    assert.ok(form);
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  // A Plan write that fails while the reference loads lands inside this attempt.
  assert.deepEqual(events, ['begin:draft-a', 'wait-reference']);
  await act(async () => { finishReference(true); await Promise.resolve(); });
  assert.deepEqual(events, ['begin:draft-a', 'wait-reference', 'send', 'release']);
  assert.equal(received[0], begun[0], 'the submit\'s own settlement reaches onSend');
});
