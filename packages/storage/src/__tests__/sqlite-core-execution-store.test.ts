import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type {
  AgentRunHeader,
  EmittedAgentRunEvent,
  InteractionCanonicalOutcome,
  InteractionRequest,
  ShellRunRecord,
} from '@maka/core';
import { createSqliteAgentRunStore } from '../agent-run-store.js';
import {
  closeSqliteInteractionStoreFacade,
  openSqliteInteractiveInteractionStoreForWrite,
  type StoredInteractionRequest,
} from '../interaction-store.js';
import { createSqliteMessageReceiptStore } from '../message-receipt-store.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { createSqliteShellRunStore } from '../shell-run-store.js';

describe('SQLite core execution stores', () => {
  test('persists AgentRun header and events', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      await store.createRun(runHeader());
      await store.appendEvent('session-1', 'run-1', runEvent());
      store.close?.();

      const reopened = createSqliteAgentRunStore(root);
      try {
        assert.equal((await reopened.readRun('session-1', 'run-1')).runId, 'run-1');
        assert.equal((await reopened.readEvents('session-1', 'run-1'))[0]?.id, 'event-1');
      } finally {
        reopened.close?.();
      }
    });
  });

  test('reads an AgentRun event type this build does not write', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      await store.createRun(runHeader());
      await store.appendEvent('session-1', 'run-1', runEvent());
      store.close?.();

      // Rewrite the stored row into what a build that still had this writer would have left
      // behind. Going through the database rather than appendEvent is the point: this build
      // must be able to read a record it is no longer allowed to produce (#1942).
      const db = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        const record = {
          ...runEvent(),
          type: 'written_by_another_version',
          data: { inputTokens: 7 },
        };
        db.prepare(
          `UPDATE core_agent_run_events SET event_type = ?, record_json = ? WHERE event_id = ?`,
        ).run('written_by_another_version', JSON.stringify(record), 'event-1');
      } finally {
        db.close();
      }

      const reopened = createSqliteAgentRunStore(root);
      try {
        const events = await reopened.readEvents('session-1', 'run-1');
        assert.deepEqual(
          events.map((event) => event.type),
          ['written_by_another_version'],
        );
        assert.equal(events[0]?.data?.inputTokens, 7);

        const recovered = await reopened.readEventsForRecovery('session-1', 'run-1');
        assert.deepEqual(
          recovered.map((event) => event.type),
          ['written_by_another_version'],
        );
      } finally {
        reopened.close?.();
      }
    });
  });

  test('persists ShellRun records', async () => {
    await withRoot(async (root) => {
      const store = createSqliteShellRunStore(root);
      await store.createShellRun(shellRun());
      store.close();

      const reopened = createSqliteShellRunStore(root);
      try {
        assert.equal((await reopened.readShellRun('session-1', 'shell-1')).command, 'printf "ok"');
      } finally {
        reopened.close();
      }
    });
  });

  test('reports a missing ShellRun with the ENOENT store contract', async () => {
    await withRoot(async (root) => {
      const store = createSqliteShellRunStore(root);
      try {
        await assert.rejects(store.readShellRun('session-1', 'missing-shell'), { code: 'ENOENT' });
      } finally {
        store.close();
      }
    });
  });

  test('persists message receipts', async () => {
    await withRoot(async (root) => {
      const store = createSqliteMessageReceiptStore(root);
      await store.beginHostEpoch('epoch-1');
      await store.commit('epoch-1', 'submit', 'session-1', 'operation-1', {
        payload: { text: 'hello' },
        result: { disposition: 'turn_started', turnId: 'turn-1' },
      });
      store.close();

      const reopened = createSqliteMessageReceiptStore(root);
      try {
        assert.deepEqual(
          (await reopened.read('epoch-1', 'submit', 'session-1', 'operation-1'))?.payload,
          { text: 'hello' },
        );
      } finally {
        reopened.close();
      }
    });
  });

  test('persists interaction request and outcome', async () => {
    await withRoot(async (root) => {
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const store = await openSqliteInteractiveInteractionStoreForWrite(owner.lease);
      try {
        await store.establishRequest(storedQuestion());
        await store.commitOutcome('request-1', questionOutcome());
        assert.equal(
          (await store.readInteraction('request-1'))?.outcome?.outcome.kind,
          'question_answer',
        );
      } finally {
        closeSqliteInteractionStoreFacade(store);
        await owner.close();
      }
    });
  });
});

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-execution-'));
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

function runEvent(): EmittedAgentRunEvent {
  return {
    type: 'run_started',
    id: 'event-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
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

function storedQuestion(): StoredInteractionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    requestId: 'request-1',
    createdAt: 1,
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

function questionOutcome(): InteractionCanonicalOutcome {
  return {
    kind: 'question_answer',
    answers: ['First'],
    committedAt: 2,
  } as InteractionCanonicalOutcome;
}
