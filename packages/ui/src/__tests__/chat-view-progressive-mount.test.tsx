import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredMessage } from '@maka/core';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';
import { LocaleProvider } from '../locale-context.js';
import { ChatView } from '../chat-view.js';
import { DEFAULT_MOUNT_WINDOW } from '../progressive-turn-mount.js';

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
    <LocaleProvider locale="en">
      <ChatSurfaceLayout composer={null}>
        <ChatView {...props} />
      </ChatSurfaceLayout>
    </LocaleProvider>
  );
}

function transcriptOf(turnCount: number): StoredMessage[] {
  return Array.from({ length: turnCount }, (_ignored, index): StoredMessage => ({
    type: 'user',
    id: `user-${index}`,
    turnId: `turn-${index}`,
    ts: index + 1,
    text: `prompt ${index}`,
  }));
}

function mountedTurnIds(markup: string): string[] {
  return [...markup.matchAll(/data-turn-id="(turn-\d+)"/g)].map((match) => match[1]!);
}

// #2052: the first commit after opening a long session renders only the tail
// window; the idle fill that completes the transcript is behavior of the
// client runtime and is covered by the pure window tests.
describe('ChatView progressive mount', () => {
  it('renders only the tail window of a long transcript in the first commit', () => {
    const markup = renderToStaticMarkup(
      <OwnedChatView messages={transcriptOf(30)} activeSession={activeSession} onNew={() => undefined} />,
    );
    const mounted = mountedTurnIds(markup);
    assert.equal(mounted.length, DEFAULT_MOUNT_WINDOW.initialWindow);
    assert.equal(mounted[0], `turn-${30 - DEFAULT_MOUNT_WINDOW.initialWindow}`);
    assert.equal(mounted[mounted.length - 1], 'turn-29');
  });

  it('renders a short transcript completely', () => {
    const markup = renderToStaticMarkup(
      <OwnedChatView messages={transcriptOf(4)} activeSession={activeSession} onNew={() => undefined} />,
    );
    assert.deepEqual(mountedTurnIds(markup), ['turn-0', 'turn-1', 'turn-2', 'turn-3']);
  });

  it('keeps one prompt rail tick per turn while the transcript is windowed', () => {
    const markup = renderToStaticMarkup(
      <OwnedChatView messages={transcriptOf(30)} activeSession={activeSession} onNew={() => undefined} />,
    );
    const railTicks = markup.match(/maka-prompt-rail-tick/g) ?? [];
    assert.ok(railTicks.length >= 30, `expected 30 rail ticks, saw ${railTicks.length}`);
  });
});
