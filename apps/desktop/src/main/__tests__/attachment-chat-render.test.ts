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

const activeSession: SessionSummary = {
  id: 's1',
  name: 'Sent reference check',
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

describe('sent reference frontend', () => {
  it('keeps sent references outside the authored-text bubble', () => {
    const attachments: AttachmentRef[] = [
      {
        kind: 'pdf',
        name: 'design-spec.pdf',
        mimeType: 'application/pdf',
        bytes: 512_000,
        ref: { kind: 'session_file', sessionId: 's1', relativePath: 'artifact-1' },
      },
      {
        kind: 'image',
        name: 'layout.png',
        mimeType: 'image/png',
        bytes: 4,
        ref: { kind: 'session_file', sessionId: 's1', relativePath: 'artifact-2' },
      },
    ];
    const messages: StoredMessage[] = [{
      type: 'user',
      id: 'u1',
      turnId: 't1',
      ts: 1,
      text: '请用 /skill:writer 检查',
      attachments,
      quotes: [{ text: 'reference', sourceTurnId: 't0' }],
    }];
    const markup = renderWithLocale(createElement(ChatView, {
      messages,
      activeSession,
      onNew: () => {},
    } satisfies Parameters<typeof ChatView>[0]));

    const bubbleIndex = markup.indexOf('astryx-chat-message-bubble');
    assert.ok(markup.indexOf('astryx-token') < bubbleIndex);
    assert.ok(markup.indexOf('maka-user-quotes') < bubbleIndex);
    assert.ok(markup.indexOf('maka-user-attachments') < bubbleIndex);
    assert.ok(markup.indexOf('astryx-badge') > bubbleIndex);
  });

  it('renders sent Skill invocations as neutral tokens without guessing @ text', () => {
    const messages: StoredMessage[] = [
      {
        type: 'user',
        id: 'u1',
        turnId: 't1',
        ts: 1,
        text: '请用 /skill:writer 看 @notes',
      },
    ];
    const markup = renderWithLocale(createElement(ChatView, {
      messages,
      activeSession,
      onNew: () => {},
    } satisfies Parameters<typeof ChatView>[0]));

    assert.match(markup, /class="astryx-badge neutral[^"]*"[^>]*>[^<]*\/skill:writer<\/span>/);
    assert.doesNotMatch(markup, /class="astryx-badge neutral[^"]*"[^>]*>[^<]*@notes<\/span>/);
  });

  it('keeps sent file tokens compact while exposing size accessibly', () => {
    const attachment: AttachmentRef = {
      kind: 'pdf',
      name: 'design-spec.pdf',
      mimeType: 'application/pdf',
      bytes: 512_000,
      ref: { kind: 'session_file', sessionId: 's1', relativePath: 'artifact-1' },
    };
    const messages: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: '看下附件', attachments: [attachment] },
    ];
    const markup = renderWithLocale(createElement(ChatView, {
      messages,
      activeSession,
      onNew: () => {},
    } satisfies Parameters<typeof ChatView>[0]));

    const tokenIndex = markup.indexOf('astryx-token');
    const bubbleIndex = markup.indexOf('astryx-chat-message-bubble');
    assert.notEqual(tokenIndex, -1);
    assert.ok(tokenIndex < bubbleIndex);
    assert.match(markup, /lucide-file-text/);
    assert.match(markup, /class="[^"]*astryx-icon[^"]*"[^>]*data-size="sm"/);
    assert.match(markup, /design-spec\.pdf/);
    assert.match(markup, /aria-description="500\.0 KB"/);
    assert.doesNotMatch(markup, />500\.0 KB</);
    assert.doesNotMatch(markup, /maka-attachment-file-card/);
  });

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
    const markup = renderWithLocale(createElement(ChatView, {
      messages,
      activeSession,
      onNew: () => {},
    } satisfies Parameters<typeof ChatView>[0]));

    assert.match(markup, /maka-user-attachments/);
    assert.match(markup, /astryx-thumbnail/);
    assert.doesNotMatch(markup, /maka-user-attachment-thumb(?:-pending|-image)?(?:\s|")/);
  });
});
