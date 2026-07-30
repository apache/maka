import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core';

import { buildCommandList, buildSessionCommands } from '../../renderer/command-palette-commands.js';
import { messageReadErrorMessage, openPathActionErrorMessage } from '../../renderer/app-shell-copy.js';
import { getShellCopy } from '../../renderer/locales/shell-copy.js';

describe('shell copy catalog', () => {
  it('provides complete representative navigation and shared-action copy', () => {
    assert.equal(getShellCopy('zh').navigation.settings, '设置');
    assert.equal(getShellCopy('en').navigation.settings, 'Settings');
    assert.equal(getShellCopy('en').actions.retry, 'Retry');
    assert.equal(getShellCopy('en').commandPalette.placeholder, 'Search commands, settings, or conversations…');
  });

  it('classifies safe helper failures in the requested locale', () => {
    assert.equal(messageReadErrorMessage(new Error('network disconnected'), 'en'), 'Network error');
    assert.equal(
      openPathActionErrorMessage(new Error('unexpected'), 'workspace', 'en'),
      'Could not open the workspace. Try again later.',
    );
  });

  it('builds shell commands and session metadata in both locales', () => {
    let selectedModule: unknown;
    const commands = buildCommandList({
      locale: 'en',
      activeSessionId: undefined,
      themePref: 'auto',
      connections: [],
      defaultSlug: null,
      onNewChat() {},
      onOpenSettings() {},
      onOpenSettingsSection() {},
      onOpenShortcuts() {},
      onSetTheme() {},
      onSelectModule(selection) { selectedModule = selection; },
    });

    assert.equal(commands.find((command) => command.id === 'action:new-chat')?.label, 'New conversation');
    assert.equal(commands.find((command) => command.id === 'action:open-settings')?.label, 'Open Settings');
    const mcpCommand = commands.find((command) => command.id === 'nav:mcp');
    assert.equal(mcpCommand?.label, 'Open · MCP');
    mcpCommand?.run();
    assert.deepEqual(selectedModule, { section: 'extensions', module: 'mcp' });

    const sessionCommands = buildSessionCommands({
      locale: 'en',
      sessions: [
        {
          id: 'session-1',
          name: '用户原始标题',
          status: 'active',
          isFlagged: false,
          isArchived: false,
          labels: [],
          hasUnread: false,
          backend: 'fake',
          llmConnectionSlug: 'fake',
          connectionLocked: false,
          model: 'fake',
          permissionMode: 'ask',
        },
      ],
      activeSessionId: 'session-1',
      onSelectSession() {},
    });

    assert.equal(sessionCommands[0]?.label, '用户原始标题');
    assert.equal(sessionCommands[0]?.hint, 'Current');
    assert.equal(sessionCommands[0]?.group, 'Conversations');
  });

  it('localizes every visible command variant in English without silent fallback', () => {
    const connections: LlmConnection[] = [
      {
        slug: 'default-connection',
        name: 'Default Provider',
        providerType: 'openai',
        defaultModel: 'gpt-test',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        slug: 'secondary-connection',
        name: 'Secondary Provider',
        providerType: 'anthropic',
        defaultModel: 'claude-test',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const noop = () => {};
    const commands = buildCommandList({
      locale: 'en',
      activeSessionId: 'session-1',
      themePref: 'auto',
      connections,
      defaultSlug: 'default-connection',
      onNewChat: noop,
      onStartDeepResearch: noop,
      onOpenSettings: noop,
      onOpenSettingsSection: noop,
      onOpenShortcuts: noop,
      onSetTheme: noop,
      onTestConnection: noop,
      onSetDefaultConnection: noop,
      onOpenWorkspace: noop,
      onOpenProjectFolder: noop,
      onOpenSkillsFolder: noop,
      onExportActiveConversation: noop,
      onSaveActiveConversationToFile: noop,
      onCopyTodayDailyReview: noop,
      onOpenLocalMemoryFile: noop,
      onOpenWorkspaceInstructionsFile: noop,
      onSetPermissionMode: noop,
      activePermissionMode: 'ask',
      onPasteTodayDailyReviewIntoComposer: noop,
      onSaveTodayDailyReviewToFile: noop,
      onCopyEnvSummary: noop,
      onTestNetworkProxy: noop,
      onSelectModule: noop,
      onStartPlanReminder: noop,
    });

    assert.ok(commands.length >= 43, 'the fixture must exercise every optional command family');
    for (const command of commands) {
      for (const [field, value] of Object.entries({
        label: command.label,
        hint: command.hint,
        group: command.group,
      })) {
        if (!value) continue;
        assert.doesNotMatch(
          value,
          /[\u3400-\u9fff]/u,
          `${command.id}.${field} silently retained Chinese copy: ${value}`,
        );
      }
    }

    assert.equal(
      commands.find((command) => command.id === 'diag:test-default')?.label,
      'Test default connection · Default Provider',
    );
    assert.equal(
      commands.find((command) => command.id === 'connection:set-default:secondary-connection')?.label,
      'Set as default · Secondary Provider',
    );
    assert.deepEqual(
      commands
        .filter((command) => command.id.startsWith('perm:set-'))
        .map((command) => command.id),
      ['perm:set-ask', 'perm:set-bypass'],
    );
  });
});
