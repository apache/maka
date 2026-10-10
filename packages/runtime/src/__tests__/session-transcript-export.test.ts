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
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { createSessionStore } from '@maka/storage/session-store';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { seedInvocation } from './invocation-fixture.js';
import type { StoredMessage } from '@maka/core/session';
import {
  exportSessionTranscriptMarkdown,
  renderSessionTranscriptMarkdown,
} from '../session-transcript-export.js';

const CONNECTION_SLUG = 'test-connection';
const MODEL = 'test-model';

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
      workspaceRoot,
      sessionId,
      now: () => 0,
    });
    assert.ok(defected.ok, JSON.stringify(defected));
    assert.equal(defected.markdown.includes('the user wants me to hurry'), false);

    const withThinking = await exportSessionTranscriptMarkdown({
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
      workspaceRoot,
      sessionId,
      now: () => 0,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.markdown.includes('token_usage'), false);
    assert.equal(result.markdown.includes('turn_state'), false);
    assert.ok(result.markdown.includes('Hi.'));
  });
});

test('structured failures for missing workspace and session', async () => {
  await withWorkspace('transcript-export-missing', async (workspaceRoot) => {
    const noWorkspace = await exportSessionTranscriptMarkdown({
      workspaceRoot: join(workspaceRoot, 'absent'),
      sessionId: 's1',
    });
    assert.deepEqual(noWorkspace, {
      ok: false,
      reason: { kind: 'workspace_not_found', workspaceRoot: join(workspaceRoot, 'absent') },
    });

    const noSession = await exportSessionTranscriptMarkdown({
      workspaceRoot,
      sessionId: 'does-not-exist',
    });
    assert.ok(!noSession.ok);
    assert.equal(noSession.ok ? null : noSession.reason.kind, 'session_not_found');
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
