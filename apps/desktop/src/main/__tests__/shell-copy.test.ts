import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildCommandList, buildSessionCommands } from '../../renderer/command-palette-commands.js';
import { messageReadErrorMessage, openPathActionErrorMessage } from '../../renderer/app-shell-copy.js';

describe('shell copy catalog', () => {
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

});
