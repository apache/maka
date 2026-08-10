import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { StoredMessage } from '@maka/core';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';

test('an older transcript refresh cannot overwrite a newer queued-successor read', async () => {
  const first = deferred<StoredMessage[]>();
  const second = deferred<StoredMessage[]>();
  const reads = [first.promise, second.promise];
  const applied: StoredMessage[][] = [];
  const restoreWindow = installWindow({
    sessions: {
      readMessages: async () => reads.shift() ?? [],
    },
  });

  try {
    const actions = createAppShellChatActions({
      uiLocale: 'en',
      activeIdRef: { current: 'session-1' },
      addPendingSessionAction: () => true,
      captureComposerImportOwner: () => ({ sessionId: 'session-1', navSection: 'sessions' }),
      checkTaskSubmissionReadiness: async () => true,
      clearPendingSessionAction: () => undefined,
      isNewChatSendSurfaceActive: () => true,
      isShellSurfaceOwnerActive: () => true,
      markSessionReadLocally: () => undefined,
      messageRetryPendingRef: { current: new Set<string>() },
      refreshSessions: async () => [],
      setActiveId: () => undefined,
      setMessageLoadErrorBySession: () => undefined,
      setMessageRetryPendingBySession: () => undefined,
      setMessages: (messages) => {
        applied.push(messages as StoredMessage[]);
      },
      setNavSelection: () => undefined,
      setLiveTurnBySession: () => undefined,
      setInteractionBySession: () => undefined,
      showModelSetupToast: () => undefined,
      toastApi: { error: () => undefined, info: () => undefined },
      upsertSessionSummary: () => undefined,
      newChatModel: null,
      pendingNewChatThinkingLevel: null,
      newChatCollaborationMode: 'agent',
      newChatOrchestrationMode: 'default',
      newChatProjectId: undefined,
    });

    const olderRefresh = actions.refreshMessages('session-1');
    const newerRefresh = actions.refreshMessages('session-1');
    const newerMessages = [assistant('new-assistant', 'new answer')];
    second.resolve(newerMessages);
    assert.equal(await newerRefresh, true);
    first.resolve([assistant('old-assistant', 'old answer')]);
    assert.equal(await olderRefresh, true);

    assert.deepEqual(applied, [newerMessages]);
  } finally {
    restoreWindow();
  }
});

function assistant(id: string, text: string): StoredMessage {
  return {
    type: 'assistant',
    id,
    turnId: `turn-${id}`,
    ts: 1,
    text,
    modelId: 'gpt-5.6-sol',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installWindow(maka: unknown): () => void {
  const target = globalThis as unknown as { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(target, 'window');
  const previousWindow = target.window;
  Object.defineProperty(target, 'window', {
    configurable: true,
    value: {
      maka,
      setTimeout,
    },
    writable: true,
  });
  return () => {
    if (hadWindow) {
      Object.defineProperty(target, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      });
    } else {
      delete target.window;
    }
  };
}
