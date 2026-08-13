import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { PipeShellOutput, PtyShellOutput } from '@maka/core/shell-run';
import type { ShellRunToolResult } from '@maka/core/shell-run-result';
import type { SessionEvent, ToolResultContent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import {
  appendUserPrompt,
  applyShellRunViewUpdateToTranscript,
  applyMakaSessionEventToTranscript,
  applyShellRunUpdateToTranscript,
  createMakaPiTranscriptState,
  renderMakaPiActivityStrip,
  renderMakaPiTranscript,
  reconcileToolsWithStoredMessages,
  replaceTranscriptWithStoredMessages,
  toggleAllThinkingExpansion,
  toggleAllToolExpansion,
} from '../pi-transcript.js';

describe('Maka Pi TUI transcript', () => {
  test('keeps assistant text after a tool call visible after the tool block', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'inspect the package');

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: 'I will inspect it.',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Read',
        args: { path: 'package.json' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: '{ "name": "maka-agent" }' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: 'The package is named maka-agent.',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'complete',
        stopReason: 'end_turn',
      }),
    );

    assert.deepEqual(
      state.entries.map((entry) => entry.kind),
      ['user', 'assistant', 'tool', 'assistant'],
    );
    assert.equal(
      state.entries[1]?.kind === 'assistant' ? state.entries[1].text : '',
      'I will inspect it.',
    );
    assert.equal(
      state.entries[3]?.kind === 'assistant' ? state.entries[3].text : '',
      'The package is named maka-agent.',
    );
  });

  test('treats text_complete as the authoritative assistant text', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'text_delta', messageId: 'message-1', text: 'draft' }),
    );

    renderMakaPiTranscript(state, meta(), 80);
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'text_complete', messageId: 'message-1', text: 'final' }),
    );

    assert.equal(
      state.entries[0]?.kind === 'assistant' ? state.entries[0].text : undefined,
      'final',
    );
    assert.match(renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n'), /final/);
  });

  test('allows text_complete to replace streamed assistant text with empty text', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'text_delta', messageId: 'message-1', text: 'discard me' }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'text_complete', messageId: 'message-1', text: '' }),
    );

    assert.equal(state.entries[0]?.kind === 'assistant' ? state.entries[0].text : undefined, '');
  });

  test('reconciles durable tool details without resetting live turn state', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'tool_start', toolUseId: 'tool-1', toolName: 'Read', args: {} }),
    );
    state.entries.push({ kind: 'notice', level: 'error', text: 'Turn failed: provider_error' });
    state.steering = ['Keep going'];
    state.pendingFallback = [{ text: 'Try again', enqueue: 'steer' }];

    assert.equal(
      reconcileToolsWithStoredMessages(state, 'turn-1', [
        {
          type: 'tool_call',
          id: 'tool-1',
          turnId: 'turn-1',
          ts: 3,
          toolName: 'Read',
          args: { path: 'README.md' },
        },
        {
          type: 'tool_result',
          id: 'tool-result-1',
          turnId: 'turn-1',
          ts: 4,
          toolUseId: 'tool-1',
          isError: false,
          content: { kind: 'text', text: 'README contents' },
        },
      ]),
      true,
    );

    const tool = state.entries.find(
      (entry): entry is Extract<(typeof state.entries)[number], { kind: 'tool' }> =>
        entry.kind === 'tool',
    );
    assert.deepEqual(tool?.input, { path: 'README.md' });
    assert.deepEqual(tool?.result, { kind: 'text', text: 'README contents' });
    assert.deepEqual(state.steering, ['Keep going']);
    assert.deepEqual(state.pendingFallback, [{ text: 'Try again', enqueue: 'steer' }]);
    assert.equal(state.entries.at(-1)?.kind, 'notice');
  });

  test('removes a live poll card that the durable transcript folds into its Bash parent', () => {
    const state = createMakaPiTranscriptState();
    for (const tool of [
      { toolUseId: 'bash-1', toolName: 'Bash' },
      { toolUseId: 'poll-1', toolName: 'Read' },
    ]) {
      applyMakaSessionEventToTranscript(state, event({ type: 'tool_start', ...tool, args: {} }));
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_result',
          toolUseId: tool.toolUseId,
          isError: false,
          content: { kind: 'text', text: '' },
        }),
      );
    }
    const initialRun = shellRun({ ref: 'maka://runtime/session-1/run-1', revision: 1 });
    const polledRun = shellRun({ ref: 'maka://runtime/session-1/run-1', revision: 2 });

    reconcileToolsWithStoredMessages(state, 'turn-1', [
      {
        type: 'tool_call',
        id: 'bash-1',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Bash',
        args: { command: 'npm test' },
      },
      {
        type: 'tool_result',
        id: 'bash-result',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'bash-1',
        isError: false,
        content: initialRun,
      },
      {
        type: 'tool_call',
        id: 'poll-1',
        turnId: 'turn-1',
        ts: 3,
        toolName: 'Read',
        args: { ref: initialRun.ref },
      },
      {
        type: 'tool_result',
        id: 'poll-result',
        turnId: 'turn-1',
        ts: 4,
        toolUseId: 'poll-1',
        isError: false,
        content: polledRun,
      },
    ]);

    const tools = state.entries.filter(
      (entry): entry is Extract<(typeof state.entries)[number], { kind: 'tool' }> =>
        entry.kind === 'tool',
    );
    assert.deepEqual(
      tools.map((tool) => tool.toolUseId),
      ['bash-1'],
    );
    assert.equal(tools[0]?.result?.kind === 'shell_run' ? tools[0].result.revision : undefined, 2);
  });

  test('renders steering messages with human-facing text and falls back to model-facing text', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'steering_message',
        messageId: 'steering-display',
        content: {
          text: '<system-reminder>internal context</system-reminder>\nShow the result',
          displayText: 'Show the result',
        },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'steering_message',
        messageId: 'steering-plain',
        content: { text: 'Also include the tests' },
      }),
    );

    assert.deepEqual(state.entries, [
      { kind: 'user', text: 'Show the result' },
      { kind: 'user', text: 'Also include the tests' },
    ]);
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /Show the result/);
    assert.match(rendered, /Also include the tests/);
    assert.doesNotMatch(rendered, /internal context/);
  });

  test('shows failed-open compact diagnostics before success diagnostics', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'token_usage',
        input: 0,
        output: 0,
        contextBudget: {
          enabled: true,
          estimatedTokensBefore: 100,
          estimatedTokensAfter: 40,
          keptTurns: 1,
          droppedTurns: 2,
          keptEvents: 2,
          droppedEvents: 4,
          compactionDecisions: [
            {
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'replaced',
              boundaryKind: 'historyCompact',
            },
            {
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'failedOpen',
              boundaryKind: 'historyCompact',
              failOpenReason: 'write_failed',
            },
          ],
        },
      }),
    );

    assert.deepEqual(
      state.entries
        .filter((entry) => entry.kind === 'notice')
        .map((entry) => ({ level: entry.level, text: entry.text })),
      [{ level: 'error', text: 'Context compaction skipped: write_failed.' }],
    );
  });

  test('folds stored background-task polling into its parent Bash card on resume', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';

    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'tool_call',
        id: 'bash-bg',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Bash',
        args: { command: 'npm test' },
      },
      {
        type: 'tool_result',
        id: 'bash-result',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', stdout: 'starting\n', updatedAt: 2_000 }),
      },
      {
        type: 'tool_call',
        id: 'read-bg',
        turnId: 'turn-1',
        ts: 3,
        toolName: 'Read',
        args: { ref },
      },
      {
        type: 'tool_result',
        id: 'read-result',
        turnId: 'turn-1',
        ts: 4,
        toolUseId: 'read-bg',
        isError: false,
        content: shellRun({
          ref,
          status: 'completed',
          stdout: 'starting\ndone\n',
          completedAt: 5_000,
          updatedAt: 5_000,
          exitCode: 0,
        }),
      },
    ] satisfies StoredMessage[]);

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.toolUseId, 'bash-bg');
    assert.equal(tools[0]?.status, 'done');
    assert.equal(
      tools[0]?.result?.kind === 'shell_run' && tools[0].result.output?.mode === 'pipes'
        ? tools[0].result.output.stdout
        : '',
      'starting\ndone\n',
    );
  });

  test('keeps a stored errored Read poll as a card without folding it into the parent Bash card', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';

    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'tool_call',
        id: 'bash-bg',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Bash',
        args: { command: 'npm test' },
      },
      {
        type: 'tool_result',
        id: 'bash-result',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({
          ref,
          status: 'running',
          stdout: 'starting\n',
          revision: 1,
          updatedAt: 2_000,
        }),
      },
      {
        type: 'tool_call',
        id: 'read-bg',
        turnId: 'turn-1',
        ts: 3,
        toolName: 'Read',
        args: { ref },
      },
      // isError is the call-level authoritative status: even with a well-formed
      // shell_run payload, a failed poll must survive replay as its own error
      // card and must not mutate the parent.
      {
        type: 'tool_result',
        id: 'read-result',
        turnId: 'turn-1',
        ts: 4,
        toolUseId: 'read-bg',
        isError: true,
        content: shellRun({
          ref,
          status: 'running',
          stdout: 'starting\nnewer\n',
          revision: 2,
          updatedAt: 5_000,
        }),
      },
    ] satisfies StoredMessage[]);

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.deepEqual(
      tools.map((tool) => tool.toolUseId),
      ['bash-bg', 'read-bg'],
    );
    assert.equal(tools[1]?.status, 'error');
    // The parent keeps its own revision, output, and status — the failed poll
    // changes nothing.
    assert.equal(tools[0]?.status, 'running');
    assert.equal(tools[0]?.result?.kind === 'shell_run' ? tools[0].result.revision : undefined, 1);
    assert.equal(
      tools[0]?.result?.kind === 'shell_run' && tools[0].result.output?.mode === 'pipes'
        ? tools[0].result.output.stdout
        : '',
      'starting\n',
    );
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /● Read/);
  });

  test('Ctrl+O leaves tool cards above the live viewport untouched (#1097)', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-early',
        toolName: 'Bash',
        args: { command: 'early-build' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-early',
        isError: false,
        content: terminalResult(
          `early-head\n${Array.from({ length: 30 }, (_, i) => `early-row-${i}`).join('\n')}`,
        ),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: Array.from({ length: 20 }, (_, i) => `filler-${i}`).join('\n\n'),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-late',
        toolName: 'Bash',
        args: { command: 'late-build' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-late',
        isError: false,
        content: terminalResult(
          `late-head\n${Array.from({ length: 30 }, (_, i) => `late-row-${i}`).join('\n')}`,
        ),
      }),
    );

    const before = renderMakaPiTranscript(state, meta(), 100);
    const early = state.entries.find(
      (entry): entry is Extract<typeof entry, { kind: 'tool' }> =>
        entry.kind === 'tool' && entry.toolUseId === 'tool-early',
    );
    const late = state.entries.find(
      (entry): entry is Extract<typeof entry, { kind: 'tool' }> =>
        entry.kind === 'tool' && entry.toolUseId === 'tool-late',
    );
    assert.ok(early && late);
    // Scroll state as MakaPiLayoutComponent records it: the live viewport
    // starts exactly where the late card begins, leaving the early card in
    // scrollback above it.
    const viewportTop = state.renderGeometry.entryFirstLine?.get(late);
    assert.ok(viewportTop !== undefined && viewportTop > 0);
    state.renderGeometry.viewportTop = viewportTop;

    assert.equal(toggleAllToolExpansion(state), true);
    assert.equal(state.expandAllTools, true);
    assert.equal(early.expanded, false);
    assert.equal(late.expanded, true);

    const after = renderMakaPiTranscript(state, meta(), 100);
    // Everything above the viewport is terminal scrollback pi-tui cannot
    // rewrite without a scrollback-clearing full redraw; those lines must
    // stay byte-identical.
    assert.deepEqual(after.slice(0, viewportTop), before.slice(0, viewportTop));
    const afterText = after.map(stripAnsi).join('\n');
    assert.match(afterText, /late-head/);
    assert.doesNotMatch(afterText, /early-head/);
  });

  test('Ctrl+O with a head-scrolled expanded card flips the default back and leaves a notice (#1134)', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-big',
        toolName: 'Bash',
        args: { command: 'big-diff' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-big',
        isError: false,
        content: terminalResult(
          `big-head\n${Array.from({ length: 80 }, (_, i) => `big-row-${i}`).join('\n')}`,
        ),
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    assert.equal(state.expandAllTools, true);
    const entry = state.entries.find(
      (candidate): candidate is Extract<typeof candidate, { kind: 'tool' }> =>
        candidate.kind === 'tool',
    );
    assert.ok(entry);
    assert.equal(entry.expanded, true);

    // Expanding grew the document past the terminal: the card's head is now
    // terminal scrollback and only its tail is inside the live viewport.
    const before = renderMakaPiTranscript(state, meta(), 100);
    const firstLine = state.renderGeometry.entryFirstLine?.get(entry);
    assert.ok(firstLine !== undefined);
    const viewportTop = firstLine + 5;
    assert.ok(viewportTop < before.length);
    state.renderGeometry.viewportTop = viewportTop;

    // The second Ctrl+O cannot collapse the card (its head is in scrollback),
    // but it must still flip the default back and say why nothing moved.
    assert.equal(toggleAllToolExpansion(state), true);
    assert.equal(state.expandAllTools, false);
    assert.equal(entry.expanded, true);

    const notice = state.entries[state.entries.length - 1];
    assert.equal(notice.kind, 'notice');
    assert.equal(notice.kind === 'notice' && notice.level, 'info');
    assert.match(notice.kind === 'notice' ? notice.text : '', /starts collapsed/);

    const after = renderMakaPiTranscript(state, meta(), 100);
    assert.deepEqual(after.slice(0, viewportTop), before.slice(0, viewportTop));
    assert.match(after.map(stripAnsi).join('\n'), /Note: /);

    // A third Ctrl+O keeps flipping the default and keeps saying so.
    assert.equal(toggleAllToolExpansion(state), true);
    assert.equal(state.expandAllTools, true);
    const third = state.entries[state.entries.length - 1];
    assert.match(third.kind === 'notice' ? third.text : '', /starts expanded/);
  });

  test('Ctrl+T leaves thinking entries above the live viewport untouched (#1097)', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'thinking_delta',
        messageId: 'message-1',
        text: 'early-secret-reasoning',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: Array.from({ length: 20 }, (_, i) => `filler-${i}`).join('\n\n'),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'thinking_delta',
        messageId: 'message-2',
        text: 'late-visible-reasoning',
      }),
    );

    const before = renderMakaPiTranscript(state, meta(), 100);
    const late = state.entries.find(
      (entry): entry is Extract<typeof entry, { kind: 'thinking' }> =>
        entry.kind === 'thinking' && entry.messageId === 'message-2',
    );
    assert.ok(late);
    const viewportTop = state.renderGeometry.entryFirstLine?.get(late);
    assert.ok(viewportTop !== undefined && viewportTop > 0);
    state.renderGeometry.viewportTop = viewportTop;

    assert.equal(toggleAllThinkingExpansion(state), true);

    const after = renderMakaPiTranscript(state, meta(), 100);
    assert.deepEqual(after.slice(0, viewportTop), before.slice(0, viewportTop));
    const afterText = after.map(stripAnsi).join('\n');
    assert.match(afterText, /late-visible-reasoning/);
    assert.doesNotMatch(afterText, /early-secret-reasoning/);
  });

  test('Ctrl+T with only head-scrolled thinking flips the default back and leaves a notice (#1134)', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'thinking_delta',
        messageId: 'message-1',
        text: Array.from({ length: 80 }, (_, i) => `reasoning-row-${i}`).join('\n'),
      }),
    );

    assert.equal(toggleAllThinkingExpansion(state), true);
    assert.equal(state.expandAllThinking, true);

    const before = renderMakaPiTranscript(state, meta(), 100);
    const entry = state.entries.find(
      (candidate): candidate is Extract<typeof candidate, { kind: 'thinking' }> =>
        candidate.kind === 'thinking',
    );
    assert.ok(entry);
    const firstLine = state.renderGeometry.entryFirstLine?.get(entry);
    assert.ok(firstLine !== undefined);
    const viewportTop = firstLine + 10;
    state.renderGeometry.viewportTop = viewportTop;

    assert.equal(toggleAllThinkingExpansion(state), true);
    assert.equal(state.expandAllThinking, false);
    assert.equal(entry.expanded, true);

    const notice = state.entries[state.entries.length - 1];
    assert.equal(notice.kind, 'notice');
    assert.match(notice.kind === 'notice' ? notice.text : '', /starts collapsed/);

    const after = renderMakaPiTranscript(state, meta(), 100);
    assert.deepEqual(after.slice(0, viewportTop), before.slice(0, viewportTop));
  });

  test('replays WriteStdin as a human-readable operation row while merging its PTY revision into Bash', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/pty-1';
    const rawInput = 'echo hello\r';
    const updatedOutput = ptyOutput({ screen: 'READY\nUNIQUE-PTY-FRAME' });
    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'tool_call',
        id: 'bash-pty',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Bash',
        args: { command: 'interactive', pty: true },
      },
      {
        type: 'tool_result',
        id: 'bash-result',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'bash-pty',
        isError: false,
        content: shellRun({
          ref,
          mode: 'pty',
          revision: 1,
          output: ptyOutput({ screen: 'READY' }),
        }),
      },
      {
        type: 'tool_call',
        id: 'write-pty',
        turnId: 'turn-2',
        ts: 3,
        toolName: 'WriteStdin',
        args: { ref, input: rawInput, size: { cols: 100, rows: 30 } },
      },
      {
        type: 'tool_result',
        id: 'write-result',
        turnId: 'turn-2',
        ts: 4,
        toolUseId: 'write-pty',
        isError: false,
        content: shellRun({
          ref,
          mode: 'pty',
          revision: 2,
          updatedAt: 2_000,
          output: updatedOutput,
          operation: {
            kind: 'pty_control',
            failed: false,
            input: { bytes: Buffer.byteLength(rawInput, 'utf8'), queued: true },
            resize: { cols: 100, rows: 30, applied: true, changed: true },
          },
        }),
      },
    ] satisfies StoredMessage[]);

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.equal(tools.length, 2);
    assert.equal(tools[0]?.result?.kind === 'shell_run' ? tools[0].result.revision : undefined, 2);
    assert.equal(
      tools[0]?.result?.kind === 'shell_run' ? tools[0].result.operation : undefined,
      undefined,
    );
    assert.deepEqual(tools[1]?.kind === 'tool' ? tools[1].input : undefined, {
      ref,
      inputPreview: {
        text: 'echo hello\\r',
        bytes: Buffer.byteLength(rawInput, 'utf8'),
        truncated: false,
      },
      size: { cols: 100, rows: 30 },
    });

    assert.equal(toggleAllToolExpansion(state), true);
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /Entered: echo hello\\r/);
    assert.match(rendered, /Resized to 100x30/);
    assert.equal(rendered.split('UNIQUE-PTY-FRAME').length - 1, 1);
  });

  test('renders an unboxed session sandbox boundary request with exact scopes', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'sandbox_boundary_request',
        requestId: 'boundary-1',
        toolUseId: 'tool-boundary',
        justification: 'Read the user-selected file.',
        expansion: {
          filesystem: {
            entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
          },
          network: { enabled: true },
        },
      }),
    );

    const visibleLines = renderMakaPiTranscript(
      state,
      {
        title: 'Maka',
        cwd: '/tmp/project',
        model: 'test',
        connectionSlug: 'test',
        permissionMode: 'auto',
      },
      100,
    ).map(stripAnsi);

    assert.equal(state.pendingInteraction?.requestId, 'boundary-1');
    assert.ok(visibleLines.some((line) => line.includes('Allow access outside the workspace?')));
    assert.ok(visibleLines.some((line) => line.includes('Read the user-selected file.')));
    assert.ok(visibleLines.some((line) => line.includes('read exact /outside/file.txt')));
    assert.ok(visibleLines.some((line) => line.includes('network enabled')));
    assert.ok(visibleLines.some((line) => line.includes('y/Enter allow for session')));
    assert.ok(visibleLines.some((line) => line.includes('n/Esc deny')));
    assert.ok(visibleLines.every((line) => !line.includes(' a ')));
  });

  test('queues sandbox boundary and user-question requests in arrival order', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'sandbox_boundary_request',
        requestId: 'boundary-1',
        toolUseId: 'tool-1',
        justification: 'Read a selected file.',
        expansion: {
          filesystem: {
            entries: [{ path: '/outside/file.txt', access: 'read', scope: 'exact' }],
          },
        },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'user_question_request',
        requestId: 'question-1',
        toolUseId: 'tool-2',
        questions: [{ question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }],
      }),
    );

    assert.equal(state.pendingInteraction?.requestId, 'boundary-1');
    assert.deepEqual(
      state.queuedInteractions.map((item) => item.requestId),
      ['question-1'],
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'sandbox_boundary_decision_ack',
        requestId: 'boundary-1',
        toolUseId: 'tool-1',
        decision: 'allow',
        status: 'applied',
        revision: 1,
      }),
    );
    assert.equal(state.pendingInteraction?.requestId, 'question-1');
    assert.deepEqual(state.queuedInteractions, []);
  });

  test('deduplicates sandbox boundary interactions by request id', () => {
    const state = createMakaPiTranscriptState();
    const first = event({
      type: 'sandbox_boundary_request',
      requestId: 'boundary-1',
      toolUseId: 'tool-1',
      justification: 'Read first.',
      expansion: {
        filesystem: { entries: [{ path: '/first', access: 'read', scope: 'exact' }] },
      },
    });
    const question = event({
      type: 'user_question_request',
      requestId: 'question-1',
      toolUseId: 'question-tool',
      questions: [{ question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    const second = event({
      type: 'sandbox_boundary_request',
      requestId: 'boundary-2',
      toolUseId: 'tool-2',
      justification: 'Read second.',
      expansion: {
        filesystem: { entries: [{ path: '/second', access: 'read', scope: 'exact' }] },
      },
    });
    const third = event({
      type: 'sandbox_boundary_request',
      requestId: 'boundary-3',
      toolUseId: 'tool-3',
      justification: 'Read third.',
      expansion: {
        filesystem: { entries: [{ path: '/third', access: 'read', scope: 'exact' }] },
      },
    });

    applyMakaSessionEventToTranscript(state, first);
    applyMakaSessionEventToTranscript(state, question);
    applyMakaSessionEventToTranscript(state, second);
    applyMakaSessionEventToTranscript(state, third);
    applyMakaSessionEventToTranscript(
      state,
      event({
        ...first,
        id: 'boundary-request-replay',
        justification: 'Replayed first.',
      }),
    );

    assert.equal(state.pendingInteraction?.requestId, 'boundary-1');
    assert.equal(
      state.pendingInteraction?.type === 'sandbox_boundary_request'
        ? state.pendingInteraction.justification
        : undefined,
      'Read first.',
    );
    assert.deepEqual(
      state.queuedInteractions.map((item) => item.requestId),
      ['question-1', 'boundary-2', 'boundary-3'],
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'sandbox_boundary_decision_ack',
        requestId: 'boundary-3',
        toolUseId: 'tool-3',
        decision: 'deny',
        status: 'denied',
        revision: 0,
      }),
    );
    assert.deepEqual(
      state.queuedInteractions.map((item) => item.requestId),
      ['question-1', 'boundary-2'],
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'sandbox_boundary_decision_ack',
        requestId: 'boundary-2',
        toolUseId: 'tool-2',
        decision: 'deny',
        status: 'denied',
        revision: 0,
      }),
    );
    assert.deepEqual(
      state.queuedInteractions.map((item) => item.requestId),
      ['question-1'],
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'sandbox_boundary_decision_ack',
        requestId: 'boundary-1',
        toolUseId: 'tool-1',
        decision: 'deny',
        status: 'denied',
        revision: 0,
      }),
    );
    assert.equal(state.pendingInteraction?.requestId, 'question-1');
    assert.deepEqual(state.queuedInteractions, []);
  });

  test('orders thinking entries by arrival, before text and around tools', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'thinking_delta',
        messageId: 'message-1',
        text: 'plan ',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'thinking_delta',
        messageId: 'message-1',
        text: 'first',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Read',
        args: { path: 'a.ts' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: 'ok' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: 'the answer',
      }),
    );

    // Entries mirror event order: thinking, then the tool, then the reply.
    assert.deepEqual(
      state.entries.map((entry) => entry.kind),
      ['thinking', 'tool', 'assistant'],
    );
    assert.equal(state.entries[0]?.kind === 'thinking' ? state.entries[0].text : '', 'plan first');

    const collapsed = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    const markerIndex = collapsed.findIndex((line) => line.includes('Thinking…'));
    const toolIndex = collapsed.findIndex((line) => line.includes('● Read'));
    const answerIndex = collapsed.findIndex((line) => line.includes('the answer'));
    assert.ok(markerIndex >= 0);
    assert.ok(markerIndex < toolIndex);
    assert.ok(toolIndex < answerIndex);
    assert.equal(
      collapsed.some((line) => line.includes('plan first')),
      false,
    );

    assert.equal(toggleAllThinkingExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    const bodyIndex = expanded.findIndex((line) => line.includes('plan first'));
    assert.ok(bodyIndex >= 0);
    assert.ok(bodyIndex < expanded.findIndex((line) => line.includes('the answer')));
  });

  test('replaces the streamed thinking entry when thinking_complete arrives after the reply', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'thinking_delta',
        messageId: 'message-1',
        text: 'partial thought',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: 'the reply',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'thinking_complete',
        messageId: 'message-1',
        text: 'the complete thought',
      }),
    );

    // No duplicate thinking entry; the streamed one is replaced in place.
    assert.deepEqual(
      state.entries.map((entry) => entry.kind),
      ['thinking', 'assistant'],
    );
    assert.equal(
      state.entries[0]?.kind === 'thinking' ? state.entries[0].text : '',
      'the complete thought',
    );
  });

  test('replaces live Bash output with the authoritative terminal snapshot', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'printf "step one\\nstep two\\n"' },
      }),
    );
    for (const [seq, chunk] of [
      [1, 'step one\n'],
      [2, 'step two\n'],
    ] as const) {
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_output_delta',
          toolUseId: 'tool-1',
          seq,
          stream: 'stdout',
          chunk,
          redacted: false,
        }),
      );
    }
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: false,
        content: shellRun({
          status: 'completed',
          stdout: 'step one\nstep two\n',
          completedAt: 2_000,
          exitCode: 0,
        }),
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    const outputLines = expanded.split('\n').map((line) => line.trim());
    assert.equal(outputLines.filter((line) => line === 'step one').length, 1);
    assert.equal(outputLines.filter((line) => line === 'step two').length, 1);
  });

  test('folds concurrent child lifecycles into their parent agent cards', () => {
    const state = createMakaPiTranscriptState();
    for (const [toolUseId, profile] of [
      ['agent-a', 'local_read'],
      ['agent-b', 'web_research'],
      ['agent-c', 'local_read'],
    ] as const) {
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_start',
          toolUseId,
          toolName: 'agent_spawn',
          args: { profile, task: `Run ${profile}` },
        }),
      );
    }
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_output_delta',
        toolUseId: 'agent-a',
        seq: 1,
        stream: 'stdout',
        chunk: 'Child tool started: Read\n',
        redacted: false,
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_output_delta',
        toolUseId: 'agent-b',
        seq: 1,
        stream: 'stdout',
        chunk: 'Child tool started: WebSearch\n',
        redacted: false,
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'agent-a',
        isError: false,
        content: subagentResult({
          agentName: 'Local Read',
          turnId: 'child-a',
          summary: 'local result',
        }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'agent-b',
        isError: true,
        content: subagentResult({
          agentName: 'Web Research',
          turnId: 'child-b',
          status: 'failed',
          summary: 'network failed',
        }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'agent-c',
        isError: true,
        content: subagentResult({
          agentName: 'Local Read',
          turnId: 'child-c',
          status: 'cancelled',
          summary: 'stopped',
        }),
      }),
    );

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.deepEqual(
      tools.map((tool) => [tool.toolUseId, tool.status]),
      [
        ['agent-a', 'done'],
        ['agent-b', 'failed'],
        ['agent-c', 'aborted'],
      ],
    );
    assert.equal(toggleAllToolExpansion(state), true);
    const rendered = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    assert.match(rendered, /Child tool started: Read/);
    assert.match(rendered, /Child tool started: WebSearch/);
    assert.match(rendered, /local result/);
    assert.match(rendered, /network failed/);
    assert.match(rendered, /stopped/);
  });

  test('restores one parent card with its child terminal state', () => {
    const state = createMakaPiTranscriptState();
    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'tool_call',
        id: 'agent-a',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'agent_spawn',
        args: { profile: 'local_read', task: 'Inspect.' },
      },
      {
        type: 'tool_result',
        id: 'agent-result',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'agent-a',
        isError: true,
        content: subagentResult({
          agentName: 'Local Read',
          turnId: 'child-a',
          status: 'cancelled',
          summary: 'stopped',
        }),
      },
    ] satisfies StoredMessage[]);

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.toolUseId, 'agent-a');
    assert.equal(tools[0]?.status, 'aborted');
  });

  test('keeps a background Bash card running until the process settles', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'sleep 30' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({
          ref: 'maka://runtime/background-tasks/bg-1',
          status: 'running',
          cwd: '/repo',
          cmd: 'sleep 30',
          startedAt: 1_000,
          updatedAt: 11_000,
        }),
        durationMs: 10_000,
      }),
    );

    const tool = state.entries.find((entry) => entry.kind === 'tool');
    assert.equal(tool?.kind === 'tool' ? tool.status : undefined, 'running');
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /● Bash  \$ sleep 30 \(running 10s\)/);
    assert.doesNotMatch(rendered, /done/);
    assert.equal(rendered.split('$ sleep 30').length - 1, 1);
  });

  test('never renders a background-task Read card while a poll is in flight', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', stdout: 'starting\n', updatedAt: 2_000 }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-bg',
        toolName: 'Read',
        args: { ref },
      }),
    );

    // The poll is in flight, but no Read row ever appears — the parent card is
    // the only tool entry throughout.
    assert.deepEqual(
      state.entries.filter((entry) => entry.kind === 'tool').map((tool) => tool.toolUseId),
      ['bash-bg'],
    );
    const inFlight = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(inFlight, /● Read/);

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: false,
        content: shellRun({
          ref,
          status: 'running',
          stdout: 'starting\nstill running\n',
          updatedAt: 5_000,
        }),
      }),
    );

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.deepEqual(
      tools.map((tool) => tool.toolUseId),
      ['bash-bg'],
    );
    assert.equal(
      tools[0]?.result?.kind === 'shell_run' && tools[0].result.output?.mode === 'pipes'
        ? tools[0].result.output.stdout
        : '',
      'starting\nstill running\n',
    );
    const settled = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(settled, /● Read/);
  });

  test('surfaces an errored poll carrying shell_run content instead of folding it', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', stdout: 'starting\n', updatedAt: 2_000 }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-bg',
        toolName: 'Read',
        args: { ref },
      }),
    );
    // isError is the call-level authoritative status: even with a well-formed
    // shell_run payload, the failed call must not fold into the parent.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: true,
        content: shellRun({
          ref,
          status: 'running',
          stdout: 'starting\nnewer\n',
          updatedAt: 5_000,
        }),
      }),
    );

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.deepEqual(
      tools.map((tool) => tool.toolUseId),
      ['bash-bg', 'read-bg'],
    );
    assert.equal(tools[1]?.status, 'error');
    // The parent keeps its pre-error revision — the failed call changes nothing.
    assert.equal(
      tools[0]?.result?.kind === 'shell_run' && tools[0].result.output?.mode === 'pipes'
        ? tools[0].result.output.stdout
        : '',
      'starting\n',
    );
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /● Read/);
  });

  test('keeps an errored non-folded poll card instead of splicing it into the parent', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    // The Read starts before the parent carries its shell_run result, so it is
    // not folded at tool_start.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-bg',
        toolName: 'Read',
        args: { ref },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', stdout: 'starting\n', updatedAt: 2_000 }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: true,
        content: shellRun({
          ref,
          status: 'running',
          stdout: 'starting\nnewer\n',
          updatedAt: 5_000,
        }),
      }),
    );

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.deepEqual(
      tools.map((tool) => tool.toolUseId),
      ['bash-bg', 'read-bg'],
    );
    assert.equal(tools[1]?.status, 'error');
    assert.equal(
      tools[0]?.result?.kind === 'shell_run' && tools[0].result.output?.mode === 'pipes'
        ? tools[0].result.output.stdout
        : '',
      'starting\n',
    );
  });

  test('surfaces an errored background-task poll as a card instead of swallowing it', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', stdout: 'starting\n', updatedAt: 2_000 }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-bg',
        toolName: 'Read',
        args: { ref },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: true,
        content: { kind: 'text', text: 'background task no longer exists' },
      }),
    );

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.equal(tools.length, 2);
    const poll = tools[1];
    assert.equal(poll?.toolUseId, 'read-bg');
    assert.equal(poll?.toolName, 'Read');
    assert.equal(poll?.status, 'error');
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /● Read/);
    // The error disc carries the failure state; free-text error content stays
    // out of the compact row under #1086.
    assert.match(rendered, /\(1 line · 32 bytes\)/);
    assert.doesNotMatch(rendered, /background task no longer exists/);
  });

  test('never renders a StopBackgroundTask card while the stop is in flight', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'sleep 30' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running' }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'stop-bg',
        toolName: 'StopBackgroundTask',
        args: { ref },
      }),
    );

    // No transient stop row while the stop call is in flight.
    assert.deepEqual(
      state.entries.filter((entry) => entry.kind === 'tool').map((tool) => tool.toolUseId),
      ['bash-bg'],
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'stop-bg',
        isError: false,
        content: shellRun({ ref, status: 'cancelled', completedAt: 8_000, exitCode: 130 }),
      }),
    );

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.deepEqual(
      tools.map((tool) => tool.toolUseId),
      ['bash-bg'],
    );
    assert.equal(tools[0]?.status, 'aborted');
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(rendered, /● StopBackgroundTask/);
  });

  test('never folds a WriteStdin aimed at a background-task ref', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'top' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running' }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'stdin-bg',
        toolName: 'WriteStdin',
        args: { ref, input: 'q' },
      }),
    );

    // WriteStdin is a real interaction with the process, not polling: its card
    // renders from tool_start on.
    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.deepEqual(
      tools.map((tool) => tool.toolUseId),
      ['bash-bg', 'stdin-bg'],
    );
    assert.equal(tools[1]?.status, 'running');
  });

  test('stays silent for a hydration catch-up update that settles a resumed card', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';

    // A resumed session: stored history still records the run as running.
    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'tool_call',
        id: 'bash-bg',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Bash',
        args: { command: 'npm test' },
      },
      {
        type: 'tool_result',
        id: 'bash-result',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', stdout: 'starting\n', updatedAt: 2_000 }),
      },
    ] satisfies StoredMessage[]);

    // Durable state says the run settled while away: the card flips, but
    // catch-up replay is not a live event, so no notice fires.
    const applied = applyShellRunViewUpdateToTranscript(
      state,
      {
        sessionId: 'session-1',
        ownership: { kind: 'local' },
        sourceTurnId: 'turn-1',
        sourceToolCallId: 'bash-bg',
        result: shellRun({
          ref,
          status: 'completed',
          stdout: 'starting\ndone\n',
          completedAt: 48_000,
          exitCode: 0,
        }),
      },
      { announceSettle: false },
    );

    assert.equal(applied, true);
    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.equal(tools[0]?.status, 'done');
    assert.equal(
      state.entries.some((entry) => entry.kind === 'notice'),
      false,
    );
  });

  test('notifies a settle exactly once across a folded poll and the live update', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', stdout: 'starting\n', updatedAt: 2_000 }),
      }),
    );

    // The model's poll observes the settle first: exactly one notice.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-bg',
        toolName: 'Read',
        args: { ref },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: false,
        content: shellRun({
          ref,
          status: 'completed',
          stdout: 'starting\ndone\n',
          completedAt: 48_000,
          exitCode: 0,
        }),
      }),
    );
    let notices = state.entries.filter((entry) => entry.kind === 'notice');
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.kind === 'notice' ? notices[0].level : '', 'info');
    assert.match(
      notices[0]?.kind === 'notice' ? notices[0].text : '',
      /Background task completed: npm test/,
    );

    // The event-driven update reporting the same settle must not re-notify.
    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({
        ref,
        status: 'completed',
        stdout: 'starting\ndone\n',
        completedAt: 48_000,
        exitCode: 0,
      }),
    });
    notices = state.entries.filter((entry) => entry.kind === 'notice');
    assert.equal(notices.length, 1);
  });

  test('announces a detached background task settle exactly once when its owner completes it', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'build' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({
          ref,
          status: 'running',
          cmd: 'build',
          stdout: 'starting\n',
          updatedAt: 2_000,
        }),
      }),
    );

    // An inherited run is presented as `detached` while its resource keeps
    // running; this must not silence its later settle.
    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-branch',
      ownership: {
        kind: 'source_owned',
        sourceSessionId: 'session-1',
        ownerSessionId: 'session-1',
      },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({
        ref,
        status: 'running',
        cmd: 'build',
        stdout: 'starting\n',
        updatedAt: 3_000,
        revision: 3_000,
      }),
    });
    const detached = state.entries.find((entry) => entry.kind === 'tool');
    assert.equal(detached?.kind === 'tool' ? detached.status : '', 'detached');
    assert.equal(
      state.entries.some((entry) => entry.kind === 'notice'),
      false,
    );

    // The owner's live subscription settles the run: the detached card still
    // announces exactly once.
    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({
        ref,
        status: 'completed',
        cmd: 'build',
        stdout: 'starting\ndone\n',
        completedAt: 48_000,
        exitCode: 0,
        revision: 48_000,
      }),
    });
    const notices = state.entries.filter((entry) => entry.kind === 'notice');
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.kind === 'notice' ? notices[0].level : '', 'info');
    assert.match(
      notices[0]?.kind === 'notice' ? notices[0].text : '',
      /Background task completed: build/,
    );
  });

  test('announces a detached background task orphaned settle as an error exactly once', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'build' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({
          ref,
          status: 'running',
          cmd: 'build',
          stdout: 'starting\n',
          updatedAt: 2_000,
        }),
      }),
    );
    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-branch',
      ownership: {
        kind: 'source_owned',
        sourceSessionId: 'session-1',
        ownerSessionId: 'session-1',
      },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({
        ref,
        status: 'running',
        cmd: 'build',
        stdout: 'starting\n',
        updatedAt: 3_000,
        revision: 3_000,
      }),
    });
    assert.equal(
      state.entries.some((entry) => entry.kind === 'notice'),
      false,
    );

    // The owner reports the run orphaned: an error-level notice with the
    // `orphaned` verb, fired exactly once from the detached card.
    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({
        ref,
        status: 'orphaned',
        cmd: 'build',
        completedAt: 20_000,
        exitCode: 1,
        revision: 20_000,
      }),
    });
    const notices = state.entries.filter((entry) => entry.kind === 'notice');
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.kind === 'notice' ? notices[0].level : '', 'error');
    assert.match(
      notices[0]?.kind === 'notice' ? notices[0].text : '',
      /Background task orphaned: build/,
    );
  });

  test('notifies a settle exactly once when the live update precedes the folded poll', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', stdout: 'starting\n', updatedAt: 2_000 }),
      }),
    );

    // The event-driven update reports the settle first: exactly one notice.
    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({
        ref,
        status: 'completed',
        stdout: 'starting\ndone\n',
        completedAt: 48_000,
        exitCode: 0,
      }),
    });
    let notices = state.entries.filter((entry) => entry.kind === 'notice');
    assert.equal(notices.length, 1);
    assert.match(
      notices[0]?.kind === 'notice' ? notices[0].text : '',
      /Background task completed: npm test/,
    );

    // A folded poll observing the same settle afterward must not re-notify.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-bg',
        toolName: 'Read',
        args: { ref },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: false,
        content: shellRun({
          ref,
          status: 'completed',
          stdout: 'starting\ndone\n',
          completedAt: 48_000,
          exitCode: 0,
        }),
      }),
    );
    notices = state.entries.filter((entry) => entry.kind === 'notice');
    assert.equal(notices.length, 1);
  });

  test('announces a failed background task as an error with its exit and message', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'npm run build' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', cmd: 'npm run build' }),
      }),
    );

    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({
        ref,
        status: 'failed',
        cmd: 'npm run build',
        completedAt: 13_000,
        exitCode: 1,
        failureMessage: 'compiler exited\nwith diagnostics',
      }),
    });

    const notice = state.entries[state.entries.length - 1];
    assert.equal(notice?.kind, 'notice');
    assert.equal(notice?.kind === 'notice' ? notice.level : '', 'error');
    const text = notice?.kind === 'notice' ? notice.text : '';
    assert.match(text, /Background task failed: npm run build/);
    assert.match(text, /exit 1/);
    assert.match(text, /12s/);
    // Only the first line of a multi-line failure message joins the notice.
    assert.match(text, /compiler exited/);
    assert.doesNotMatch(text, /with diagnostics/);
  });

  test('stays silent for a background task already settled in stored history', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';

    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'tool_call',
        id: 'bash-bg',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Bash',
        args: { command: 'npm test' },
      },
      {
        type: 'tool_result',
        id: 'bash-result',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({
          ref,
          status: 'completed',
          stdout: 'done\n',
          completedAt: 5_000,
          updatedAt: 5_000,
          exitCode: 0,
        }),
      },
    ] satisfies StoredMessage[]);

    assert.equal(
      state.entries.some((entry) => entry.kind === 'notice'),
      false,
    );
  });

  test('drops a folded poll when the turn aborts mid-flight', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running' }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-bg',
        toolName: 'Read',
        args: { ref },
      }),
    );
    assert.equal(state.pendingShellRunPolls.size, 1);

    applyMakaSessionEventToTranscript(state, event({ type: 'abort', reason: 'user_stop' }));

    assert.equal(state.pendingShellRunPolls.size, 0);
  });

  test('folds a background-task Read result into its parent Bash card', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', stdout: 'starting\n', updatedAt: 2_000 }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-bg',
        toolName: 'Read',
        args: { ref },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: false,
        content: shellRun({
          ref,
          status: 'running',
          stdout: 'starting\nstill running\n',
          updatedAt: 5_000,
        }),
      }),
    );

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.toolUseId, 'bash-bg');
    assert.equal(
      tools[0]?.result?.kind === 'shell_run' && tools[0].result.output?.mode === 'pipes'
        ? tools[0].result.output.stdout
        : '',
      'starting\nstill running\n',
    );
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(rendered, /● Read/);
    // Running card keeps the live tail in the expanded card.
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /still running/);
  });

  test('shows polled background output instead of a stale live delta', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'build' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_output_delta',
        toolUseId: 'bash-bg',
        seq: 1,
        stream: 'stdout',
        chunk: 'starting\n',
        redacted: false,
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, stdout: '', updatedAt: 2_000 }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-bg',
        toolName: 'Read',
        args: { ref },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: false,
        content: shellRun({ ref, stdout: 'starting\n50%\n', updatedAt: 3_000 }),
      }),
    );

    // Live output lives in the expanded card for a running tool.
    assert.equal(toggleAllToolExpansion(state), true);
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /50%/);
  });

  test('re-renders a background Bash card when polling replaces output with the same length', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'watch' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, stdout: 'aaaa\n', updatedAt: 2_000 }),
      }),
    );
    // Live output lives in the expanded card for a running tool.
    assert.equal(toggleAllToolExpansion(state), true);
    const before = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(before, /aaaa/);

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-bg',
        toolName: 'Read',
        args: { ref },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: false,
        content: shellRun({ ref, stdout: 'bbbb\n', updatedAt: 3_000 }),
      }),
    );
    const after = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(after, /bbbb/);
    assert.doesNotMatch(after, /aaaa/);
  });

  test('keeps background-task Read cards when their parent Bash card is missing', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    for (const [toolUseId, stdout] of [
      ['read-1', 'first\n'],
      ['read-2', 'second\n'],
    ] as const) {
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_start',
          toolUseId,
          toolName: 'Read',
          args: { ref },
        }),
      );
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_result',
          toolUseId,
          isError: false,
          content: shellRun({ ref, status: 'running', stdout }),
        }),
      );
    }

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.equal(tools.length, 2);
    assert.deepEqual(
      tools.map((tool) => tool.toolUseId),
      ['read-1', 'read-2'],
    );
  });

  test('folds StopBackgroundTask into its parent Bash card as aborted', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'sleep 30' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref, status: 'running' }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'stop-bg',
        toolName: 'StopBackgroundTask',
        args: { ref },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'stop-bg',
        isError: false,
        content: shellRun({ ref, status: 'cancelled', completedAt: 8_000, exitCode: 130 }),
      }),
    );

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.status, 'aborted');
    const lines = renderMakaPiTranscript(state, meta(), 100);
    const rendered = lines.map(stripAnsi).join('\n');
    assert.match(rendered, /● Bash  \$ sleep 30 \(7s · cancelled · exit 130\)/);
    assert.doesNotMatch(rendered, /● StopBackgroundTask/);
  });

  test('applies a runtime-published terminal update directly to its parent Bash card', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'build' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ status: 'running', updatedAt: 2_000 }),
      }),
    );

    const applied = applyShellRunUpdateToTranscript(
      state,
      'bash-bg',
      shellRun({
        status: 'completed',
        stdout: 'done\n',
        updatedAt: 5_000,
        completedAt: 5_000,
        exitCode: 0,
      }),
    );

    assert.equal(applied, true);
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /● Bash  \$ build \(4s · 1 line\)/);
    // Compact shows the output size, not the output content.
    assert.doesNotMatch(rendered, /done/);
  });

  test('does not erase a runtime-published output update with an equal-time handoff result', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'build' },
      }),
    );
    applyShellRunUpdateToTranscript(
      state,
      'bash-bg',
      shellRun({ stdout: 'starting\n', updatedAt: 2_000 }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ updatedAt: 2_000, revision: 2_000, omitOutput: true }),
      }),
    );

    const tool = state.entries.find((entry) => entry.kind === 'tool');
    assert.equal(
      tool?.kind === 'tool' &&
        tool.result?.kind === 'shell_run' &&
        tool.result.output?.mode === 'pipes'
        ? tool.result.output.stdout
        : '',
      'starting\n',
    );
  });

  test('keeps shell_run status and exit visible while capping its stream body', () => {
    const state = createMakaPiTranscriptState();
    // A background command's status/exit is the whole point of expanding the
    // card; a bare head/tail cap would keep only `$ cmd` + the last stdout lines
    // and hide whether the process failed or timed out.
    const stdout = Array.from({ length: 10 }, (_, i) => `out-line-${i}`).join('\n');
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'shell-1',
        toolName: 'StopBackgroundTask',
        args: { ref: 'bg-42' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'shell-1',
        isError: false,
        content: shellRun({
          ref: 'bg-42',
          status: 'failed',
          cwd: '/repo',
          cmd: 'npm run watch',
          startedAt: 1,
          updatedAt: 2,
          completedAt: 2,
          exitCode: 137,
          failureMessage: 'killed by signal',
          stdout,
          stderr: 'boom-stderr',
        }),
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    // Failure metadata a bare head/tail cap would bury stays visible.
    assert.match(expanded, /failed/);
    assert.match(expanded, /exit 137/);
    assert.match(expanded, /killed by signal/);
    assert.match(expanded, /bg-42/);
    // The command/cwd live on the result, not the ref-only input, so the
    // expanded card must repeat them to say which process this was.
    assert.match(expanded, /npm run watch/);
    // The stream body is still capped, and stderr keeps its label.
    assert.match(expanded, /lines hidden/);
    assert.match(expanded, /\[stderr\]/);
    assert.match(expanded, /boom-stderr/);
  });

  test('keeps generic compact summaries bounded for malformed and oversized results', () => {
    const cases = [
      {
        toolUseId: 'malformed',
        content: { kind: 'text', text: undefined } as unknown as ToolResultContent,
      },
      {
        toolUseId: 'malformed-truthy',
        content: { kind: 'text', text: 42 } as unknown as ToolResultContent,
      },
      {
        toolUseId: 'oversized',
        content: { kind: 'text', text: 'x'.repeat(20_000) } satisfies ToolResultContent,
      },
    ];

    for (const testCase of cases) {
      const state = createMakaPiTranscriptState();
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_start',
          toolUseId: testCase.toolUseId,
          toolName: 'mcp__local__result',
          args: {},
        }),
      );
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_result',
          toolUseId: testCase.toolUseId,
          isError: false,
          content: testCase.content,
        }),
      );

      const row = renderMakaPiTranscript(state, meta(), 80).map(stripAnsi)[1] ?? '';
      assert.ok(visibleWidth(row) <= 80, `row width ${visibleWidth(row)} exceeds 80`);
      if (testCase.toolUseId.startsWith('malformed')) {
        assert.match(row, /\(no output\)/);
        if (testCase.toolUseId === 'malformed-truthy') {
          assert.equal(toggleAllToolExpansion(state), true);
          assert.doesNotMatch(
            renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n'),
            /42/,
          );
        }
      } else {
        assert.match(row, /\(1 line · 20000 bytes\)/);
        assert.doesNotMatch(row, /x{20}/);
      }
    }
  });

  test('orders and de-dupes tool_output_delta by seq and marks redacted chunks', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-1',
        toolName: 'Bash',
        args: { command: 'run' },
      }),
    );
    // Out-of-order + duplicate seq + a redacted chunk.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_output_delta',
        toolUseId: 'bash-1',
        seq: 2,
        stream: 'stdout',
        chunk: 'SECOND',
        redacted: false,
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_output_delta',
        toolUseId: 'bash-1',
        seq: 1,
        stream: 'stdout',
        chunk: 'FIRST',
        redacted: false,
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_output_delta',
        toolUseId: 'bash-1',
        seq: 1,
        stream: 'stdout',
        chunk: 'DUPLICATE',
        redacted: false,
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_output_delta',
        toolUseId: 'bash-1',
        seq: 3,
        stream: 'stderr',
        chunk: 'secret',
        redacted: true,
      }),
    );

    // Compact: a running tool shows only the disc row; live output (including
    // the redaction marker) lives in the expanded card.
    const compact = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(compact, /secret/);
    assert.doesNotMatch(compact, /\[redacted\]/);

    assert.equal(toggleAllToolExpansion(state), true);
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.ok(rendered.indexOf('FIRST') < rendered.indexOf('SECOND'));
    assert.doesNotMatch(rendered, /DUPLICATE/);
    assert.doesNotMatch(rendered, /secret/);
    assert.match(rendered, /\[redacted\]/);
    assert.match(rendered, /\[stderr\]/);
  });

  test('renders the redaction marker for an empty redacted output delta', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'redacted-empty',
        toolName: 'Bash',
        args: { command: 'secret' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_output_delta',
        toolUseId: 'redacted-empty',
        seq: 1,
        stream: 'stdout',
        chunk: '',
        redacted: true,
      }),
    );

    // Live output lives in the expanded card for a running tool.
    assert.equal(toggleAllToolExpansion(state), true);
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /\[redacted\]/);
  });

  test('caps a long live stream group in the expanded card', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-stream',
        toolName: 'Bash',
        args: { command: 'seq 20' },
      }),
    );
    // Ten single-line stdout chunks form one stream group; the expanded card
    // head/tail caps the group body just like a finished command dump.
    for (let i = 0; i < 10; i += 1) {
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_output_delta',
          toolUseId: 'bash-stream',
          seq: i,
          stream: 'stdout',
          chunk: `${i === 0 ? '' : '\n'}stream-line-${i}`,
          redacted: false,
        }),
      );
    }

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /stream-line-0/);
    assert.match(expanded, /stream-line-9/);
    assert.match(expanded, /lines hidden/);
    assert.doesNotMatch(expanded, /stream-line-5/); // a middle line the cap hides
  });

  test('retains the newest live output when a stream exceeds its buffer limit', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bounded',
        toolName: 'Bash',
        args: { command: 'verbose' },
      }),
    );
    const chunks = Array.from(
      { length: 9 },
      (_, i) => `chunk-${i}-start\n${'x\n'.repeat(4_090)}chunk-${i}-end\n`,
    );
    for (const [i, chunk] of chunks.entries()) {
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_output_delta',
          toolUseId: 'bash-bounded',
          seq: i,
          stream: 'stdout',
          chunk,
          redacted: false,
        }),
      );
    }

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(expanded, /chunk-0-start\b/);
    assert.match(expanded, /chunk-8-end\b/);
    const droppedChars = chunks.reduce((total, chunk) => total + chunk.length, 0) - 64 * 1024;
    assert.match(expanded, new RegExp(`${droppedChars} earlier live-output chars truncated`));
  });

  test('drops the oldest progress when the chunk count reaches its limit', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'progress-many-chunks',
        toolName: 'Workflow',
        args: {},
      }),
    );
    for (let i = 0; i < 513; i += 1) {
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_progress',
          toolUseId: 'progress-many-chunks',
          chunk: `progress-${i}\n`,
        }),
      );
    }

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(expanded, /progress-0\b/);
    assert.match(expanded, /progress-512\b/);
  });
});

describe('transcript entry render memoization', () => {
  test('re-renders thinking when a same-length final replaces the streamed text', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'thinking_delta',
        messageId: 'message-1',
        text: 'AAAA',
      }),
    );
    assert.equal(toggleAllThinkingExpansion(state), true);
    const streamed = renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n');
    assert.match(streamed, /AAAA/);

    // thinking_complete replaces the text in place; same length must still bust
    // the render cache so the final reasoning is shown, not the streamed draft.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'thinking_complete',
        messageId: 'message-1',
        text: 'BBBB',
      }),
    );
    const finalized = renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n');
    assert.match(finalized, /BBBB/);
    assert.doesNotMatch(finalized, /AAAA/);
  });

  test('merges a latestStream-only ShellRun update into the card result', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'build' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({
          stdout: 'AAAA',
          stderr: 'BBBB',
          updatedAt: 3_000,
          latestStream: 'stderr',
          status: 'completed',
          completedAt: 3_000,
          exitCode: 0,
        }),
      }),
    );
    // The compact row carries only the line count and the expanded card shows
    // both streams, so a latestStream flip is observable only on the result
    // itself — the render must still re-run from a fresh memo entry.
    const latestStream = () => {
      const tool = state.entries.find((entry) => entry.kind === 'tool');
      return tool?.kind === 'tool' &&
        tool.result?.kind === 'shell_run' &&
        tool.result.output?.mode === 'pipes'
        ? tool.result.output.latestStream
        : undefined;
    };
    assert.equal(latestStream(), 'stderr');

    applyShellRunUpdateToTranscript(
      state,
      'bash-bg',
      shellRun({
        stdout: 'AAAA',
        stderr: 'BBBB',
        updatedAt: 3_000,
        revision: 3_001,
        latestStream: 'stdout',
        status: 'completed',
        completedAt: 3_000,
        exitCode: 0,
      }),
    );
    assert.equal(latestStream(), 'stdout');
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /\(2s · 2 lines\)/);
  });

  test('re-renders equal-length ShellRun output only when revision advances', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'build' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ stdout: 'AAAA', updatedAt: 3_000, latestStream: 'stdout' }),
      }),
    );
    // Live output lives in the expanded card for a running tool.
    assert.equal(toggleAllToolExpansion(state), true);
    const before = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(before, /AAAA/);

    applyShellRunUpdateToTranscript(
      state,
      'bash-bg',
      shellRun({
        stdout: 'BBBB',
        updatedAt: 3_000,
        revision: 3_001,
        latestStream: 'stdout',
      }),
    );
    const after = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(after, /BBBB/);
    assert.doesNotMatch(after, /AAAA/);
  });
});

function meta() {
  return {
    title: 'Maka',
    cwd: '/tmp/project',
    model: 'deepseek-v4-flash',
    connectionSlug: 'deepseek',
    permissionMode: 'ask',
  } as const;
}

function terminalResult(
  stdout: string,
  stderr = '',
  overrides: Partial<
    Omit<Extract<ToolResultContent, { kind: 'terminal' }>, 'kind' | 'output'>
  > = {},
): Extract<ToolResultContent, { kind: 'terminal' }> {
  return {
    kind: 'terminal',
    cwd: '/repo',
    cmd: 'echo',
    status: 'completed',
    exitCode: 0,
    ...overrides,
    output: {
      mode: 'pipes',
      stdout,
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  } as const;
}

type ShellRunCommonOverrides = Partial<
  Pick<
    ShellRunToolResult,
    | 'ref'
    | 'status'
    | 'cwd'
    | 'cmd'
    | 'startedAt'
    | 'updatedAt'
    | 'completedAt'
    | 'exitCode'
    | 'failureMessage'
    | 'revision'
    | 'timeoutMs'
    | 'operation'
  >
>;

type PipeShellRunFixtureOverrides = ShellRunCommonOverrides & {
  mode?: 'pipes';
  output?: PipeShellOutput;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  latestStream?: 'stdout' | 'stderr';
  omitOutput?: boolean;
};

type PtyShellRunFixtureOverrides = ShellRunCommonOverrides & {
  mode: 'pty';
  output?: PtyShellOutput;
  omitOutput?: boolean;
};

function shellRun(
  overrides: PtyShellRunFixtureOverrides,
): Extract<ShellRunToolResult, { mode: 'pty' }>;
function shellRun(
  overrides?: PipeShellRunFixtureOverrides,
): Extract<ShellRunToolResult, { mode: 'pipes' }>;
function shellRun(
  overrides: PipeShellRunFixtureOverrides | PtyShellRunFixtureOverrides = {},
): ShellRunToolResult {
  if (overrides.mode === 'pty') {
    const { mode: _mode, output, omitOutput, operation, ...state } = overrides;
    const compact = {
      kind: 'shell_run',
      ref: 'maka://runtime/background-tasks/bg-1',
      mode: 'pty',
      status: 'running',
      cwd: '/repo',
      cmd: 'npm test',
      revision: state.revision ?? state.updatedAt ?? state.completedAt ?? 1,
      startedAt: 1_000,
      updatedAt: 1_000,
      ...state,
    } as const;
    if (omitOutput) {
      if (operation) throw new Error('Compact ShellRun fixtures cannot carry an operation');
      return compact;
    }
    const snapshot = { ...compact, output: output ?? ptyOutput() };
    return operation ? { ...snapshot, operation } : snapshot;
  }
  const {
    mode: _mode,
    output: explicitOutput,
    stdout = '',
    stderr = '',
    stdoutTruncated = false,
    stderrTruncated = false,
    latestStream,
    omitOutput,
    operation,
    ...state
  } = overrides;
  const output = explicitOutput ?? {
    mode: 'pipes' as const,
    stdout,
    stderr,
    ...(latestStream ? { latestStream } : {}),
    stdoutTruncated,
    stderrTruncated,
    redacted: false,
  };
  const compact = {
    kind: 'shell_run',
    ref: 'maka://runtime/background-tasks/bg-1',
    mode: 'pipes',
    status: 'running',
    cwd: '/repo',
    cmd: 'npm test',
    revision: state.revision ?? state.updatedAt ?? state.completedAt ?? 1,
    startedAt: 1_000,
    updatedAt: 1_000,
    ...state,
  } as const;
  if (omitOutput) {
    if (operation) throw new Error('Compact ShellRun fixtures cannot carry an operation');
    return compact;
  }
  const snapshot = { ...compact, output };
  if (!operation) return snapshot;
  if (operation.kind !== 'stop') {
    throw new Error('Pipe ShellRun fixtures cannot carry a PTY control operation');
  }
  return { ...snapshot, operation };
}

function ptyOutput(overrides: Partial<PtyShellOutput> = {}): PtyShellOutput {
  return {
    mode: 'pty',
    screen: '',
    scrollback: '',
    cols: 80,
    rows: 24,
    cursor: { x: 0, y: 0, visible: true },
    alternateScreen: false,
    truncated: false,
    redacted: false,
    ...overrides,
  };
}

function event(input: { type: SessionEvent['type'] } & Record<string, unknown>): SessionEvent {
  return {
    id: `${input.type}-id`,
    turnId: 'turn-1',
    ts: 1,
    ...input,
  } as SessionEvent;
}

function subagentResult(
  overrides: Partial<Extract<ToolResultContent, { kind: 'subagent' }>> = {},
): Extract<ToolResultContent, { kind: 'subagent' }> {
  return {
    kind: 'subagent',
    agentName: 'Local Read',
    turnId: 'child-turn',
    status: 'completed',
    permissionMode: 'explore',
    summary: 'done',
    artifactIds: [],
    ...overrides,
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
