import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatView } from '../chat-view.js';
import { LocaleProvider } from '../locale-context.js';

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

describe('ChatView load failure', () => {
  it('uses one assertive live region for the Astryx empty state', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <ChatView
          messages={[]}
          activeSession={activeSession}
          messageLoadError="Could not load messages"
          onNew={() => undefined}
        />
      </LocaleProvider>,
    );

    assert.equal(markup.match(/role="alert"/g)?.length, 1);
    assert.doesNotMatch(markup, /role="status"/);
  });
});
