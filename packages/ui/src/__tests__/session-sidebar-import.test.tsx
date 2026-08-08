import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { SessionSidebarNav } from '../session-sidebar-nav.js';

test('shows the localized external import action only when the shell enables it', () => {
  const enabled = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionSidebarNav
        selection={{ section: 'sessions', filter: 'chats' }}
        onSelect={() => undefined}
        onNew={() => undefined}
        onImport={() => undefined}
      />
    </LocaleProvider>,
  );
  const disabled = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionSidebarNav
        selection={{ section: 'sessions', filter: 'chats' }}
        onSelect={() => undefined}
        onNew={() => undefined}
      />
    </LocaleProvider>,
  );

  assert.match(enabled, /Import conversation/);
  assert.doesNotMatch(disabled, /Import conversation/);
});
