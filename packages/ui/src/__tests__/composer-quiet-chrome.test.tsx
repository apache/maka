import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { Composer } from '../composer.js';

function render(children: ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider locale="zh">{children}</LocaleProvider>);
}

/**
 * The one mode mark's own `<button>` tag and its contents, bounded by its
 * closing tag. Assertions scoped to this cannot be satisfied by a later
 * control that happens to carry the same attribute.
 */
function markPast(markup: string, mode: string): string {
  const at = markup.indexOf(`data-mode="${mode}"`);
  if (at < 0) return '';
  const open = markup.lastIndexOf('<button', at);
  const close = markup.indexOf('</button>', at);
  return markup.slice(open, close < 0 ? undefined : close + '</button>'.length);
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
      /maka-composer-model-chip|maka-model-switcher-trigger|maka-new-chat-model-selector/,
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

  it('keeps the model + thinking pair mounted mid-turn, locked with the reason', () => {
    // A turn in flight locks the model and thinking parameters; it does not
    // remove their meaning. The pair must stay in the footer — unmounting it
    // reflowed the whole row on turn start/end — and the lock must explain
    // itself: Astryx Button keeps a tooltipped trigger focusable via
    // aria-disabled, so the reason copy is discoverable by pointer, keyboard,
    // and screen reader alike.
    //
    // The fixture must make streaming the ONLY lock source: an activeSession
    // already at rest ('done') and a catalog that contains the current model,
    // so the assertions below attribute the lock to `streaming` alone — and a
    // deletion of the streaming branch in composer.tsx turns this red.
    const session = {
      id: 'session-1',
      name: 'Test',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'done' as const,
      backend: 'fake' as const,
      llmConnectionSlug: 'fake',
      connectionLocked: false,
      model: 'fake',
      permissionMode: 'ask' as const,
    };
    const choices = [
      { connectionSlug: 'fake', providerType: 'anthropic' as const, model: 'fake', label: 'fake' },
    ];
    const thinkingProps = {
      activeThinkingLevels: ['off', 'high'] as ('off' | 'high')[],
      activeThinkingLevel: 'high' as const,
      onThinkingLevelChange: () => {},
    };
    const renderComposer = (streaming: boolean) => render(
      <Composer
        onSend={() => true}
        onStop={() => {}}
        streaming={streaming}
        activeSession={session}
        modelLabel="demo-model"
        modelChoices={choices}
        onModelChange={() => {}}
        {...thinkingProps}
      />,
    );

    // The lock trigger is any element carrying the class — the component
    // family behind it (ghost button today) is its own business.
    const tagCarrying = (markup: string, className: string): string =>
      new RegExp(`<[a-z]+[^>]*${className}[^>]*>`).exec(markup)?.[0] ?? '';

    const midTurn = renderComposer(true);
    assert.match(midTurn, /maka-model-selection-controls/, 'the pair must not unmount mid-turn');
    assert.match(tagCarrying(midTurn, 'maka-model-switcher-trigger'), /aria-disabled="true"/, 'mid-turn the model menu is locked, not gone');
    assert.match(tagCarrying(midTurn, 'maka-thinking-level-selector'), /aria-disabled="true"/, 'mid-turn the thinking menu is locked, not gone');
    // The contract is the reason, not the attribute: each locked control
    // explains the lock in its own words (tooltip markup renders in SSR).
    assert.match(midTurn, /等结束后再切换模型/, 'the model lock names its reason');
    assert.match(midTurn, /等结束后再切换思考级别/, 'the thinking lock names its reason');

    const atRest = renderComposer(false);
    assert.doesNotMatch(tagCarrying(atRest, 'maka-model-switcher-trigger'), /aria-disabled/, 'at rest the model menu is enabled');
    assert.doesNotMatch(tagCarrying(atRest, 'maka-thinking-level-selector'), /aria-disabled/, 'at rest the thinking menu is enabled');
  });

  it('reads active modes off the footer toolbar, after the model pair', () => {
    const markup = render(
      <Composer
        onSend={() => true}
        onStop={() => {}}
        planModeActive
        onPlanModeChange={() => {}}
        swarmModeActive
        onSwarmModeChange={() => {}}
        graphModeActive
        onGraphModeChange={() => {}}
        modelLabel="demo"
        modelChoices={[]}
        newChatThinkingLevels={['off', 'high']}
        newChatThinkingLevel="high"
        onNewChatThinkingLevelChange={() => {}}
      />,
    );

    const leftControls = markup.match(
      /maka-composer-left-controls[\s\S]*?maka-composer-right-controls/,
    )?.[0] ?? '';
    // All three modes read off the same slot — graph is not a special case.
    for (const mode of ['plan', 'swarm', 'graph']) {
      assert.match(leftControls, new RegExp(`data-mode="${mode}"`), `${mode} must mark the footer`);
    }
    // Modes trail the model + thinking pair so toggling one never shifts them.
    const modelIdx = leftControls.indexOf('maka-model-selection-controls');
    const modeIdx = leftControls.indexOf('data-mode="plan"');
    assert.ok(modelIdx >= 0 && modeIdx > modelIdx, 'modes must follow the model pair');
    // The mark is the same ghost icon button as ＋ and permission, named by
    // its mode and identified by its icon — never by a hue. Bound the slice to
    // this one button so a later mark cannot satisfy it.
    const planMark = markPast(leftControls, 'plan');
    assert.match(planMark, /^<button/, 'the mark is the button itself, not a wrapper');
    assert.match(planMark, /data-variant="ghost"/, 'same ghost variant as ＋ and permission');
    assert.match(planMark, /lucide-list-todo/, 'the icon says which mode it is');
    assert.match(planMark, /aria-label="Plan"/, 'the button is named for the mode');
    assert.match(planMark, /maka-composer-mode-button/, 'the accent rule has a target');
    assert.doesNotMatch(planMark, /astryx-token/, 'a mode is not a coloured pill');
    // Modes alone stage nothing for the next send, so no drawer mounts.
    assert.doesNotMatch(markup, /maka-composer-context-drawer/);
  });

  it('drops a mode mark the host gave no way to switch off', () => {
    // An active mode with no change handler would otherwise render a focusable,
    // tooltipped button whose click is a silent no-op.
    const markup = render(
      <Composer onSend={() => true} onStop={() => {}} planModeActive modelLabel="demo" />,
    );
    assert.doesNotMatch(markup, /data-mode="plan"/);
  });

  it('counts only send-consumed context in the drawer badge, never modes', () => {
    const markup = render(
      <Composer
        onSend={() => true}
        onStop={() => {}}
        planModeActive
        onPlanModeChange={() => {}}
        swarmModeActive
        onSwarmModeChange={() => {}}
        graphModeActive
        onGraphModeChange={() => {}}
        pendingAttachments={[{ displayName: 'notes.md', kind: 'doc', size: 12 }]}
        onRemoveAttachment={() => {}}
        modelLabel="demo"
      />,
    );

    assert.match(markup, /maka-composer-context-drawer/);
    // One attachment staged, three modes on — the badge reads 1. Match the
    // badge's own text node, not the first badge-ish substring in the document.
    const badge = /astryx-badge[^>]*>(\d+)</.exec(markup);
    assert.ok(badge, 'the drawer must render a count badge');
    assert.equal(badge![1], '1', 'the drawer badge must exclude modes');
    // The drawer itself carries no mode marks any more. Bound the slice by the
    // next footer landmark, not by the first </div>, which any card-shaped
    // drawer item would end early.
    const drawer = markup.slice(
      markup.indexOf('maka-composer-context-drawer'),
      markup.indexOf('maka-composer-left-controls'),
    );
    assert.doesNotMatch(drawer, /data-mode=/);
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
});
