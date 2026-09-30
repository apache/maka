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
import { act, createElement, createRef, Profiler, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { ChatSurfaceLayout, LocaleProvider, type ComposerHandle } from '@maka/ui';
import type { AttachmentRef } from '@maka/core/events';
import {
  createComposerStagingCommands, createRevisionAwareOnSend,
  StagedComposer, StagedQuoteChatView, PlanProvider, PlanServicesProvider,
  type PlanServices, type RevisionSendPorts, type ComposerStagingSubmission,
} from '../../renderer/features/conversation/index.js';
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
            createElement(PlanProvider, { session: undefined, children: createElement(Frame, { draftKey, visible }) }),
          }),
        }),
      }),
    })));
  };
  await render();
  return { commands, composer, container, render, counts: () => [frameRenders, siblingRenders], transcriptCommits: () => transcriptCommits };
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
  await act(() => view.commands.captureSubmission().restore({
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

test('captured staging clears/restores its original draft and Host, preserving newer context', async () => {
  const view = await mount();
  await act(() => view.commands.captureSubmission().restore({
    attachments: [attachment], directoryReferences: [{ hostId: 'host-a', path: '/work/first' }],
  }));
  let submitted!: ComposerStagingSubmission;
  await act(() => {
    view.commands.addQuote({ text: 'same-tick quote' });
    submitted = view.commands.captureSubmission();
    view.commands.addQuote({ text: 'later quote' });
  });
  assert.deepEqual(submitted.quotesForSend()?.map((quote) => quote.text), ['same-tick quote']);
  await act(() => view.commands.captureSubmission().restore({
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
  await act(() => submitted.restore({ directoryReferences: [{ hostId: 'host-a', path: '/work/restored' }] }));
  await view.render('draft-a', 'host-b');
  assert.deepEqual(view.commands.captureSubmission().directoryOptions, {}, 'Host B cannot see Host A directories');
  await view.render('draft-a', 'host-a');
  const remaining = view.commands.captureSubmission();
  assert.deepEqual(remaining.submittableAttachments?.map((item) => item.displayName), ['later.txt']);
  assert.deepEqual(remaining.quotesForSend()?.map((quote) => quote.text), ['later quote']);
  assert.deepEqual(remaining.directoryOptions.directoryReferences?.map((item) => item.path), ['/work/later', '/work/restored']);
  await act(() => root!.unmount());
  root = undefined;
  assert.throws(() => view.commands.captureSubmission(), /not mounted/);
});

for (const accepted of [true, false]) {
  test(`production send captures staging before awaiting; accepted=${accepted}`, async () => {
    const view = await mount();
    await act(() => view.commands.addQuote({ text: 'submitted quote' }));
    let resolve!: (accepted: boolean) => void;
    const sendResult = new Promise<boolean>((done) => { resolve = done; });
    let sentQuotes: readonly { text: string }[] | undefined;
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
    await act(() => view.commands.addQuote({ text: 'later quote' }));
  await view.render('draft-b');
    await act(() => view.commands.addQuote({ text: 'other draft' }));
    await act(async () => { resolve(accepted); await pending; });
    assert.deepEqual(sentQuotes?.map((quote) => quote.text), ['submitted quote']);
    assert.deepEqual(view.commands.captureSubmission().quotesForSend()?.map((quote) => quote.text), ['other draft']);
  await view.render('draft-a');
    assert.deepEqual(view.commands.captureSubmission().quotesForSend()?.map((quote) => quote.text),
      accepted ? ['later quote'] : ['submitted quote', 'later quote']);
  });
}
