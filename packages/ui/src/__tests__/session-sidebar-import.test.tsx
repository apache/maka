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

test('exposes active and archived conversation views in the session navigation', () => {
  const active = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionSidebarNav
        selection={{ section: 'sessions', filter: 'chats' }}
        onSelect={() => undefined}
        onNew={() => undefined}
      />
    </LocaleProvider>,
  );
  const archived = renderToStaticMarkup(
    <LocaleProvider locale="zh">
      <SessionSidebarNav
        selection={{ section: 'sessions', filter: 'archived' }}
        onSelect={() => undefined}
        onNew={() => undefined}
      />
    </LocaleProvider>,
  );

  assert.match(active, />Conversations</);
  assert.match(active, />Archived</);
  assert.match(active, /aria-current="page"[\s\S]*?>Conversations</);
  assert.match(archived, />会话</);
  assert.match(archived, />已归档</);
  assert.match(archived, /aria-current="page"[\s\S]*?>已归档</);
});
