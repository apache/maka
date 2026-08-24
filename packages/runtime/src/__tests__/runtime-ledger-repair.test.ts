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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import {
  createSqliteAgentRunStore,
  createSqliteRuntimeStore,
  createSessionStore,
} from '@maka/storage';
import { createExternalSessionAdapterRegistry } from '@maka/storage/external-sessions';
import { buildRuntimeEventModelReplayPlan } from '../model-history.js';
import { buildPriorRuntimeContext } from '../prior-run-context.js';
import { backfillRuntimeEventsFromStoredMessages } from '../runtime-event-backfill.js';
import { RuntimeLedgerRepair } from '../runtime-ledger-repair.js';

test('repairs imported transcript turns into provider-neutral canonical history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-transcript-ledger-repair-'));
  const sessions = createSessionStore(root);
  const runs = createSqliteAgentRunStore(root);
  const runtimeEvents = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  let sequence = 0;
  const newId = () => `repair-${++sequence}`;

  try {
    const externalTs = Date.now() + 86_400_000;
    const messages: StoredMessage[] = [
      {
        type: 'user',
        id: 'z-user',
        turnId: 'turn-1',
        ts: externalTs,
        text: 'Fix the parser',
      },
      {
        type: 'assistant',
        id: 'a-assistant',
        turnId: 'turn-1',
        ts: externalTs,
        text: 'I found the issue.',
        thinking: { text: 'provider-specific reasoning' },
        modelId: 'external-model',
      },
      {
        type: 'tool_call',
        id: 'tool-1',
        turnId: 'turn-1',
        ts: externalTs,
        toolName: 'codex::exec',
        args: { command: 'pwd' },
      },
      {
        type: 'tool_result',
        id: 'result-1',
        turnId: 'turn-1',
        ts: externalTs,
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: '/repo' },
      },
      {
        type: 'turn_state',
        id: 'state-1',
        turnId: 'turn-1',
        ts: externalTs,
        status: 'completed',
        partialOutputRetained: true,
      },
    ];
    const session = await sessions.createImportedSession(
      {
        cwd: '/repo',
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-v4-flash',
        permissionMode: 'ask',
      },
      messages,
      { adapterId: 'test', sourceSessionId: 'source-session-1' },
    );
    assert.equal(session.transcriptLedgerVersion, 0);
    const repair = new RuntimeLedgerRepair({
      runStore: runs,
      runtimeEventStore: runtimeEvents,
      readMessages: (sessionId) => sessions.readMessages(sessionId),
      appendMessage: (sessionId, message) => sessions.appendMessage(sessionId, message),
      appendTurnState: async () => undefined,
      newId,
      now: () => 100,
    });

    await repair.materializeTranscriptLedger(session);
    await repair.materializeTranscriptLedger(session);

    const [importedRun] = await runs.listSessionRuns(session.id);
    assert.ok(importedRun);
    assert.equal(importedRun.turnId, 'turn-1');
    assert.equal(importedRun.status, 'completed');
    assert.ok(importedRun.createdAt < session.createdAt);

    const importedEvents = await runtimeEvents.readRuntimeEvents(session.id, importedRun.runId);
    assert.deepEqual(
      buildRuntimeEventModelReplayPlan(importedEvents).items.map((item) =>
        item.kind === 'text' ? [item.role, item.content] : item.kind,
      ),
      [
        ['user', 'Fix the parser'],
        ['assistant', 'I found the issue.'],
      ],
    );

    const continuedMessages: StoredMessage[] = [
      {
        type: 'user',
        id: 'continued-user',
        turnId: 'turn-2',
        ts: session.createdAt + 1,
        text: 'What should I do next?',
      },
      {
        type: 'assistant',
        id: 'continued-assistant',
        turnId: 'turn-2',
        ts: session.createdAt + 2,
        text: 'Add a regression test.',
        modelId: 'continued-model',
      },
      {
        type: 'turn_state',
        id: 'continued-state',
        turnId: 'turn-2',
        ts: session.createdAt + 3,
        status: 'completed',
        partialOutputRetained: true,
      },
    ];
    const continuedRun = await runs.createRun({
      ...importedRun,
      runId: 'continued-run',
      invocationId: 'continued-invocation',
      turnId: 'turn-2',
      status: 'completed',
      createdAt: session.createdAt + 1,
      updatedAt: session.createdAt + 3,
      completedAt: session.createdAt + 3,
    });
    for (const event of backfillRuntimeEventsFromStoredMessages({
      run: continuedRun,
      messages: continuedMessages,
      newId,
      now: () => session.createdAt + 3,
    }).events) {
      await runtimeEvents.appendRuntimeEvent(session.id, continuedRun.runId, event);
    }

    const currentRunId = 'current-run';
    await runs.createRun({
      ...continuedRun,
      runId: currentRunId,
      invocationId: 'current-invocation',
      turnId: 'turn-3',
      status: 'running',
      createdAt: session.createdAt + 4,
      updatedAt: session.createdAt + 4,
      completedAt: undefined,
    });
    const prior = await buildPriorRuntimeContext({
      sessionId: session.id,
      currentRunId,
      currentTurnId: 'turn-3',
      linkedChildSession: false,
      runStore: runs,
      runtimeEventStore: runtimeEvents,
      runStoreAvailable: true,
      runtimeEventStoreAvailable: true,
      readMessages: () => sessions.readMessages(session.id),
    });
    assert.deepEqual(
      buildRuntimeEventModelReplayPlan(prior?.events ?? []).items.map((item) =>
        item.kind === 'text' ? [item.role, item.content] : item.kind,
      ),
      [
        ['user', 'Fix the parser'],
        ['assistant', 'I found the issue.'],
        ['user', 'What should I do next?'],
        ['assistant', 'Add a regression test.'],
      ],
    );
  } finally {
    runtimeEvents.close();
    runs.close?.();
    await sessions.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The Claude Code adapter records a turn the transcript stops inside as
 * `aborted` with `abortSource: 'external_session_snapshot'`, rather than
 * emitting no terminal state at all.
 *
 * The difference is only visible here. An adapter-level assertion can show
 * which `turn_state` was emitted, but not what the Ledger does with it — and
 * what it does is the whole reason the choice matters: an uncorroborated
 * terminal is refused and the repair path writes `failed`, so a transcript
 * that was merely cut short would import as internal corruption.
 */
test('an imported snapshot cutoff survives materialization as aborted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-snapshot-cutoff-'));
  const sessions = createSessionStore(root);
  const runs = createSqliteAgentRunStore(root);
  const runtimeEvents = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  let sequence = 0;
  const newId = () => `cutoff-${++sequence}`;

  try {
    const ts = Date.now() + 86_400_000;
    const cutoffMessages: StoredMessage[] = [
      { type: 'user', id: 'c-user', turnId: 'turn-cut', ts, text: 'read the file' },
      {
        type: 'assistant',
        id: 'c-assistant',
        turnId: 'turn-cut',
        ts,
        text: 'Reading it now.',
        contentOrder: ['text'],
        modelId: 'claude-opus-5',
      },
      {
        type: 'tool_call',
        id: 'c-tool',
        turnId: 'turn-cut',
        ts,
        toolName: 'Read',
        args: { path: '/repo/a.ts' },
      },
      // No tool_result: the transcript ends between the call and its answer.
      {
        type: 'turn_state',
        id: 'c-state',
        turnId: 'turn-cut',
        ts,
        status: 'aborted',
        abortedAt: ts,
        abortSource: 'external_session_snapshot',
        partialOutputRetained: true,
      },
    ];
    const session = await sessions.createImportedSession(
      {
        cwd: '/repo',
        llmConnectionSlug: 'anthropic',
        model: 'claude-opus-5',
        permissionMode: 'ask',
      },
      cutoffMessages,
      { adapterId: 'claude-code', sourceSessionId: 'cut-1' },
    );
    const repair = new RuntimeLedgerRepair({
      runStore: runs,
      runtimeEventStore: runtimeEvents,
      readMessages: (sessionId) => sessions.readMessages(sessionId),
      appendMessage: (sessionId, message) => sessions.appendMessage(sessionId, message),
      appendTurnState: async () => undefined,
      newId,
      now: () => 100,
    });

    await repair.materializeTranscriptLedger(session);

    const [run] = await runs.listSessionRuns(session.id);
    assert.ok(run);
    // `cancelled`, not `failed`: the Ledger accepted the recorded abort. Before
    // the adapter emitted one, this same transcript materialized as
    // `failed / missing_terminal_event`.
    assert.equal(run.status, 'cancelled');
    assert.notEqual(run.failureClass, 'missing_terminal_event');
  } finally {
    await runtimeEvents.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('an imported turn with no terminal state is repaired to failed', async () => {
  // The behaviour the adapter now avoids, pinned so the reason for emitting a
  // cutoff cannot quietly stop being true.
  const root = await mkdtemp(join(tmpdir(), 'maka-missing-terminal-'));
  const sessions = createSessionStore(root);
  const runs = createSqliteAgentRunStore(root);
  const runtimeEvents = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  let sequence = 0;
  const newId = () => `missing-${++sequence}`;

  try {
    const ts = Date.now() + 86_400_000;
    const session = await sessions.createImportedSession(
      {
        cwd: '/repo',
        llmConnectionSlug: 'anthropic',
        model: 'claude-opus-5',
        permissionMode: 'ask',
      },
      [
        { type: 'user', id: 'm-user', turnId: 'turn-missing', ts, text: 'read the file' },
        {
          type: 'assistant',
          id: 'm-assistant',
          turnId: 'turn-missing',
          ts,
          text: 'Reading it now.',
          contentOrder: ['text'],
          modelId: 'claude-opus-5',
        },
      ],
      { adapterId: 'claude-code', sourceSessionId: 'missing-1' },
    );
    const repair = new RuntimeLedgerRepair({
      runStore: runs,
      runtimeEventStore: runtimeEvents,
      readMessages: (sessionId) => sessions.readMessages(sessionId),
      appendMessage: (sessionId, message) => sessions.appendMessage(sessionId, message),
      appendTurnState: async () => undefined,
      newId,
      now: () => 100,
    });

    await repair.materializeTranscriptLedger(session);

    const [run] = await runs.listSessionRuns(session.id);
    assert.ok(run);
    assert.equal(run.status, 'failed');
    assert.equal(run.failureClass, 'missing_terminal_event');
  } finally {
    await runtimeEvents.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('a resolved Claude transcript replays as the conversation the user kept', async () => {
  // The whole path, end to end: raw records → lineage resolution → conversion
  // → Ledger materialization → the replay a continuation would be given.
  //
  // The transcript holds every shape the resolver exists for, together, the
  // way a real one does: a rewound prompt whose branch was abandoned, a
  // response split across records with its visible text in the LAST fragment,
  // and two calls of one response separated by the first one's result.
  const root = await mkdtemp(join(tmpdir(), 'maka-claude-lineage-'));
  const sessions = createSessionStore(root);
  const runs = createSqliteAgentRunStore(root);
  const runtimeEvents = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  let sequence = 0;
  const newId = () => `lineage-${++sequence}`;
  const SOURCE_SESSION_ID = 'aaaaaaaa-0000-4000-8000-00000000e2e1';

  try {
    const stamp = (offset: number) => new Date(Date.now() + 86_400_000 + offset).toISOString();
    const records: Record<string, unknown>[] = [
      { type: 'system', uuid: 'p0', parentUuid: null, timestamp: stamp(0), cwd: '/repo' },
      // The rewind, in the shape the corpus writes it: two prompts under one
      // parent. The first was typed, answered, and then withdrawn by the edit.
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: 'p0',
        timestamp: stamp(500),
        cwd: '/repo',
        message: { role: 'user', content: 'summarise teh parser' },
      },
      {
        type: 'assistant',
        uuid: 'a_dead',
        parentUuid: 'u1',
        timestamp: stamp(1000),
        cwd: '/repo',
        message: {
          role: 'assistant',
          id: 'msg_dead',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'ANSWER TO THE TYPO PROMPT' }],
          stop_reason: 'end_turn',
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'p0',
        timestamp: stamp(2000),
        cwd: '/repo',
        message: { role: 'user', content: 'summarise the parser' },
      },
      // One response, three records. Thinking first, then a call, then — after
      // that call's result — the visible text and a second call.
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u2',
        timestamp: stamp(3000),
        cwd: '/repo',
        message: {
          role: 'assistant',
          id: 'msg_live',
          model: 'claude-opus-5',
          content: [{ type: 'thinking', thinking: 'Two files.' }],
          stop_reason: 'tool_use',
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'a1',
        timestamp: stamp(4000),
        cwd: '/repo',
        message: {
          role: 'assistant',
          id: 'msg_live',
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} }],
          stop_reason: 'tool_use',
        },
      },
      {
        type: 'user',
        uuid: 'r1',
        parentUuid: 'a2',
        timestamp: stamp(5000),
        cwd: '/repo',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'parser.ts' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a3',
        parentUuid: 'r1',
        timestamp: stamp(6000),
        cwd: '/repo',
        message: {
          role: 'assistant',
          id: 'msg_live',
          model: 'claude-opus-5',
          content: [
            { type: 'text', text: 'The parser is recursive descent.' },
            { type: 'tool_use', id: 'toolu_b', name: 'Read', input: {} },
          ],
          stop_reason: 'end_turn',
        },
      },
      {
        type: 'user',
        uuid: 'r2',
        parentUuid: 'a3',
        timestamp: stamp(7000),
        cwd: '/repo',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'lexer.ts' }],
        },
      },
    ];

    // Through the adapter registry, not a direct call to the converter: the
    // seam an import actually crosses is `readSession`, and a test that
    // skipped it would not notice the adapter refusing the transcript.
    const claudeHome = join(root, 'claude-home');
    await mkdir(join(claudeHome, 'projects', '-repo'), { recursive: true });
    await writeFile(
      join(claudeHome, 'projects', '-repo', `${SOURCE_SESSION_ID}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );
    const adapter = createExternalSessionAdapterRegistry({
      claudeCode: { claudeHome },
    }).require('claude-code');
    const messages = [...(await adapter.readSession(SOURCE_SESSION_ID)).messages];
    const session = await sessions.createImportedSession(
      {
        cwd: '/repo',
        llmConnectionSlug: 'anthropic',
        model: 'claude-opus-5',
        permissionMode: 'ask',
      },
      messages,
      { adapterId: 'claude-code', sourceSessionId: SOURCE_SESSION_ID },
    );
    const repair = new RuntimeLedgerRepair({
      runStore: runs,
      runtimeEventStore: runtimeEvents,
      readMessages: (sessionId) => sessions.readMessages(sessionId),
      appendMessage: (sessionId, message) => sessions.appendMessage(sessionId, message),
      appendTurnState: async () => undefined,
      newId,
      now: () => 100,
    });
    await repair.materializeTranscriptLedger(session);

    const [run] = await runs.listSessionRuns(session.id);
    assert.ok(run);
    const events = await runtimeEvents.readRuntimeEvents(session.id, run.runId);
    const replay = buildRuntimeEventModelReplayPlan(events).items;
    const text = replay
      .filter((item) => item.kind === 'text')
      .map((item) => (item as { role: string; content: string }).content);

    // No selected text is lost: the reply lives in the LAST fragment of its
    // response, which the previous converter suppressed for not being first.
    assert.ok(
      text.some((content) => content.includes('The parser is recursive descent.')),
      `reply missing from replay: ${JSON.stringify(text)}`,
    );
    // No abandoned branch is imported: the rewound prompt and its answer are
    // not context the continuation should be given.
    assert.equal(
      text.some((content) => content.includes('ANSWER TO THE TYPO PROMPT')),
      false,
    );
    assert.equal(
      text.some((content) => content.includes('summarise teh parser')),
      false,
    );
    assert.ok(text.some((content) => content.includes('summarise the parser')));

    // Every result is still paired with the correct call, and both calls of
    // one response precede both results — they came from one API response, so
    // neither was issued after the other's result came back.
    const calls = messages.filter((m) => m.type === 'tool_call');
    const results = messages.filter((m) => m.type === 'tool_result');
    assert.deepEqual(
      calls.map((m) => m.id),
      ['toolu_a', 'toolu_b'],
    );
    assert.deepEqual(
      results.map((m) => (m as Extract<StoredMessage, { type: 'tool_result' }>).toolUseId),
      ['toolu_a', 'toolu_b'],
    );
    const shape = messages
      .filter((m) => m.type === 'tool_call' || m.type === 'tool_result')
      .map((m) =>
        m.type === 'tool_call'
          ? `call:${m.id}`
          : `result:${(m as Extract<StoredMessage, { type: 'tool_result' }>).toolUseId}`,
      );
    assert.deepEqual(shape, ['call:toolu_a', 'call:toolu_b', 'result:toolu_a', 'result:toolu_b']);

    // And the turn is terminal on its own evidence, not repaired into one.
    assert.equal(run.status, 'completed');
    assert.notEqual(run.failureClass, 'missing_terminal_event');
  } finally {
    runtimeEvents.close();
    runs.close?.();
    await sessions.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
