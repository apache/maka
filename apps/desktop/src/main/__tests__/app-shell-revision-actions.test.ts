import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { SessionSummary, StoredMessage } from '@maka/core';
import {
  abandonTurnRevisionCopyAttempt,
  createAppShellRevisionActions,
  type TurnRevisionDraft,
} from '../../renderer/app-shell-revision-actions.js';
import {
  completeSessionCopyAttempt,
  readSessionCopyAttempt,
} from '../../renderer/session-copy-attempt.js';

const revisionAttemptKey = {
  scope: 'edit-and-resend:turn-1',
  kind: 'revision' as const,
  sourceSessionId: 'source',
};

afterEach(() => {
  const attempt = readSessionCopyAttempt(revisionAttemptKey);
  if (attempt) completeSessionCopyAttempt(revisionAttemptKey, attempt.copyId);
});

function session(id: string): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: false,
    model: 'test',
    permissionMode: 'ask',
  };
}

function userMessage(
  overrides: Partial<Extract<StoredMessage, { type: 'user' }>> = {},
): Extract<StoredMessage, { type: 'user' }> {
  return {
    type: 'user',
    id: 'message-1',
    turnId: 'turn-1',
    ts: 1,
    text: 'Human-facing prompt',
    ...overrides,
  };
}

function installWindow(
  reviseBeforeTurn: (
    sessionId: string,
    input: { sourceTurnId: string; copyId?: string },
  ) => Promise<SessionSummary>,
  cleanupSessionCopy: (sessionId: string) => Promise<void>,
  abandonSessionCopy: (sessionId: string) => Promise<void>,
): () => void {
  const target = globalThis as unknown as { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(target, 'window');
  const previousWindow = target.window;
  Object.defineProperty(target, 'window', {
    configurable: true,
    value: {
      maka: { sessions: { reviseBeforeTurn, cleanupSessionCopy, abandonSessionCopy } },
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

function createHarness(options: {
  reviseBeforeTurn: (
    sessionId: string,
    input: { sourceTurnId: string; copyId?: string },
  ) => Promise<SessionSummary>;
  messages?: StoredMessage[];
  pendingAttachments?: boolean;
  previousComposerText?: string;
  refreshMessagesResult?: boolean;
  abandonThrows?: boolean;
}) {
  const activeIdRef: { current: string | undefined } = { current: 'source' };
  const revisionDraftRef: { current: TurnRevisionDraft | null } = { current: null };
  const composerCalls: string[] = [];
  const opened: string[] = [];
  const revisionCalls: Array<[string, { sourceTurnId: string; copyId?: string }]> = [];
  const abandoned: string[] = [];
  const infoToasts: Array<[string, string | undefined]> = [];
  const restoreWindow = installWindow(
    async (sessionId, input) => {
      revisionCalls.push([sessionId, input]);
      return options.reviseBeforeTurn(sessionId, input);
    },
    async () => undefined,
    async (sessionId) => {
      abandoned.push(sessionId);
      if (options.abandonThrows) throw new Error('cleanup intent was not recorded');
    },
  );
  const actions = createAppShellRevisionActions({
    uiLocale: 'en',
    activeIdRef,
    composerRef: {
      current: {
        setText: (text: string) => { composerCalls.push(text); },
        appendText: () => undefined,
        getText: () => options.previousComposerText ?? 'Previous draft',
        clearDraft: (key: string) => { composerCalls.push(`<clear:${key}>`); },
        setDraft: (key: string, text: string) => { composerCalls.push(`<draft:${key}:${text}>`); },
        focus: () => { composerCalls.push('<focus>'); },
      },
    },
    messages: options.messages ?? [userMessage()],
    hasPendingAttachments: () => options.pendingAttachments === true,
    openSessionInChat: (sessionId) => {
      opened.push(sessionId);
      activeIdRef.current = sessionId;
    },
    refreshMessages: async () => options.refreshMessagesResult ?? true,
    refreshSessions: async () => [],
    setMessages: () => undefined,
    commitRevisionDraft: (draft) => { revisionDraftRef.current = draft; },
    revisionDraftRef,
    toastApi: {
      info: (title, description) => { infoToasts.push([title, description]); },
      error: () => undefined,
    },
    upsertSessionSummary: () => undefined,
  });
  return {
    actions,
    activeIdRef,
    revisionCalls,
    composerCalls,
    infoToasts,
    opened,
    abandoned,
    restoreWindow,
    revisionDraftRef,
    getRevisionDraft: () => revisionDraftRef.current,
  };
}

describe('app shell revision actions', () => {
  it('starts a local draft and creates a version only when the edited text is sent', async () => {
    const harness = createHarness({ reviseBeforeTurn: async () => session('revision') });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      assert.deepEqual(harness.revisionCalls, []);
      assert.equal(harness.revisionDraftRef.current?.draftSessionId, 'source');
      assert.deepEqual(harness.composerCalls, ['Human-facing prompt', '<focus>']);

      assert.equal(await harness.actions.prepareRevisionSend('Edited prompt'), true);
      assert.deepEqual(harness.revisionCalls, [
        [
          'source',
          {
            sourceTurnId: 'turn-1',
            copyId: harness.revisionDraftRef.current?.copyId,
          },
        ],
      ]);
      assert.deepEqual(harness.opened, ['revision']);
      assert.equal(harness.revisionDraftRef.current?.draftSessionId, 'revision');
      assert.deepEqual(
        harness.composerCalls,
        ['Human-facing prompt', '<focus>', '<draft:revision:Edited prompt>', '<focus>'],
      );
    } finally {
      harness.restoreWindow();
    }
  });

  it('keeps one copy identity when revision preparation has an ambiguous failure', async () => {
    let attempts = 0;
    const harness = createHarness({
      reviseBeforeTurn: async (_sessionId, input) => {
        attempts += 1;
        if (attempts === 1) throw new Error('response lost');
        return session(input.copyId ?? 'missing-copy-id');
      },
    });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      assert.equal(await harness.actions.prepareRevisionSend('Edited prompt'), false);
      assert.equal(await harness.actions.prepareRevisionSend('Edited prompt'), true);
      const copyIds = harness.revisionCalls.map(([, input]) => input.copyId);
      assert.equal(copyIds.length, 2);
      assert.equal(copyIds[0], copyIds[1]);
      assert.equal(harness.revisionDraftRef.current?.draftSessionId, copyIds[0]);
    } finally {
      harness.restoreWindow();
    }
  });

  it('refuses source and retained attachment history before creating a lossy revision', () => {
    const attachment = {
      kind: 'image' as const,
      name: 'source.png',
      mimeType: 'image/png',
      bytes: 4,
      ref: { kind: 'session_file' as const, sessionId: 'source', relativePath: 'attachment-1' },
    };
    const harness = createHarness({
      messages: [
        userMessage({ turnId: 'turn-0', attachments: [attachment] }),
        userMessage({ id: 'message-2', turnId: 'turn-1', ts: 2 }),
      ],
      reviseBeforeTurn: async () => session('revision'),
    });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      assert.equal(harness.revisionDraftRef.current, null);
      assert.deepEqual(harness.revisionCalls, []);
      assert.equal(harness.infoToasts[0]?.[0], 'This message cannot be edited yet');
    } finally {
      harness.restoreWindow();
    }
  });

  it('refuses transformed prompts and a composer that already owns attachments', () => {
    const transformed = createHarness({
      messages: [userMessage({ text: '<invoked-skill>hidden</invoked-skill>', displayText: '/skill prompt' })],
      reviseBeforeTurn: async () => session('revision'),
    });
    try {
      transformed.actions.beginEditUserMessage('turn-1');
      assert.equal(transformed.revisionDraftRef.current, null);
    } finally {
      transformed.restoreWindow();
    }

    const pending = createHarness({
      pendingAttachments: true,
      reviseBeforeTurn: async () => session('revision'),
    });
    try {
      pending.actions.beginEditUserMessage('turn-1');
      assert.equal(pending.revisionDraftRef.current, null);
    } finally {
      pending.restoreWindow();
    }
  });

  it('does not steal focus when navigation wins a pending revision creation', async () => {
    let resolveRevision: ((value: SessionSummary) => void) | undefined;
    const revisionPromise = new Promise<SessionSummary>((resolve) => { resolveRevision = resolve; });
    const harness = createHarness({ reviseBeforeTurn: async () => revisionPromise });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      const pending = harness.actions.prepareRevisionSend('Edited prompt');
      await Promise.resolve();
      harness.activeIdRef.current = 'another-session';
      resolveRevision?.(session('revision'));
      assert.equal(await pending, false);
      assert.deepEqual(harness.opened, []);
      assert.deepEqual(harness.abandoned, ['revision']);
    } finally {
      harness.restoreWindow();
    }
  });

  it('rolls back an empty version when its copied history cannot load', async () => {
    const harness = createHarness({
      reviseBeforeTurn: async () => session('revision'),
      refreshMessagesResult: false,
    });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      const abandonedCopyId = harness.revisionDraftRef.current?.copyId;
      assert.equal(await harness.actions.prepareRevisionSend('Edited prompt'), false);
      assert.equal(harness.activeIdRef.current, 'source');
      assert.equal(harness.revisionDraftRef.current?.draftSessionId, 'source');
      assert.deepEqual(harness.abandoned, ['revision']);
      assert.notEqual(harness.revisionDraftRef.current?.copyId, abandonedCopyId);
      assert.ok(harness.composerCalls.includes('<draft:source:Edited prompt>'));
      assert.deepEqual(harness.composerCalls.slice(-2), ['Edited prompt', '<focus>']);
    } finally {
      harness.restoreWindow();
    }
  });

  it('does not replace a target until its cleanup intent is durable', async () => {
    const control = {
      reviseBeforeTurn: async () => session('revision'),
      refreshMessagesResult: false,
      abandonThrows: true,
    };
    const harness = createHarness(control);
    try {
      harness.actions.beginEditUserMessage('turn-1');
      const copyId = harness.revisionDraftRef.current?.copyId;
      assert.equal(await harness.actions.prepareRevisionSend('Edited prompt'), false);
      assert.equal(harness.revisionDraftRef.current?.copyId, copyId);
      assert.equal(harness.revisionDraftRef.current?.copyPhase, 'abandoning');
      assert.deepEqual(harness.abandoned, ['revision']);
    } finally {
      control.abandonThrows = false;
      await harness.actions.cancelRevisionDraft();
      harness.restoreWindow();
    }
  });

  it('durably abandons the target when a committed Revision response is lost', async () => {
    const harness = createHarness({
      reviseBeforeTurn: async () => {
        throw new Error('Committed response was lost');
      },
    });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      const firstCopyId = harness.revisionDraftRef.current?.copyId;
      assert.equal(await harness.actions.prepareRevisionSend('Edited prompt'), false);

      await harness.actions.cancelRevisionDraft();
      assert.deepEqual(harness.abandoned, [firstCopyId]);
      assert.equal(harness.revisionDraftRef.current, null);

      harness.actions.beginEditUserMessage('turn-1');
      assert.notEqual(harness.getRevisionDraft()?.copyId, firstCopyId);
    } finally {
      harness.restoreWindow();
    }
  });

  it('remembers an ambiguous Revision request across renderer state loss', async () => {
    const first = createHarness({
      reviseBeforeTurn: async () => {
        throw new Error('Committed response was lost');
      },
    });
    first.actions.beginEditUserMessage('turn-1');
    const copyId = first.revisionDraftRef.current?.copyId;
    assert.equal(await first.actions.prepareRevisionSend('Edited prompt'), false);
    first.restoreWindow();

    const reloaded = createHarness({ reviseBeforeTurn: async () => session('revision') });
    try {
      reloaded.actions.beginEditUserMessage('turn-1');
      assert.equal(reloaded.revisionDraftRef.current?.copyId, copyId);
      assert.equal(reloaded.revisionDraftRef.current?.copyPhase, 'started');
      await reloaded.actions.cancelRevisionDraft();
      assert.deepEqual(reloaded.abandoned, [copyId]);
    } finally {
      reloaded.restoreWindow();
    }
  });

  it('keeps an archived draft cleanup handle until durable abandon is acknowledged', async () => {
    const first = createHarness({
      reviseBeforeTurn: async () => {
        throw new Error('Committed response was lost');
      },
      abandonThrows: true,
    });
    first.actions.beginEditUserMessage('turn-1');
    assert.equal(await first.actions.prepareRevisionSend('Edited prompt'), false);
    const draft = first.revisionDraftRef.current;
    assert.ok(draft);
    assert.equal(await abandonTurnRevisionCopyAttempt(draft), false);
    first.restoreWindow();

    const reloaded = createHarness({ reviseBeforeTurn: async () => session('revision') });
    try {
      reloaded.actions.beginEditUserMessage('turn-1');
      assert.equal(reloaded.revisionDraftRef.current?.copyPhase, 'abandoning');
      await reloaded.actions.cancelRevisionDraft();
    } finally {
      reloaded.restoreWindow();
    }
  });

  it('cancels back to the source and restores its previous draft', async () => {
    const harness = createHarness({
      reviseBeforeTurn: async () => session('revision'),
      previousComposerText: '/skill:workspace-only Previous draft',
    });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      await harness.actions.prepareRevisionSend('Edited prompt');
      await harness.actions.cancelRevisionDraft();
      assert.equal(harness.revisionDraftRef.current, null);
      assert.deepEqual(harness.opened, ['revision', 'source']);
      assert.deepEqual(harness.abandoned, ['revision']);
      assert.ok(harness.composerCalls.includes('<clear:revision>'));
      // One restore carries both the words and the staged Skill.
      assert.ok(
        harness.composerCalls.includes('<draft:source:/skill:workspace-only Previous draft>'),
      );
      assert.deepEqual(
        harness.composerCalls.slice(-2),
        ['/skill:workspace-only Previous draft', '<focus>'],
      );
    } finally {
      harness.restoreWindow();
    }
  });
});
