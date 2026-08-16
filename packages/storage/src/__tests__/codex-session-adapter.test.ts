import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeStoredMessage } from '@maka/core/session';
import { CodexSessionAdapter } from '../codex-session-adapter.js';
import { createExternalSessionAdapterRegistry } from '../external-session-adapters.js';

const CURRENT_FIXTURE = fixturePath('codex-rollout-v0.144.jsonl');

describe('CodexSessionAdapter', () => {
  test('lists active and archived root Sessions from the newest Codex state database', async () => {
    await withCodexHome(async (codexHome) => {
      const activePath = await seedFixtureRollout(codexHome, 'codex-session-1', false);
      const archivedPath = await seedMinimalRollout(
        codexHome,
        'codex-session-archived',
        true,
        '/workspace/archive',
        'Archived task',
      );
      await seedStateDatabase(codexHome, [
        {
          id: 'codex-session-1',
          rolloutPath: activePath,
          cwd: '/workspace/project',
          name: 'Named Codex thread',
          createdAtMs: 1000,
          updatedAtMs: 3000,
          archived: false,
          source: 'cli',
        },
        {
          id: 'codex-session-archived',
          rolloutPath: archivedPath,
          cwd: '/workspace/archive',
          name: 'Archived Codex thread',
          createdAtMs: 1500,
          updatedAtMs: 2000,
          archived: true,
          source: 'vscode',
        },
        {
          id: 'codex-subagent',
          rolloutPath: activePath,
          cwd: '/workspace/project',
          name: 'Internal child',
          createdAtMs: 2000,
          updatedAtMs: 4000,
          archived: false,
          source: '{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}',
        },
      ]);

      const adapter = new CodexSessionAdapter({ codexHome });
      assert.equal(await adapter.detect(), true);
      assert.deepEqual(await adapter.listSessions(), [
        {
          id: 'codex-session-1',
          name: 'Named Codex thread',
          cwd: '/workspace/project',
          createdAt: 1_000_000,
          updatedAt: 3_000_000,
          archived: false,
        },
      ]);
      assert.deepEqual(
        (await adapter.listSessions({ includeArchived: true })).map((session) => session.id),
        ['codex-session-1', 'codex-session-archived'],
      );
      assert.deepEqual(
        await adapter.listSessions({ includeArchived: true, cwd: '/workspace/archive/' }),
        [
          {
            id: 'codex-session-archived',
            name: 'Archived Codex thread',
            cwd: '/workspace/archive',
            createdAt: 1_500_000,
            updatedAt: 2_000_000,
            archived: true,
          },
        ],
      );
    });
  });

  test('converts Codex presentation events and raw tool items without duplicates', async () => {
    await withCodexHome(async (codexHome) => {
      await seedFixtureRollout(codexHome, 'codex-session-1', false);
      const adapter = new CodexSessionAdapter({ codexHome });

      assert.deepEqual(await adapter.listSessions(), [
        {
          id: 'codex-session-1',
          name: 'Fix the parser',
          cwd: '/workspace/project',
          createdAt: Date.parse('2026-08-08T00:00:00.000Z'),
          updatedAt: await rolloutMtime(codexHome, 'codex-session-1', false),
          archived: false,
        },
      ]);

      const session = await adapter.readSession('codex-session-1');
      assert.deepEqual(session.metadata, {
        name: 'Fix the parser',
        cwd: '/workspace/project',
      });
      assert.equal(session.messages.length, 9);
      for (const message of session.messages) {
        assert.deepEqual(decodeStoredMessage(message), message);
      }

      assert.deepEqual(session.messages[0], {
        type: 'user',
        id: 'codex-user-1',
        turnId: 'codex-turn-1',
        ts: Date.parse('2026-08-08T00:00:02.000Z'),
        text: 'Fix the parser',
      });
      assert.deepEqual(session.messages[1], {
        type: 'assistant',
        id: 'codex-codex-session-1-reasoning-7',
        turnId: 'codex-turn-1',
        ts: Date.parse('2026-08-08T00:00:03.000Z'),
        text: '',
        thinking: { text: 'Inspect the failing path.' },
        contentOrder: ['thinking'],
        modelId: 'gpt-codex-test',
      });
      assert.equal(session.messages[2]?.type, 'assistant');
      assert.equal(session.messages[2]?.text, 'I found the issue.');
      assert.deepEqual(session.messages[3], {
        type: 'tool_call',
        id: 'call-wait-1',
        turnId: 'codex-turn-1',
        ts: Date.parse('2026-08-08T00:00:05.000Z'),
        toolName: 'wait',
        args: { milliseconds: 25 },
      });
      assert.deepEqual(session.messages[4], {
        type: 'tool_result',
        id: 'function-output-1',
        turnId: 'codex-turn-1',
        ts: Date.parse('2026-08-08T00:00:06.000Z'),
        toolUseId: 'call-wait-1',
        isError: false,
        content: { kind: 'text', text: 'waited' },
      });
      assert.equal(session.messages[5]?.type, 'tool_call');
      assert.equal(session.messages[5]?.args, '*** Begin Patch');
      assert.deepEqual(
        session.messages[6]?.type === 'tool_result' ? session.messages[6].content : undefined,
        { kind: 'text', text: 'Done\n1 file changed' },
      );
      assert.equal(session.messages[7]?.type, 'system_note');
      assert.equal(session.messages[8]?.type, 'turn_state');
      assert.equal(session.messages[8]?.status, 'completed');
    });
  });

  test('imports terminal errors as failed without failing turns on non-terminal errors', async () => {
    await withCodexHome(async (codexHome) => {
      const sessionId = 'codex-error-semantics';
      await seedRawRollout(codexHome, sessionId, errorSemanticsRollout(sessionId));

      const session = await new CodexSessionAdapter({ codexHome }).readSession(sessionId);
      assert.deepEqual(
        session.messages
          .filter((message) => message.type === 'turn_state')
          .map(({ turnId, status, errorClass }) => ({ turnId, status, errorClass })),
        [
          { turnId: 'turn-terminal', status: 'failed', errorClass: 'codex_error' },
          { turnId: 'turn-rollback', status: 'completed', errorClass: undefined },
          { turnId: 'turn-not-steerable', status: 'completed', errorClass: undefined },
        ],
      );
    });
  });

  test('filesystem fallback excludes internal subagent rollouts', async () => {
    await withCodexHome(async (codexHome) => {
      await seedMinimalRollout(
        codexHome,
        'codex-root-fallback',
        false,
        '/workspace/root',
        'Root task',
      );
      const subagentId = 'codex-subagent-fallback';
      await seedRawRollout(
        codexHome,
        subagentId,
        minimalRollout(subagentId, '/workspace/root', 'Internal task', {
          subagent: {
            thread_spawn: { parent_thread_id: 'parent', depth: 1 },
          },
        }),
      );

      const adapter = new CodexSessionAdapter({ codexHome });
      assert.deepEqual(
        (await adapter.listSessions()).map((session) => session.id),
        ['codex-root-fallback'],
      );
      await assert.rejects(adapter.readSession(subagentId), /not found/);
    });
  });

  test('rejects corrupt interior records, tolerates a torn tail, and bounds full reads', async () => {
    await withCodexHome(async (codexHome) => {
      const fixture = await readFile(CURRENT_FIXTURE, 'utf8');
      const corruptId = 'codex-corrupt';
      await seedRawRollout(
        codexHome,
        corruptId,
        fixture
          .replaceAll('codex-session-1', corruptId)
          .replace(
            '\n{"timestamp":"2026-08-08T00:00:01.000Z"',
            '\nnot-json\n{"timestamp":"2026-08-08T00:00:01.000Z"',
          ),
      );
      const tornId = 'codex-torn';
      await seedRawRollout(
        codexHome,
        tornId,
        `${fixture.replaceAll('codex-session-1', tornId)}{"timestamp"`,
      );

      const adapter = new CodexSessionAdapter({ codexHome });
      await assert.rejects(adapter.readSession(corruptId), /Invalid Codex rollout.*line 2/);
      assert.equal((await adapter.readSession(tornId)).messages.length, 9);

      const bounded = new CodexSessionAdapter({ codexHome, maxRolloutBytes: 100 });
      await assert.rejects(bounded.readSession(tornId), /exceeds 100 bytes/);
    });
  });

  test('never follows a state database rollout path outside CODEX_HOME', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'maka-codex-outside-'));
    try {
      await withCodexHome(async (codexHome) => {
        const id = 'codex-escaped';
        const escapedPath = join(outside, `rollout-2026-08-08T00-00-00-${id}.jsonl`);
        await writeFile(escapedPath, minimalRollout(id, '/outside', 'outside'));
        await seedStateDatabase(codexHome, [
          {
            id,
            rolloutPath: escapedPath,
            cwd: '/outside',
            name: 'Escaped',
            createdAtMs: 1000,
            updatedAtMs: 2000,
            archived: false,
            source: 'cli',
          },
        ]);

        const adapter = new CodexSessionAdapter({ codexHome });
        assert.deepEqual(await adapter.listSessions(), []);
        await assert.rejects(adapter.readSession(id), /not found/);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('is registered by the internal default registry', async () => {
    await withCodexHome(async (codexHome) => {
      const registry = createExternalSessionAdapterRegistry({ codex: { codexHome } });
      assert.equal(registry.require('codex').id, 'codex');
    });
  });
});

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../src/__tests__/fixtures/${name}`, import.meta.url));
}

async function withCodexHome(run: (codexHome: string) => Promise<void>): Promise<void> {
  const codexHome = await mkdtemp(join(tmpdir(), 'maka-codex-adapter-'));
  try {
    await run(codexHome);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function seedFixtureRollout(
  codexHome: string,
  sessionId: string,
  archived: boolean,
): Promise<string> {
  const fixture = (await readFile(CURRENT_FIXTURE, 'utf8')).replaceAll(
    'codex-session-1',
    sessionId,
  );
  return seedRawRollout(codexHome, sessionId, fixture, archived);
}

async function seedMinimalRollout(
  codexHome: string,
  sessionId: string,
  archived: boolean,
  cwd: string,
  userText: string,
): Promise<string> {
  return seedRawRollout(codexHome, sessionId, minimalRollout(sessionId, cwd, userText), archived);
}

async function seedRawRollout(
  codexHome: string,
  sessionId: string,
  content: string,
  archived = false,
): Promise<string> {
  const directory = archived
    ? join(codexHome, 'archived_sessions')
    : join(codexHome, 'sessions', '2026', '08', '08');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-08-08T00-00-00-${sessionId}.jsonl`);
  await writeFile(path, content);
  return path;
}

function minimalRollout(
  sessionId: string,
  cwd: string,
  userText: string,
  source: unknown = 'cli',
): string {
  return [
    JSON.stringify({
      timestamp: '2026-08-08T00:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: sessionId, id: sessionId, cwd, source },
    }),
    JSON.stringify({
      timestamp: '2026-08-08T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: userText },
    }),
    '',
  ].join('\n');
}

function errorSemanticsRollout(sessionId: string): string {
  const event = (second: number, payload: Record<string, unknown>): string =>
    JSON.stringify({
      timestamp: `2026-08-08T00:00:${String(second).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload,
    });
  return [
    JSON.stringify({
      timestamp: '2026-08-08T00:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: sessionId, id: sessionId, cwd: '/workspace', source: 'cli' },
    }),
    event(1, { type: 'task_started', turn_id: 'turn-terminal' }),
    event(2, { type: 'user_message', message: 'Fail terminally' }),
    event(3, {
      type: 'task_complete',
      turn_id: 'turn-terminal',
      error: { message: 'capacity', codex_error_info: 'server_overloaded' },
    }),
    event(4, { type: 'task_started', turn_id: 'turn-rollback' }),
    event(5, { type: 'user_message', message: 'Rollback warning' }),
    event(6, {
      type: 'error',
      message: 'rollback failed',
      codex_error_info: 'thread_rollback_failed',
    }),
    event(7, { type: 'task_complete', turn_id: 'turn-rollback' }),
    event(8, { type: 'task_started', turn_id: 'turn-not-steerable' }),
    event(9, { type: 'user_message', message: 'Steer review' }),
    event(10, {
      type: 'error',
      message: 'cannot steer review',
      codex_error_info: { active_turn_not_steerable: { turn_kind: 'review' } },
    }),
    event(11, { type: 'task_complete', turn_id: 'turn-not-steerable' }),
    '',
  ].join('\n');
}

interface StateRow {
  id: string;
  rolloutPath: string;
  cwd: string;
  name: string;
  createdAtMs: number;
  updatedAtMs: number;
  archived: boolean;
  source: string;
}

async function seedStateDatabase(codexHome: string, rows: readonly StateRow[]): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        cwd TEXT,
        name TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        archived INTEGER,
        source TEXT
      )
    `);
    const insert = database.prepare(`
      INSERT INTO threads (
        id, rollout_path, cwd, name, created_at_ms, updated_at_ms, archived, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.id,
        row.rolloutPath,
        row.cwd,
        row.name,
        row.createdAtMs,
        row.updatedAtMs,
        row.archived ? 1 : 0,
        row.source,
      );
    }
  } finally {
    database.close();
  }
}

async function rolloutMtime(
  codexHome: string,
  sessionId: string,
  archived: boolean,
): Promise<number> {
  const { stat } = await import('node:fs/promises');
  const directory = archived
    ? join(codexHome, 'archived_sessions')
    : join(codexHome, 'sessions', '2026', '08', '08');
  return (await stat(join(directory, `rollout-2026-08-08T00-00-00-${sessionId}.jsonl`))).mtimeMs;
}
