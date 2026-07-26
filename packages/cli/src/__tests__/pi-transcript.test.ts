import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { _setColorLevelForTesting } from '../tui-ansi.js';
import type { PipeShellOutput, PtyShellOutput, ShellRunToolResult } from '@maka/core';
import type { SessionEvent, ToolResultContent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import {
  appendUserPrompt,
  applyShellRunViewUpdateToTranscript,
  applyMakaSessionEventToTranscript,
  applyShellRunUpdateToTranscript,
  createMakaPiTranscriptState,
  renderMakaPiActivityStrip,
  renderMakaPiStatusLine,
  renderMakaPiTranscript,
  refreshRunningShellRunElapsed,
  replaceTranscriptWithStoredMessages,
  submitCompactToTranscript,
  toggleAllThinkingExpansion,
  toggleAllToolExpansion,
  togglePendingPermissionDetails,
} from '../pi-transcript.js';

// Pin the color level so ANSI-escape assertions are hermetic. Detection reads
// process.env.TERM/COLORTERM at module load, so ambient terminal capability
// (truecolor locally, unset/dumb on CI runners) would otherwise decide whether
// color escapes appear. Level 3 (truecolor) is the development default these
// tests lock (#1064/#1066); matches tui-ansi.test.ts's reset convention.
before(() => _setColorLevelForTesting(3));

// The branded empty-session home opens on a four-line lowercase ASCII `maka`
// wordmark in Maka blue (#1098). Stored without trailing spaces so the render
// and these assertions agree after rtrim; the fallback width is derived from it.
const MAKA_WORDMARK = [
  ' _ __    __ _  _  __   __ _',
  "| '_ \\  / _` | | |/ / / _` |",
  '| |_) | | (_| | |   <  | (_| |',
  '|_.__/  \\__,_| |_|\\_\\  \\__,_|',
];
const MAKA_WORDMARK_WIDTH = Math.max(...MAKA_WORDMARK.map((line) => line.length));

describe('Maka Pi TUI transcript', () => {
  test('greets on a fresh empty session with the branded maka home and drops it once a prompt lands', () => {
    const state = createMakaPiTranscriptState();

    const lines = renderMakaPiTranscript(state, meta(), 100).map((line) =>
      stripAnsi(line).replace(/\s+$/, ''),
    );
    // Four-line lowercase ASCII maka wordmark.
    assert.deepEqual(lines.slice(0, 4), MAKA_WORDMARK);
    // The wordmark is Maka blue (accent), not plain text.
    assert.ok(renderMakaPiTranscript(state, meta(), 100)[0].includes('\x1b[38;2;87;163;239m'));
    // Short Chinese-first tagline.
    assert.ok(lines.includes('陪你把事做完'));
    // Command-center hints: direct input + /session + /model + /setup. /help is
    // no longer a home hint — autocomplete teaches commands as you type.
    assert.ok(lines.some((line) => line.trim().startsWith('输入消息开始对话')));
    assert.ok(lines.some((line) => /\/session/.test(line)));
    assert.ok(lines.some((line) => /\/model/.test(line)));
    assert.ok(lines.some((line) => /\/setup/.test(line)));
    assert.equal(
      lines.some((line) => /\/help/.test(line)),
      false,
    );
    // The active model/connection live in the statusline, not the welcome.
    assert.equal(
      lines.some((line) => /deepseek-v4-flash/.test(line)),
      false,
    );

    // Once a turn exists the transcript takes over — the welcome never returns.
    appendUserPrompt(state, 'hello world');
    const afterPrompt = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.equal(/\/session/.test(afterPrompt), false);
    assert.ok(afterPrompt.includes('hello world'));
  });

  test('falls back to a plain maka mark when the terminal is too narrow for the wordmark', () => {
    const state = createMakaPiTranscriptState();

    // One column below the wordmark's own width degrades it to a single maka line.
    const narrow = renderMakaPiTranscript(state, meta(), MAKA_WORDMARK_WIDTH - 1).map((line) =>
      stripAnsi(line).replace(/\s+$/, ''),
    );
    assert.equal(narrow[0], 'maka');
    assert.equal(
      narrow.slice(0, 4).some((line) => /__/.test(line)),
      false,
    );
    // The tagline and hints still show below the fallback mark.
    assert.ok(narrow.includes('陪你把事做完'));
    assert.ok(narrow.some((line) => /\/session/.test(line)));

    // At the wordmark's own width the four-line wordmark still renders.
    const atThreshold = renderMakaPiTranscript(state, meta(), MAKA_WORDMARK_WIDTH).map((line) =>
      stripAnsi(line).replace(/\s+$/, ''),
    );
    assert.deepEqual(atThreshold.slice(0, 4), MAKA_WORDMARK);
  });

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

  test('shows a fixed system notice when the configured step limit is reached', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(state, event({ type: 'complete', stopReason: 'step_limit' }));

    assert.deepEqual(state.entries, [
      {
        kind: 'notice',
        level: 'info',
        text: 'Reached the configured step limit. The task may be incomplete. Send “continue” to resume.',
      },
    ]);
  });

  test('restores the step-limit system notice from stored history', () => {
    const state = createMakaPiTranscriptState();

    replaceTranscriptWithStoredMessages(state, [
      { type: 'system_note', id: 'notice-1', turnId: 'turn-1', ts: 1, kind: 'step_limit' },
    ]);

    assert.deepEqual(state.entries, [
      {
        kind: 'notice',
        level: 'info',
        text: 'Reached the configured step limit. The task may be incomplete. Send “continue” to resume.',
      },
    ]);
  });

  test('reports completed manual compact runs when there was nothing to compact', async () => {
    const state = createMakaPiTranscriptState();
    const driver = new RecordingDriver([
      event({ type: 'token_usage', input: 0, output: 0 }),
      event({ type: 'complete', stopReason: 'end_turn' }),
    ]);

    await submitCompactToTranscript({ state, driver });

    assert.equal(driver.compactCalls, 1);
    assert.ok(
      state.entries.some(
        (entry) => entry.kind === 'notice' && entry.text === 'Nothing to compact.',
      ),
    );
  });

  test('reports manual compact failed-open diagnostics instead of no-op success', async () => {
    const state = createMakaPiTranscriptState();
    const driver = new RecordingDriver([
      event({
        type: 'token_usage',
        input: 0,
        output: 0,
        contextBudget: {
          enabled: true,
          estimatedTokensBefore: 100,
          estimatedTokensAfter: 100,
          keptTurns: 2,
          droppedTurns: 0,
          keptEvents: 4,
          droppedEvents: 0,
          compactionDecisions: [
            {
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'failedOpen',
              boundaryKind: 'historyCompact',
              failOpenReason: 'output_length',
            },
          ],
        },
      }),
      event({ type: 'complete', stopReason: 'end_turn' }),
    ]);

    await submitCompactToTranscript({ state, driver });

    assert.ok(
      state.entries.some(
        (entry) =>
          entry.kind === 'notice' &&
          entry.level === 'error' &&
          entry.text === 'Context compaction skipped: output_length.',
      ),
    );
    assert.equal(
      state.entries.some(
        (entry) => entry.kind === 'notice' && entry.text === 'Nothing to compact.',
      ),
      false,
    );
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

  test('rebuilds transcript from stored session messages', () => {
    const state = createMakaPiTranscriptState();

    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 1,
        text: 'What did we decide?',
      },
      {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 2,
        text: 'We decided to keep the TUI small.',
        thinking: { text: 'recall the decision' },
        modelId: 'deepseek-v4-flash',
      },
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
    ] satisfies StoredMessage[]);

    // Stored thinking happened before the reply text, so it resumes above it.
    assert.deepEqual(
      state.entries.map((entry) => entry.kind),
      ['user', 'thinking', 'assistant', 'tool'],
    );
    assert.equal(
      state.entries[0]?.kind === 'user' ? state.entries[0].text : '',
      'What did we decide?',
    );
    assert.equal(
      state.entries[1]?.kind === 'thinking' ? state.entries[1].text : '',
      'recall the decision',
    );
    assert.equal(
      state.entries[2]?.kind === 'assistant' ? state.entries[2].text : '',
      'We decided to keep the TUI small.',
    );
    assert.equal(
      state.entries[3]?.kind === 'tool' ? state.entries[3].output : '',
      'README contents',
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

  test('keeps a stored errored StopBackgroundTask poll as a card without folding it into the parent', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/bg-1';

    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'tool_call',
        id: 'bash-bg',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Bash',
        args: { command: 'sleep 30' },
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
        id: 'stop-bg',
        turnId: 'turn-1',
        ts: 3,
        toolName: 'StopBackgroundTask',
        args: { ref },
      },
      {
        type: 'tool_result',
        id: 'stop-result',
        turnId: 'turn-1',
        ts: 4,
        toolUseId: 'stop-bg',
        isError: true,
        content: shellRun({
          ref,
          status: 'cancelled',
          stdout: 'starting\n',
          revision: 2,
          completedAt: 5_000,
          exitCode: 130,
        }),
      },
    ] satisfies StoredMessage[]);

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.deepEqual(
      tools.map((tool) => tool.toolUseId),
      ['bash-bg', 'stop-bg'],
    );
    assert.equal(tools[1]?.status, 'error');
    assert.equal(tools[0]?.status, 'running');
    assert.equal(tools[0]?.result?.kind === 'shell_run' ? tools[0].result.revision : undefined, 1);
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /● StopBackgroundTask/);
  });

  test('renders a PTY around the cursor when compact and as three head plus three tail rows when expanded', () => {
    const state = createMakaPiTranscriptState();
    const screen = Array.from({ length: 8 }, (_, index) => `pty-row-${index + 1}`).join('\n');
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-pty',
        toolName: 'Bash',
        args: { command: 'interactive', pty: true },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-pty',
        isError: false,
        content: shellRun({
          mode: 'pty',
          output: ptyOutput({
            screen,
            cursor: { x: 0, y: 6, visible: true },
          }),
        }),
      }),
    );

    // Compact: a running PTY Bash shows only the disc row; the PTY screen
    // lives in the expanded card.
    const compact = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(compact, /● Bash  \$ interactive \(running\)/);
    assert.doesNotMatch(compact, /pty-row-1/);

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    for (const row of [1, 2, 3, 6, 7, 8]) assert.match(expanded, new RegExp(`pty-row-${row}`));
    assert.doesNotMatch(expanded, /pty-row-[45]/);
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

  test('Ctrl+O reports nothing to toggle when the session has no tool card at all', () => {
    const state = createMakaPiTranscriptState();
    assert.equal(toggleAllToolExpansion(state), false);
    assert.equal(state.expandAllTools, false);
    assert.equal(
      state.entries.some((entry) => entry.kind === 'notice'),
      false,
    );
  });

  test('tool cards born after an expand-all start expanded', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'first' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: false,
        content: terminalResult('ok\n'),
      }),
    );
    assert.equal(toggleAllToolExpansion(state), true);

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-2',
        toolName: 'Bash',
        args: { command: 'second' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-2',
        isError: false,
        content: terminalResult(
          `second-head\n${Array.from({ length: 10 }, (_, i) => `second-row-${i}`).join('\n')}`,
        ),
      }),
    );

    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /second-head/);
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
    assert.match(rendered, /Queued: echo hello\\r/);
    assert.match(rendered, /Resized to 100x30/);
    assert.equal(rendered.split('UNIQUE-PTY-FRAME').length - 1, 1);
  });

  test('projects raw live WriteStdin args at the TUI transcript boundary', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/pty-live';

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'write-live',
        toolName: 'WriteStdin',
        args: { ref, input: 'echo live\r' },
      }),
    );

    const entry = state.entries.find(
      (candidate): candidate is Extract<typeof candidate, { kind: 'tool' }> =>
        candidate.kind === 'tool',
    );
    assert.deepEqual(entry?.input, {
      ref,
      inputPreview: { text: 'echo live\\r', bytes: 10, truncated: false },
    });
  });

  test('restores the total elapsed time of a settled background Bash card', () => {
    const state = createMakaPiTranscriptState();
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
          status: 'completed',
          startedAt: 1_000,
          updatedAt: 6_000,
          completedAt: 6_000,
          exitCode: 0,
        }),
      },
    ] satisfies StoredMessage[]);

    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /● Bash  \$ npm test \(5s\)/);
  });

  test('rebuilds automatic context compaction notes from stored session messages', () => {
    const state = createMakaPiTranscriptState();

    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'system_note',
        id: 'note-1',
        turnId: 'turn-1',
        ts: 1,
        kind: 'context_compacted',
      },
    ] satisfies StoredMessage[]);

    assert.deepEqual(
      state.entries.filter((entry) => entry.kind === 'notice'),
      [
        {
          kind: 'notice',
          level: 'info',
          text: 'Context compacted to keep this session within the model window.',
        },
      ],
    );
  });

  test('rebuilds fail-open notes without claiming history was trimmed', () => {
    const state = createMakaPiTranscriptState();

    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'system_note',
        id: 'note-failed-open',
        turnId: 'turn-1',
        ts: 1,
        kind: 'context_compaction_failed_open',
      },
    ] satisfies StoredMessage[]);

    assert.deepEqual(
      state.entries.filter((entry) => entry.kind === 'notice'),
      [
        {
          kind: 'notice',
          level: 'info',
          text: 'Context summary failed; the session continued without a new summary.',
        },
      ],
    );
  });

  test('renders every transcript line within the terminal width', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'please inspect a very long path under packages/runtime/src');
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: 'I will inspect `packages/runtime/src/very-long-file-name.ts` now.',
      }),
    );

    const lines = renderMakaPiTranscript(
      state,
      {
        title: 'Maka',
        cwd: '/Users/yuhan/workspace/oss/maka-agent/.worktree/maka-cli-tui',
        model: 'deepseek-v4-flash',
        connectionSlug: 'deepseek',
        permissionMode: 'bypass',
        busy: true,
      },
      12,
    );

    assert.ok(lines.every((line) => visibleWidth(line) <= 12));
  });

  test('renders assistant messages as bare text without a speaker label', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: 'hello',
      }),
    );

    const visibleLines = renderMakaPiTranscript(
      state,
      {
        title: 'Maka',
        cwd: '/tmp/project',
        model: 'deepseek-v4-flash',
        connectionSlug: 'deepseek',
        permissionMode: 'bypass',
      },
      80,
    ).map(stripAnsi);

    assert.ok(visibleLines.some((line) => line.trim() === 'hello'));
    assert.ok(!visibleLines.some((line) => line.includes('maka')));
    assert.ok(!visibleLines.some((line) => line.includes('Assistant')));
  });

  test('renders user messages with a > quote prefix instead of a speaker label', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'hello world');

    const visibleLines = renderMakaPiTranscript(
      state,
      {
        title: 'Maka',
        cwd: '/tmp/project',
        model: 'deepseek-v4-flash',
        connectionSlug: 'deepseek',
        permissionMode: 'bypass',
      },
      80,
    ).map(stripAnsi);

    assert.ok(
      visibleLines.some((line) => line.startsWith('> ')),
      'user row should start with >',
    );
    assert.ok(!visibleLines.some((line) => line.includes('User')), 'no User speaker label');
  });

  test('surfaces context compaction diagnostics as transcript notes', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'token_usage',
        input: 1200,
        output: 100,
        contextBudget: {
          enabled: true,
          policyName: 'cli-default-history-budget',
          maxHistoryEstimatedTokens: 32000,
          estimatedTokensBefore: 42000,
          estimatedTokensAfter: 18000,
          keptTurns: 3,
          droppedTurns: 5,
          keptEvents: 7,
          droppedEvents: 20,
          highWaterReason: 'history_compact',
          compactionDecisions: [
            {
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'replaced',
              boundaryKind: 'historyCompact',
              coveredTurns: 5,
              coveredRuntimeEvents: 20,
              estimatedTokensSaved: 24000,
            },
          ],
        },
      }),
    );

    const visibleLines = renderMakaPiTranscript(
      state,
      {
        title: 'Maka',
        cwd: '/tmp/project',
        model: 'deepseek-v4-flash',
        connectionSlug: 'deepseek',
        permissionMode: 'bypass',
      },
      120,
    ).map(stripAnsi);

    assert.ok(visibleLines.some((line) => line.includes('Context compacted')));
    assert.ok(visibleLines.some((line) => line.includes('historyCompact')));
    assert.ok(visibleLines.some((line) => line.includes('saved ~24000 tokens')));
  });

  test('surfaces pending permission requests with terminal decision hints', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'permission_request',
        requestId: 'permission-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        category: 'shell_unsafe',
        reason: 'shell_dangerous',
        args: { command: 'npm test' },
        hint: 'Run tests before editing.',
      }),
    );

    const visibleLines = renderMakaPiTranscript(
      state,
      {
        title: 'Maka',
        cwd: '/tmp/project',
        model: 'deepseek-v4-flash',
        connectionSlug: 'deepseek',
        permissionMode: 'ask',
      },
      100,
    ).map(stripAnsi);

    assert.equal(state.pendingInteraction?.requestId, 'permission-1');
    assert.ok(visibleLines.some((line) => line.includes('Permission required')));
    assert.ok(visibleLines.some((line) => line.includes('Bash')));
    assert.ok(visibleLines.some((line) => line.includes('npm test')));
    assert.ok(visibleLines.some((line) => line.includes('y/Enter allow')));
    assert.ok(visibleLines.some((line) => line.includes('n/Esc deny')));
  });

  test('renders one-call additional permission paths and risks without turn-wide approval', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'permission_request',
        kind: 'additional_permissions',
        requestId: 'permission-additional',
        toolUseId: 'tool-write',
        toolName: 'Write',
        category: 'file_write',
        reason: 'additional_permissions',
        args: undefined,
        cwd: '/workspace',
        justification: 'Write requires access to the requested path.',
        intentHash: `sha256:${'1'.repeat(64)}`,
        permissionsHash: `sha256:${'2'.repeat(64)}`,
        additionalPermissions: {
          fileSystem: { entries: [{ path: '/outside/file.txt', access: 'write', scope: 'exact' }] },
        },
        risk: { outsideWorkspace: true, protectedMetadata: false, networkEnabled: false },
        alsoApprovesToolExecution: true,
        availableDecisions: ['allow_once', 'deny'],
        rememberForTurnAllowed: false,
      }),
    );

    const visible = renderMakaPiTranscript(
      state,
      {
        title: 'Maka',
        cwd: '/workspace',
        model: 'model',
        connectionSlug: 'connection',
        permissionMode: 'ask',
      },
      120,
    )
      .map(stripAnsi)
      .join('\n');
    assert.match(visible, /Additional permission required/);
    assert.match(visible, /write exact \/outside\/file\.txt/);
    assert.match(visible, /risk: outside workspace/);
    assert.doesNotMatch(visible, /allow for turn/);
  });

  test('renders one-call unsandboxed execution details without turn-wide approval', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'permission_request',
        kind: 'sandbox_escalation',
        requestId: 'permission-escalation',
        toolUseId: 'tool-bash',
        toolName: 'Bash',
        category: 'shell_unsafe',
        reason: 'sandbox_escalation',
        args: undefined,
        command: 'printf retry-ok > /tmp/retry.txt',
        cwd: '/workspace',
        justification: 'The exact command must write outside the workspace.',
        intentHash: `sha256:${'3'.repeat(64)}`,
        commandHash: `sha256:${'4'.repeat(64)}`,
        trigger: 'sandbox_denial',
        risk: {
          unsandboxedExecution: true,
          unrestrictedFileSystem: true,
          unrestrictedNetwork: true,
          protectedMetadataExposed: true,
        },
        alsoApprovesToolExecution: true,
        availableDecisions: ['allow_once', 'deny'],
        rememberForTurnAllowed: false,
      }),
    );

    const visible = renderMakaPiTranscript(
      state,
      {
        title: 'Maka',
        cwd: '/workspace',
        model: 'model',
        connectionSlug: 'connection',
        permissionMode: 'ask',
      },
      120,
    )
      .map(stripAnsi)
      .join('\n');
    assert.match(visible, /Unsandboxed execution approval required/);
    assert.match(visible, /cwd: \/workspace/);
    assert.match(visible, /printf retry-ok > \/tmp\/retry\.txt/);
    assert.match(visible, /unrestricted filesystem, network, and protected metadata/);
    assert.doesNotMatch(visible, /allow for turn/);
  });

  test('keeps WriteStdin permission details bounded until explicitly expanded', () => {
    const state = createMakaPiTranscriptState();
    const hiddenSuffix = '\u001b[31mrm -rf /tmp/hidden-suffix\r';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'permission_request',
        requestId: 'permission-stdin',
        toolUseId: 'tool-stdin',
        toolName: 'WriteStdin',
        category: 'shell_unsafe',
        reason: 'shell_dangerous',
        args: {
          ref: 'maka://runtime/background-tasks/pty-1',
          input: `password=super-secret ${'x'.repeat(200)}${hiddenSuffix}`,
          size: { cols: 120, rows: 40 },
        },
        rememberForTurnAllowed: false,
      }),
    );

    const collapsed = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    assert.match(collapsed, /maka:\/\/runtime\/background-tasks\/pty-1/);
    assert.match(collapsed, /size: 120x40/);
    assert.doesNotMatch(collapsed, /super-secret/);
    assert.doesNotMatch(collapsed, /hidden-suffix/);

    assert.equal(togglePendingPermissionDetails(state), true);
    const rawExpanded = renderMakaPiTranscript(state, meta(), 120).join('\n');
    const expanded = stripAnsi(rawExpanded);
    assert.match(expanded, /super-secret/);
    assert.match(expanded, /\\u\{001B\}\[31mrm -rf/);
    assert.match(expanded, /\/tmp\/hidden-suffix\\r/);
    assert.doesNotMatch(rawExpanded, /\u001b\[31mrm -rf/);

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'permission_decision_ack',
        requestId: 'permission-stdin',
        toolUseId: 'tool-stdin',
        decision: 'allow',
      }),
    );
    assert.equal(state.expandedPermissionRequestId, undefined);
  });

  test('queues permission and user-question requests in arrival order', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'permission_request',
        requestId: 'permission-1',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        category: 'shell_unsafe',
        reason: 'shell_dangerous',
        args: {},
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

    assert.equal(state.pendingInteraction?.requestId, 'permission-1');
    assert.deepEqual(
      state.queuedInteractions.map((item) => item.requestId),
      ['question-1'],
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'permission_decision_ack',
        requestId: 'permission-1',
        toolUseId: 'tool-1',
        decision: 'allow',
      }),
    );
    assert.equal(state.pendingInteraction?.requestId, 'question-1');
    assert.deepEqual(state.queuedInteractions, []);
  });

  test('deduplicates interactions and expires permissions by their lifecycle ids', () => {
    const state = createMakaPiTranscriptState();
    const first = event({
      type: 'permission_request',
      requestId: 'permission-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'printf first' },
    });
    const question = event({
      type: 'user_question_request',
      requestId: 'question-1',
      toolUseId: 'question-tool',
      questions: [{ question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    const second = event({
      type: 'permission_request',
      requestId: 'permission-2',
      toolUseId: 'tool-2',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'printf second' },
    });
    const third = event({
      type: 'permission_request',
      requestId: 'permission-3',
      toolUseId: 'tool-3',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'printf third' },
    });

    applyMakaSessionEventToTranscript(state, first);
    applyMakaSessionEventToTranscript(state, question);
    applyMakaSessionEventToTranscript(state, second);
    applyMakaSessionEventToTranscript(state, third);
    applyMakaSessionEventToTranscript(
      state,
      event({
        ...first,
        id: 'permission-request-replay',
        args: { command: 'printf replayed-first' },
      }),
    );

    assert.equal(state.pendingInteraction?.requestId, 'permission-1');
    assert.deepEqual(
      state.pendingInteraction?.type === 'permission_request'
        ? state.pendingInteraction.args
        : undefined,
      { command: 'printf first' },
    );
    assert.deepEqual(
      state.queuedInteractions.map((item) => item.requestId),
      ['question-1', 'permission-2', 'permission-3'],
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'permission_decision_ack',
        requestId: 'permission-3',
        toolUseId: 'tool-3',
        decision: 'deny',
      }),
    );
    assert.deepEqual(
      state.queuedInteractions.map((item) => item.requestId),
      ['question-1', 'permission-2'],
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-2',
        isError: true,
        content: { kind: 'text', text: 'permission expired' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'unrelated-tool',
        isError: false,
        content: { kind: 'text', text: 'ok' },
      }),
    );
    assert.deepEqual(
      state.queuedInteractions.map((item) => item.requestId),
      ['question-1'],
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: true,
        content: { kind: 'text', text: 'permission expired' },
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

  test('separates the thinking marker from tool rows with blank lines', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'ls' },
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
        type: 'thinking_delta',
        messageId: 'message-1',
        text: 'plan the next step',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-2',
        toolName: 'Bash',
        args: { command: 'pwd' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-2',
        isError: false,
        content: { kind: 'text', text: 'ok' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-3',
        toolName: 'Bash',
        args: { command: 'whoami' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-3',
        isError: false,
        content: { kind: 'text', text: 'ok' },
      }),
    );

    const lines = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    const markerIndex = lines.findIndex((line) => line.includes('Thinking…'));
    assert.ok(markerIndex > 0);

    // Thinking reads as model output: a blank line sets it apart from the
    // tool rows on both sides.
    assert.equal(lines[markerIndex - 1], '');
    assert.equal(lines[markerIndex + 1], '');

    // Consecutive tool rows stay compact — no blank line between them.
    const toolIndices = lines
      .map((line, index) => (line.includes('● Bash') ? index : -1))
      .filter((index) => index >= 0);
    assert.deepEqual(toolIndices, [markerIndex - 2, markerIndex + 2, markerIndex + 3]);
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

  test('keeps tool cards compact until the latest tool is expanded', () => {
    const state = createMakaPiTranscriptState();
    // `head-line` is first; the compact one-line summary shows only the output
    // size, never output content, and expanding reveals the full stdout.
    const stdout = `head-line\n${Array.from({ length: 30 }, (_, i) => `row-${i}`).join('\n')}`;

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: false,
        content: terminalResult(stdout),
      }),
    );

    const compactLines = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi);
    const compact = compactLines.join('\n');

    // Compact cards are a single line (plus the leading blank separator).
    assert.equal(compactLines.length, 2);
    assert.match(compact, /● Bash  \$ npm test/);
    assert.match(compact, /\(31 lines\)/);
    assert.doesNotMatch(compact, /head-line/);
    assert.doesNotMatch(compact, /row-29/);
    // The annotation's shapes carry the affordance; no expand marker remains.
    assert.doesNotMatch(compact, /›/);

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');

    assert.match(expanded, /head-line/);
    assert.match(expanded, /row-29/);
  });

  test('summarizes a failing Bash tool with a red exit code, not the error text', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: true,
        content: terminalResult('some earlier output', 'first error\nfinal error line\n', {
          status: 'failed',
          exitCode: 1,
        }),
      }),
    );

    const lines = renderMakaPiTranscript(state, meta(), 120);
    assert.equal(lines.length, 2);
    const compact = lines.map(stripAnsi).join('\n');
    assert.match(compact, /\(exit 1\)/);
    // The error text itself lives only in the expanded card.
    assert.doesNotMatch(compact, /final error line/);
    // The exit code is red.
    assert.match(lines.join('\n'), /\x1b\[31mexit 1\x1b\[39m/);
  });

  test('marks a completed tool with a green disc', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'true' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: false,
        content: terminalResult('', '', { cmd: 'true' }),
      }),
    );

    const lines = renderMakaPiTranscript(state, meta(), 100);
    assert.match(lines.join('\n'), /\x1b\[32m●\x1b\[39m/);
  });

  test('hides a sub-second duration on a settled compact row', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-fast',
        toolName: 'Bash',
        args: { command: 'true' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-fast',
        isError: false,
        content: shellRun({
          status: 'completed',
          startedAt: 1_000,
          updatedAt: 1_300,
          completedAt: 1_300,
          exitCode: 0,
        }),
      }),
    );

    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /● Bash  \$ true \(no output\)/);
    assert.doesNotMatch(rendered, /0s/);
  });

  test('shows the first real command line when a Bash command leads with comments', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: '# look for the setting\ngrep -n "setting" src/config.ts' },
      }),
    );

    const compact = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(compact, /\$ grep -n "setting" src\/config\.ts/);
    assert.doesNotMatch(compact, /look for the setting/);
  });

  test('summarizes a silent successful command as (no output)', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'true' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: false,
        content: terminalResult('', '', { cmd: 'true' }),
      }),
    );

    const lines = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi);
    assert.equal(lines.length, 2);
    assert.match(lines.join('\n'), /\(no output\)/);
    assert.doesNotMatch(lines.join('\n'), /\(Ctrl\+O\)/);
  });

  test('shows the latest live output line while a tool is running', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'npm run build' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_output_delta',
        toolUseId: 'tool-1',
        seq: 1,
        stream: 'stdout',
        chunk: 'step one\n',
        redacted: false,
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_output_delta',
        toolUseId: 'tool-1',
        seq: 2,
        stream: 'stdout',
        chunk: 'step two\n',
        redacted: false,
      }),
    );

    const lines = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi);
    assert.equal(lines.length, 2);
    const compact = lines.join('\n');
    assert.match(compact, /● Bash  \$ npm run build \(running\)/);
    assert.doesNotMatch(compact, /step one/);
    assert.doesNotMatch(compact, /step two/);

    // Live output lives in the expanded card for a running tool.
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    assert.match(expanded, /step two/);
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

  test('shows live elapsed time and stop guidance on a running background Bash card', () => {
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
        content: shellRun({ startedAt: 1_000, updatedAt: 2_000 }),
      }),
    );

    assert.equal(refreshRunningShellRunElapsed(state, 13_500), true);
    const compact = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(compact, /running 13s/);
    assert.doesNotMatch(compact, /Ask Maka to stop this task/);

    // Stop guidance is expanded-only for a running background Bash shell_run.
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /Ask Maka to stop this task/);
  });

  test('describes a detached background Bash card by ownership, not lifecycle', () => {
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
        content: shellRun({ stdout: '', stderr: '' }),
      }),
    );
    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'branch',
      ownership: { kind: 'source_owned', sourceSessionId: 'source', ownerSessionId: 'source' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({ stdout: '', stderr: '' }),
    });

    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /\(detached\)/);
    assert.doesNotMatch(rendered, /continues in source session/);

    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'branch',
      ownership: { kind: 'source_unavailable', sourceSessionId: 'source' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({ stdout: '', stderr: '' }),
    });
    const unavailable = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(unavailable, /\(source unavailable\)/);
    assert.doesNotMatch(unavailable, /Ask Maka to stop this task/);
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

  test('announces at the transcript tail when a running background task completes', () => {
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

    const notice = state.entries[state.entries.length - 1];
    assert.equal(notice?.kind, 'notice');
    assert.equal(notice?.kind === 'notice' ? notice.level : '', 'info');
    const text = notice?.kind === 'notice' ? notice.text : '';
    assert.match(text, /Background task completed: npm test/);
    assert.match(text, /exit 0/);
    assert.match(text, /47s/);
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

  test('announces a stopped background task as a plain note', () => {
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
        content: shellRun({ ref, status: 'running', cmd: 'sleep 30' }),
      }),
    );

    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({
        ref,
        status: 'cancelled',
        cmd: 'sleep 30',
        completedAt: 8_000,
        exitCode: 130,
      }),
    });

    const notice = state.entries[state.entries.length - 1];
    assert.equal(notice?.kind, 'notice');
    assert.equal(notice?.kind === 'notice' ? notice.level : '', 'info');
    assert.match(notice?.kind === 'notice' ? notice.text : '', /Background task stopped: sleep 30/);
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

  test('announces a timed-out background task with human-readable text', () => {
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

    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({ ref, status: 'timed_out', completedAt: 60_000 }),
    });

    const notice = state.entries[state.entries.length - 1];
    assert.equal(notice?.kind, 'notice');
    assert.equal(notice?.kind === 'notice' ? notice.level : '', 'error');
    const text = notice?.kind === 'notice' ? notice.text : '';
    assert.match(text, /Background task timed out: npm test/);
    assert.doesNotMatch(text, /timed_out/);
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

  test('shows stdout as latest when it arrives after stderr', () => {
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
    const result = shellRun({
      stdout: '99%\n',
      stderr: 'warning\n',
      latestStream: 'stdout',
      updatedAt: 3_000,
    });
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: result,
      }),
    );

    // Live output lives in the expanded card for a running tool.
    assert.equal(toggleAllToolExpansion(state), true);
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /99%/);
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
    // An aborted background task uses the danger disc (red).
    assert.match(lines.join('\n'), /\x1b\[31m●\x1b\[39m/);
  });

  test('marks a failed background Bash card with the danger disc on the compact row', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-fail',
        toolName: 'Bash',
        args: { command: 'false' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-fail',
        isError: false,
        content: shellRun({
          status: 'failed',
          startedAt: 1_000,
          updatedAt: 2_000,
          completedAt: 2_000,
          exitCode: 1,
        }),
      }),
    );

    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    assert.equal(tools[0]?.kind === 'tool' ? tools[0].status : undefined, 'failed');
    const lines = renderMakaPiTranscript(state, meta(), 100);
    const rendered = lines.map(stripAnsi).join('\n');
    assert.match(rendered, /● Bash  \$ false/);
    // A failed background run uses the danger (red) disc, not the muted done disc.
    assert.match(lines.join('\n'), /\x1b\[31m●\x1b\[39m/);
  });

  test('keeps duration and the expand marker when a compact row overflows', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-long',
        toolName: 'Bash',
        args: { command: 'npm run build ' + 'x'.repeat(60) },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-long',
        isError: false,
        content: shellRun({
          status: 'completed',
          startedAt: 1_000,
          updatedAt: 6_000,
          completedAt: 6_000,
          exitCode: 0,
          stdout: 'first\nlast\n',
        }),
      }),
    );

    const lines = renderMakaPiTranscript(state, meta(), 60).map(stripAnsi);
    assert.equal(lines.length, 2); // one card line plus the leading blank separator
    const row = lines[1]!;
    // A long command must not hide the elapsed time or the outcome.
    assert.match(row, /\(5s · 2 lines\)$/);
    assert.ok(visibleWidth(row) <= 60, `row width ${visibleWidth(row)} exceeds 60`);
  });

  test('reserves a fixed-shape annotation when it fits alongside the row head', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-cap',
        toolName: 'Bash',
        args: { command: 'npm run build ' + 'x'.repeat(60) },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-cap',
        isError: false,
        content: shellRun({
          status: 'timed_out',
          startedAt: 0,
          updatedAt: 1_234_000,
          completedAt: 1_234_000,
          exitCode: 124,
        }),
      }),
    );

    const lines = renderMakaPiTranscript(state, meta(), 60).map(stripAnsi);
    const row = lines[1]!;
    // The complete fixed-shape annotation is reserved before the long command
    // target, so the timeout and exit code remain readable.
    assert.match(row, /\(1234s · timed_out · exit 124\)$/);
    assert.ok(visibleWidth(row) <= 60, `row width ${visibleWidth(row)} exceeds 60`);
  });

  test('keeps a duration-bearing generic outcome readable when it exceeds the old cap', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'generic-duration',
        toolName: 'McpTool',
        args: { target: 'x'.repeat(80) },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'generic-duration',
        isError: false,
        content: { kind: 'text', text: 'line\n'.repeat(100) },
        durationMs: 12_000,
      }),
    );

    const row = renderMakaPiTranscript(state, meta(), 80).map(stripAnsi)[1]!;
    assert.match(row, /\(12s · 100 lines · 500 bytes\)$/);
    assert.doesNotMatch(row, /\(1…\)$/);
    assert.ok(visibleWidth(row) <= 80, `row width ${visibleWidth(row)} exceeds 80`);
  });

  test('reserves the fixed-shape generic annotation when the row overflows', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'frob-1',
        toolName: 'Frobnicate',
        args: { alpha: 'x'.repeat(50), beta: 'two' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'frob-1',
        isError: false,
        content: { kind: 'json', value: { gamma: 3 } },
      }),
    );

    const lines = renderMakaPiTranscript(state, meta(), 40).map(stripAnsi);
    const row = lines[1]!;
    // The result content is no longer used as an annotation. Its fixed-shape
    // summary remains available while the long input target is truncated.
    assert.match(row, /alpha/);
    assert.match(row, /\(1 line · \d+ bytes\)$/);
    assert.ok(visibleWidth(row) <= 40, `row width ${visibleWidth(row)} exceeds 40`);
  });

  test('hides a sub-second duration instead of rounding it up to 1s', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-fast',
        toolName: 'Bash',
        args: { command: 'true' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-fast',
        isError: false,
        content: shellRun({
          status: 'completed',
          startedAt: 1_000,
          updatedAt: 1_999,
          completedAt: 1_999,
          exitCode: 0,
          stdout: 'ok\n',
        }),
      }),
    );

    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    // 999ms rounds to 1, but the gate is on raw milliseconds: no `1s`.
    assert.match(rendered, /● Bash  \$ true \(1 line\)/);
  });

  test('shows 1s once a full second has elapsed', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-1s',
        toolName: 'Bash',
        args: { command: 'true' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-1s',
        isError: false,
        content: shellRun({
          status: 'completed',
          startedAt: 1_000,
          updatedAt: 2_000,
          completedAt: 2_000,
          exitCode: 0,
          stdout: 'ok\n',
        }),
      }),
    );

    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /● Bash  \$ true \(1s · 1 line\)/);
  });

  test('a running row stays bare `running` for a sub-second duration', () => {
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
        content: shellRun({ status: 'running', startedAt: 1_000, updatedAt: 1_400 }),
        durationMs: 400,
      }),
    );

    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /● Bash  \$ sleep 30 \(running\)/);
  });

  test('counts stdout and stderr lines per stream, not at the join boundary', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-fg',
        toolName: 'Bash',
        args: { command: 'fg' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-fg',
        isError: false,
        content: terminalResult('out\n', 'err\n'),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'bg' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({
          status: 'completed',
          startedAt: 0,
          updatedAt: 2_000,
          completedAt: 2_000,
          exitCode: 0,
          stdout: 'out\n',
          stderr: 'err\n',
        }),
      }),
    );

    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    // `out\n` + `err\n` is two lines — joining before counting would invent a
    // third line at the stream boundary.
    assert.match(rendered, /● Bash  \$ fg \(2 lines\)/);
    assert.match(rendered, /● Bash  \$ bg \(2s · 2 lines\)/);
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

  test('summarizes Read results as a line/byte count and never replays file content', () => {
    const state = createMakaPiTranscriptState();
    const fileText = Array.from({ length: 4 }, (_, i) => `content-line-${i}`).join('\n');

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-1',
        toolName: 'Read',
        args: { path: 'src/app.ts', offset: 10, limit: 20 },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-1',
        isError: false,
        content: { kind: 'json', value: { content: fileText } },
      }),
    );

    const compactLines = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(compactLines.length, 2);
    const compact = compactLines.join('\n');
    assert.match(compact, /src\/app\.ts offset 10 limit 20/);
    assert.match(compact, /\(4 lines\)/);
    assert.doesNotMatch(compact, /content-line-0/);

    // A successful Read pulled the file into the model's context; expanding the
    // card confirms the read but must not dump the file into the transcript.
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(expanded, /content-line-0/);
    assert.match(expanded, /Read 4 lines, 59 bytes/);
  });

  test('counts a Read summary without the file trailing newline', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-nl',
        toolName: 'Read',
        args: { path: 'one.txt' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-nl',
        isError: false,
        content: { kind: 'json', value: { content: 'only-line\n' } },
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /Read 1 line, 10 bytes/);
  });

  test('shows maka://runtime resource Read output in full, never summarized or capped', () => {
    const state = createMakaPiTranscriptState();
    // A runtime resource read returns live state (background-task metadata +
    // output) that only lives in the transcript. Its body opens with several
    // metadata lines, so it must be neither summarized nor head/tail-capped.
    const body = [
      'ref: maka://runtime/background-tasks/abc',
      'status: running',
      'cwd: /repo',
      'command: npm test',
      'started: 1',
      'updated: 2',
      '',
      'stdout:',
      'first-output-line',
      'middle-output-line',
      'last-output-line',
    ].join('\n');
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-rt',
        toolName: 'Read',
        args: { ref: 'maka://runtime/background-tasks/abc' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-rt',
        isError: false,
        content: { kind: 'text', text: body },
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /command: npm test/); // a mid-body line a cap would hide
    assert.match(expanded, /stdout:/);
    assert.match(expanded, /middle-output-line/);
    assert.doesNotMatch(expanded, /lines hidden/);
    assert.doesNotMatch(expanded, /Read \d+ lines,/);
  });

  test('keeps an archived Read placeholder status visible instead of a line count', () => {
    const state = createMakaPiTranscriptState();
    // Compaction can replace a completed filesystem Read's result with an archive
    // placeholder; its not_loaded/missing status must stay visible, not be read as
    // a one-line file body.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-arch',
        toolName: 'Read',
        args: { path: 'README.md' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-arch',
        isError: false,
        content: { kind: 'archived_tool_result', status: 'not_loaded' },
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /Archived tool result: not_loaded/);
    assert.doesNotMatch(expanded, /Read \d+ lines,/);
  });

  test('reports the same Read line count collapsed and expanded for a trailing-newline file', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-count',
        toolName: 'Read',
        args: { path: 'three.txt' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-count',
        isError: false,
        content: { kind: 'json', value: { content: 'a\nb\nc\n' } },
      }),
    );

    // Collapsed and expanded must agree: both drop the trailing newline, so the
    // same card cannot flip from "4 lines" to "3 lines" when toggled with Ctrl+O.
    const compact = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(compact, /\(3 lines\)/);
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /Read 3 lines, 6 bytes/);
  });

  test('preserves a real trailing blank line in the Read line count', () => {
    const state = createMakaPiTranscriptState();
    // Only the single conventional EOF newline is dropped: `a\n\n` keeps its
    // trailing blank line (two lines), and a lone `\n` is one blank line.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-blank',
        toolName: 'Read',
        args: { path: 'blank.txt' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-blank',
        isError: false,
        content: { kind: 'json', value: { content: 'a\n\n' } },
      }),
    );
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /Read 2 lines, 3 bytes/);
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

  test('does not repeat the command when a background Bash result already shows it', () => {
    const state = createMakaPiTranscriptState();
    // A Bash background handoff carries the command on both the input and the
    // shell_run result; the expanded card must print `$ cmd` once, not twice.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'npm run watch' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({
          ref: 'bg-9',
          status: 'running',
          cwd: '/repo',
          cmd: 'npm run watch',
          startedAt: 1,
          updatedAt: 2,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    const occurrences = expanded.split('$ npm run watch').length - 1;
    assert.equal(occurrences, 1);
    assert.match(expanded, /cwd: \/repo/); // cwd is not in the input summary, so shown once here
  });

  test('renders the full command for a multiline background Bash result', () => {
    const state = createMakaPiTranscriptState();
    // The Bash input summary shows only the first line, so a multiline command
    // must be rendered in full by the result or the rest is lost.
    const command = 'npm run build \\\n  --watch \\\n  --verbose';
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-ml',
        toolName: 'Bash',
        args: { command },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-ml',
        isError: false,
        content: shellRun({
          ref: 'bg-ml',
          status: 'running',
          cwd: '/repo',
          cmd: command,
          startedAt: 1,
          updatedAt: 2,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /--watch/);
    assert.match(expanded, /--verbose/);
  });

  test('renders a report-style result in full instead of head/tail capping it', () => {
    const state = createMakaPiTranscriptState();
    // Report-style kinds (agent reports, summaries) are content the user expands
    // to read in full; unlike a raw command dump they must not be capped.
    const report = Array.from({ length: 12 }, (_, i) => `report-line-${i}`).join('\n');
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'sum-1',
        toolName: 'Task',
        args: {},
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'sum-1',
        isError: false,
        content: { kind: 'summary', original: 'x', summarized: report, reason: 'too_large' },
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /report-line-0/);
    assert.match(expanded, /report-line-6/); // a mid-body line a head/tail cap would hide
    assert.match(expanded, /report-line-11/);
    assert.doesNotMatch(expanded, /lines hidden/);
  });

  test('summarizes Grep results as a match count and shows matches expanded', () => {
    const state = createMakaPiTranscriptState();
    const matches = Array.from({ length: 12 }, (_, i) => `match-${i}`);

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'grep-1',
        toolName: 'Grep',
        args: { pattern: 'TODO', path: 'packages', glob: '*.ts' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'grep-1',
        isError: false,
        content: { kind: 'json', value: { matches } },
      }),
    );

    const compactLines = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(compactLines.length, 2);
    const compact = compactLines.join('\n');
    assert.match(compact, /TODO in packages glob \*\.ts/);
    assert.match(compact, /\(12 matches\)/);
    assert.doesNotMatch(compact, /match-0/);

    // Expanding a Grep card shows every match — a structured list the user
    // opened the card to scan, not a raw dump to head/tail cap. All 12 rows,
    // including the middle ones, must survive and there is no hidden-count marker.
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    for (let i = 0; i < 12; i += 1) assert.match(expanded, new RegExp(`match-${i}\\b`));
    assert.doesNotMatch(expanded, /lines hidden/);
  });

  test('summarizes Glob results as a file count and shows the list expanded', () => {
    const state = createMakaPiTranscriptState();
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'glob-1',
        toolName: 'Glob',
        args: { pattern: '**/*.ts', cwd: 'packages' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'glob-1',
        isError: false,
        content: { kind: 'json', value: { files } },
      }),
    );

    const compactLines = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(compactLines.length, 2);
    const compact = compactLines.join('\n');
    assert.match(compact, /● Glob  \*\*\/\*\.ts in packages/);
    assert.match(compact, /\(3 files\)/);
    assert.doesNotMatch(compact, /src\/a\.ts/);

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /src\/a\.ts/);
    assert.match(expanded, /src\/c\.ts/);
  });

  test('does not fabricate a Grep match count from an error-shaped result', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'grep-1',
        toolName: 'Grep',
        args: { pattern: 'TODO' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'grep-1',
        isError: false,
        content: { kind: 'json', value: { error: 'boom\nsecond line\nthird' } },
      }),
    );

    const compact = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    // A 3-line error object must not be reported as "3 matches". It uses the
    // generic fixed-shape summary instead, without raw JSON or result content.
    assert.doesNotMatch(compact, /\d+ matches/);
    assert.match(compact, /\(4 lines · 35 bytes\)/);
    assert.doesNotMatch(compact, /"error":"boom/);
    assert.doesNotMatch(compact, /error:/);
  });

  test('does not fabricate a Grep match count when matches is not an array', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'grep-1',
        toolName: 'Grep',
        args: { pattern: 'TODO' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'grep-1',
        isError: false,
        content: { kind: 'json', value: { matches: 'not-an-array' } },
      }),
    );

    const compact = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    assert.doesNotMatch(compact, /\d+ matches/);
  });

  test('does not fabricate a Glob file count when files is null', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'glob-1',
        toolName: 'Glob',
        args: { pattern: '**/*.ts' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'glob-1',
        isError: false,
        content: { kind: 'json', value: { files: null } },
      }),
    );

    const compact = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    assert.doesNotMatch(compact, /\d+ files/);
  });

  test('keeps generic JSON input and result summaries on a single line', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Frobnicate',
        args: { alpha: 1, beta: 'two' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'json', value: { gamma: 3, delta: 'four' } },
      }),
    );

    const lines = renderMakaPiTranscript(state, meta(), 200).map(stripAnsi);
    // Never more than one card line (plus the leading blank separator):
    // multi-line JSON must not split the header.
    assert.equal(lines.length, 2);
    // #1086: generic results use a fixed-shape size summary instead of
    // leaking the first result line into the compact row.
    assert.match(lines[1] ?? '', /● Frobnicate  alpha: 1 beta: two \(\d+ lines · \d+ bytes\)/);
    assert.doesNotMatch(lines[1] ?? '', /\{"alpha"/);
    assert.doesNotMatch(lines[1] ?? '', /\{"gamma"/);
    assert.doesNotMatch(lines[1] ?? '', /gamma:/);
  });

  test('summarizes free-text MCP results with UTF-8 line and byte counts', () => {
    const state = createMakaPiTranscriptState();
    const text = '你好\n世界\n';

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'mcp-1',
        toolName: 'mcp__github__search',
        args: { query: 'Maka' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'mcp-1',
        isError: false,
        content: { kind: 'text', text },
      }),
    );

    const compact = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    assert.match(compact, /\(2 lines · 14 bytes\)/);
    assert.doesNotMatch(compact, /你好|世界/);

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    assert.match(expanded, /你好/);
    assert.match(expanded, /世界/);
  });

  test('uses no output for empty and whitespace-only generic results', () => {
    for (const [toolUseId, text] of [
      ['empty', ''],
      ['blank', ' \n\t '],
    ] as const) {
      const state = createMakaPiTranscriptState();
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_start',
          toolUseId,
          toolName: 'mcp__local__empty',
          args: {},
        }),
      );
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_result',
          toolUseId,
          isError: false,
          content: { kind: 'text', text },
        }),
      );

      const compact = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
      assert.match(compact, /\(no output\)/);
      assert.doesNotMatch(compact, /lines · \d+ bytes/);
    }
  });

  test('keeps subagent summaries out of compact rows', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'agent-summary',
        toolName: 'agent_spawn',
        args: { profile: 'local_read', task: 'Inspect the repository.' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'agent-summary',
        isError: false,
        content: subagentResult({ summary: 'first result line\nsecond result line' }),
      }),
    );

    const compact = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    assert.match(compact, /\(2 lines · \d+ bytes\)/);
    assert.doesNotMatch(compact, /first result line|second result line/);
  });

  test('shows archived Read status instead of archived placeholder text', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'read-archived',
        toolName: 'Read',
        args: { path: 'README.md' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-archived',
        isError: false,
        content: { kind: 'archived_tool_result', status: 'not_loaded' },
      }),
    );

    const compact = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    assert.match(compact, /\(archived: not_loaded\)/);
    assert.doesNotMatch(compact, /Archived tool result:/);
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

  test('renders the same generic result summary for live and stored transcript paths', () => {
    const live = createMakaPiTranscriptState();
    const stored = createMakaPiTranscriptState();
    const text = 'live and replay\nuse the same shape\n';

    applyMakaSessionEventToTranscript(
      live,
      event({
        type: 'tool_start',
        toolUseId: 'mcp-replay',
        toolName: 'mcp__github__search',
        args: { query: 'replay' },
      }),
    );
    applyMakaSessionEventToTranscript(
      live,
      event({
        type: 'tool_result',
        toolUseId: 'mcp-replay',
        isError: false,
        content: { kind: 'text', text },
      }),
    );
    replaceTranscriptWithStoredMessages(stored, [
      {
        type: 'tool_call',
        id: 'mcp-replay',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'mcp__github__search',
        args: { query: 'replay' },
      },
      {
        type: 'tool_result',
        id: 'mcp-result',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'mcp-replay',
        isError: false,
        content: { kind: 'text', text },
      },
    ] satisfies StoredMessage[]);

    assert.deepEqual(
      renderMakaPiTranscript(live, meta(), 120).map(stripAnsi),
      renderMakaPiTranscript(stored, meta(), 120).map(stripAnsi),
    );
  });

  test('summarizes file_diff compactly and colors the expanded diff', () => {
    const state = createMakaPiTranscriptState();
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1 +1 @@',
      '-removed line',
      '+added line',
    ].join('\n');

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'edit-1',
        toolName: 'Edit',
        args: { path: 'file.ts' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'edit-1',
        isError: false,
        content: { kind: 'file_diff', paths: ['file.ts'], diff },
      }),
    );

    const compactLines = renderMakaPiTranscript(state, meta(), 100);
    assert.equal(compactLines.length, 2);
    const compactRaw = compactLines.join('\n');
    // Compact: `+1 -1` with green add count and red delete count; the path is
    // already the card's input summary, so the diff summary does not repeat it.
    assert.match(compactLines.map(stripAnsi).join('\n'), /\(\+1 -1\)/);
    assert.doesNotMatch(compactLines.map(stripAnsi).join('\n'), /\+1 -1 file\.ts/);
    assert.match(compactRaw, /\x1b\[32m\+1\x1b\[39m/);
    assert.match(compactRaw, /\x1b\[31m-1\x1b\[39m/);
    assert.doesNotMatch(compactLines.map(stripAnsi).join('\n'), /added line/);

    assert.equal(toggleAllToolExpansion(state), true);
    const raw = renderMakaPiTranscript(state, meta(), 100).join('\n');
    // Green (32) around the added line, red (31) around the removed line.
    assert.match(raw, /\x1b\[32m\+added line\x1b\[39m/);
    assert.match(raw, /\x1b\[31m-removed line\x1b\[39m/);
  });

  test('caps long terminal output to head and tail lines when expanded', () => {
    const state = createMakaPiTranscriptState();
    const stdout = Array.from({ length: 20 }, (_, i) => `out-${i}`).join('\n');

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-1',
        toolName: 'Bash',
        args: { command: 'seq 20' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-1',
        isError: false,
        content: terminalResult(stdout),
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    // First three and last three lines survive; the middle collapses to a marker.
    assert.match(expanded, /out-0\n/);
    assert.match(expanded, /out-2\n/);
    assert.match(expanded, /out-17\n/);
    assert.match(expanded, /out-19/);
    assert.doesNotMatch(expanded, /out-10\b/);
    assert.match(expanded, /⋯ 14 lines hidden ⋯/);
  });

  test('ignores a trailing newline when counting terminal output for the cap', () => {
    const state = createMakaPiTranscriptState();
    // Real command output ends in a newline. The seven content lines are within
    // the cap, so a trailing newline must not push the count to eight and cap it.
    const stdout = `${Array.from({ length: 7 }, (_, i) => `row-${i}`).join('\n')}\n`;
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-nl',
        toolName: 'Bash',
        args: { command: 'seq 7' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-nl',
        isError: false,
        content: terminalResult(stdout),
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /row-0\b/);
    assert.match(expanded, /row-3\b/);
    assert.match(expanded, /row-6\b/);
    assert.doesNotMatch(expanded, /lines hidden/);
  });

  test('counts real tail lines past a trailing newline when capping', () => {
    const state = createMakaPiTranscriptState();
    // Ten real lines plus a trailing newline: the tail must be the last three
    // real lines (not two plus a blank), and the hidden count must be four.
    const stdout = `${Array.from({ length: 10 }, (_, i) => `row-${i}`).join('\n')}\n`;
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-nl2',
        toolName: 'Bash',
        args: { command: 'seq 10' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-nl2',
        isError: false,
        content: terminalResult(stdout),
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /row-7\b/);
    assert.match(expanded, /row-9\b/);
    assert.doesNotMatch(expanded, /row-5\b/);
    assert.match(expanded, /⋯ 4 lines hidden ⋯/);
  });

  test('shows a long diff in full when expanded — diffs are the head/tail exception', () => {
    const state = createMakaPiTranscriptState();
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1 +20 @@',
      ...Array.from({ length: 20 }, (_, i) => `+line-${i}`),
    ].join('\n');

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'edit-2',
        toolName: 'Edit',
        args: { path: 'file.ts' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'edit-2',
        isError: false,
        content: { kind: 'file_diff', paths: ['file.ts'], diff },
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    // Every added line is present and no lines are hidden.
    assert.match(expanded, /\+line-0\b/);
    assert.match(expanded, /\+line-10\b/);
    assert.match(expanded, /\+line-19\b/);
    assert.doesNotMatch(expanded, /lines hidden/);
  });

  test('renders file_write results as a byte summary', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'write-1',
        toolName: 'Write',
        args: { path: 'out.txt' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'write-1',
        isError: false,
        content: { kind: 'file_write', path: 'out.txt', bytes: 42 },
      }),
    );

    const lines = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(lines.length, 2);
    // The path is already the card's input summary; the result adds only size.
    assert.match(lines.join('\n'), /● Write  out\.txt \(42 bytes\)/);
    assert.doesNotMatch(lines.join('\n'), /Wrote 42 bytes to/);
    assert.doesNotMatch(lines.join('\n'), /\(Ctrl\+O\)/);
  });

  test('expands and collapses every tool card with one global toggle', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-a',
        toolName: 'Bash',
        args: { command: 'echo a' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-a',
        isError: false,
        // The body is the first stdout line, so the compact tail summary hides it
        // while expansion reveals it.
        content: terminalResult('alpha-body-line\ntail-a'),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-b',
        toolName: 'Bash',
        args: { command: 'echo b' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-b',
        isError: false,
        content: terminalResult('beta-body-line\ntail-b'),
      }),
    );

    const compact = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(compact, /alpha-body-line/);
    assert.doesNotMatch(compact, /beta-body-line/);

    // One press expands every tool card.
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /alpha-body-line/);
    assert.match(expanded, /beta-body-line/);

    // A second press collapses every tool card again.
    assert.equal(toggleAllToolExpansion(state), true);
    const collapsed = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(collapsed, /alpha-body-line/);
    assert.doesNotMatch(collapsed, /beta-body-line/);
  });

  test('expands and collapses every thinking entry with one global toggle', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'thinking_delta',
        messageId: 'message-1',
        text: 'first thought body',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: 'first reply',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'thinking_delta',
        messageId: 'message-2',
        text: 'second thought body',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-2',
        text: 'second reply',
      }),
    );

    const collapsed = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(collapsed.filter((line) => line.includes('Thinking…')).length, 2);
    assert.equal(
      collapsed.some((line) => line.includes('thought body')),
      false,
    );

    // One press expands every thinking entry.
    assert.equal(toggleAllThinkingExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /first thought body/);
    assert.match(expanded, /second thought body/);

    // A second press collapses every thinking entry again.
    assert.equal(toggleAllThinkingExpansion(state), true);
    const recollapsed = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(recollapsed.filter((line) => line.includes('Thinking…')).length, 2);
    assert.equal(
      recollapsed.some((line) => line.includes('thought body')),
      false,
    );
  });

  test('global toggles report false when the transcript has no matching entries', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'hello');
    assert.equal(toggleAllToolExpansion(state), false);
    assert.equal(toggleAllThinkingExpansion(state), false);
    assert.equal(state.expandAllTools, false);
    assert.equal(state.expandAllThinking, false);
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

  test('drops the oldest live output when the chunk count reaches its limit', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-many-chunks',
        toolName: 'Bash',
        args: { command: 'verbose' },
      }),
    );
    for (let i = 0; i < 513; i += 1) {
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_output_delta',
          toolUseId: 'bash-many-chunks',
          seq: i,
          stream: i % 2 === 0 ? 'stdout' : 'stderr',
          chunk: `chunk-${i}\n`,
          redacted: false,
        }),
      );
    }

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(expanded, /chunk-0\b/);
    assert.match(expanded, /chunk-512\b/);
  });

  test('ignores empty output without displacing retained output', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'output-empty',
        toolName: 'Bash',
        args: { command: 'verbose' },
      }),
    );
    for (let i = 0; i < 512; i += 1) {
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_output_delta',
          toolUseId: 'output-empty',
          seq: i,
          stream: i % 2 === 0 ? 'stdout' : 'stderr',
          chunk: `chunk-${i}\n`,
          redacted: false,
        }),
      );
    }
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_output_delta',
        toolUseId: 'output-empty',
        seq: 512,
        stream: 'stdout',
        chunk: '',
        redacted: false,
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /chunk-0\b/);
    assert.match(expanded, /chunk-511\b/);
  });

  test('retains the newest progress when progress text exceeds its buffer limit', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'progress-bounded',
        toolName: 'Workflow',
        args: {},
      }),
    );
    const chunks = Array.from(
      { length: 9 },
      (_, i) => `progress-${i}-start\n${'x\n'.repeat(4_090)}progress-${i}-end\n`,
    );
    for (const chunk of chunks) {
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_progress',
          toolUseId: 'progress-bounded',
          chunk,
        }),
      );
    }

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(expanded, /progress-0-start\b/);
    assert.match(expanded, /progress-8-end\b/);
    const droppedChars = chunks.reduce((total, chunk) => total + chunk.length, 0) - 64 * 1024;
    assert.match(expanded, new RegExp(`${droppedChars} earlier progress chars truncated`));
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

  test('ignores empty progress without displacing retained progress', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'progress-empty',
        toolName: 'Workflow',
        args: {},
      }),
    );
    for (let i = 0; i < 512; i += 1) {
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_progress',
          toolUseId: 'progress-empty',
          chunk: `progress-${i}\n`,
        }),
      );
    }
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_progress',
        toolUseId: 'progress-empty',
        chunk: '',
      }),
    );

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /progress-0\b/);
    assert.match(expanded, /progress-511\b/);
  });
});

describe('transcript entry render memoization', () => {
  test('reuses the rendered lines of an unchanged entry across renders', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: 'stable answer',
      }),
    );
    applyMakaSessionEventToTranscript(state, event({ type: 'complete', stopReason: 'end_turn' }));

    const first = renderMakaPiTranscript(state, meta(), 80);
    const second = renderMakaPiTranscript(state, meta(), 80);
    assert.deepEqual(second, first);

    // A width change must bust the cache and re-wrap.
    const narrow = renderMakaPiTranscript(state, meta(), 20);
    assert.notDeepEqual(narrow, first);
  });

  test('re-renders a tool entry when Ctrl+O expansion is toggled', () => {
    const state = createMakaPiTranscriptState();
    // A Grep (not a filesystem Read, which now renders only a summary) so
    // expansion genuinely changes the rendered block and its body is shown.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Grep',
        args: { pattern: 'beta' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: 'alpha\nbeta\ngamma' },
      }),
    );

    const collapsed = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.notEqual(expanded, collapsed);
    assert.match(expanded, /beta/);
  });

  test('re-renders live progress after the bounded buffer reaches a stable length', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'progress-cache',
        toolName: 'Workflow',
        args: {},
      }),
    );
    for (let i = 0; i < 512; i += 1) {
      applyMakaSessionEventToTranscript(
        state,
        event({
          type: 'tool_progress',
          toolUseId: 'progress-cache',
          chunk: `progress-${i}\n`,
        }),
      );
    }
    assert.equal(toggleAllToolExpansion(state), true);
    const before = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(before, /progress-511\b/);

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_progress',
        toolUseId: 'progress-cache',
        chunk: 'progress-512\n',
      }),
    );
    const after = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(after, /progress-512\b/);
    assert.doesNotMatch(after, /progress-0\b/);
  });

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

describe('Maka Pi TUI status line', () => {
  test('shows thinking:high when thinkingLevel is set', () => {
    const line = stripAnsi(
      renderMakaPiStatusLine(
        {
          ...meta(),
          thinkingLevel: 'high',
          thinkingLevels: ['off', 'low', 'medium', 'high', 'max'],
        },
        100,
      ),
    );
    assert.match(line, /thinking:high/);
  });

  test('omits thinking:default when thinkingLevel is unset but levels are available (#1064)', () => {
    const line = stripAnsi(
      renderMakaPiStatusLine(
        {
          ...meta(),
          thinkingLevels: ['off', 'low', 'medium', 'high', 'max'],
        },
        100,
      ),
    );
    assert.doesNotMatch(line, /thinking/);
  });

  test('omits thinking segment when no levels are available', () => {
    const line = stripAnsi(
      renderMakaPiStatusLine(
        {
          ...meta(),
        },
        100,
      ),
    );
    assert.doesNotMatch(line, /thinking/);
  });

  test('omits thinking segment when thinkingLevels is empty', () => {
    const line = stripAnsi(
      renderMakaPiStatusLine(
        {
          ...meta(),
          thinkingLevels: [],
        },
        100,
      ),
    );
    assert.doesNotMatch(line, /thinking/);
  });

  test('shows ctx used/window pct% when modelContextWindow and contextRemaining are both set', () => {
    const line = stripAnsi(
      renderMakaPiStatusLine(
        {
          ...meta(),
          modelContextWindow: 128_000,
          usage: { costUsd: 0, cacheHitInput: 0, cacheMissInput: 0, contextRemaining: 96_000 },
        },
        100,
      ),
    );
    assert.match(line, /ctx 32k\/128k 25%/);
  });

  test('omits ctx segment when modelContextWindow is set but no contextRemaining (#1064)', () => {
    // token_usage.input is a billing-cumulative sum across tool-loop steps,
    // not the last request's context size, so it cannot serve as a proxy
    // for "used context". The ctx segment is omitted rather than misleading.
    const line = stripAnsi(
      renderMakaPiStatusLine(
        {
          ...meta(),
          modelContextWindow: 128_000,
          usage: { costUsd: 0, cacheHitInput: 0, cacheMissInput: 0 },
        },
        100,
      ),
    );
    assert.doesNotMatch(line, /ctx /);
  });

  test('ctx segment uses yellow when usage >80% (#1064)', () => {
    const raw = renderMakaPiStatusLine(
      {
        ...meta(),
        modelContextWindow: 128_000,
        usage: { costUsd: 0, cacheHitInput: 0, cacheMissInput: 0, contextRemaining: 12_800 },
      },
      100,
    );
    // 115200/128000 = 90% → yellow (\x1b[33m)
    assert.ok(raw.includes('\x1b[33m'), 'ctx segment should use yellow at >80%');
  });

  test('ctx segment uses red when usage >95% (#1064)', () => {
    const raw = renderMakaPiStatusLine(
      {
        ...meta(),
        modelContextWindow: 128_000,
        usage: { costUsd: 0, cacheHitInput: 0, cacheMissInput: 0, contextRemaining: 3_200 },
      },
      100,
    );
    // 124800/128000 = 97.5% → red (\x1b[31m)
    assert.ok(raw.includes('\x1b[31m'), 'ctx segment should use red at >95%');
  });

  test('ctx segment uses dim when usage <=80% (#1064)', () => {
    const raw = renderMakaPiStatusLine(
      {
        ...meta(),
        modelContextWindow: 128_000,
        usage: { costUsd: 0, cacheHitInput: 0, cacheMissInput: 0, contextRemaining: 96_000 },
      },
      100,
    );
    // 25% → dim (\x1b[2m), not yellow or red
    assert.ok(raw.includes('\x1b[2m'), 'ctx segment should use dim at <=80%');
    assert.ok(!raw.includes('\x1b[33m'), 'ctx segment should not use yellow at <=80%');
    assert.ok(!raw.includes('\x1b[31m'), 'ctx segment should not use red at <=80%');
  });

  test('shortens cwd to ~-relative path when under home (#1064)', () => {
    const home = process.env.HOME ?? '';
    if (home) {
      const line = stripAnsi(
        renderMakaPiStatusLine(
          {
            ...meta(),
            cwd: `${home}/workspace/project`,
          },
          120,
        ),
      );
      assert.match(line, /~\/workspace\/project/);
    }
  });

  test('leaves cwd unchanged when not under home (#1064)', () => {
    const line = stripAnsi(
      renderMakaPiStatusLine(
        {
          ...meta(),
          cwd: '/tmp/project',
        },
        120,
      ),
    );
    assert.match(line, /\/tmp\/project/);
  });

  test('omits ctx segment when contextRemaining is set but no modelContextWindow', () => {
    const line = stripAnsi(
      renderMakaPiStatusLine(
        {
          ...meta(),
          usage: { costUsd: 0, cacheHitInput: 0, cacheMissInput: 0, contextRemaining: 96_000 },
        },
        100,
      ),
    );
    assert.doesNotMatch(line, /ctx /);
  });
});

describe('Maka Pi TUI activity strip', () => {
  test('shows transient provider retry progress and clears it on model output', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, {
      type: 'provider_retry',
      id: 'retry-1',
      turnId: 'turn-1',
      ts: 1,
      phase: 'scheduled',
      attempt: 3,
      maxAttempts: 10,
      delayMs: 4_000,
      reason: 'rate_limit',
    });

    assert.equal(
      stripAnsi(
        renderMakaPiActivityStrip(
          { ...meta(), turnElapsedMs: 5_500, providerRetry: state.providerRetry },
          100,
        ),
      ),
      'Retrying in 4s (3/10)',
    );

    applyMakaSessionEventToTranscript(state, {
      type: 'text_delta',
      id: 'text-1',
      turnId: 'turn-1',
      ts: 2,
      messageId: 'message-1',
      text: 'recovered',
    });
    assert.equal(state.providerRetry, undefined);
  });

  test('shows Working… Ns when turnElapsedMs is set', () => {
    const line = stripAnsi(
      renderMakaPiActivityStrip(
        {
          ...meta(),
          turnElapsedMs: 5_500,
        },
        100,
      ),
    );
    assert.equal(line, 'Working… 5s');
  });

  test('shows blank row when turnElapsedMs is undefined', () => {
    const line = renderMakaPiActivityStrip(meta(), 100);
    assert.equal(line, '');
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

class RecordingDriver {
  compactCalls = 0;

  constructor(private readonly events: SessionEvent[]) {}

  async *compactSession(): AsyncIterable<SessionEvent> {
    this.compactCalls += 1;
    for (const event of this.events) yield event;
  }
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
