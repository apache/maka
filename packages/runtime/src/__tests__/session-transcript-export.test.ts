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
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import { createSessionStore } from '@maka/storage/session-store';
import { openRuntimeEventReadPersistence } from '@maka/storage/runtime-event-persistence';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from '@maka/storage/operational-state-store';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { seedInvocation } from './invocation-fixture.js';
import type { StoredMessage } from '@maka/core/session';
import {
  exportSessionTranscriptMarkdown,
  exportSessionTranscriptMarkdownToFile,
  renderSessionTranscriptMarkdown,
  type SessionTranscriptExportSources,
} from '../session-transcript-export.js';

const CONNECTION_SLUG = 'test-connection';
const MODEL = 'test-model';

// The exporter receives storage openers from composition (storage dependency
// guard); tests compose the same read-only, require-current stores the CLI
// command hands it.
const sources: SessionTranscriptExportSources = {
  openSessionStore: (workspaceRoot) =>
    createSessionStore(workspaceRoot, { schemaMigration: 'require_current', access: 'read' }),
  openRuntimeEventLedger: (workspaceRoot) =>
    openRuntimeEventReadPersistence({ workspaceRoot }).then((persistence) => ({
      // The read persistence carries every method the read model calls; the
      // runtime reader fragment is narrower than the full write store contract.
      runtimeEventStore: persistence.runtimeEventStore as unknown as RuntimeEventStore,
      close: () => persistence.close(),
    })),
};

async function withWorkspace(
  name: string,
  run: (workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const root = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(join(tmpdir(), `${name}-`)),
  );
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  try {
    await run(workspaceRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createSession(workspaceRoot: string, name: string): Promise<string> {
  const store = createSessionStore(workspaceRoot);
  try {
    const header = await store.create({
      cwd: workspaceRoot,
      llmConnectionSlug: CONNECTION_SLUG,
      model: MODEL,
      permissionMode: 'ask',
      name,
    });
    return header.id;
  } finally {
    await store.close?.();
  }
}

async function writeMessages(
  workspaceRoot: string,
  sessionId: string,
  messages: readonly StoredMessage[],
): Promise<void> {
  const store = createSessionStore(workspaceRoot);
  try {
    await store.appendMessages(sessionId, [...messages]);
  } finally {
    await store.close?.();
  }
}

function userMessage(id: string, turnId: string, ts: number, text: string): StoredMessage {
  return { type: 'user', id, turnId, ts, text };
}

function assistantMessage(input: {
  id: string;
  turnId: string;
  ts: number;
  text: string;
  thinking?: string;
}): StoredMessage {
  return {
    type: 'assistant',
    id: input.id,
    turnId: input.turnId,
    ts: input.ts,
    text: input.text,
    modelId: MODEL,
    ...(input.thinking === undefined ? {} : { thinking: { text: input.thinking } }),
  };
}

function toolCallMessage(input: {
  id: string;
  turnId: string;
  ts: number;
  toolName: string;
  intent?: string;
  args?: unknown;
}): StoredMessage {
  return {
    type: 'tool_call',
    id: input.id,
    turnId: input.turnId,
    ts: input.ts,
    toolName: input.toolName,
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    args: input.args ?? {},
  };
}

function toolResultMessage(input: {
  id: string;
  turnId: string;
  ts: number;
  toolUseId: string;
  isError?: boolean;
  text: string;
}): StoredMessage {
  return {
    type: 'tool_result',
    id: input.id,
    turnId: input.turnId,
    ts: input.ts,
    toolUseId: input.toolUseId,
    isError: input.isError ?? false,
    content: { kind: 'text', text: input.text },
  };
}

test('exports the full transcript from persistence, tool results included', async () => {
  await withWorkspace('transcript-export-full', async (workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot, 'Debug session');
    await writeMessages(workspaceRoot, sessionId, [
      userMessage('u1', 'turn-1', 1, 'list the files'),
      toolCallMessage({
        id: 'call-1',
        turnId: 'turn-1',
        ts: 2,
        toolName: 'Bash',
        intent: 'list directory contents',
      }),
      toolResultMessage({
        id: 'r1',
        turnId: 'turn-1',
        ts: 3,
        toolUseId: 'call-1',
        text: 'src/\nREADME.md',
      }),
      assistantMessage({ id: 'a1', turnId: 'turn-1', ts: 4, text: 'Here are the files.' }),
      userMessage('u2', 'turn-2', 5, 'thanks'),
      assistantMessage({ id: 'a2', turnId: 'turn-2', ts: 6, text: 'Anytime.' }),
    ]);

    const result = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId,
      now: () => 0,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.messageCount, 6);
    const order = [
      '# Debug session',
      '## You',
      'list the files',
      '### Tool calls',
      '`Bash`',
      'Result (ok)',
      'README.md',
      '## Maka',
      'Here are the files.',
      '## You',
      'thanks',
      '## Maka',
      'Anytime.',
    ];
    let cursor = 0;
    for (const needle of order) {
      const at = result.markdown.indexOf(needle, cursor);
      assert.ok(at >= 0, `expected ${JSON.stringify(needle)} after ${cursor}`);
      cursor = at;
    }
  });
});

test('redacts secrets in assistant text, tool intents, and tool results', async () => {
  await withWorkspace('transcript-export-redaction', async (workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot, 'Secrets');
    await writeMessages(workspaceRoot, sessionId, [
      userMessage('u1', 'turn-1', 1, 'run it'),
      toolCallMessage({
        id: 'call-1',
        turnId: 'turn-1',
        ts: 2,
        toolName: 'Bash',
        intent: 'token sk-intent-secret done',
      }),
      toolResultMessage({
        id: 'r1',
        turnId: 'turn-1',
        ts: 3,
        toolUseId: 'call-1',
        isError: true,
        text: 'token sk-result-secret done',
      }),
      assistantMessage({
        id: 'a1',
        turnId: 'turn-1',
        ts: 4,
        text: 'token sk-answer-secret done',
      }),
    ]);

    const result = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId,
      now: () => 0,
    });
    assert.ok(result.ok, JSON.stringify(result));
    for (const secret of ['sk-intent-secret', 'sk-result-secret', 'sk-answer-secret']) {
      assert.equal(result.markdown.includes(secret), false, secret);
    }
    assert.equal(result.markdown.match(/\[redacted\]/g)?.length, 3);
  });
});

test('thinking stays out by default and rides in behind the flag', async () => {
  await withWorkspace('transcript-export-thinking', async (workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot, 'Thinking');
    await writeMessages(workspaceRoot, sessionId, [
      userMessage('u1', 'turn-1', 1, 'go'),
      assistantMessage({
        id: 'a1',
        turnId: 'turn-1',
        ts: 2,
        text: 'Done.',
        thinking: 'the user wants me to hurry',
      }),
    ]);

    const defected = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId,
      now: () => 0,
    });
    assert.ok(defected.ok, JSON.stringify(defected));
    assert.equal(defected.markdown.includes('the user wants me to hurry'), false);

    const withThinking = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId,
      includeThinking: true,
      now: () => 0,
    });
    assert.ok(withThinking.ok, JSON.stringify(withThinking));
    assert.ok(withThinking.markdown.includes('the user wants me to hurry'));
  });
});

test('operational rows never reach the export', async () => {
  await withWorkspace('transcript-export-operational', async (workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot, 'Operational');
    await writeMessages(workspaceRoot, sessionId, [
      userMessage('u1', 'turn-1', 1, 'hello'),
      {
        type: 'token_usage',
        id: 'tu1',
        turnId: 'turn-1',
        ts: 2,
        input: 10,
        output: 5,
      } as StoredMessage,
      {
        type: 'turn_state',
        id: 'ts1',
        turnId: 'turn-1',
        ts: 3,
        status: 'completed',
      } as StoredMessage,
      assistantMessage({ id: 'a1', turnId: 'turn-1', ts: 4, text: 'Hi.' }),
    ]);

    const result = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId,
      now: () => 0,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.markdown.includes('token_usage'), false);
    assert.equal(result.markdown.includes('turn_state'), false);
    assert.ok(result.markdown.includes('Hi.'));

    // The substring assertions above are vacuous on their own — a renderer
    // that grew a fallback for unknown row types would leak `token_usage`
    // rows without ever printing that literal. Pin the whole document: the
    // export of the polluted session must be byte-identical to the export of
    // a clean session with the same spoken rows.
    const cleanSessionId = await createSession(workspaceRoot, 'Operational');
    await writeMessages(workspaceRoot, cleanSessionId, [
      userMessage('u1', 'turn-1', 1, 'hello'),
      assistantMessage({ id: 'a1', turnId: 'turn-1', ts: 4, text: 'Hi.' }),
    ]);
    const clean = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId: cleanSessionId,
      now: () => 0,
    });
    assert.ok(clean.ok, JSON.stringify(clean));
    assert.equal(result.ok ? result.markdown : '', clean.ok ? clean.markdown : '');
  });
});

test('structured failures for missing workspace and session', async () => {
  await withWorkspace('transcript-export-missing', async (workspaceRoot) => {
    const noWorkspace = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot: join(workspaceRoot, 'absent'),
      sessionId: 's1',
    });
    assert.deepEqual(noWorkspace, {
      ok: false,
      reason: { kind: 'workspace_not_found', workspaceRoot: join(workspaceRoot, 'absent') },
    });

    // An initialized-but-empty workspace has no database to share, so the
    // read-only open fails closed before the session lookup (#6036 review).
    const emptyWorkspace = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId: 'does-not-exist',
    });
    assert.ok(!emptyWorkspace.ok);
    assert.equal(emptyWorkspace.ok ? null : emptyWorkspace.reason.kind, 'schema_unsupported');

    // With a current database in place the missing session surfaces itself.
    acquireOperationalStateDatabase(workspaceRoot).close();
    const noSession = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId: 'does-not-exist',
    });
    assert.ok(!noSession.ok);
    assert.equal(noSession.ok ? null : noSession.reason.kind, 'session_not_found');
  });
});

test('never creates the operational database: an uninitialized workspace fails closed', async () => {
  await withWorkspace('transcript-export-readonly-empty', async (workspaceRoot) => {
    const result = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId: 's1',
    });
    assert.ok(!result.ok);
    assert.equal(result.ok ? null : result.reason.kind, 'schema_unsupported');
    await assert.rejects(stat(join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME)));
  });
});

test('never migrates the operational database: an older schema fails instead of upgrading', async () => {
  await withWorkspace('transcript-export-readonly-legacy', async (workspaceRoot) => {
    // Build a current database, then rewind one migration so only its Runtime
    // Host may bring it forward (same fixture the storage store tests use).
    acquireOperationalStateDatabase(workspaceRoot).close();
    const older = new DatabaseSync(join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME));
    older.exec(`
      ALTER TABLE core_agent_runs ADD COLUMN record_json TEXT;
      UPDATE operational_schema_migrations
      SET version = 6
      WHERE scope = 'core_execution';
    `);
    older.close();

    const result = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId: 's1',
    });
    assert.ok(!result.ok);
    assert.equal(result.ok ? null : result.reason.kind, 'schema_unsupported');

    // The rewind the export found on open is still the one on disk: a write
    // path would have migrated `core_execution` past version 6.
    const reader = new DatabaseSync(join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME), {
      readOnly: true,
    });
    try {
      const row = reader
        .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'core_execution'")
        .get() as { version: number };
      assert.equal(row.version, 6);
    } finally {
      reader.close();
    }
  });
});

test('read-only export leaves the writer journal mode untouched', async () => {
  await withWorkspace('transcript-export-readonly-journal', async (workspaceRoot) => {
    acquireOperationalStateDatabase(workspaceRoot).close();
    const db = new DatabaseSync(join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME));
    db.exec('PRAGMA journal_mode = DELETE');
    db.close();

    // The journal flip happened at open time in the flagged behavior — even a
    // failing export (missing session here) must not touch it (#6036 review).
    const result = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId: 'does-not-exist',
    });
    assert.ok(!result.ok);

    const reader = new DatabaseSync(join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME), {
      readOnly: true,
    });
    try {
      const mode = reader.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      assert.equal(mode.journal_mode, 'delete');
    } finally {
      reader.close();
    }
  });
});

test('renderer stays a pure function over stored messages', () => {
  const markdown = renderSessionTranscriptMarkdown(
    'Pure',
    [
      userMessage('u1', 'turn-1', 1, 'one'),
      assistantMessage({ id: 'a1', turnId: 'turn-1', ts: 2, text: 'two' }),
    ],
    { now: () => 0 },
  );
  assert.ok(markdown.startsWith('# Pure\n'));
  assert.ok(markdown.endsWith('\n'));
  assert.ok(markdown.includes('## You'));
  assert.ok(markdown.includes('## Maka'));
});

/**
 * A completed invocation as current sessions actually persist it: the runtime
 * event ledger is the transcript authority, and `session_messages` stays empty.
 */
async function seedLedgerTurn(workspaceRoot: string, sessionId: string): Promise<void> {
  const runtime = createSqliteRuntimeStore(join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME));
  try {
    const { invocationId } = await seedInvocation(runtime, {
      sessionId,
      runId: 'run-1',
      turnId: 'turn-1',
      openedAt: 1,
    });
    const base = { sessionId, invocationId, runId: 'run-1', turnId: 'turn-1' };
    const events: RuntimeEvent[] = [
      {
        id: 'e-user',
        ...base,
        ts: 2,
        partial: false,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'list the files' },
      },
      {
        id: 'e-steer',
        ...base,
        ts: 3,
        partial: false,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'include the hidden ones', steering: true },
      },
      {
        id: 'e-answer',
        ...base,
        ts: 4,
        partial: false,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'Here are all the files.' },
      },
      {
        id: 'e-terminal',
        ...base,
        ts: 5,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      },
    ];
    for (const event of events) {
      await runtime.appendRuntimeEvent(sessionId, 'run-1', event);
    }
  } finally {
    runtime.close();
  }
}

test('exports a ledger-backed session the read model projects, not zero rows', async () => {
  await withWorkspace('transcript-export-ledger', async (workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot, 'Ledger session');
    await seedLedgerTurn(workspaceRoot, sessionId);

    const result = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId,
      now: () => 0,
    });
    assert.ok(result.ok, JSON.stringify(result));
    // Three spoken messages plus the turn_state row the terminal event
    // projects — operational rows ride in the stream and render nowhere.
    assert.equal(result.messageCount, 4);
    assert.ok(result.markdown.includes('list the files'));
    assert.ok(result.markdown.includes('include the hidden ones'));
    assert.ok(result.markdown.includes('Here are all the files.'));
  });
});

test('redacts shell_run fallbacks and terminal labels before rendering', () => {
  const markdown = renderSessionTranscriptMarkdown(
    'Redact',
    [
      userMessage('u1', 'turn-1', 1, 'run it'),
      toolCallMessage({ id: 'call-1', turnId: 'turn-1', ts: 2, toolName: 'Bash' }),
      {
        type: 'tool_result',
        id: 'r1',
        turnId: 'turn-1',
        ts: 3,
        toolUseId: 'call-1',
        isError: false,
        content: {
          kind: 'terminal',
          cwd: '/tmp',
          cmd: 'echo sk-cmd-secret',
          status: 'completed',
          exitCode: 0,
          output: 'token sk-output-secret done',
        },
      },
      toolCallMessage({ id: 'call-2', turnId: 'turn-1', ts: 4, toolName: 'Bash' }),
      {
        type: 'tool_result',
        id: 'r2',
        turnId: 'turn-1',
        ts: 5,
        toolUseId: 'call-2',
        isError: false,
        content: {
          kind: 'shell_run',
          ref: { kind: 'workspace_file', relativePath: 'runs/shell-1' },
          status: 'completed',
          cwd: '/tmp',
          cmd: 'curl -H "Authorization: Bearer sk-shell-secret" https://example.test',
          startedAt: 1,
          updatedAt: 2,
          revision: 1,
          mode: 'pipes',
        },
      },
    ] as StoredMessage[],
    { now: () => 0 },
  );
  for (const secret of ['sk-cmd-secret', 'sk-output-secret', 'sk-shell-secret']) {
    assert.equal(markdown.includes(secret), false, secret);
  }
});

test('redacts file-result paths and file-write destinations before rendering', () => {
  const markdown = renderSessionTranscriptMarkdown(
    'Redact paths',
    [
      userMessage('u1', 'turn-1', 1, 'show diffs'),
      toolCallMessage({ id: 'call-1', turnId: 'turn-1', ts: 2, toolName: 'Edit' }),
      {
        type: 'tool_result',
        id: 'r1',
        turnId: 'turn-1',
        ts: 3,
        toolUseId: 'call-1',
        isError: false,
        content: {
          kind: 'file_diff',
          paths: ['src/sk-path-fixture123.ts'],
          diff: 'clean diff text',
        },
      },
      toolCallMessage({ id: 'call-2', turnId: 'turn-1', ts: 4, toolName: 'Write' }),
      {
        type: 'tool_result',
        id: 'r2',
        turnId: 'turn-1',
        ts: 5,
        toolUseId: 'call-2',
        isError: false,
        content: { kind: 'file_write', path: 'src/sk-write-fixture123.ts', bytes: 10 },
      },
    ] as StoredMessage[],
    { now: () => 0 },
  );
  for (const secret of ['sk-path-fixture123', 'sk-write-fixture123']) {
    assert.equal(markdown.includes(secret), false, secret);
  }
  assert.ok(markdown.includes('clean diff text'));
});

test('renders every user message in a turn, steering included', () => {
  const markdown = renderSessionTranscriptMarkdown(
    'Steering',
    [
      userMessage('u1', 'turn-1', 1, 'list the files'),
      assistantMessage({ id: 'a1', turnId: 'turn-1', ts: 2, text: 'Here are the visible ones.' }),
      {
        type: 'user',
        id: 'u2',
        turnId: 'turn-1',
        ts: 3,
        text: 'include the hidden ones',
        steeringEventId: 'e-steer',
      },
      assistantMessage({ id: 'a2', turnId: 'turn-1', ts: 4, text: 'Here are all of them.' }),
    ] as StoredMessage[],
    { now: () => 0 },
  );
  assert.equal(markdown.match(/## You/g)?.length, 2);
  assert.ok(markdown.includes('list the files'));
  assert.ok(markdown.includes('include the hidden ones'));
  assert.ok(markdown.includes('Here are all of them.'));
});

test('emits rows in stored order — steering after a tool call prints after it', () => {
  // The mis-ordering liugddx flagged: a steering "STOP" the user sent after a
  // tool call ran must not print ahead of that call (#6036 review).
  const markdown = renderSessionTranscriptMarkdown(
    'Order',
    [
      userMessage('u1', 'turn-1', 1, 'start the long job'),
      toolCallMessage({ id: 'c1', turnId: 'turn-1', ts: 2, toolName: 'long_job' }),
      toolResultMessage({
        id: 'r1',
        toolUseId: 'c1',
        turnId: 'turn-1',
        ts: 3,
        text: 'still running',
      }),
      {
        type: 'user',
        id: 'u2',
        turnId: 'turn-1',
        ts: 4,
        text: 'STOP',
        steeringEventId: 'e-steer',
      },
      assistantMessage({ id: 'a1', turnId: 'turn-1', ts: 5, text: 'stopped.' }),
    ] as StoredMessage[],
    { now: () => 0 },
  );
  const order = ['start the long job', '`long_job`', 'still running', 'STOP', 'stopped.'].map(
    (fragment) => markdown.indexOf(fragment),
  );
  assert.ok(
    order.every((index) => index >= 0),
    'every row renders',
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    'rows must stay in stored order',
  );
});

test('file export streams the string form and appends subagent sessions', async () => {
  await withWorkspace('transcript-export-file', async (workspaceRoot) => {
    const store = createSessionStore(workspaceRoot);
    const parent = await store.create({
      cwd: workspaceRoot,
      llmConnectionSlug: CONNECTION_SLUG,
      model: MODEL,
      permissionMode: 'ask',
      name: 'Main',
    });
    await writeMessages(workspaceRoot, parent.id, [
      userMessage('u1', 'turn-1', 1, 'fan out'),
      assistantMessage({ id: 'a1', turnId: 'turn-1', ts: 2, text: 'Delegated.' }),
    ]);
    const child = await store.createSubagent({
      cwd: workspaceRoot,
      llmConnectionSlug: CONNECTION_SLUG,
      model: MODEL,
      permissionMode: 'ask',
      name: 'Scout',
      subagentParent: {
        kind: 'subagent',
        parentSessionId: parent.id,
        spawnedBy: { parentRunId: 'run-1', parentTurnId: 'turn-1', toolCallId: 'tc-1' },
        lifecycle: 'foreground',
      },
      subagentRuntime: {
        schemaVersion: 1,
        definitionVersion: 1,
        agentId: 'local-read',
        agentName: 'Local Read',
        profile: 'local_read',
        systemPrompt: 'Read the assigned workspace task.',
        toolNames: ['Read'],
        categoryPolicy: { read: 'allow' },
      },
      subagentSpawn: {
        schemaVersion: 1,
        requestFingerprint: 'a'.repeat(64),
        initialTurnId: 'sub-turn-1',
        initialRunId: 'sub-run-1',
      },
    } as Parameters<typeof store.createSubagent>[0]);
    await writeMessages(workspaceRoot, child.header.id, [
      userMessage('su1', 'sub-turn-1', 3, 'scout the repo'),
      assistantMessage({ id: 'sa1', turnId: 'sub-turn-1', ts: 4, text: 'Scouted.' }),
    ]);
    await store.close?.();

    const outPath = join(workspaceRoot, 'transcript.md');
    const result = await exportSessionTranscriptMarkdownToFile({
      sources,
      workspaceRoot,
      sessionId: parent.id,
      outPath,
      now: () => 0,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.subagentSessions, 1);
    const file = await readFile(outPath, 'utf8');

    const stringForm = await exportSessionTranscriptMarkdown({
      sources,
      workspaceRoot,
      sessionId: parent.id,
      now: () => 0,
    });
    assert.ok(stringForm.ok, JSON.stringify(stringForm));
    // The streamed file carries everything the string form has, then the
    // subagent story under its own title.
    assert.ok(file.includes(stringForm.ok ? stringForm.markdown : ''));
    assert.ok(file.includes('# Scout'));
    assert.ok(file.includes('scout the repo'));
  });
});

test('file export memory stays bounded on a 1,000-turn session', { timeout: 180_000 }, async () => {
  await withWorkspace('transcript-export-scale', async (workspaceRoot) => {
    const sessionId = await createSession(workspaceRoot, 'Scale');
    const store = createSessionStore(workspaceRoot);
    const bigResult = 'x'.repeat(50_000);
    const rows: StoredMessage[] = [];
    for (let turn = 0; turn < 1000; turn += 1) {
      const ts = turn * 4;
      rows.push(userMessage(`u${turn}`, `t${turn}`, ts, `turn ${turn} ask`));
      rows.push(
        toolCallMessage({ id: `c${turn}`, turnId: `t${turn}`, ts: ts + 1, toolName: 'read_file' }),
      );
      rows.push(
        toolResultMessage({
          id: `r${turn}`,
          toolUseId: `c${turn}`,
          turnId: `t${turn}`,
          ts: ts + 2,
          text: bigResult,
        }),
      );
      rows.push(
        assistantMessage({
          id: `a${turn}`,
          turnId: `t${turn}`,
          ts: ts + 3,
          text: `turn ${turn} done`,
        }),
      );
      if (rows.length >= 400) {
        await store.appendMessages(sessionId, [...rows]);
        rows.length = 0;
      }
    }
    if (rows.length > 0) await store.appendMessages(sessionId, [...rows]);
    await store.close?.();

    const outPath = join(workspaceRoot, 'scale.md');
    const before = process.memoryUsage.rss();
    const startedAt = Date.now();
    const result = await exportSessionTranscriptMarkdownToFile({
      sources,
      workspaceRoot,
      sessionId,
      outPath,
      now: () => 0,
    });
    const seconds = (Date.now() - startedAt) / 1000;
    const rssDeltaMb = (process.memoryUsage.rss() - before) / 1e6;
    // The numbers the PR owes #5958: ~50 MB of tool-result content streamed to
    // disk without materializing the document.
    console.log(
      `[scale] turns=1000 content≈48MB bytes=${result.ok ? result.bytes : '?'} ` +
        `rssDelta=${rssDeltaMb.toFixed(0)}MB time=${seconds.toFixed(1)}s`,
    );
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(result.ok && result.bytes > 50_000_000, 'the whole transcript reached the file');
    assert.ok(
      rssDeltaMb < 200,
      `streaming export must not balloon RSS: +${rssDeltaMb.toFixed(0)}MB`,
    );
    assert.ok(seconds < 120, `export took ${seconds.toFixed(1)}s`);
  });
});
