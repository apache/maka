/**
 * #1045 P1/P2 behavior pins for the freeze-at-open command list:
 *  - base command list identity stays usable after options churn (ref deref)
 *  - export run() reads the LATEST messages from the options ref
 *  - session rows rebuild from visibleSessions independently of the base list
 *
 * Pure unit test of the builders (no React / no source-regex).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { SessionSummary, StoredMessage } from '@maka/core';
import {
  buildAppShellCommandList,
  buildAppShellSessionCommands,
  type AppShellCommandListOptions,
} from '../../renderer/app-shell-command-actions.js';

function session(partial: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'name'>): SessionSummary {
  return {
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'done',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: false,
    model: 'fake',
    permissionMode: 'ask',
    ...partial,
  };
}

function userMessage(text: string, id = 'u1'): StoredMessage {
  return { type: 'user', id, turnId: 't1', ts: 1, text };
}

function makeOptions(partial: Partial<AppShellCommandListOptions> = {}): AppShellCommandListOptions {
  const activeId = partial.activeId ?? 's1';
  const sessions = partial.sessions ?? [session({ id: activeId, name: '会话 A' })];
  return {
    activeId,
    activePermissionMode: 'ask',
    connections: [],
    defaultConnection: null,
    dailyReviewBridge: {
      fetchDay: async () => {
        throw new Error('unused');
      },
    },
    messages: [],
    sessions,
    themePref: 'auto',
    visibleSessions: sessions,
    captureComposerImportOwner: () => ({
      sessionId: activeId,
      navSection: 'sessions',
    }),
    closePalette: () => undefined,
    composerRef: { current: null },
    createSession: () => undefined,
    startModeSession: async () => false,
    isComposerImportOwnerActive: () => true,
    openHelp: () => undefined,
    openPlanReminderForm: () => undefined,
    openProjectFolder: async () => undefined,
    openSessionInChat: () => undefined,
    openSettings: () => undefined,
    openSettingsSection: () => undefined,
    openSkillsFolder: async () => undefined,
    openWorkspaceFolder: async () => undefined,
    refreshConnections: async () => undefined,
    saveDailyReviewMarkdown: async () => undefined,
    setNavSelection: () => undefined,
    setPermissionMode: async () => undefined,
    setThemePref: () => undefined,
    toastApi: {
      success: () => undefined,
      info: () => undefined,
      error: () => undefined,
    },
    ...partial,
    uiLocale: partial.uiLocale ?? 'zh',
  };
}

describe('app-shell command freeze + live session rows (#1045)', () => {
  const originalClipboard = globalThis.navigator?.clipboard;

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    } else if (globalThis.navigator) {
      // @ts-expect-error test cleanup may drop clipboard
      delete globalThis.navigator.clipboard;
    }
  });

  test('base command identity stays stable across message churn; export run uses latest messages', async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        ...(globalThis.navigator ?? {}),
        clipboard: {
          writeText: async (text: string) => {
            written.push(text);
          },
        },
      },
    });

    const optionsRef = {
      current: makeOptions({
        activeId: 's1',
        messages: [userMessage('stale-body')],
        sessions: [session({ id: 's1', name: '导出会话' })],
      }),
    };

    // Freeze-at-open: build base once, then churn messages without rebuilding.
    const baseCommands = buildAppShellCommandList(optionsRef);
    const baseIds = baseCommands.map((c) => c.id);
    const exportCmd = baseCommands.find((c) => c.id === 'diag:export-conversation');
    assert.ok(exportCmd, 'export command must be present when activeId is set at build time');

    optionsRef.current = {
      ...optionsRef.current,
      messages: [userMessage('latest-streamed-body', 'u2')],
      // Churn that must NOT force a base rebuild for correctness:
      themePref: 'dark',
      toastApi: {
        success: () => undefined,
        info: () => undefined,
        error: () => undefined,
      },
    };

    // Same array identity — the palette keeps this frozen list while open
    // (useAppShellCommands freezes base on paletteOpen, not on messages).
    assert.deepEqual(
      baseCommands.map((c) => c.id),
      baseIds,
      'frozen base list must keep the build-time command ids across message churn',
    );
    assert.equal(
      baseCommands.find((c) => c.id === 'diag:export-conversation'),
      exportCmd,
      'export command object identity is stable while the base list is frozen',
    );

    await exportCmd!.run();
    assert.equal(written.length, 1, 'export must write clipboard once');
    assert.match(
      written[0]!,
      /latest-streamed-body/,
      'export run() must dereference latest messages from the options ref',
    );
    assert.doesNotMatch(written[0]!, /stale-body/, 'export must not keep the build-time messages snapshot');
  });

  test('session rows reflect visibleSessions changes independently of the frozen base list', () => {
    const s1 = session({ id: 's1', name: '会话 A' });
    const s2 = session({ id: 's2', name: '会话 B' });
    const optionsRef = {
      current: makeOptions({
        activeId: 's1',
        sessions: [s1],
        visibleSessions: [s1],
      }),
    };

    const baseCommands = buildAppShellCommandList(optionsRef);
    const sessionRowsOpen = buildAppShellSessionCommands(optionsRef);
    assert.deepEqual(
      sessionRowsOpen.map((c) => c.id),
      ['session:s1'],
    );
    assert.equal(sessionRowsOpen[0]?.hint, '当前');

    // Background create while palette stays open: base stays frozen; sessions rebuild.
    optionsRef.current = {
      ...optionsRef.current,
      sessions: [s1, s2],
      visibleSessions: [s1, s2],
      messages: [userMessage('churn that must not touch base identity')],
    };
    const sessionRowsAfterCreate = buildAppShellSessionCommands(optionsRef);
    assert.deepEqual(
      sessionRowsAfterCreate.map((c) => c.id),
      ['session:s1', 'session:s2'],
      'session catalog rows must track visibleSessions while the palette is open',
    );

    // Base list is still the original frozen object (caller does not rebuild).
    assert.ok(baseCommands.every((c) => !c.id.startsWith('session:')));
    assert.equal(baseCommands.find((c) => c.id === 'diag:export-conversation')?.id, 'diag:export-conversation');

    // Active-session hint updates with activeId without rebuilding base.
    optionsRef.current = {
      ...optionsRef.current,
      activeId: 's2',
    };
    const sessionRowsAfterSwitch = buildAppShellSessionCommands(optionsRef);
    assert.equal(sessionRowsAfterSwitch.find((c) => c.id === 'session:s2')?.hint, '当前');
    assert.equal(sessionRowsAfterSwitch.find((c) => c.id === 'session:s1')?.hint, undefined);
  });

  test('session select run() uses openSessionInChat from the live options ref', () => {
    const selected: string[] = [];
    const optionsRef = {
      current: makeOptions({
        visibleSessions: [session({ id: 's9', name: '目标' })],
        openSessionInChat: (id) => {
          selected.push(id);
        },
      }),
    };
    const rows = buildAppShellSessionCommands(optionsRef);
    // Swap the callback after build (same pattern as openSessionInChatRef).
    optionsRef.current = {
      ...optionsRef.current,
      openSessionInChat: (id) => {
        selected.push(`live:${id}`);
      },
    };
    rows[0]!.run();
    assert.deepEqual(selected, ['live:s9']);
  });
});
