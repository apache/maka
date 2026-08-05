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

  it('renders the picker in the footer controls while the chat is a draft', () => {
    const markup = render({});

    assert.match(markup, /maka-composer-workspace/);
    assert.match(markup, /maka-workspace-picker/);
  });

  it('drops it once a session owns the composer, even though the host still passes it', () => {
    const markup = render({ activeSession });

    assert.doesNotMatch(markup, /maka-composer-workspace/);
    assert.doesNotMatch(markup, /maka-workspace-picker/);
  });
});
