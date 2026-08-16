import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import {
  createSqliteAgentRunStore,
  createSqliteRuntimeStore,
  createSessionStore,
} from '@maka/storage';
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
        backend: 'fake',
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-v4-flash',
        permissionMode: 'ask',
      },
      messages,
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
