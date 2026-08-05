import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { Composer } from '../composer.js';

/**
 * The project is a session-creation parameter: it decides where a NEW chat
 * starts and is fixed once the first message creates the session. So the host
 * passes the picker unconditionally and the composer owns the gate — these
 * assertions pin that lifetime, not the placement.
 */
describe('Composer workspace picker', () => {
  const workspacePicker = {
    label: 'maka-agent',
    projects: [],
    onAdd: () => undefined,
    onSelectProject: () => undefined,
    onRelink: () => undefined,
    onSelectNoProject: () => undefined,
  };

  const activeSession = {
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

  function render(props: { activeSession?: typeof activeSession }): string {
    return renderToStaticMarkup(
      <LocaleProvider locale="en">
        <Composer
          onSend={() => true}
          onStop={() => {}}
          modelLabel="demo-model"
          modelChoices={[]}
          activeSession={props.activeSession}
          workspacePicker={workspacePicker}
        />
      </LocaleProvider>,
    );
  }

  /**
   * Containment and order, not mere presence: the placement is what this
   * control has churned on — a bar of its own above the card, the empty-chat
   * hero, a composer header row — and each of those renders the same classes
   * somewhere in the markup. Only the footer group puts it beside the other
   * parameters of this send, where losing it on the first message moves
   * nothing to its left.
   */
  it('renders the picker in the footer controls, after the model group', () => {
    const markup = render({});

    const leftControls = markup.match(
      /maka-composer-left-controls[\s\S]*?maka-composer-right-controls/,
    )?.[0] ?? '';
    assert.match(leftControls, /maka-composer-workspace/, 'picker rides the footer row');
    assert.match(leftControls, /maka-workspace-picker/);

    const modelIdx = leftControls.indexOf('maka-model-selection-controls');
    const pickerIdx = leftControls.indexOf('maka-composer-workspace');
    assert.ok(modelIdx >= 0 && pickerIdx > modelIdx, 'picker follows the model pair');
  });

  it('drops it once a session owns the composer, even though the host still passes it', () => {
    const markup = render({ activeSession });

    assert.doesNotMatch(markup, /maka-composer-workspace/);
    assert.doesNotMatch(markup, /maka-workspace-picker/);
  });
});
