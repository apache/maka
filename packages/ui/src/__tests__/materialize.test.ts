import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AttachmentRef, StoredMessage } from '@maka/core';
import {
  materializeChat,
  materializeTurns,
  overlayLiveTurn,
  type TurnTimelineItem,
} from '../materialize.js';

const imageAttachment: AttachmentRef = {
  kind: 'image',
  name: 'chart.png',
  mimeType: 'image/png',
  bytes: 1024,
  ref: { kind: 'session_file', sessionId: 's1', relativePath: 'chart.png' },
};

const codeAttachment: AttachmentRef = {
  kind: 'code',
  name: 'main.ts',
  mimeType: 'text/typescript',
  bytes: 512,
  ref: { kind: 'workspace_file', relativePath: 'src/main.ts' },
};

describe('materializeChat attachments', () => {
  test('projects user message attachments onto the chat item', () => {
    const messages: StoredMessage[] = [
      { type: 'user', id: 'm1', turnId: 't1', ts: 1, text: 'see this', attachments: [imageAttachment, codeAttachment] },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].attachments, [imageAttachment, codeAttachment]);
  });

  test('leaves attachments absent when the user message has none', () => {
    const messages: StoredMessage[] = [
      { type: 'user', id: 'm1', turnId: 't1', ts: 1, text: 'plain prompt' },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.equal(items[0].attachments, undefined);
  });

  test('preserves Host provenance on a Goal continuation', () => {
    const messages: StoredMessage[] = [
      {
        type: 'user',
        id: 'm1',
        turnId: 't1',
        ts: 1,
        text: '[Goal continuation] Keep working.',
        origin: { kind: 'goal', goalId: 'goal-1' },
      },
    ];

    assert.deepEqual(materializeChat(messages)[0]?.hostOrigin, {
      kind: 'goal',
      goalId: 'goal-1',
    });
    assert.deepEqual(materializeTurns(messages)[0]?.user?.hostOrigin, {
      kind: 'goal',
      goalId: 'goal-1',
    });
  });

  test('surfaces automatic context compaction system notes inline', () => {
    const messages: StoredMessage[] = [
      { type: 'system_note', id: 'note-1', turnId: 't1', ts: 1, kind: 'context_compacted' },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.equal(items[0].role, 'system');
    assert.equal(items[0].text, 'Context compacted to keep this session within the model window.');
  });

  test('surfaces history compaction fail-open notices inline', () => {
    const messages: StoredMessage[] = [
      { type: 'system_note', id: 'note-1', turnId: 't1', ts: 1, kind: 'context_compaction_failed_open' },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.equal(items[0].role, 'system');
    assert.equal(
      items[0].text,
      'Context summary failed; the session continued without a new summary.',
    );
  });

  test('surfaces a step-limit system notice inline', () => {
    const items = materializeChat([
      { type: 'system_note', id: 'note-1', turnId: 't1', ts: 1, kind: 'step_limit' },
    ]);

    assert.equal(items.length, 1);
    assert.equal(items[0].role, 'system');
    assert.equal(
      items[0].text,
      'Reached the configured step limit. The task may be incomplete. Send “continue” to resume.',
    );
  });
});

// ── #1307: the timeline model stays flat (fold is a render concern) ──────────

function userMsg(turnId: string, ts: number, text: string): StoredMessage {
  return { type: 'user', id: `u-${turnId}`, turnId, ts, text };
}

function shellRunResult(revision: number) {
  return {
    kind: 'shell_run' as const,
    ref: 'maka://runtime/background-tasks/pty-1',
    mode: 'pty' as const,
    status: 'running' as const,
    cwd: '/repo',
    cmd: 'job',
    startedAt: 1,
    updatedAt: revision,
    revision,
    output: {
      mode: 'pty' as const,
      screen: 'ready',
      scrollback: '',
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0, visible: true },
      alternateScreen: false,
      truncated: false,
      redacted: false,
    },
  };
}

describe('flat timeline under tool projection (#1307 P1 regression)', () => {
  test('shell-run folding away a turn’s only tool leaves a flat thinking-only timeline', () => {
    // Turn t1 owns the Bash ShellRun parent; the live turn t2's ONLY tool is a
    // Read carrying a shell_run result with the same ref, so foldShellRunTurns
    // merges it into t1's Bash and drops it from t2 entirely. With the fold
    // living in the model this used to strand an illegal thinking-only
    // "processing" block with an empty summary; the flat model simply drops
    // the emptied tools group.
    const settled = materializeTurns([
      { type: 'tool_call', id: 'bash-1', turnId: 't1', ts: 1, toolName: 'Bash', args: { command: 'job', pty: true } },
      { type: 'tool_result', id: 'r-bash-1', turnId: 't1', ts: 2, toolUseId: 'bash-1', isError: false, content: shellRunResult(1) },
      userMsg('t2', 3, 'q'),
    ]);
    const turns = overlayLiveTurn(settled, {
      turnId: 't2',
      phase: 'streamed',
      steps: [{
        stepId: 'a1',
        thinking: { text: 'watching the background job', truncated: false, complete: false },
        tools: [{
          toolUseId: 'read-1',
          toolName: 'Read',
          stepId: 'a1',
          status: 'completed',
          args: {},
          result: shellRunResult(2),
        }],
      }],
    });
    const liveTurn = turns.find((turn) => turn.turnId === 't2');
    assert.deepEqual(liveTurn?.timeline.map((item: TurnTimelineItem) => item.kind), ['thinking']);
  });
});
