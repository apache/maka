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
import { act, createElement, createRef, Fragment, Profiler, StrictMode, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { ChatSurfaceLayout, LocaleProvider, type ComposerHandle } from '@maka/ui';
import type { AttachmentRef, DirectoryReference } from '@maka/core/events';
import {
  createComposerStagingCommands, createRevisionAwareOnSend, createStagedFollowUp,
  StagedComposer, StagedQuoteChatView, PlanProvider, PlanServicesProvider,
  type PlanServices, type RevisionSendPorts, type ComposerStagingSubmission,
} from '../../renderer/features/conversation/index.js';
import { useComposerStaging } from '../../renderer/features/conversation/testing.js';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';
import { createAppShellRevisionActions, type TurnRevisionDraft } from '../../renderer/app-shell-revision-actions.js';
import { createActionsDeps, createTransientState, EMPTY_SKILL_INVOCATION } from './app-shell-chat-actions-fixture.js';
import { ComposerStagingFixture } from './composer-staging-fixture.js';

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

async function mount() {
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
        ref: composer, draftKey, hidden: !visible, onSend: () => {}, onStop: () => {},
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
        createElement(ComposerStagingFixture, { commands, draftKey, directoryHostId: hostId, children:
          createElement(PlanServicesProvider, { services: planServices, children:
            createElement(PlanProvider, { session: undefined, children: createElement(Fragment, null,
              createElement(StagingProbe), createElement(Frame, { draftKey, visible }),
            ) }),
          }),
        }),
      }),
    })));
  };
  await render();
  return { commands, composer, container, render,
    stage(content: { attachments?: readonly AttachmentRef[]; directoryReferences?: readonly DirectoryReference[] }) {
      const key = commands.captureSubmission().draftKey;
      staging.restoreAttachments(key, content.attachments ?? []);
      staging.restoreDirectories(key, content.directoryReferences ?? []);
    },
    editQuote: (index: number, note: string) => staging.composerQuoteProps(true).onEditQuoteComment!(index, note),
    counts: () => [frameRenders, siblingRenders], transcriptCommits: () => transcriptCommits };
}

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
      const actions = createAppShellChatActions({
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
  const actions = createAppShellChatActions({ ...createActionsDeps(), ...transient.deps, activeIdRef: { current: 'draft-a' } });
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
    const actions = createAppShellRevisionActions({
      uiLocale: 'en', activeIdRef, captureSelection: () => () => true, composerRef: view.composer,
      readMessages: () => [{ type: 'user', id: 'message', turnId: `guard-${context}`, text: 'original', ts: 1 }],
      hasPendingAttachments: () => view.commands.captureSubmission().hasPendingContext,
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
