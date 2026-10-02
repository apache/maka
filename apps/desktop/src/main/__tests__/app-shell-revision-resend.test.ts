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

/**
 * Unchanged-text edit-and-resend regression (PR #5815 follow-up).
 *
 * The production fix removed the `text.trim() === revision.originalText.trim()`
 * early return from the composer's submit path. The existing
 * `app-shell-revision-actions.test.ts` suite only calls `prepareRevisionSend()`
 * directly, so it cannot tell whether the real submit path still short-circuits
 * unchanged text. This suite mounts the real ChatComposerRegion, wires its
 * `onSend` with the same factory AppShell uses (`createRevisionAwareOnSend`,
 * which owns both the target-owning wrapper and the revision-aware submit),
 * submits the unchanged text through the real Composer form, and asserts the
 * revision branch plus the normal send both happen. Restoring the old guard in
 * the production submit path must fail this test.
 */

import { ComposerStagingFixture } from './composer-staging-fixture.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { StoredMessage } from '@maka/core/session';
import {
  LocaleProvider,
  type ComposerHandle,
  type ComposerSendMetadata,
} from '@maka/ui';
import { ChatComposerRegion } from '../../renderer/chat-composer-region.js';
import {
  completeTurnRevisionCopyAttempt,
  createAppShellRevisionActions,
  type TurnRevisionDraft,
} from '../../renderer/app-shell-revision-actions.js';
import { parseDesktopSlashCommand } from '../../renderer/desktop-slash-command.js';
import {
  mergeWorkspaceReferences,
  rebaseWorkspaceFileReferences,
} from '../../renderer/follow-up-submit-routing.js';
import { getDesktopConversationCopy } from '../../renderer/application/contracts/conversation-copy.js';
import {
  createRevisionAwareOnSend,
  type RevisionSendPorts,
} from '../../renderer/features/conversation/index.js';

const SESSION_1 = JSON.stringify(['host-1', 'session-1']);
const SESSION_2 = JSON.stringify(['host-1', 'session-2']);
const ORIGINAL_TEXT = 'original message';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  HTMLBRElement: globalThis.HTMLBRElement,
  Element: globalThis.Element,
  Event: globalThis.Event,
  Node: globalThis.Node,
  sessionStorage: globalThis.sessionStorage,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

function userMessage(turnId: string, text: string): StoredMessage {
  return {
    id: `msg-${turnId}`,
    type: 'user',
    turnId,
    ts: 1,
    text,
  } as StoredMessage;
}

interface RevisionWorld {
  revisionActions: {
    beginEditUserMessage: (turnId: string) => void;
  };
  composer: { current: ComposerHandle | null };
  document: Document;
  submitSend: () => Promise<void>;
  activeIdRef: { current: string | undefined };
  revisionDraftRef: { current: TurnRevisionDraft | null };
  reviseCalls: Array<{
    sourceSessionId: string;
    args: { sourceTurnId: string; copyId: string };
  }>;
  sendCalls: Array<{
    text: string;
    options: {
      waitForHostAdmission?: boolean;
      targetSessionId?: string;
    };
  }>;
  submittedTexts: string[];
  sendPendingFlags: boolean[];
  restoreWindow: () => void;
}

async function mountRevisionWorld(): Promise<RevisionWorld> {
  const { document, window } = parseHTML('<div id="root"></div>');
  const storage = new Map<string, string>();
  const getSelection = () =>
    ({
      rangeCount: 0,
      isCollapsed: true,
      anchorNode: null,
      focusNode: null,
      removeAllRanges() {},
      addRange() {},
      getRangeAt: () => {
        throw new Error('no range');
      },
    }) as unknown as Selection;
  Object.assign(document, { getSelection });
  Object.assign(window, {
    getSelection,
    getComputedStyle: () =>
      ({
        direction: 'ltr',
        writingMode: 'horizontal-tb',
        getPropertyValue: () => '',
      }) as unknown as CSSStyleDeclaration,
    matchMedia: () =>
      ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
  });
  document.createRange = () =>
    ({
      selectNodeContents() {},
      collapse() {},
      cloneRange() {
        return this;
      },
    }) as unknown as Range;
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    HTMLBRElement: window.HTMLBRElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const activeIdRef: { current: string | undefined } = { current: SESSION_1 };
  const revisionDraftRef: { current: TurnRevisionDraft | null } = { current: null };
  let selectionRevision = 0;
  const reviseCalls: RevisionWorld['reviseCalls'] = [];
  const sendCalls: RevisionWorld['sendCalls'] = [];
  const submittedTexts: string[] = [];

  const target = globalThis as { window?: unknown };
  const linkedomWindow = target.window as Record<string, unknown>;
  linkedomWindow.maka = {
    sessions: {
      reviseBeforeTurn: async (sourceSessionId: string, args: { sourceTurnId: string; copyId: string }) => {
        reviseCalls.push({ sourceSessionId, args });
        return { id: SESSION_2 };
      },
      abandonSessionCopy: async () => {},
    },
  };
  const restoreWindow = () => {
    delete linkedomWindow.maka;
  };

  const composer = createRef<ComposerHandle>();
  const revisionActions = createAppShellRevisionActions({
    uiLocale: 'en' as never,
    activeIdRef,
    captureSelection: () => {
      const revision = selectionRevision;
      return () => selectionRevision === revision;
    },
    composerRef: composer,
    readMessages: () => [userMessage('turn-1', ORIGINAL_TEXT)],
    hasPendingAttachments: () => false,
    openSessionInChat: (sessionId: string) => {
      selectionRevision += 1;
      activeIdRef.current = sessionId;
    },
    refreshSessions: async () => [],
    commitRevisionDraft: (draft: TurnRevisionDraft | null) => {
      revisionDraftRef.current = draft;
    },
    revisionDraftRef,
    toastApi: { info: () => {}, error: () => {} },
  } as never);

  let pendingSend: Promise<boolean | void> | undefined;
  const sendPendingFlags: boolean[] = [];
  const ports: RevisionSendPorts<TurnRevisionDraft> = {
    shellCopy: {
      sideChatUnavailableTitle: '',
      sideChatUnavailableDescription: '',
      sideChatContextPendingTitle: '',
      sideChatContextPendingDescription: '',
      swarmModeEnabledTitle: '',
      swarmModeDisabledTitle: '',
      swarmModeStatusDescription: '',
      graphModeEnabledTitle: '',
      graphModeDisabledTitle: '',
      graphModeStatusDescription: '',
      graphHistoryTitle: '',
      graphHistoryDescription: '',
    },
    toastApi: { info: () => {} },
    activeIdRef,
    revisionDraftRef,
    composerRef: composer,
    retractedWorkspaceReferencesRef: { current: {} },
    captureStaging: () => ({
      draftKey: 'draft',
      hasPendingContext: false,
      hasStagedQuotes: false,
      submittableAttachments: undefined,
      directoryOptions: {},
      quotesForSend: () => undefined,
      clearSubmittedContext: () => {},
      clearQuotes: () => {},
    }),
    prepareRevisionSend: (text: string) => revisionActions.prepareRevisionSend(text),
    completeRevisionCopyAttempt: completeTurnRevisionCopyAttempt,
    parseSlashCommand: parseDesktopSlashCommand,
    mergeWorkspaceReferences,
    rebaseWorkspaceFileReferences,
    revisionUnavailableCopy: getDesktopConversationCopy('en').actions,
    compactSession: async () => {
      assert.fail('an unchanged revision send must not compact');
    },
    send: (async (
      text: string,
      _pending?: unknown,
      sendOptions?: { waitForHostAdmission?: boolean; targetSessionId?: string },
    ) => {
      sendCalls.push({
        text,
        options: {
          waitForHostAdmission: sendOptions?.waitForHostAdmission,
          targetSessionId: sendOptions?.targetSessionId,
        },
      });
      return true;
    }) as RevisionSendPorts<TurnRevisionDraft>['send'],
    enqueueFollowUp: async () => false,
    settleNewTaskImageNoticeOwner: () => {},
    commitRevisionDraft: (draft: TurnRevisionDraft | null) => {
      revisionDraftRef.current = draft;
    },
    resolveNewTaskSessionHandler: () => () => {},
    openSideChat: () => {
      assert.fail('an unchanged revision send must not open side chat');
    },
    getActiveOrchestrationMode: () => 'default',
    setOrchestrationModeActive: async () => true,
  };

  // The exact callback construction AppShell uses: the shared factory owns
  // both the target-owning wrapper and the revision-aware submit. The local
  // wrapper only observes the submitted text, then forwards.
  const productionOnSend = createRevisionAwareOnSend({
    ...ports,
    setNewTaskSendPending: (pending: boolean) => {
      sendPendingFlags.push(pending);
    },
  });

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  await act(async () => {
    root.render(
      createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(ComposerStagingFixture, {
          draftKey: SESSION_1,
          children: createElement(ChatComposerRegion, {
            composerRef: composer,
            active: true,
            onboardingComposerHidden: false,
            activeInteraction: undefined,
            activeId: SESSION_1,
            contextUsageSessionId: SESSION_1,
            newTaskDraftKey: 'new-task:test-target',
            newTaskSendPending: false,
            stopPending: false,
            respondToSandboxBoundary: () => undefined,
            respondToClientCapability: () => undefined,
            respondToUserQuestion: () => undefined,
            respondToUserForm: () => undefined,
            stop: () => undefined,
            onOpenContextUsage: () => undefined,
            canStageContext: true,
            contextPickEnabled: true,
            directoryPickerEnabled: false,
            onSend: (text: string, metadata?: ComposerSendMetadata) => {
              submittedTexts.push(text);
              pendingSend = productionOnSend(text, metadata);
              return pendingSend;
            },
            onStop: () => undefined,
          }),
        }),
      }),
    );
  });

  return {
    revisionActions,
    composer,
    document,
    submitSend: async () => {
      const form = document.querySelector('form');
      assert.ok(form, 'the mounted Composer renders a submit form');
      await act(async () => {
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
      assert.ok(pendingSend, 'submitting the Composer must reach the production onSend');
      await act(async () => {
        await pendingSend;
      });
      await act(async () => {});
    },
    activeIdRef,
    revisionDraftRef,
    reviseCalls,
    sendCalls,
    submittedTexts,
    sendPendingFlags,
    restoreWindow,
  };
}

test('resending an unchanged revision goes through reviseBeforeTurn and the normal send', async () => {
  const world = await mountRevisionWorld();
  try {
    await act(async () => {
      // Enter edit mode for the sent turn, then keep the text identical.
      world.revisionActions.beginEditUserMessage('turn-1');
    });
    assert.equal(world.composer.current?.getText(), ORIGINAL_TEXT);

    await world.submitSend();

    // The real Composer submit carried the unchanged text into production onSend.
    assert.deepEqual(world.submittedTexts, [ORIGINAL_TEXT]);
    // The target-owning wrapper ran around the send.
    assert.deepEqual(world.sendPendingFlags, [true, false]);
    // The revision branch ran exactly once against the source turn.
    assert.equal(world.reviseCalls.length, 1);
    assert.equal(world.reviseCalls[0]?.sourceSessionId, SESSION_1);
    assert.equal(world.reviseCalls[0]?.args.sourceTurnId, 'turn-1');
    assert.equal(typeof world.reviseCalls[0]?.args.copyId, 'string');
    // The normal send followed exactly once into the child session,
    // still carrying the original text.
    assert.equal(world.sendCalls.length, 1);
    assert.equal(world.sendCalls[0]?.text, ORIGINAL_TEXT);
    assert.equal(world.sendCalls[0]?.options.targetSessionId, SESSION_2);
    assert.equal(world.sendCalls[0]?.options.waitForHostAdmission, true);
    // The revision draft settled and the composer kept no residue.
    assert.equal(world.revisionDraftRef.current, null);
    assert.equal(world.composer.current?.getText(), '');
  } finally {
    world.restoreWindow();
  }
});
