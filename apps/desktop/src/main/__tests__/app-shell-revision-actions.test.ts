import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionSummary, StoredMessage } from '@maka/core';
import {
  createAppShellRevisionActions,
  type TurnRevisionDraft,
} from '../../renderer/app-shell-revision-actions.js';
import type { ComposerSkillSelection } from '@maka/ui';

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
    input: { sourceTurnId: string },
  ) => Promise<SessionSummary>,
  remove: (sessionId: string) => Promise<void>,
): () => void {
  const target = globalThis as unknown as { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(target, 'window');
  const previousWindow = target.window;
  Object.defineProperty(target, 'window', {
    configurable: true,
    value: {
      maka: { sessions: { reviseBeforeTurn, remove } },
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
    input: { sourceTurnId: string },
  ) => Promise<SessionSummary>;
  messages?: StoredMessage[];
  pendingAttachments?: boolean;
  previousComposerText?: string;
  previousComposerSkills?: ComposerSkillSelection[];
  getComposerSkills?: () => ComposerSkillSelection[];
  refreshMessagesResult?: boolean;
}) {
  const activeIdRef: { current: string | undefined } = { current: 'source' };
  const revisionDraftRef: { current: TurnRevisionDraft | null } = { current: null };
  const composerCalls: string[] = [];
  const opened: string[] = [];
  const revisionCalls: Array<[string, { sourceTurnId: string }]> = [];
  const removed: string[] = [];
  const infoToasts: Array<[string, string | undefined]> = [];
  const writtenSkillDrafts: Array<[string, ComposerSkillSelection[]]> = [];
  const restoreWindow = installWindow(
    async (sessionId, input) => {
      revisionCalls.push([sessionId, input]);
      return options.reviseBeforeTurn(sessionId, input);
    },
    async (sessionId) => { removed.push(sessionId); },
  );
  const actions = createAppShellRevisionActions({
    uiLocale: 'en',
    activeIdRef,
    composerRef: {
      current: {
        setText: (text: string) => { composerCalls.push(text); },
        appendText: () => undefined,
        getText: () => options.previousComposerText ?? 'Previous draft',
        getSkills: () => options.getComposerSkills?.() ?? options.previousComposerSkills ?? [],
        setSkills: () => undefined,
        setSkillDraft: (key, skills) => {
          writtenSkillDrafts.push([key, skills.map((skill) => ({ ...skill }))]);
          composerCalls.push(`<skill-draft:${key}:${skills.map((skill) => skill.id).join(',')}>`);
        },
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
    removed,
    writtenSkillDrafts,
    restoreWindow,
    revisionDraftRef,
  };
}

describe('app shell revision actions', () => {
  it('starts a local draft and creates a version only when the edited text is sent', async () => {
    const harness = createHarness({ reviseBeforeTurn: async () => session('revision') });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      assert.deepEqual(harness.revisionCalls, []);
      assert.equal(harness.revisionDraftRef.current?.draftSessionId, 'source');
      assert.deepEqual(harness.revisionDraftRef.current?.previousComposerSkills, []);
      assert.deepEqual(harness.composerCalls, ['Human-facing prompt', '<focus>']);

      assert.equal(await harness.actions.prepareRevisionSend('Edited prompt'), true);
      assert.deepEqual(harness.revisionCalls, [['source', { sourceTurnId: 'turn-1' }]]);
      assert.deepEqual(harness.opened, ['revision']);
      assert.equal(harness.revisionDraftRef.current?.draftSessionId, 'revision');
      assert.deepEqual(
        harness.composerCalls,
        [
          'Human-facing prompt',
          '<focus>',
          '<skill-draft:revision:>',
          '<draft:revision:Edited prompt>',
          '<focus>',
        ],
      );
    } finally {
      harness.restoreWindow();
    }
  });

  it('migrates the submitted Skill snapshot when the live draft changes during revision creation', async () => {
    let resolveRevision: ((value: SessionSummary) => void) | undefined;
    const revisionPromise = new Promise<SessionSummary>((resolve) => { resolveRevision = resolve; });
    let liveSkills: ComposerSkillSelection[] = [
      { id: 'alpha', name: 'Alpha' },
    ];
    const harness = createHarness({
      getComposerSkills: () => liveSkills,
      reviseBeforeTurn: async () => revisionPromise,
    });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      const pending = harness.actions.prepareRevisionSend('Edited prompt');
      await Promise.resolve();
      liveSkills = [{ id: 'beta', name: 'Beta' }];
      resolveRevision?.(session('revision'));

      assert.equal(await pending, true);
      assert.deepEqual(harness.writtenSkillDrafts, [
        ['revision', [{ id: 'alpha', name: 'Alpha' }]],
      ]);
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
      assert.deepEqual(harness.removed, ['revision']);
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
      assert.equal(await harness.actions.prepareRevisionSend('Edited prompt'), false);
      assert.equal(harness.activeIdRef.current, 'source');
      assert.equal(harness.revisionDraftRef.current?.draftSessionId, 'source');
      assert.deepEqual(harness.removed, ['revision']);
      assert.ok(harness.composerCalls.includes('<draft:source:Edited prompt>'));
      assert.deepEqual(harness.composerCalls.slice(-2), ['Edited prompt', '<focus>']);
    } finally {
      harness.restoreWindow();
    }
  });

  it('cancels back to the source and restores its previous draft', async () => {
    const harness = createHarness({
      reviseBeforeTurn: async () => session('revision'),
      previousComposerSkills: [{ id: 'workspace-only', name: 'Workspace Only' }],
    });
    try {
      harness.actions.beginEditUserMessage('turn-1');
      await harness.actions.prepareRevisionSend('Edited prompt');
      await harness.actions.cancelRevisionDraft();
      assert.equal(harness.revisionDraftRef.current, null);
      assert.deepEqual(harness.opened, ['revision', 'source']);
      assert.deepEqual(harness.removed, ['revision']);
      assert.ok(harness.composerCalls.includes('<clear:revision>'));
      assert.ok(harness.composerCalls.includes('<skill-draft:source:workspace-only>'));
      assert.deepEqual(harness.composerCalls.slice(-2), ['Previous draft', '<focus>']);
    } finally {
      harness.restoreWindow();
    }
  });
});
