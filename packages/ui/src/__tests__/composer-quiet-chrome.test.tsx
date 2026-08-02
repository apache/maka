import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { Composer } from '../composer.js';

function render(children: ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider locale="zh">{children}</LocaleProvider>);
}

describe('composer quiet chrome', () => {
  it('keeps resting chrome to permission icon, plus menu, model, and send', () => {
    const markup = render(
      <Composer
        onSend={() => true}
        onStop={() => {}}
        onPickAttachments={() => {}}
        onPermissionModeChange={() => {}}
        onPlanModeChange={() => {}}
        onSwarmModeChange={() => {}}
        mentionSkills={[{ id: 'pdf', name: 'PDF' }]}
        modelLabel="demo-model"
        modelChoices={[]}
      />,
    );

    // Quiet surface: no header attach/voice cluster, no standalone modes/skills triggers.
    assert.doesNotMatch(markup, /maka-composer-header-actions/);
    assert.doesNotMatch(markup, /maka-composer-header-context/);
    assert.doesNotMatch(markup, /maka-composer-modes-menu/);
    assert.doesNotMatch(markup, /maka-composer-skill-trigger/);
    assert.doesNotMatch(markup, /maka-composer-streaming-hint/);

    // Footer left: plus → permission → model (+ thinking when levels offered).
    // Footer right: send only (no mic by default).
    assert.match(markup, /permissionModeIcon/);
    assert.match(markup, /maka-composer-plus-menu/);
    assert.match(markup, /maka-composer-left-controls/);
    assert.match(markup, /maka-composer-right-controls/);
    const plusIdx = markup.indexOf('maka-composer-plus-menu');
    const permissionIdx = markup.indexOf('permissionModeIcon');
    assert.ok(plusIdx >= 0 && permissionIdx > plusIdx, 'plus must sit left of permission');
    // Model chip/switcher is left of send (in left-controls), not next to send.
    const leftControls = markup.match(
      /maka-composer-left-controls[\s\S]*?maka-composer-right-controls/,
    )?.[0] ?? '';
    assert.match(
      leftControls,
      /maka-composer-model-chip|maka-model-switcher|maka-new-chat-model-selector|maka-model-picker-root/,
      'model control must render in left-controls after permission',
    );
    // Thinking stays out of the model menu; without levels it does not mount.
    assert.doesNotMatch(markup, /maka-thinking-level-selector/);
    assert.doesNotMatch(markup, /maka-composer-voice-button/);
    assert.doesNotMatch(markup, /maka-composer-realtime-voice-button/);
  });

  it('places thinking beside the model in left-controls when levels are offered', () => {
    const markup = render(
      <Composer
        onSend={() => true}
        onStop={() => {}}
        modelLabel="demo-model"
        modelChoices={[]}
        newChatThinkingLevels={['off', 'low', 'medium', 'high']}
        newChatThinkingLevel="medium"
        onNewChatThinkingLevelChange={() => {}}
      />,
    );

    const leftControls = markup.match(
      /maka-composer-left-controls[\s\S]*?maka-composer-right-controls/,
    )?.[0] ?? '';
    assert.match(
      leftControls,
      /maka-model-selection-controls/,
      'model + thinking share one left-footer pair',
    );
    assert.match(
      leftControls,
      /maka-thinking-level-selector/,
      'thinking must sit beside the model in left-controls',
    );
    const rightControls = markup.match(
      /maka-composer-right-controls[\s\S]*$/,
    )?.[0] ?? '';
    assert.doesNotMatch(
      rightControls,
      /maka-thinking-level-selector/,
      'thinking must not sit next to send',
    );
  });

  it('surfaces active mode and skill selections as drawer tokens, not footer chips', () => {
    const markup = render(
      <Composer
        onSend={() => true}
        onStop={() => {}}
        planModeActive
        onPlanModeChange={() => {}}
        mentionSkills={[{ id: 'pdf', name: 'PDF 工具' }]}
        modelLabel="demo"
      />,
    );

    // Drawer mounts when there is staged context; mode indicator is a token.
    assert.match(markup, /maka-composer-context-drawer/);
    assert.match(markup, /maka-composer-mode-indicator[^>]*data-mode="plan"/);
    assert.match(markup, /astryx-token/);
    // Legacy text mode-indicator button is gone from the footer.
    assert.doesNotMatch(markup, /<button[^>]*maka-composer-mode-indicator/);
  });

  it('shows a single voice control only when the host wires capture', () => {
    const markup = render(
      <Composer
        onSend={() => true}
        onStop={() => {}}
        onToggleVoiceCapture={() => {}}
        modelLabel="demo"
      />,
    );
    assert.match(markup, /maka-composer-voice-button/);
    assert.doesNotMatch(markup, /maka-composer-realtime-voice-button/);
  });

  it('places the workspace picker above the composer card for new chats', () => {
    const markup = render(
      <Composer
        onSend={() => true}
        onStop={() => {}}
        modelLabel="demo"
        workspacePicker={{
          projects: [],
          onAdd: () => {},
          onSelectProject: () => {},
          onRelink: () => {},
          onSelectNoProject: () => {},
        }}
      />,
    );
    assert.match(markup, /maka-composer-workspace-dock/);
    // Workspace row is a sibling above the form, not nested after the card.
    const dockIdx = markup.indexOf('maka-composer-workspace-dock');
    const formIdx = markup.indexOf('maka-composer composer');
    assert.ok(dockIdx >= 0 && formIdx > dockIdx);
  });

  /**
   * The project and branch decide where a NEW chat starts; once a session
   * exists they no longer move it. Leaving the row on screen in an open chat
   * reads as "you can still change this session's context here", which is
   * false — so the same wired picker must render nothing.
   */
  it('drops the workspace picker once a session is active', () => {
    const workspacePicker = {
      projects: [],
      onAdd: () => {},
      onSelectProject: () => {},
      onRelink: () => {},
      onSelectNoProject: () => {},
    };
    const markup = render(
      <Composer
        onSend={() => true}
        onStop={() => {}}
        modelLabel="demo"
        workspacePicker={workspacePicker}
        activeSession={{
          id: 'session-1',
          name: 'Test',
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
        }}
      />,
    );
    assert.doesNotMatch(markup, /maka-composer-workspace-dock/);
  });
});
