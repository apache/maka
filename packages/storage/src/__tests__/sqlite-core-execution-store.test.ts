import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  AgentRunEvent,
  AgentRunHeader,
  InteractionCanonicalOutcome,
  InteractionRequest,
  ShellRunRecord,
} from '@maka/core';
import { createAgentRunStore, createSqliteAgentRunStore } from '../agent-run-store.js';
import {
  closeSqliteInteractionStoreFacade,
  interactionLocator,
  openInteractiveInteractionStoreForWrite,
  openSqliteInteractiveInteractionStoreForWrite,
  type StoredInteractionRequest,
} from '../interaction-store.js';
import {
  createMessageReceiptStore,
  createSqliteMessageReceiptStore,
} from '../message-receipt-store.js';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from '../operational-state-store.js';
import { createShellRunStore, createSqliteShellRunStore } from '../shell-run-store.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';

describe('SQLite core execution cutover', () => {
  test('imports AgentRun state once and never appends to legacy files', async () => {
    await withRoot(async (root) => {
      const legacy = createAgentRunStore(root);
      const header = runHeader();
      const firstEvent = runEvent('event-1', 1);
      await legacy.createRun(header);
      await legacy.appendEvent(header.sessionId, header.runId, firstEvent);
      await legacy.admitRootTurn({
        sessionId: header.sessionId,
        turnId: header.turnId,
        proposedRunId: header.runId,
        proposedUserMessageId: 'message-1',
        execution: { kind: 'external_message' },
        previousRootTurnId: null,
        normalizedInput: { text: 'hello' },
        sourceMessages: [],
        admittedAt: 1,
      });
      const legacyEventsPath = join(
        root,
        'sessions',
        header.sessionId,
        'runs',
        header.runId,
        'events.jsonl',
      );
      const legacyBytes = await readFile(legacyEventsPath);

      const sqlite = createSqliteAgentRunStore(root);
      await sqlite.ready?.();
      assert.deepEqual(await sqlite.readRun(header.sessionId, header.runId), header);
      assert.deepEqual(await sqlite.readEvents(header.sessionId, header.runId), [firstEvent]);
      assert.equal(
        (await sqlite.listRootTurnAdmissionsForRecovery(header.sessionId))[0]?.turnId,
        header.turnId,
      );
      await sqlite.appendEvent(header.sessionId, header.runId, runEvent('event-2', 2));
      assert.deepEqual(
        (await sqlite.readEvents(header.sessionId, header.runId)).map((event) => event.id),
        ['event-1', 'event-2'],
      );
      assert.deepEqual(await readFile(legacyEventsPath), legacyBytes);
      sqlite.close?.();

      const reopened = createSqliteAgentRunStore(root);
      await reopened.ready?.();
      assert.deepEqual(
        (await reopened.readEvents(header.sessionId, header.runId)).map((event) => event.id),
        ['event-1', 'event-2'],
      );
      reopened.close?.();
    });
  });

  test('rejects SQLite updates to immutable AgentRun admission identity', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      try {
        const original = {
          ...runHeader(),
          continuationSource: {
            sourceInvocationId: 'source-invocation',
            sourceRunId: 'source-run',
            sourceTurnId: 'source-turn',
            sourceRuntimeEventHighWater: 1,
          },
        } satisfies AgentRunHeader;
        await store.createRun(original);

        await assert.rejects(
          store.updateRun(original.sessionId, original.runId, { modelId: 'different-model' }),
          /admission identity is immutable: modelId/,
        );
        await assert.rejects(
          store.updateRun(original.sessionId, original.runId, { continuationSource: undefined }),
          /admission identity is immutable: continuationSource/,
        );
        assert.deepEqual(await store.readRun(original.sessionId, original.runId), original);
      } finally {
        store.close?.();
      }
    });
  });

  test('rolls back copied AgentRun rows and resumes a started cutover', async () => {
    await withRoot(async (root) => {
      const legacy = createAgentRunStore(root);
      await legacy.createRun(runHeader());
      await legacy.appendEvent('session-1', 'run-1', runEvent('event-1', 1));

      const interrupted = createSqliteAgentRunStore(root, {
        failpoint: (point) => {
          if (point === 'after_cutover_rows_copied') throw new Error('simulated crash');
        },
      });
      assert.ok(interrupted.ready);
      await assert.rejects(interrupted.ready(), /simulated crash/);
      interrupted.close?.();

      const inspection = acquireOperationalStateDatabase(root);
      const journal = inspection.database
        .prepare(`
          SELECT state
          FROM cutover_journal
          WHERE store_name = 'agent_runs'
        `)
        .get() as { state?: unknown } | undefined;
      const count = inspection.database
        .prepare('SELECT COUNT(*) AS count FROM core_agent_runs')
        .get() as { count?: unknown };
      assert.equal(journal?.state, 'started');
      assert.equal(count.count, 0);
      inspection.close();

      const resumed = createSqliteAgentRunStore(root);
      await resumed.ready?.();
      assert.equal((await resumed.readRun('session-1', 'run-1')).runId, 'run-1');
      resumed.close?.();
    });
  });

  test('imports ShellRun state and keeps payload files unchanged', async () => {
    await withRoot(async (root) => {
      const legacy = createShellRunStore(root);
      await legacy.createShellRun(shellRun());
      const legacyPath = join(
        root,
        'sessions',
        'session-1',
        'shell-runs',
        'shell-1',
        'shell-run.json',
      );
      const before = await readFile(legacyPath);

      const sqlite = createSqliteShellRunStore(root);
      await sqlite.ready();
      assert.equal((await sqlite.readShellRun('session-1', 'shell-1')).status, 'running');
      const updated = await sqlite.updateShellRun('session-1', 'shell-1', {
        status: 'completed',
        completedAt: 2,
        exitCode: 0,
        updatedAt: 2,
      });
      assert.equal(updated.revision, 2);
      assert.deepEqual(await readFile(legacyPath), before);
      sqlite.close();
    });
  });

  test('imports receipts and interactions while new writes stay SQLite-only', async () => {
    await withRoot(async (root) => {
      const receipts = createMessageReceiptStore(root);
      await receipts.beginHostEpoch('epoch-1');
      await receipts.commit('epoch-1', 'submit', 'session-1', 'operation-1', {
        payload: { text: 'hello' },
        result: { accepted: true },
      });

      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const legacyOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(legacyOwner);
      if (!legacyOwner) return;
      const legacyInteractions = await openInteractiveInteractionStoreForWrite(legacyOwner.lease);
      const request = storedQuestion('request-1', 1);
      assert.equal((await legacyInteractions.establishRequest(request)).status, 'stable');
      assert.equal(
        (await legacyInteractions.commitOutcome('request-1', questionOutcome('First', 2))).status,
        'stable',
      );
      await legacyOwner.close();

      const sqliteReceipts = createSqliteMessageReceiptStore(root);
      await sqliteReceipts.ready();
      assert.deepEqual(await sqliteReceipts.read('epoch-1', 'submit', 'session-1', 'operation-1'), {
        payload: { text: 'hello' },
        result: { accepted: true },
      });
      await sqliteReceipts.commit('epoch-1', 'interrupt', 'session-1', 'operation-2', {
        payload: { reason: 'stop' },
        result: { interrupted: true },
      });
      await assert.rejects(
        () =>
          stat(
            join(root, 'message-receipts', 'epoch-1', 'interrupt', 'session-1', 'operation-2.json'),
          ),
        { code: 'ENOENT' },
      );
      sqliteReceipts.close();

      const sqliteOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(sqliteOwner);
      if (!sqliteOwner) return;
      const sqliteInteractions = await openSqliteInteractiveInteractionStoreForWrite(
        sqliteOwner.lease,
      );
      assert.equal(
        (await sqliteInteractions.readInteraction('request-1'))?.outcome?.outcome.kind,
        'question_answer',
      );
      const sqliteOnly = storedQuestion('request-2', 3);
      assert.equal((await sqliteInteractions.establishRequest(sqliteOnly)).status, 'stable');
      await assert.rejects(
        () => stat(join(root, 'interactions', interactionLocator(sqliteOnly.requestId))),
        { code: 'ENOENT' },
      );
      closeSqliteInteractionStoreFacade(sqliteInteractions);
      await sqliteOwner.close();

      assert.ok((await stat(join(root, OPERATIONAL_STATE_DATABASE_NAME))).isFile());
    });
  });
});

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-core-execution-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runHeader(): AgentRunHeader {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  };
}

function runEvent(id: string, ts: number): AgentRunEvent {
  return {
    type: 'run_started',
    id,
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts,
  };
}

function shellRun(): ShellRunRecord {
  return {
    shellRunId: 'shell-1',
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: '/workspace',
    command: 'printf "ok"',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: {
      mode: 'pipes',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
}

function storedQuestion(requestId: string, createdAt: number): StoredInteractionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    requestId,
    createdAt,
    request: {
      kind: 'question',
      toolUseId: 'tool-1',
      questions: [
        {
          question: 'Choose',
          options: [
            { label: 'First', description: 'First' },
            { label: 'Second', description: 'Second' },
          ],
        },
      ],
    } as InteractionRequest,
  };
}

function questionOutcome(answer: string, committedAt: number): InteractionCanonicalOutcome {
  return {
    kind: 'question_answer',
    answers: [answer],
    committedAt,
  } as InteractionCanonicalOutcome;
}
