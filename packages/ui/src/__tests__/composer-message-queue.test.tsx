import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer, reorderQueueEntryIds } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

function render(children: ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider locale="zh">{children}</LocaleProvider>);
}

describe('composer message queue', () => {
  it('moves one stable queue identity onto the target position', () => {
    const entries = ['a', 'b', 'c'].map((entryId) => ({
      entryId,
      messageId: `message-${entryId}`,
      content: { text: entryId },
      placement: 'next_turn' as const,
      state: 'queued' as const,
    }));

    assert.deepEqual(reorderQueueEntryIds(entries, 'a', 'c'), ['b', 'c', 'a']);
    assert.deepEqual(reorderQueueEntryIds(entries, 'c', 'a'), ['c', 'a', 'b']);
    assert.equal(reorderQueueEntryIds(entries, 'a', 'a'), undefined);
  });

  it('keeps Queue, Steer, Stop, and the pending workband visible during a run', () => {
    const markup = render(
      <Composer
        streaming
        followUpMode="queue"
        queuedMessages={{
          steering: [{
            entryId: 'steer-1',
            messageId: 'message-1',
            content: { text: 'adjust the current implementation' },
            placement: 'current_turn',
            state: 'queued',
          }],
          followup: [{
            entryId: 'followup-1',
            messageId: 'message-2',
            content: { text: 'run the full test suite next' },
            placement: 'next_turn',
            state: 'queued',
          }],
        }}
        onFollowUpModeChange={() => {}}
        onRetractQueued={() => {}}
        onQueueMutation={() => true}
        onSend={() => true}
        onStop={() => {}}
        modelLabel="demo"
      />,
    );

    assert.match(markup, /maka-composer-queue/);
    assert.match(markup, /本轮/);
    assert.match(markup, /下一轮/);
    assert.match(markup, /maka-composer-follow-up-mode/);
    assert.match(markup, /data-value="queue"[\s\S]*?>排队<\/span>/);
    assert.match(markup, /data-value="steer"[\s\S]*?>引导<\/span>/);
    assert.match(markup, /maka-composer-stop-button/);
    assert.equal(markup.match(/aria-label="停止"/g)?.length, 1);
    assert.match(markup, /aria-label="排队"/);
    assert.match(markup, /aria-label="立即引导"/);
    assert.match(markup, /aria-label="编辑排队消息"/);
    assert.match(markup, /aria-label="删除排队消息"/);
    assert.match(markup, /aria-label="拖动排队消息"/);
    assert.doesNotMatch(markup, /draggable="true"/);
  });

  it('shows an interrupted queue as paused with an explicit Resume action', () => {
    const markup = render(
      <Composer
        queuedMessages={{
          paused: true,
          steering: [],
          followup: [{
            entryId: 'followup-1',
            messageId: 'message-1',
            content: { text: 'continue later' },
            placement: 'next_turn',
            state: 'queued',
          }],
        }}
        onQueueMutation={() => true}
        onSend={() => true}
        onStop={() => {}}
      />,
    );

    assert.match(markup, /由于你中断了当前响应，队列已暂停/);
    assert.match(
      markup,
      /<button[^>]*maka-composer-queue-resume[^>]*>[\s\S]*?继续[\s\S]*?<\/button>/,
    );
  });
});
