import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { Composer } from '../composer.js';

/**
 * The project is a session-creation parameter: it decides where a NEW chat
 * starts and is fixed once the first message creates the session. That lifetime
 * is why the picker sits in the composer's header row — a row that exists only
 * while the caller passes it — rather than in the footer control row, whose
 * other controls persist for the whole session. So these assertions pin the
 * lifetime, not the placement.
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

  function render(props: { workspacePicker?: typeof workspacePicker }): string {
    return renderToStaticMarkup(
      <LocaleProvider locale="en">
        <Composer
          onSend={() => true}
          onStop={() => {}}
          modelLabel="demo-model"
          modelChoices={[]}
          workspacePicker={props.workspacePicker}
        />
      </LocaleProvider>,
    );
  }

  it('renders the picker above the input while the chat is a draft', () => {
    const markup = render({ workspacePicker });

    assert.match(markup, /maka-composer-workspace/);
    assert.match(markup, /maka-workspace-picker/);
  });

  it('drops the header row once a session owns the composer', () => {
    const markup = render({});

    assert.doesNotMatch(markup, /maka-composer-workspace/);
    assert.doesNotMatch(markup, /maka-workspace-picker/);
  });
});
