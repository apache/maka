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
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { SessionChangedEvent } from '@maka/core/session';
import type { SessionSnapshot } from '@maka/core/session-reference';
import {
  ConversationServicesProvider,
  type ConversationServices,
  useSessionReferenceComposer,
} from '../../renderer/features/conversation/index.js';
import { useComposerQuotes } from '../../renderer/features/conversation/controller/use-composer-quotes.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  Object.assign(globalThis, originalGlobals);
});

test('Session reference picker keeps same-Host sessions and send waits for the snapshot', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  root = createRoot(container);

  const session = (id: string, runtimeHostId: string, extra = {}) => ({
    id,
    runtimeHostId,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active' as const,
    backend: 'ai-sdk' as const,
    llmConnectionSlug: 'connection',
    connectionLocked: false,
    model: 'model',
    permissionMode: 'ask' as const,
    ...extra,
  });
  const sessions = [
    session('current', 'host-a'),
    session('source', 'host-a'),
    session('other-host', 'host-b'),
    session('archived', 'host-a', { isArchived: true }),
  ];
  let releaseSnapshot: (snapshot: SessionSnapshot) => void = () => undefined;
  const snapshot = new Promise<SessionSnapshot>((resolve) => {
    releaseSnapshot = resolve;
  });
  const services: ConversationServices = {
    sessions: {
      list: async () => sessions,
      subscribeChanges: (_handler: (event: SessionChangedEvent) => void) => () => undefined,
      readSnapshot: async () => snapshot,
    },
    skills: { listInvocable: async () => [] },
    workspace: { searchFiles: async () => ({ ok: false, reason: 'no_project' }) },
    newTasks: {
      subscribeChanges: () => () => undefined,
      listInvocableSkills: async () => [],
      searchFiles: async () => ({ ok: false, reason: 'no_project' }),
    },
    mcp: { subscribeChanges: () => () => undefined },
  };
  let latestQuotes: ReturnType<typeof useComposerQuotes> | undefined;
  let latest: ReturnType<typeof useSessionReferenceComposer> | undefined;
  function Probe() {
    latestQuotes = useComposerQuotes({ draftKey: 'current' });
    latest = useSessionReferenceComposer({
      sessions,
      activeId: 'current',
      hostId: 'host-a',
      addQuote: latestQuotes.addQuote,
      errorCopy: {
        unavailableTitle: 'Session unavailable',
        unavailableDetail: 'Refresh and try again.',
        emptyTitle: 'No referenceable content',
        emptyDetail: 'Only user and assistant text can be referenced.',
        readFailedTitle: 'Read failed',
        readFailedDetail: 'Try again later.',
      },
    });
    return null;
  }
  await act(async () => {
    root?.render(createElement(ConversationServicesProvider, {
      services,
      children: createElement(Probe),
    }));
  });
  assert.deepEqual(latest?.references.map((item) => item.id), ['source']);

  let pick!: Promise<void>;
  await act(async () => {
    pick = latest!.pick({ id: 'source' });
    await Promise.resolve();
  });
  assert.equal(latest?.pending, true);
  const waiting = latest!.waitForPending();
  const pendingQuotes = latestQuotes!.pendingQuotes;
  await act(async () => {
    releaseSnapshot({
      reference: { sessionId: 'source', sessionName: 'source', capturedAt: 1 },
      items: [],
      text: 'Assistant: bounded context',
      estimatedTokens: 4,
      maxChars: 12_000,
      truncated: false,
    });
    await pick;
  });
  assert.equal(await waiting, true);
  assert.deepEqual(pendingQuotes, [{
    text: 'Assistant: bounded context',
    label: 'Session: source',
    sourceSessionId: 'source',
    sourceSessionName: 'source',
    sourceCapturedAt: 1,
    sourceTruncated: false,
  }]);
});

test('an immediate send observes the selected Session snapshot in its QuoteRef payload', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  root = createRoot(container);

  const source = {
    id: 'source',
    runtimeHostId: 'host-a',
    name: 'Research',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active' as const,
    backend: 'ai-sdk' as const,
    llmConnectionSlug: 'connection',
    connectionLocked: false,
    model: 'model',
    permissionMode: 'ask' as const,
  };
  const services: ConversationServices = {
    sessions: {
      list: async () => [source],
      subscribeChanges: () => () => undefined,
      readSnapshot: async () => new Promise<SessionSnapshot>((resolve) => {
        queueMicrotask(() => resolve({
          reference: { sessionId: 'source', sessionName: 'Research', capturedAt: 2 },
          items: [],
          text: 'Assistant: prior research',
          estimatedTokens: 4,
          maxChars: 12_000,
          truncated: false,
        }));
      }),
    },
    skills: { listInvocable: async () => [] },
    workspace: { searchFiles: async () => ({ ok: false, reason: 'no_project' }) },
    newTasks: {
      subscribeChanges: () => () => undefined,
      listInvocableSkills: async () => [],
      searchFiles: async () => ({ ok: false, reason: 'no_project' }),
    },
    mcp: { subscribeChanges: () => () => undefined },
  };
  let latestQuotes: ReturnType<typeof useComposerQuotes> | undefined;
  let latest: ReturnType<typeof useSessionReferenceComposer> | undefined;
  let sendCapturedQuotes: () => readonly unknown[] = () => [];
  function Probe() {
    latestQuotes = useComposerQuotes({ draftKey: 'current' });
    const capturedQuotes = latestQuotes.pendingQuotes;
    sendCapturedQuotes = () => capturedQuotes;
    latest = useSessionReferenceComposer({
      sessions: [
        { ...source, id: 'current', runtimeHostId: 'host-a', name: 'Current' },
        source,
      ],
      activeId: 'current',
      hostId: 'host-a',
      addQuote: latestQuotes.addQuote,
      errorCopy: {
        unavailableTitle: 'Session unavailable',
        unavailableDetail: 'Refresh and try again.',
        emptyTitle: 'No referenceable content',
        emptyDetail: 'Only user and assistant text can be referenced.',
        readFailedTitle: 'Read failed',
        readFailedDetail: 'Try again later.',
      },
    });
    return null;
  }
  await act(async () => {
    root?.render(createElement(ConversationServicesProvider, {
      services,
      children: createElement(Probe),
    }));
  });

  await act(async () => {
    const pick = latest!.pick({ id: 'source' });
    await latest!.waitForPending();
    await pick;
  });

  assert.deepEqual(sendCapturedQuotes(), [{
    text: 'Assistant: prior research',
    label: 'Session: Research',
    sourceSessionId: 'source',
    sourceSessionName: 'Research',
    sourceCapturedAt: 2,
    sourceTruncated: false,
  }]);
});

test('ignores a snapshot that resolves after the Composer owner changes', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  root = createRoot(container);

  const session = (id: string) => ({
    id,
    runtimeHostId: 'host-a',
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active' as const,
    backend: 'ai-sdk' as const,
    llmConnectionSlug: 'connection',
    connectionLocked: false,
    model: 'model',
    permissionMode: 'ask' as const,
  });
  let release!: (snapshot: SessionSnapshot) => void;
  const services: ConversationServices = {
    sessions: {
      list: async () => [session('current'), session('next'), session('source')],
      subscribeChanges: () => () => undefined,
      readSnapshot: async () => new Promise<SessionSnapshot>((resolve) => {
        release = resolve;
      }),
    },
    skills: { listInvocable: async () => [] },
    workspace: { searchFiles: async () => ({ ok: false, reason: 'no_project' }) },
    newTasks: {
      subscribeChanges: () => () => undefined,
      listInvocableSkills: async () => [],
      searchFiles: async () => ({ ok: false, reason: 'no_project' }),
    },
    mcp: { subscribeChanges: () => () => undefined },
  };
  let activeId = 'current';
  let latestQuotes: ReturnType<typeof useComposerQuotes> | undefined;
  let latest: ReturnType<typeof useSessionReferenceComposer> | undefined;
  function Probe() {
    latestQuotes = useComposerQuotes({ draftKey: 'current' });
    latest = useSessionReferenceComposer({
      sessions: [session('current'), session('next'), session('source')],
      activeId,
      hostId: 'host-a',
      addQuote: latestQuotes.addQuote,
      errorCopy: {
        unavailableTitle: 'Session unavailable',
        unavailableDetail: 'Refresh and try again.',
        emptyTitle: 'No referenceable content',
        emptyDetail: 'Only user and assistant text can be referenced.',
        readFailedTitle: 'Read failed',
        readFailedDetail: 'Try again later.',
      },
    });
    return null;
  }
  await act(async () => {
    root?.render(createElement(ConversationServicesProvider, {
      services,
      children: createElement(Probe),
    }));
  });
  let pick!: Promise<void>;
  await act(async () => {
    pick = latest!.pick({ id: 'source' });
    await Promise.resolve();
  });
  await act(async () => {
    activeId = 'next';
    root?.render(createElement(ConversationServicesProvider, {
      services,
      children: createElement(Probe),
    }));
  });
  await act(async () => {
    release({
      reference: { sessionId: 'source', sessionName: 'source', capturedAt: 1 },
      items: [],
      text: 'stale context',
      estimatedTokens: 3,
      maxChars: 12_000,
      truncated: false,
    });
    await pick;
  });
  assert.deepEqual(latestQuotes?.pendingQuotes, []);
});
