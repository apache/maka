import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AttachmentRef, SessionSummary, StoredMessage } from '@maka/core';
import { ChatSurfaceLayout, ChatView, LocaleProvider } from '@maka/ui';

function renderWithLocale(child: ReactNode): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'zh',
      children: createElement(ChatSurfaceLayout, { composer: null, children: child }),
    }),
  );
}

describe('attachment frontend', () => {
  it('renders user image attachments inside the chat turn stream', () => {
    const attachment: AttachmentRef = {
      kind: 'image',
      name: 'clipboard.png',
      mimeType: 'image/png',
      bytes: 4,
      ref: { kind: 'session_file', sessionId: 's1', relativePath: 'artifact-1' },
    };
    const messages: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: '看这张图', attachments: [attachment] },
    ];
    const activeSession: SessionSummary = {
      id: 's1',
      name: 'Attachment check',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionSlug: 'fixture',
      connectionLocked: false,
      model: 'fixture-model',
      permissionMode: 'ask',
    };

    const markup = renderWithLocale(createElement(ChatView, {
      messages,
      activeSession,
      onNew: () => {},
    } satisfies Parameters<typeof ChatView>[0]));

    assert.match(markup, /maka-user-attachments/);
    assert.match(markup, /maka-user-attachment-thumb-pending/);
  });
});
