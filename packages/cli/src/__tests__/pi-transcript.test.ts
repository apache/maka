/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { PipeShellOutput, PtyShellOutput } from '@maka/core/shell-run';
import type { ShellRunToolResult } from '@maka/core/shell-run-result';
import type { SessionEvent, ShellRunSnapshotResult, ToolResultContent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import {
  appendUserCommandToTranscript,
  appendUserPrompt,
  applyExpansionDefaultToAll,
  applyShellRunViewUpdateToTranscript,
  applyMakaSessionEventToTranscript,
  applyShellRunUpdateToTranscript,
  createMakaPiTranscriptState,
  hasExpandedEntriesAboveViewport,
  renderMakaPiActivityStrip,
  renderMakaPiPendingQueue,
  renderMakaPiStatusLine,
  renderMakaPiTranscript,
  refreshRunningShellRunElapsed,
  hydrateToolsWithStoredMessages,
  makaPiToolPresentationStatus,
  retireCancelledTransientMessages,
  replaceTranscriptWithStoredMessages,
  shortenCwd,
  submitCompactToTranscript,
  toggleAllThinkingExpansion,
  toggleAllToolExpansion,
  type MakaPiToolEntry,
} from '../pi-transcript.js';

function toolStatus(entry: MakaPiToolEntry | undefined): string | undefined {
  return entry ? makaPiToolPresentationStatus(entry) : undefined;
}

describe('Maka Pi TUI transcript', () => {
  test('renders manual compaction from the typed terminal outcome', async () => {
    for (const [outcome, expected] of [
      [{ kind: 'compacted' as const, checkpointId: 'checkpoint-1' }, 'Context compacted.'],
      [{ kind: 'unchanged' as const, reason: 'already_compacted' }, 'Nothing to compact.'],
      [
        { kind: 'failed' as const, reason: 'write_failed' },
        'Context compaction failed: write_failed.',
      ],
    ] as const) {
      const state = createMakaPiTranscriptState();
      await submitCompactToTranscript({
        state,
        driver: {
          compactSession: async function* () {
            yield {
              type: 'complete' as const,
              id: 'complete-1',
              turnId: 'compact-1',
              ts: 1,
              stopReason: 'end_turn' as const,
              contextCompactionOutcome: outcome,
            };
          },
        },
      });
      const notice = state.entries.at(-1);
      assert.equal(notice?.kind, 'notice');
      assert.equal(notice?.kind === 'notice' ? notice.text : '', expected);
    }
  });

  test('renders stored legacy Automation prompts as read-only provenance', () => {
    const state = createMakaPiTranscriptState();
    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 1,
        text: 'automated prompt',
        origin: { kind: 'legacy_automation', automationId: 'automation-1' },
      },
    ]);

    assert.deepEqual(state.entries, [{ kind: 'legacy_automation', text: 'automated prompt' }]);
    assert.match(
      renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n'),
      /Legacy Automation \(history only\).*automated prompt/s,
    );
  });

  test('renders fresh-session guidance in the resolved locale', () => {
    const state = createMakaPiTranscriptState();

    const englishLines = renderMakaPiTranscript(state, { ...meta(), uiLocale: 'en' }, 100).map(
      stripAnsi,
    );
    assert.deepEqual(englishLines.slice(0, 5), [
      '                  _',
      '  _ __ ___   __ _| | ____ _',
      " | '_ ` _ \\ / _` | |/ / _` |",
      ' | | | | | | (_| |   < (_| |',
      ' |_| |_| |_|\\__,_|_|\\_\\__,_|',
    ]);
    const english = englishLines.join('\n');
    assert.match(english, /Get things done together/);
    assert.match(english, /Type a message to start/);
    assert.match(english, /\/session\s+Switch or resume a session/);

    const chinese = renderMakaPiTranscript(state, { ...meta(), uiLocale: 'zh' }, 100)
      .map(stripAnsi)
      .join('\n');
    assert.match(chinese, /陪你把事做完/);
    assert.match(chinese, /输入消息开始对话/);
    assert.match(chinese, /\/session\s+切换或恢复会话/);
  });

  test('keeps every pending-queue preview on exactly one terminal row (#3824)', () => {
    const state = createMakaPiTranscriptState();
    // limitText appends its truncation suffix behind a newline once the 200-char
    // cap trips; an embedded newline shifts every later row down while pi-tui
    // still counts one row written, corrupting the frame until the queue drains.
    state.steering = ['s'.repeat(250)];
    state.followup = ['f'.repeat(250)];

    const lines = renderMakaPiPendingQueue(state, 400, process.platform, 'en');
    for (const line of lines) {
      assert.doesNotMatch(line, /[\r\n]/, `pending-queue row must be a single row: ${line}`);
    }
    // The truncation notice still reaches the user, just on the same row.
    assert.match(stripAnsi(lines[0] ?? ''), /50 chars truncated/);
  });

  test('renders the pending-queue edit shortcut for the current platform', () => {
    const state = createMakaPiTranscriptState();
    state.steering = ['Keep going'];
    const renderFor = (platform: NodeJS.Platform) =>
      renderMakaPiPendingQueue(state, 80, platform, 'en').map(stripAnsi);

    assert.equal(renderFor('darwin').at(-1), '⌥+↑ take queued messages back to re-edit');
    assert.equal(renderFor('linux').at(-1), 'Alt+↑ take queued messages back to re-edit');
    assert.equal(
      renderMakaPiPendingQueue(state, 80, 'linux', 'zh').map(stripAnsi).at(-1),
      'Alt+↑ 取回队列以重新编辑',
    );
  });

  test('renders goal-origin prompts as autonomous provenance, not as user prompts', () => {
    const state = createMakaPiTranscriptState();
    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'user',
        id: 'message-1',
        turnId: 'turn-1',
        ts: 1,
        text: '[Goal continuation] The goal is not yet met.',
        origin: { kind: 'goal', goalId: 'goal-1' },
      },
    ]);

    assert.deepEqual(state.entries, [
      { kind: 'goal_continuation', text: '[Goal continuation] The goal is not yet met.' },
    ]);
    assert.match(
      renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n'),
      /Goal continuation \(autonomous\).*Goal continuation\] The goal is not yet met/s,
    );
  });

  test('status line shows a live goal and hides terminal or absent goals', () => {
    const base = {
      goalId: 'goal-1',
      revision: 1,
      sessionId: 'session-1',
      condition: 'Ship it',
      setAt: Date.now() - 60_000,
      iterations: 3,
      maxIterations: 50,
      consecutiveNoProgress: 0,
      blockCap: 8,
      tokenBudget: null,
      tokensSpent: 0,
      lastReason: null,
      achievedAt: null,
      pausedAt: null,
    } as const;
    const active = stripAnsi(
      renderMakaPiStatusLine({ ...meta(), goal: { ...base, status: 'active' as const } }, 120),
    );
    assert.match(active, /goal 3\/50 1m/);

    const paused = stripAnsi(
      renderMakaPiStatusLine(
        { ...meta(), goal: { ...base, status: 'paused' as const, pausedAt: Date.now() - 30_000 } },
        120,
      ),
    );
    assert.match(paused, /goal paused 3\/50/);

    const achieved = stripAnsi(
      renderMakaPiStatusLine({ ...meta(), goal: { ...base, status: 'achieved' as const } }, 120),
    );
    assert.doesNotMatch(achieved, /goal/);
    assert.doesNotMatch(stripAnsi(renderMakaPiStatusLine({ ...meta(), goal: null }, 120)), /goal/);
  });

  test('renders side conversation status in English for every UI locale', () => {
    assert.equal(
      stripAnsi(
        renderMakaPiStatusLine(
          { ...meta(), uiLocale: 'zh', sideConversation: { view: 'side' } },
          200,
        ),
      ),
      'Side from main thread · Ctrl+/ to switch · Ctrl+C to close',
    );
    for (const [parentStatus, label] of [
      ['needs_input', 'main needs input'],
      ['needs_approval', 'main needs approval'],
      ['failed', 'main failed'],
      ['interrupted', 'main interrupted'],
      ['closed', 'main closed'],
      ['finished', 'main finished'],
    ] as const) {
      assert.equal(
        stripAnsi(
          renderMakaPiStatusLine(
            {
              ...meta(),
              uiLocale: 'zh',
              sideConversation: { view: 'side', parentStatus },
            },
            200,
          ),
        ),
        `Side from main thread · ${label} · Ctrl+/ to switch · Ctrl+C to close`,
      );
    }
    assert.match(
      stripAnsi(
        renderMakaPiStatusLine(
          { ...meta(), uiLocale: 'zh', sideConversation: { view: 'parent' } },
          200,
        ),
      ),
      /Ctrl\+\/ for side/,
    );
  });

  test('status line degrades to ctx ?/window when the window is known but usage is not (#3371)', () => {
    // No usage object at all: the window is known, so degrade explicitly.
    assert.match(
      stripAnsi(renderMakaPiStatusLine({ ...meta(), modelContextWindow: 500_000 }, 120)),
      /ctx \?\/500k/,
    );

    // Usage exists but contextRemaining has not been reported yet.
    assert.match(
      stripAnsi(
        renderMakaPiStatusLine(
          {
            ...meta(),
            modelContextWindow: 500_000,
            usage: { costUsd: 0, cacheHitInput: 0, cacheMissInput: 0 },
          },
          120,
        ),
      ),
      /ctx \?\/500k/,
    );

    // Window unknown: the segment stays hidden, even with usage present.
    assert.doesNotMatch(
      stripAnsi(
        renderMakaPiStatusLine(
          { ...meta(), usage: { costUsd: 0.01, cacheHitInput: 0, cacheMissInput: 0 } },
          120,
        ),
      ),
      /ctx/,
    );

    // contextRemaining present: the measured segment is unchanged.
    assert.match(
      stripAnsi(
        renderMakaPiStatusLine(
          {
            ...meta(),
            modelContextWindow: 500_000,
            usage: { costUsd: 0, cacheHitInput: 0, cacheMissInput: 0, contextRemaining: 480_000 },
          },
          120,
        ),
      ),
      /ctx 20k\/500k 4%/,
    );
  });

  test('status line drops whole low-value segments on overflow, lowest rank first (#3421)', () => {
    const richMeta = {
      ...meta(),
      modelContextWindow: 500_000,
      usage: {
        costUsd: 0.42,
        cacheHitInput: 60,
        cacheMissInput: 40,
        contextRemaining: 480_000,
      },
    };
    // Wide: everything renders.
    const wide = stripAnsi(renderMakaPiStatusLine(richMeta, 120));
    assert.match(wide, /ctx 20k\/500k 4%/);
    assert.match(wide, /\$0\.42/);
    assert.match(wide, /cache 60%/);
    assert.match(wide, /deepseek · \/tmp\/project/);

    // Below full width, cache drops before cost, and no segment is cut
    // mid-token while any lower rank still survives.
    const fullWidth = visibleWidth(wide);
    const noCache = stripAnsi(renderMakaPiStatusLine(richMeta, fullWidth - 1));
    assert.doesNotMatch(noCache, /cache/);
    assert.match(noCache, /\$0\.42/);
    const noCost = stripAnsi(
      renderMakaPiStatusLine(richMeta, fullWidth - 'cache 60% · '.length - 1),
    );
    assert.doesNotMatch(noCost, /cache|\$0\.42/);
    assert.match(noCost, /deepseek · \/tmp\/project/);
  });

  test('status line shortens cwd to its basename before dropping it (#3421)', () => {
    const line = stripAnsi(
      renderMakaPiStatusLine(
        {
          ...meta(),
          cwd: '/very/long/nested/project-directory',
          modelContextWindow: 500_000,
          usage: {
            costUsd: 0,
            cacheHitInput: 1,
            cacheMissInput: 1,
            contextRemaining: 480_000,
          },
        },
        // Room for title, mode, model, ctx and a short tail only.
        'Maka · Auto · deepseek-v4-flash · ctx 20k/500k 4% · project-directory'.length,
      ),
    );
    assert.doesNotMatch(line, /very\/long/);
    assert.match(line, /project-directory/);
  });

  test('status line drops a drive-root cwd instead of rendering an empty basename (#3421)', () => {
    const line = stripAnsi(
      renderMakaPiStatusLine(
        {
          ...meta(),
          cwd: 'C:\\',
          modelContextWindow: 500_000,
          usage: {
            costUsd: 0.5,
            cacheHitInput: 1,
            cacheMissInput: 1,
            contextRemaining: 480_000,
          },
        },
        40,
      ),
    );
    // C:\ has no useful basename; the segment drops cleanly rather than
    // leaving an empty segment dangling after the separator.
    assert.doesNotMatch(line, /C:\\/);
    assert.doesNotMatch(line, /·\s*$/);
  });

  test('status line never drops mode, model, goal, or ctx at narrow widths (#3421)', () => {
    const line = stripAnsi(
      renderMakaPiStatusLine(
        {
          ...meta(),
          permissionMode: 'bypass',
          modelContextWindow: 500_000,
          usage: {
            costUsd: 9.99,
            cacheHitInput: 1,
            cacheMissInput: 1,
            contextRemaining: 480_000,
          },
          goal: {
            goalId: 'goal-1',
            revision: 1,
            sessionId: 'session-1',
            condition: 'Ship it',
            setAt: Date.now() - 60_000,
            iterations: 1,
            maxIterations: 50,
            consecutiveNoProgress: 0,
            blockCap: 8,
            tokenBudget: null,
            tokensSpent: 0,
            lastReason: null,
            achievedAt: null,
            pausedAt: null,
            status: 'active' as const,
          },
        },
        75,
      ),
    );
    assert.match(line, /Full access/);
    assert.match(line, /deepseek-v4-flash/);
    assert.match(line, /goal 1\/50/);
    assert.match(line, /ctx 20k\/500k 4%/);
    assert.doesNotMatch(line, /\$9\.99|cache|deepseek ·|tmp\/project/);
  });

  test('status line compacts every critical segment before the narrow-width fallback (#3421)', () => {
    const metadata = {
      ...meta(),
      permissionMode: 'bypass',
      model: 'anthropic/claude-opus-4-1-very-long',
      modelContextWindow: 500_000,
      usage: {
        costUsd: 9.99,
        cacheHitInput: 1,
        cacheMissInput: 1,
        contextRemaining: 20_000,
      },
      goal: {
        goalId: 'goal-1',
        revision: 1,
        sessionId: 'session-1',
        condition: 'Ship it',
        setAt: Date.now() - 60_000,
        iterations: 1,
        maxIterations: 50,
        consecutiveNoProgress: 0,
        blockCap: 8,
        tokenBudget: null,
        tokensSpent: 0,
        lastReason: null,
        achievedAt: null,
        pausedAt: null,
        status: 'active' as const,
      },
    };

    for (const width of [40, 70, 80]) {
      const line = stripAnsi(renderMakaPiStatusLine(metadata, width));
      assert.ok(visibleWidth(line) <= width);
      assert.match(line, /Maka/);
      assert.match(line, /Full/);
      assert.match(line, /anthropic/);
      assert.match(line, /(?:goal |g)1\/50/);
      assert.match(line, /(?:ctx .*96%|c96%)/);
    }
  });

  test('keeps assistant text after a tool call visible after the tool block', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'inspect the package', 'message-1', true);

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

  test('preserves a transient user row across a sparse transcript replacement', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'send now', 'message-1', true);

    replaceTranscriptWithStoredMessages(state, [], { preserveClientLocalEntries: true });

    assert.deepEqual(state.entries, [
      { kind: 'user', messageId: 'message-1', text: 'send now', transient: true },
    ]);
  });

  test('removes only transient rows with durable cancellation proof', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'accepted', 'message-accepted', true);
    appendUserPrompt(state, 'handed off', 'message-handed-off', true);
    appendUserPrompt(state, 'cancelled', 'message-cancelled', true);

    retireCancelledTransientMessages(state, ['message-cancelled']);

    assert.deepEqual(
      state.entries.map((entry) => ('messageId' in entry ? entry.messageId : undefined)),
      ['message-accepted', 'message-handed-off'],
    );
  });

  test('keeps a transient user row before later durable output in a sparse replacement', () => {
    const state = createMakaPiTranscriptState();
    replaceTranscriptWithStoredMessages(state, [
      { type: 'user', id: 'old-user', turnId: 'old-turn', ts: 1, text: 'before' },
    ]);
    appendUserPrompt(state, 'send now', 'message-1', true);
    state.entries.push({ kind: 'assistant', messageId: 'later-assistant', text: 'after' });

    replaceTranscriptWithStoredMessages(
      state,
      [
        { type: 'user', id: 'old-user', turnId: 'old-turn', ts: 1, text: 'before' },
        {
          type: 'assistant',
          id: 'later-assistant',
          turnId: 'turn-1',
          ts: 3,
          text: 'after',
          modelId: 'model-1',
        },
      ],
      { preserveClientLocalEntries: true },
    );

    assert.deepEqual(
      state.entries.map((entry) =>
        entry.kind === 'user' || entry.kind === 'assistant' ? entry.messageId : entry.kind,
      ),
      ['old-user', 'message-1', 'later-assistant'],
    );
  });

  test('keeps an unanchored transient user row after existing durable history', () => {
    const state = createMakaPiTranscriptState();
    replaceTranscriptWithStoredMessages(state, [
      { type: 'user', id: 'old-user', turnId: 'old-turn', ts: 1, text: 'before' },
      {
        type: 'assistant',
        id: 'old-assistant',
        turnId: 'old-turn',
        ts: 2,
        text: 'answer',
        modelId: 'model-1',
      },
    ]);
    appendUserPrompt(state, 'send now', 'message-1', true);

    replaceTranscriptWithStoredMessages(
      state,
      [
        { type: 'user', id: 'old-user', turnId: 'old-turn', ts: 1, text: 'before' },
        {
          type: 'assistant',
          id: 'old-assistant',
          turnId: 'old-turn',
          ts: 2,
          text: 'answer',
          modelId: 'model-1',
        },
      ],
      { preserveClientLocalEntries: true },
    );

    assert.deepEqual(
      state.entries.map((entry) =>
        entry.kind === 'user' || entry.kind === 'assistant' ? entry.messageId : entry.kind,
      ),
      ['old-user', 'old-assistant', 'message-1'],
    );
  });

  test('keeps a leading transient row before an entirely new durable replacement', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'current prompt', 'message-current', true);
    state.entries.push({ kind: 'assistant', messageId: 'old-assistant', text: 'old live output' });

    replaceTranscriptWithStoredMessages(
      state,
      [
        { type: 'user', id: 'next-user', turnId: 'next-turn', ts: 3, text: 'next prompt' },
        {
          type: 'assistant',
          id: 'next-assistant',
          turnId: 'next-turn',
          ts: 4,
          text: 'next answer',
          modelId: 'model-1',
        },
      ],
      { preserveClientLocalEntries: true },
    );

    assert.deepEqual(
      state.entries.map((entry) =>
        entry.kind === 'user' || entry.kind === 'assistant' ? entry.messageId : entry.kind,
      ),
      ['message-current', 'next-user', 'next-assistant'],
    );
  });

  test('reconciles a transient user row by messageId when durable history arrives', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'send now', 'message-1', true);

    replaceTranscriptWithStoredMessages(
      state,
      [{ type: 'user', id: 'message-1', turnId: 'turn-1', ts: 1, text: 'send now' }],
      { preserveClientLocalEntries: true },
    );

    assert.deepEqual(state.entries, [{ kind: 'user', messageId: 'message-1', text: 'send now' }]);
  });

  test('keeps a projected in-flight steering echo transient until durable reconciliation', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'send now', 'message-1', true);

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'steering_message',
        messageId: 'message-1',
        content: { text: 'send now' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'message_admission',
        messageId: 'message-1',
        outcome: 'retracted',
      }),
    );

    assert.deepEqual(state.entries, []);
  });

  test('removes only the transient row named by a retracted admission', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'keep this', 'message-kept', true);
    appendUserPrompt(state, 'take this back', 'message-retracted', true);

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'message_admission',
        messageId: 'message-retracted',
        outcome: 'retracted',
      }),
    );

    assert.deepEqual(state.entries, [
      { kind: 'user', messageId: 'message-kept', text: 'keep this', transient: true },
    ]);
  });

  test('updates a projected steering echo in its transient message position', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'send now', 'message-1', true);
    state.entries.push({ kind: 'notice', level: 'error', text: 'later row' });

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'steering_message',
        messageId: 'message-1',
        content: { text: 'canonical text' },
      }),
    );

    assert.deepEqual(state.entries, [
      { kind: 'user', messageId: 'message-1', text: 'canonical text', transient: true },
      { kind: 'notice', level: 'error', text: 'later row' },
    ]);
  });

  test('uses a shared message gutter and trims trailing block rows', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: 'I will run it.\n\n',
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'true' },
      }),
    );

    const lines = renderMakaPiTranscript(state, meta(), 40).map(stripAnsi);
    assert.equal(lines[0], '');
    assert.equal(lines[2], '');
    assert.match(lines[1] ?? '', /^ I will run it\.\s+$/);
    assert.match(lines[3] ?? '', /^ ● Bash  \$ true \(running\)$/);
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

  test('hydrates durable tool details without resetting live turn state', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'tool_start', toolUseId: 'tool-1', toolName: 'Read', args: {} }),
    );
    state.entries.push({ kind: 'notice', level: 'error', text: 'Turn failed: provider_error' });
    state.steering = ['Keep going'];

    assert.equal(
      hydrateToolsWithStoredMessages(state, 'turn-1', [
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
    assert.equal(state.entries.at(-1)?.kind, 'notice');
  });

  test('keeps a hydrated background Bash live when its omitted settlement arrives', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-bg',
        toolName: 'Bash',
        args: { command: 'npm test' },
      }),
    );
    hydrateToolsWithStoredMessages(
      state,
      'turn-1',
      storedBash('bash-bg', shellRun({ status: 'running', revision: 1 })),
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-bg',
        isError: false,
        contentOmitted: true,
        content: { kind: 'text', text: '' },
        durationMs: 777,
      }),
    );

    const bash = state.entries.find(
      (entry) => entry.kind === 'tool' && entry.toolUseId === 'bash-bg',
    );
    assert.equal(bash?.kind === 'tool' ? makaPiToolPresentationStatus(bash) : undefined, 'running');
    assert.equal(bash?.kind === 'tool' ? bash.durationMs : undefined, 0);
    assert.equal(refreshRunningShellRunElapsed(state, 2_000), true);
  });

  test('does not replace a newer live ShellRun revision with an older durable snapshot', () => {
    const state = createMakaPiTranscriptState();
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
        content: shellRun({
          status: 'completed',
          revision: 5,
          updatedAt: 5_000,
          completedAt: 5_000,
          stdout: 'complete\n',
        }),
      }),
    );

    hydrateToolsWithStoredMessages(
      state,
      'turn-1',
      storedBash('bash-bg', shellRun({ status: 'running', revision: 1 })),
    );

    const bash = state.entries.find(
      (entry) => entry.kind === 'tool' && entry.toolUseId === 'bash-bg',
    );
    assert.equal(
      bash?.kind === 'tool' && bash.result?.kind === 'shell_run' ? bash.result.revision : undefined,
      5,
    );
    assert.equal(
      bash?.kind === 'tool' && bash.result?.kind === 'shell_run' ? bash.result.status : undefined,
      'completed',
    );
  });

  test('does not materialize an omitted placeholder as a tool result', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'late-result',
        isError: false,
        contentOmitted: true,
        content: { kind: 'text', text: '' },
      }),
    );

    const tool = state.entries.find(
      (entry) => entry.kind === 'tool' && entry.toolUseId === 'late-result',
    );
    assert.equal(tool?.kind === 'tool' ? tool.result : undefined, undefined);
    assert.equal(tool?.kind === 'tool' ? makaPiToolPresentationStatus(tool) : undefined, 'done');
  });

  test('does not reopen a settled call from a resultless durable snapshot', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'tool_start', toolUseId: 'read-1', toolName: 'Read', args: {} }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-1',
        isError: false,
        content: { kind: 'text', text: 'complete' },
      }),
    );

    hydrateToolsWithStoredMessages(state, 'turn-1', [
      {
        type: 'tool_call',
        id: 'read-1',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Read',
        args: { path: 'README.md' },
      },
      {
        type: 'turn_state',
        id: 'running-state',
        turnId: 'turn-1',
        ts: 2,
        status: 'running',
        partialOutputRetained: true,
      },
    ]);

    const tool = state.entries.find(
      (entry) => entry.kind === 'tool' && entry.toolUseId === 'read-1',
    );
    assert.equal(tool?.kind === 'tool' ? makaPiToolPresentationStatus(tool) : undefined, 'done');
  });

  test('does not replace a newer live result or terminal outcome with durable history', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'tool_start', toolUseId: 'read-1', toolName: 'Read', args: {} }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-1',
        isError: true,
        content: { kind: 'text', text: '' },
      }),
    );

    hydrateToolsWithStoredMessages(state, 'turn-1', [
      {
        type: 'tool_call',
        id: 'read-1',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Read',
        args: { path: 'README.md' },
      },
      {
        type: 'tool_result',
        id: 'old-result',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'read-1',
        isError: false,
        content: { kind: 'text', text: 'older durable output' },
      },
    ]);

    const tool = state.entries.find(
      (entry) => entry.kind === 'tool' && entry.toolUseId === 'read-1',
    );
    assert.deepEqual(tool?.kind === 'tool' ? tool.result : undefined, { kind: 'text', text: '' });
    assert.equal(tool?.kind === 'tool' ? tool.callStatus : undefined, 'errored');
  });

  test('keeps an in-flight background poll suppressed during durable hydration', () => {
    const { state, messages } = inFlightBackgroundPollFixture();
    hydrateToolsWithStoredMessages(state, 'turn-1', messages);

    const poll = state.entries.find(
      (entry) => entry.kind === 'tool' && entry.toolUseId === 'read-bg',
    );
    assert.equal(poll?.kind === 'tool' ? poll.suppressed : undefined, true);
    assert.equal(poll?.kind === 'tool' ? makaPiToolPresentationStatus(poll) : undefined, 'running');
  });

  test('drops a hydrated in-flight background poll on abort', () => {
    const { state, messages } = inFlightBackgroundPollFixture();
    hydrateToolsWithStoredMessages(state, 'turn-1', messages);

    applyMakaSessionEventToTranscript(state, event({ type: 'abort', reason: 'user_stop' }));

    assert.equal(
      state.entries.some((entry) => entry.kind === 'tool' && entry.toolUseId === 'read-bg'),
      false,
    );
  });

  test('drops a resultless background poll when the turn completes', () => {
    const { state, messages } = inFlightBackgroundPollFixture();
    hydrateToolsWithStoredMessages(state, 'turn-1', [
      ...messages.filter((message) => message.type !== 'turn_state'),
      {
        type: 'turn_state',
        id: 'turn-state-complete',
        turnId: 'turn-1',
        ts: 5,
        status: 'completed',
        partialOutputRetained: true,
      },
    ]);

    applyMakaSessionEventToTranscript(state, event({ type: 'complete', stopReason: 'end_turn' }));

    assert.equal(
      state.entries.some((entry) => entry.kind === 'tool' && entry.toolUseId === 'read-bg'),
      false,
    );
  });

  test('lets the live result own failed-poll tail placement after durable hydration', () => {
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
      event({ type: 'tool_start', toolUseId: 'read-bg', toolName: 'Read', args: { ref } }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'text_delta', messageId: 'assistant-late', text: 'Still working' }),
    );

    const before = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    const assistant = state.entries.find(
      (entry) => entry.kind === 'assistant' && entry.messageId === 'assistant-late',
    );
    assert.ok(assistant);
    const viewportTop = state.renderGeometry.entryFirstLine?.get(assistant);
    assert.ok(viewportTop !== undefined && viewportTop > 0);
    state.renderGeometry.viewportTop = viewportTop;

    hydrateToolsWithStoredMessages(state, 'turn-1', [
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
        content: shellRun({ ref, status: 'running' }),
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
        isError: true,
        content: { kind: 'text', text: 'background task no longer exists' },
      },
    ]);

    const hydratedPoll = state.entries.find(
      (entry) => entry.kind === 'tool' && entry.toolUseId === 'read-bg',
    );
    assert.equal(hydratedPoll?.kind === 'tool' ? hydratedPoll.suppressed : undefined, true);
    assert.deepEqual(
      renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).slice(0, viewportTop),
      before.slice(0, viewportTop),
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: true,
        content: { kind: 'text', text: '' },
        contentOmitted: true,
      }),
    );

    const tail = state.entries.at(-1);
    assert.equal(tail?.kind, 'tool');
    assert.equal(tail?.kind === 'tool' ? tail.toolUseId : undefined, 'read-bg');
    assert.deepEqual(tail?.kind === 'tool' ? tail.result : undefined, {
      kind: 'text',
      text: 'background task no longer exists',
    });
  });

  test('keeps a successful poll correlated until its live result folds it', () => {
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
        content: shellRun({ ref, status: 'running', revision: 1 }),
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'tool_start', toolUseId: 'read-bg', toolName: 'Read', args: { ref } }),
    );

    hydrateToolsWithStoredMessages(state, 'turn-1', [
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
        content: shellRun({ ref, status: 'running', revision: 1 }),
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
        content: shellRun({ ref, status: 'running', revision: 2 }),
      },
    ]);

    assert.equal(
      state.entries.some((entry) => entry.kind === 'tool' && entry.toolUseId === 'read-bg'),
      true,
    );

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', revision: 2 }),
      }),
    );

    assert.equal(
      state.entries.some((entry) => entry.kind === 'tool' && entry.toolUseId === 'read-bg'),
      false,
    );
    const parent = state.entries.find(
      (entry) => entry.kind === 'tool' && entry.toolUseId === 'bash-bg',
    );
    assert.equal(
      parent?.kind === 'tool' && parent.result?.kind === 'shell_run'
        ? parent.result.revision
        : undefined,
      2,
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
      { kind: 'user', messageId: 'steering-display', text: 'Show the result' },
      { kind: 'user', messageId: 'steering-plain', text: 'Also include the tests' },
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
    assert.equal(toolStatus(tools[0]), 'done');
    assert.equal(
      tools[0]?.result?.kind === 'shell_run' && tools[0].result.output?.mode === 'pipes'
        ? tools[0].result.output.stdout
        : '',
      'starting\ndone\n',
    );
  });

  test('explains a stored tool call whose turn ended without a result', () => {
    const state = createMakaPiTranscriptState();
    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'tool_call',
        id: 'tool-1',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'Read',
        args: { path: '/tmp/example.txt' },
      },
      {
        type: 'turn_state',
        id: 'turn-state-1',
        turnId: 'turn-1',
        ts: 2,
        status: 'completed',
        partialOutputRetained: false,
      },
    ] satisfies StoredMessage[]);

    assert.equal(toggleAllToolExpansion(state), true);
    assert.match(
      renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n'),
      /Interrupted before the tool returned a result\./,
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
    assert.equal(toolStatus(tools[1]), 'error');
    // The parent keeps its own revision, output, and status — the failed poll
    // changes nothing.
    assert.equal(toolStatus(tools[0]), 'running');
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

  test('a collapse with mixed card positions names the stranded cards and offers the second press (#4011)', () => {
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

    // Expand both while everything is in view, then let the viewport scroll so
    // the early card's head sits in scrollback and only the late card remains
    // reachable.
    assert.equal(toggleAllToolExpansion(state), true);
    renderMakaPiTranscript(state, meta(), 100);
    const early = state.entries.find(
      (entry): entry is Extract<typeof entry, { kind: 'tool' }> =>
        entry.kind === 'tool' && entry.toolUseId === 'tool-early',
    );
    const late = state.entries.find(
      (entry): entry is Extract<typeof entry, { kind: 'tool' }> =>
        entry.kind === 'tool' && entry.toolUseId === 'tool-late',
    );
    assert.ok(early && late);
    const viewportTop = state.renderGeometry.entryFirstLine?.get(late);
    assert.ok(viewportTop !== undefined && viewportTop > 0);
    state.renderGeometry.viewportTop = viewportTop;

    // The collapse reaches the late card but strands the early one, and the
    // notice says so instead of staying silent (#4011).
    assert.equal(toggleAllToolExpansion(state), true);
    assert.equal(state.expandAllTools, false);
    assert.equal(early.expanded, true);
    assert.equal(late.expanded, false);
    const notice = state.entries[state.entries.length - 1];
    assert.equal(notice.kind, 'notice');
    const text = notice.kind === 'notice' ? notice.text : '';
    assert.match(text, /1 tool card above the view stayed expanded/);
    assert.match(text, /press Ctrl\+O again within 2s/);
    assert.match(text, /starts collapsed/);
    assert.equal(hasExpandedEntriesAboveViewport(state, 'tool'), true);
  });

  test('the confirmed second press collapses the stranded card without flipping the default (#4011)', () => {
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
    renderMakaPiTranscript(state, meta(), 100);
    const entry = state.entries.find(
      (candidate): candidate is Extract<typeof candidate, { kind: 'tool' }> =>
        candidate.kind === 'tool',
    );
    assert.ok(entry);
    const firstLine = state.renderGeometry.entryFirstLine?.get(entry);
    assert.ok(firstLine !== undefined);
    state.renderGeometry.viewportTop = firstLine + 5;

    // First press: viewport-scoped collapse strands the card; the state is
    // confirmable (the runner owns the confirm window itself).
    assert.equal(toggleAllToolExpansion(state), true);
    assert.equal(state.expandAllTools, false);
    assert.equal(entry.expanded, true);
    assert.equal(hasExpandedEntriesAboveViewport(state, 'tool'), true);

    // Confirmed second press: every candidate takes the collapsed default and
    // the default itself does not move (a plain toggle would flip it back).
    assert.equal(applyExpansionDefaultToAll(state, 'tool'), true);
    assert.equal(state.expandAllTools, false);
    assert.equal(entry.expanded, false);
    assert.equal(hasExpandedEntriesAboveViewport(state, 'tool'), false);
    // Idempotent once everything already matches the default.
    assert.equal(applyExpansionDefaultToAll(state, 'tool'), false);
  });

  test('an expand toggle with collapsed cards above the viewport stays silent about them (#4011)', () => {
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
        content: terminalResult(`early-head\nearly-row`),
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
        content: terminalResult(`late-head\nlate-row`),
      }),
    );

    renderMakaPiTranscript(state, meta(), 100);
    const late = state.entries.find(
      (entry): entry is Extract<typeof entry, { kind: 'tool' }> =>
        entry.kind === 'tool' && entry.toolUseId === 'tool-late',
    );
    assert.ok(late);
    const viewportTop = state.renderGeometry.entryFirstLine?.get(late);
    assert.ok(viewportTop !== undefined && viewportTop > 0);
    state.renderGeometry.viewportTop = viewportTop;

    // Expanding the in-view card leaves the collapsed card above untouched —
    // compact in scrollback, harmless — and offers no redraw for it.
    assert.equal(toggleAllToolExpansion(state), true);
    assert.equal(late.expanded, true);
    assert.equal(
      state.entries.some(
        (entry) => entry.kind === 'notice' && entry.text.includes('again within 2s'),
      ),
      false,
    );
    // And nothing expanded sits above the viewport, so no confirm can arm.
    assert.equal(hasExpandedEntriesAboveViewport(state, 'tool'), false);
  });

  test('hasExpandedEntriesAboveViewport is false while entry positions are unknown (#4011)', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        args: { command: 'build' },
      }),
    );
    const entry = state.entries.find(
      (candidate): candidate is Extract<typeof candidate, { kind: 'tool' }> =>
        candidate.kind === 'tool',
    );
    assert.ok(entry);
    entry.expanded = true;
    // Wholesale-replacement window: no positions recorded, viewport scrolled.
    state.renderGeometry.entryFirstLine = undefined;
    state.renderGeometry.viewportTop = 10;
    assert.equal(hasExpandedEntriesAboveViewport(state, 'tool'), false);
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
    assert.equal(tools[1]?.durationMs, undefined);
    refreshRunningShellRunElapsed(state, 3_000);
    assert.equal(tools[1]?.durationMs, undefined);

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
    assert.ok(visibleLines.some((line) => line.includes('y/Enter allow for this task')));
    assert.ok(visibleLines.some((line) => line.includes('n/Esc deny')));
    assert.ok(visibleLines.every((line) => !line.includes(' a ')));
  });

  test('queues sandbox boundary, question, and form requests in arrival order', () => {
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
        type: 'form_request',
        requestId: 'form-1',
        toolUseId: 'tool-3',
        message: 'Configure deployment',
        requester: { name: 'deploy', source: 'Acme MCP' },
        fields: [{ kind: 'boolean', name: 'notify', label: 'Notify', required: false }],
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
      ['form-1', 'question-1'],
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
    assert.equal(state.pendingInteraction?.requestId, 'form-1');
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'form_answer_ack',
        requestId: 'form-1',
        toolUseId: 'tool-3',
      }),
    );
    assert.equal(state.pendingInteraction?.requestId, 'question-1');
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'user_question_answer_ack',
        requestId: 'question-1',
        toolUseId: 'tool-2',
      }),
    );
    assert.equal(state.pendingInteraction, undefined);
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
      tools.map((tool) => [tool.toolUseId, makaPiToolPresentationStatus(tool)]),
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
    assert.equal(toolStatus(tools[0]), 'aborted');
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
    assert.equal(tool?.kind === 'tool' ? makaPiToolPresentationStatus(tool) : undefined, 'running');
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

    // The poll is in flight, but no Read row ever appears.
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

  test('folds an omitted Runtime Host poll result using its live correlation', () => {
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
        args: undefined,
        shellRunRef: ref,
      }),
    );

    const poll = state.entries.find(
      (entry) => entry.kind === 'tool' && entry.toolUseId === 'read-bg',
    );
    assert.equal(poll?.kind === 'tool' ? poll.suppressed : undefined, true);

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: false,
        content: { kind: 'text', text: '' },
        contentOmitted: true,
      }),
    );

    assert.equal(
      state.entries.some((entry) => entry.kind === 'tool' && entry.toolUseId === 'read-bg'),
      false,
    );
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
    assert.equal(toolStatus(tools[1]), 'error');
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
    assert.equal(toolStatus(tools[1]), 'error');
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
    assert.equal(toolStatus(poll), 'error');
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /● Read/);
    // The error disc carries the failure state; free-text error content stays
    // out of the compact row under #1086.
    assert.match(rendered, /\(1 line · 32 bytes\)/);
    assert.doesNotMatch(rendered, /background task no longer exists/);
  });

  test('surfaces a failed poll at the tail without rewriting scrollback', () => {
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
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'text_delta',
        messageId: 'assistant-late',
        text: 'Still working\nwith more output',
      }),
    );

    const before = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    const assistant = state.entries.find(
      (entry) => entry.kind === 'assistant' && entry.messageId === 'assistant-late',
    );
    assert.ok(assistant);
    const viewportTop = state.renderGeometry.entryFirstLine?.get(assistant);
    assert.ok(viewportTop !== undefined && viewportTop > 0);
    state.renderGeometry.viewportTop = viewportTop;

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: true,
        content: { kind: 'text', text: 'background task no longer exists' },
      }),
    );

    const after = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.deepEqual(after.slice(0, viewportTop), before.slice(0, viewportTop));
    assert.match(after.slice(viewportTop).join('\n'), /● Read/);
  });

  test('removes a successful off-screen poll without changing scrollback', () => {
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
      event({ type: 'text_delta', messageId: 'assistant-middle', text: 'Still working' }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'tool_start', toolUseId: 'read-bg', toolName: 'Read', args: { ref } }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'text_delta', messageId: 'assistant-late', text: 'More output' }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'tool_start', toolUseId: 'read-file', toolName: 'Read', args: {} }),
    );

    const before = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    const visibleTail = state.entries.find(
      (entry) => entry.kind === 'tool' && entry.toolUseId === 'read-file',
    );
    assert.ok(visibleTail);
    const viewportTop = state.renderGeometry.entryFirstLine?.get(visibleTail);
    assert.ok(viewportTop !== undefined && viewportTop > 0);
    state.renderGeometry.viewportTop = viewportTop;

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'read-bg',
        isError: false,
        content: shellRun({ ref, status: 'running', revision: 2 }),
      }),
    );

    const after = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(
      state.entries.some((entry) => entry.kind === 'tool' && entry.toolUseId === 'read-bg'),
      false,
    );
    assert.deepEqual(after.slice(0, viewportTop), before.slice(0, viewportTop));
  });

  test('gives a suppressed poll zero transcript footprint', () => {
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
      event({ type: 'text_delta', messageId: 'assistant-middle', text: 'Still working' }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'tool_start', toolUseId: 'read-bg', toolName: 'Read', args: { ref } }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'tool_start', toolUseId: 'read-file', toolName: 'Read', args: {} }),
    );

    const before = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    state.entries = state.entries.filter(
      (entry) => entry.kind !== 'tool' || entry.toolUseId !== 'read-bg',
    );
    const after = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);

    assert.deepEqual(after, before);
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
    const inFlight = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(inFlight, /● StopBackgroundTask/);

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
    assert.equal(toolStatus(tools[0]), 'aborted');
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
    assert.equal(toolStatus(tools[1]), 'running');
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
    assert.equal(toolStatus(tools[0]), 'done');
    assert.equal(
      state.entries.some((entry) => entry.kind === 'notice'),
      false,
    );
  });

  test('updates a local user command card from its Runtime Resource', () => {
    const state = createMakaPiTranscriptState();
    const ref = 'maka://runtime/background-tasks/user-command-1';
    appendUserCommandToTranscript(state, {
      commandId: 'user-command-1',
      command: 'pwd',
      result: shellRun({ ref, status: 'running', stdout: '' }) as ShellRunSnapshotResult,
    });

    const applied = applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'user-command-1',
      sourceToolCallId: 'user-command-1',
      result: shellRun({
        ref,
        status: 'completed',
        stdout: '/repo\n',
        completedAt: 2_000,
        exitCode: 0,
      }),
    });

    assert.equal(applied, true);
    const tool = state.entries.find((entry) => entry.kind === 'tool');
    assert.equal(tool?.toolName, 'User command');
    assert.equal(tool?.callStatus, 'completed');
    assert.equal(tool?.expanded, true);
    const shellResult = tool?.result;
    assert.equal(
      shellResult?.kind === 'shell_run' && shellResult.mode === 'pipes'
        ? shellResult.output?.stdout
        : '',
      '/repo\n',
    );
    assert.equal(
      state.entries.some((entry) => entry.kind === 'notice'),
      false,
    );
  });

  test('keeps user commands expanded and outside Ctrl+O model-tool toggles', () => {
    const state = createMakaPiTranscriptState();
    appendUserCommandToTranscript(state, {
      commandId: 'user-command-1',
      command: 'printf done',
      result: shellRun({
        ref: 'maka://runtime/background-tasks/user-command-1',
        status: 'completed',
        stdout: 'done\n',
        completedAt: 2_000,
        exitCode: 0,
      }) as ShellRunSnapshotResult,
    });
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'model-tool-1',
        toolName: 'Bash',
        args: { command: 'printf model' },
      }),
    );
    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    const userCommand = tools.find((entry) => entry.userOwned === true);
    const modelTool = tools.find((entry) => entry.userOwned !== true);
    assert.ok(userCommand && modelTool);
    assert.equal(userCommand.expanded, true);
    assert.equal(modelTool.expanded, false);

    assert.equal(toggleAllToolExpansion(state), true);
    assert.equal(userCommand.expanded, true);
    assert.equal(modelTool.expanded, true);
    assert.equal(toggleAllToolExpansion(state), true);
    assert.equal(userCommand.expanded, true);
    assert.equal(modelTool.expanded, false);
  });

  test('preserves local user-command cards only for same-session reconnect replacement', () => {
    const state = createMakaPiTranscriptState();
    appendUserCommandToTranscript(state, {
      commandId: 'user-command-1',
      command: 'sleep 60',
      result: shellRun({
        ref: 'maka://runtime/background-tasks/user-command-1',
        status: 'running',
        stdout: '',
      }) as ShellRunSnapshotResult,
    });

    replaceTranscriptWithStoredMessages(state, [], { preserveClientLocalEntries: true });
    assert.equal(
      state.entries.some((entry) => entry.kind === 'tool' && entry.userOwned === true),
      true,
    );

    replaceTranscriptWithStoredMessages(state, []);
    assert.equal(
      state.entries.some((entry) => entry.kind === 'tool' && entry.userOwned === true),
      false,
    );
  });

  test('reconnect re-inserts preserved user-command cards at their chronological position (#3210)', () => {
    const state = createMakaPiTranscriptState();
    // The command ran before the model turns that followed it.
    appendUserCommandToTranscript(state, {
      commandId: 'user-command-1',
      command: 'pwd',
      result: shellRun({
        ref: 'maka://runtime/background-tasks/user-command-1',
        status: 'completed',
        stdout: '/repo\n',
        startedAt: 1_000,
      }) as ShellRunSnapshotResult,
    });

    replaceTranscriptWithStoredMessages(
      state,
      [
        { type: 'user', id: 'message-1', turnId: 'turn-1', ts: 2_000, text: 'later prompt' },
        {
          type: 'assistant',
          id: 'message-2',
          turnId: 'turn-1',
          ts: 3_000,
          text: 'later answer',
          modelId: 'model-1',
        },
      ],
      { preserveClientLocalEntries: true },
    );

    const cardIndex = state.entries.findIndex(
      (entry) => entry.kind === 'tool' && entry.userOwned === true,
    );
    const promptIndex = state.entries.findIndex((entry) =>
      JSON.stringify(entry).includes('later prompt'),
    );
    const answerIndex = state.entries.findIndex((entry) =>
      JSON.stringify(entry).includes('later answer'),
    );
    assert.notEqual(cardIndex, -1);
    assert.notEqual(promptIndex, -1);
    assert.notEqual(answerIndex, -1);
    assert.ok(cardIndex < promptIndex, 'card must stay ahead of the later turn');
    assert.ok(promptIndex < answerIndex);
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
    assert.equal(
      detached?.kind === 'tool' ? makaPiToolPresentationStatus(detached) : '',
      'detached',
    );
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

  test('does not pair stale ownership with a newer ShellRun revision', () => {
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
    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-1',
      ownership: { kind: 'local' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({ ref, status: 'running', revision: 5, updatedAt: 5 }),
    });
    applyShellRunViewUpdateToTranscript(state, {
      sessionId: 'session-branch',
      ownership: {
        kind: 'source_owned',
        sourceSessionId: 'session-1',
        ownerSessionId: 'session-1',
      },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-bg',
      result: shellRun({ ref, status: 'running', revision: 4, updatedAt: 4 }),
    });

    const bash = state.entries.find(
      (entry) => entry.kind === 'tool' && entry.toolUseId === 'bash-bg',
    );
    assert.equal(
      bash?.kind === 'tool' && bash.result?.kind === 'shell_run' ? bash.result.revision : undefined,
      5,
    );
    assert.equal(bash?.kind === 'tool' ? bash.shellRunSource : undefined, undefined);
    assert.equal(bash?.kind === 'tool' ? makaPiToolPresentationStatus(bash) : undefined, 'running');
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
    const beforeAbort = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(beforeAbort, /● Read/);

    applyMakaSessionEventToTranscript(state, event({ type: 'abort', reason: 'user_stop' }));

    const afterAbort = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(afterAbort, /● Read/);
    assert.equal(
      state.entries.some((entry) => entry.kind === 'tool' && entry.suppressed),
      false,
    );
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
    assert.equal(toolStatus(tools[0]), 'aborted');
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

  test('names a live quiet Bash row from the wire args preview', () => {
    const state = createMakaPiTranscriptState();
    // Runtime Host live tool_start omits full args; the bounded preview is all
    // the compact row has until the turn-end reconcile.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-preview',
        toolName: 'Bash',
        args: undefined,
        argsPreview: { command: 'git status --porcelain' },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-preview',
        isError: false,
        content: {
          kind: 'terminal',
          cwd: '/repo',
          cmd: 'git status --porcelain',
          status: 'completed',
          exitCode: 0,
          output: { mode: 'pipes', stdout: '', stderr: '' },
        },
      }),
    );

    const rendered = renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n');
    assert.match(rendered, /\$ git status --porcelain/);
    // Once the row names the call, the quiet-success disclaimer is noise.
    assert.doesNotMatch(rendered, /\(no output\)/);
  });

  test('keeps todo_write arguments quiet and shows only its settled snapshot', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'todo-write',
        toolName: 'todo_write',
        displayName: 'Todo Write',
        args: undefined,
        argsPreview: undefined,
      }),
    );

    const running = renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n');
    assert.match(running, /Todo Write/);
    assert.doesNotMatch(running, /uncommitted item/);

    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'todo-write',
        isError: false,
        content: {
          kind: 'text',
          text: 'Todo list updated.\n1. [in_progress] committed item',
        },
      }),
    );

    const settled = renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n');
    assert.match(settled, /Todo Write/);
    assert.match(settled, /2 lines/);
    assert.equal(toggleAllToolExpansion(state), true);
    assert.match(
      renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n'),
      /committed item/,
    );
  });

  test('never restores todo_write arguments from durable transcript reconciliation', () => {
    const messages = [
      {
        type: 'tool_call',
        id: 'todo-write',
        turnId: 'turn-1',
        ts: 1,
        toolName: 'todo_write',
        displayName: 'Todo Write',
        args: { todos: [{ content: 'uncommitted item', status: 'pending' }] },
      },
      {
        type: 'tool_result',
        id: 'todo-result',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'todo-write',
        isError: false,
        content: {
          kind: 'text',
          text: 'Todo list updated (1 items):\n1. [in_progress] "committed item"',
        },
      },
    ] satisfies StoredMessage[];

    for (const reconcile of [
      (state: ReturnType<typeof createMakaPiTranscriptState>) =>
        replaceTranscriptWithStoredMessages(state, messages),
      (state: ReturnType<typeof createMakaPiTranscriptState>) => {
        applyMakaSessionEventToTranscript(
          state,
          event({
            type: 'tool_start',
            toolUseId: 'todo-write',
            toolName: 'todo_write',
            displayName: 'Todo Write',
            args: undefined,
          }),
        );
        hydrateToolsWithStoredMessages(state, 'turn-1', messages);
      },
    ]) {
      const state = createMakaPiTranscriptState();
      reconcile(state);
      const tool = state.entries.find(
        (entry) => entry.kind === 'tool' && entry.toolUseId === 'todo-write',
      );
      assert.deepEqual(tool?.kind === 'tool' ? tool.input : undefined, {});
      assert.equal(toggleAllToolExpansion(state), true);
      const rendered = renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n');
      assert.match(rendered, /committed item/);
      assert.doesNotMatch(rendered, /uncommitted item/);
    }
  });

  test('prefers a redacted runtime intent for a live compact row', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'grep-intent',
        toolName: 'Grep',
        args: undefined,
        intent: '  inspect   render entry with sk-1234567890abcdef  ',
      }),
    );

    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(rendered, /inspect render entry with <redacted>/);
    assert.doesNotMatch(rendered, /sk-1234567890abcdef/);
  });

  test('never renders a secret Bash command from the durable shell_run result', () => {
    const state = createMakaPiTranscriptState();
    const secret = 'super-secret-token-value';
    const command = `# preserve the multiline result-side path\ncurl -H \"Authorization: Bearer ${secret}\" https://example.com`;
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_start',
        toolUseId: 'bash-durable-redaction',
        toolName: 'Bash',
        args: { command },
      }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-durable-redaction',
        isError: false,
        content: shellRun({
          cmd: command,
          status: 'completed',
          completedAt: 2_000,
          exitCode: 0,
        }),
      }),
    );
    assert.equal(toggleAllToolExpansion(state), true);

    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(rendered, new RegExp(secret));
    assert.match(rendered, /redacted/i);
  });

  test('keeps the no-output placeholder when the row cannot name the call', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({ type: 'tool_start', toolUseId: 'bash-blind', toolName: 'Bash', args: undefined }),
    );
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'tool_result',
        toolUseId: 'bash-blind',
        isError: false,
        content: {
          kind: 'terminal',
          cwd: '/repo',
          cmd: 'true',
          status: 'completed',
          exitCode: 0,
          output: { mode: 'pipes', stdout: '', stderr: '' },
        },
      }),
    );

    const rendered = renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n');
    assert.match(rendered, /\(no output\)/);
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

  test('provider retry activity strip counts down in the client clock domain', (t) => {
    // #3393: a subscription quota window can hand the runtime an hours-long
    // Retry-After. The strip stamps the client-local receipt time when the
    // event lands and ticks down from it, so the display never mixes the
    // (possibly remote) Runtime Host clock with the client clock.
    const start = 1_700_000_000_000;
    t.mock.timers.enable({ apis: ['Date'], now: start });
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'provider_retry',
        phase: 'scheduled',
        attempt: 2,
        maxAttempts: 10,
        delayMs: 16_083_000,
        reason: 'rate_limit',
      }),
    );
    // Receipt is stamped on the client clock at application time.
    assert.equal(state.providerRetry?.receivedAtMs, start);

    const strip = () =>
      stripAnsi(renderMakaPiActivityStrip({ ...meta(), providerRetry: state.providerRetry }, 120));

    // Hours-long waits render as a humanized duration, not a raw second count.
    assert.match(strip(), /Retrying in 4h 28m 3s \(2\/10\)/);

    // Elapsed time ticks the countdown down; zero-value units are omitted.
    t.mock.timers.setTime(start + 63_000);
    assert.match(strip(), /Retrying in 4h 27m \(2\/10\)/);

    // An elapsed wait floors at 1s until `started` replaces the banner.
    t.mock.timers.setTime(start + 17_000_000);
    assert.match(strip(), /Retrying in 1s \(2\/10\)/);
  });

  test('provider retry strip counts down from the host-authoritative remainingMs', (t) => {
    // A host re-projection mid-wait (reconnect) sends the recomputed
    // remainingMs duration; the strip counts THAT down from receipt instead
    // of restarting at the full delay.
    const start = 1_700_000_000_000;
    t.mock.timers.enable({ apis: ['Date'], now: start });
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'provider_retry',
        phase: 'scheduled',
        attempt: 2,
        maxAttempts: 10,
        delayMs: 16_083_000,
        remainingMs: 61_000,
        reason: 'rate_limit',
      }),
    );
    assert.match(
      stripAnsi(renderMakaPiActivityStrip({ ...meta(), providerRetry: state.providerRetry }, 120)),
      /Retrying in 1m 1s \(2\/10\)/,
    );

    // The started phase carries no countdown at all.
    applyMakaSessionEventToTranscript(
      state,
      event({
        type: 'provider_retry',
        phase: 'started',
        attempt: 2,
        maxAttempts: 10,
        reason: 'rate_limit',
      }),
    );
    assert.match(
      stripAnsi(renderMakaPiActivityStrip({ ...meta(), providerRetry: state.providerRetry }, 120)),
      /^Retrying \(2\/10\)$/,
    );
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

function storedBash(toolUseId: string, content: ShellRunToolResult): StoredMessage[] {
  return [
    {
      type: 'tool_call',
      id: toolUseId,
      turnId: 'turn-1',
      ts: 1,
      toolName: 'Bash',
      args: { command: 'npm test' },
    },
    {
      type: 'tool_result',
      id: `${toolUseId}-result`,
      turnId: 'turn-1',
      ts: 2,
      toolUseId,
      isError: false,
      content,
    },
  ];
}

function inFlightBackgroundPollFixture(): {
  state: ReturnType<typeof createMakaPiTranscriptState>;
  messages: StoredMessage[];
} {
  const state = createMakaPiTranscriptState();
  const ref = 'maka://runtime/background-tasks/bg-1';
  applyMakaSessionEventToTranscript(
    state,
    event({ type: 'tool_start', toolUseId: 'bash-bg', toolName: 'Bash', args: {} }),
  );
  applyMakaSessionEventToTranscript(
    state,
    event({
      type: 'tool_result',
      toolUseId: 'bash-bg',
      isError: false,
      content: shellRun({ ref }),
    }),
  );
  applyMakaSessionEventToTranscript(
    state,
    event({ type: 'tool_start', toolUseId: 'read-bg', toolName: 'Read', args: { ref } }),
  );
  return {
    state,
    messages: [
      {
        type: 'turn_state',
        id: 'turn-state-1',
        turnId: 'turn-1',
        ts: 1,
        status: 'running',
        partialOutputRetained: true,
      },
      { type: 'tool_call', id: 'bash-bg', turnId: 'turn-1', ts: 2, toolName: 'Bash', args: {} },
      {
        type: 'tool_result',
        id: 'bash-bg-result',
        turnId: 'turn-1',
        ts: 3,
        toolUseId: 'bash-bg',
        isError: false,
        content: shellRun({ ref }),
      },
      {
        type: 'tool_call',
        id: 'read-bg',
        turnId: 'turn-1',
        ts: 4,
        toolName: 'Read',
        args: { ref },
      },
    ],
  };
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

describe('shortenCwd', () => {
  test('shortens POSIX paths under the home directory', {
    skip: process.platform === 'win32',
  }, () => {
    assert.equal(shortenCwd('/Users/alice/work/project', '/Users/alice'), '~/work/project');
    assert.equal(shortenCwd('/Users/alice/..\\notes', '/Users/alice'), '~/..\\notes');
    assert.equal(shortenCwd('/Users/alice', '/Users/alice'), '~');
  });

  test('keeps POSIX paths outside the home directory absolute', {
    skip: process.platform === 'win32',
  }, () => {
    assert.equal(shortenCwd('/Users/alice-shared', '/Users/alice'), '/Users/alice-shared');
    assert.equal(shortenCwd('/Users', '/Users/alice'), '/Users');
    assert.equal(shortenCwd('/tmp/project', '/Users/alice'), '/tmp/project');
  });

  test('shortens Windows profile paths (#3825)', { skip: process.platform !== 'win32' }, () => {
    assert.equal(shortenCwd('C:\\Users\\alice\\Videos', 'C:\\Users\\alice'), '~/Videos');
    assert.equal(
      shortenCwd('C:\\Users\\alice\\Videos\\Clips', 'C:\\Users\\alice'),
      '~/Videos\\Clips',
    );
    assert.equal(shortenCwd('C:\\Users\\alice', 'C:\\Users\\alice'), '~');
  });

  test('shortens Windows profile paths with case-only differences (#3825)', {
    skip: process.platform !== 'win32',
  }, () => {
    assert.equal(shortenCwd('c:\\users\\alice\\videos', 'C:\\Users\\alice'), '~/videos');
  });

  test('keeps Windows paths outside the profile directory absolute (#3825)', {
    skip: process.platform !== 'win32',
  }, () => {
    assert.equal(
      shortenCwd('C:\\Users\\alice-shared', 'C:\\Users\\alice'),
      'C:\\Users\\alice-shared',
    );
    assert.equal(shortenCwd('D:\\data\\project', 'C:\\Users\\alice'), 'D:\\data\\project');
  });
});
