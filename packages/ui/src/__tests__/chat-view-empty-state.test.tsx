import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';
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

function OwnedChatView(props: ComponentProps<typeof ChatView>) {
  return (
    <ChatSurfaceLayout composer={null}>
      <ChatView {...props} />
    </ChatSurfaceLayout>
  );
}

describe('ChatView layout ownership', () => {
  it('rejects rendering without the Astryx chat surface owner', () => {
    assert.throws(
      () => renderToStaticMarkup(
        <LocaleProvider locale="en">
          <ChatView messages={[]} activeSession={activeSession} onNew={() => undefined} />
        </LocaleProvider>,
      ),
      /ChatSurfaceLayout/,
    );
  });
});

describe('ChatView load failure', () => {
  it('uses one assertive live region for the Astryx empty state', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <OwnedChatView
          messages={[]}
          activeSession={activeSession}
          messageLoadError="Could not load messages"
          onNew={() => undefined}
        />
      </LocaleProvider>,
    );

    assert.equal(markup.match(/role="alert"/g)?.length, 1);
  });
});

describe('ChatView session context', () => {
  it('omits the context layer when the session has no extra context', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <OwnedChatView messages={[]} activeSession={activeSession} onNew={() => undefined} />
      </LocaleProvider>,
    );

    assert.doesNotMatch(markup, /data-session-context-layer=/);
  });

  it('renders active session metadata and controls in one context layer', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <OwnedChatView
          messages={[]}
          activeSession={{ ...activeSession, name: 'Chat Surface convergence', labels: ['mode:deep_research'] }}
          memoryActive
          onOpenMemorySettings={() => undefined}
          goalIndicator={{
            condition: 'Ship the reviewable UI change',
            status: 'active',
            iterations: 4,
            maxIterations: 12,
            onClear: () => undefined,
          }}
          branchBanner={{
            parentSessionId: 'session-parent',
            parentSessionName: 'UI polish review',
          }}
          onBranchBannerClick={() => undefined}
          revisionNavigation={{
            current: 2,
            total: 3,
            previousSessionId: 'session-revision-1',
            nextSessionId: 'session-revision-3',
          }}
          onRevisionNavigate={() => undefined}
          onNew={() => undefined}
        />
      </LocaleProvider>,
    );

    assert.match(markup, /data-session-context-layer="true"/);
    assert.match(markup, /UI polish review/);
    assert.match(markup, /Chat Surface convergence/);
    assert.equal(markup.match(/maka-session-context__breadcrumb-label/g)?.length, 2);
    assert.match(markup, /aria-label="Local memory enabled"/);
    assert.match(markup, /aria-label="Deep Research, read-only exploration"/);
    assert.match(markup, /Goal 4 of 12/);
    assert.match(markup, /Version 2 of 3/);
  });
});

describe('ChatView system notices', () => {
  it('renders visible runtime notices with the Astryx system-message primitive', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <OwnedChatView
          messages={[
            {
              type: 'system_note',
              id: 'note-1',
              turnId: 'turn-1',
              ts: 1,
              kind: 'context_compacted',
            },
          ]}
          activeSession={activeSession}
          onNew={() => undefined}
        />
      </LocaleProvider>,
    );

    assert.match(markup, /class="[^"]*astryx-chat-system-message[^"]*"/);
    assert.match(markup, /Context compacted to keep this session within the model window\./);
  });
});

describe('ChatView sent inline references', () => {
  it('replays the frozen Composer labels with Astryx badges', () => {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <OwnedChatView
          messages={[
            {
              type: 'user',
              id: 'user-1',
              turnId: 'turn-1',
              ts: 1,
              text: 'Use /skill:writer on @docs/chat turn.tsx',
              inlineReferences: [
                { kind: 'skill', value: '/skill:writer', label: 'Writer', start: 4 },
                {
                  kind: 'workspace_file',
                  value: '@docs/chat turn.tsx',
                  label: 'chat turn.tsx',
                  start: 21,
                },
              ],
            },
          ]}
          activeSession={activeSession}
          onNew={() => undefined}
        />
      </LocaleProvider>,
    );

    assert.match(markup, />Writer</);
    assert.match(markup, />chat turn\.tsx</);
    assert.doesNotMatch(markup, />\/skill:writer</);
    assert.doesNotMatch(markup, />@docs\/chat turn\.tsx</);
    assert.equal(markup.match(/astryx-badge/g)?.length, 2);
  });
});

describe('ChatView #642 streaming fallback', () => {
  // The fallback renders outside TurnView, so it must localize the message
  // aria-label itself — a bare ChatMessage resolves Astryx's shipped
  // "Message from {sender}" and leaks English into a Chinese a11y tree.
  it('localizes the fallback assistant message aria-label', () => {
    // No liveTurn: a live turn projects into `turns` and takes the localized
    // TurnView path instead. The fallback needs streaming with zero turns —
    // wait indicators alone — which is exactly the #642 replay window.
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="zh">
        <OwnedChatView
          messages={[]}
          activeSession={activeSession}
          processingIndicator
          onNew={() => undefined}
        />
      </LocaleProvider>,
    );

    assert.match(markup, /data-live-streaming="true"/);
    assert.match(markup, /aria-label="Maka 的回答"/);
    assert.doesNotMatch(markup, /Message from/);
  });
});
