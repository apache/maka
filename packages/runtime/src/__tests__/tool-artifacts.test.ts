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

import { nextId } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import type { SessionEvent } from '@maka/core/events';
import {
  deriveToolArtifactCandidates,
  extractStdoutRedirectPath,
  recordToolArtifactsSafely,
} from '../tool-artifacts.js';
import { ToolRuntime, type MakaTool, type ToolRuntimeInput } from '../tool-runtime.js';

describe('deriveToolArtifactCandidates', () => {
  test('Write derives a file-backed candidate from structured result path', () => {
    const [candidate] = deriveToolArtifactCandidates({
      toolName: 'Write',
      cwd: '/workspace/maka',
      args: { path: 'docs/report.html', content: '<h1>Report</h1>' },
      result: { ok: true, path: '/workspace/maka/docs/report.html', bytes: 15 },
    });

    assert.deepStrictEqual(candidate, {
      kind: 'html',
      name: 'report.html',
      mimeType: 'text/html',
      source: 'tool_result',
      summary: 'Write tool output',
      sourcePath: '/workspace/maka/docs/report.html',
    });
  });

  test('Edit derives a diff candidate from structured edit args', () => {
    const [candidate] = deriveToolArtifactCandidates({
      toolName: 'Edit',
      cwd: '/workspace/maka',
      args: { path: 'src/main.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      result: { ok: true, path: '/workspace/maka/src/main.ts', replacements: 1 },
    });

    assert.strictEqual(candidate?.kind, 'diff');
    assert.strictEqual(candidate?.name, 'main.ts.diff');
    assert.strictEqual(candidate?.mimeType, 'text/x-diff');
    assert.strictEqual(
      typeof candidate?.content === 'string' && candidate.content.includes('-const a = 1;'),
      true,
    );
    assert.strictEqual(
      typeof candidate?.content === 'string' && candidate.content.includes('+const a = 2;'),
      true,
    );
  });

  test('Bash derives only explicit stdout redirects and does not scan stdout/stderr text', () => {
    const [candidate] = deriveToolArtifactCandidates({
      toolName: 'Bash',
      cwd: '/workspace/maka',
      args: { command: 'npm run build > "reports/build.log" 2>&1' },
      result: { stdout: 'wrote /tmp/guessed.html', stderr: 'see report.pdf' },
    });

    assert.strictEqual(candidate?.sourcePath, '/workspace/maka/reports/build.log');
    assert.strictEqual(candidate?.kind, 'file');

    assert.deepStrictEqual(
      deriveToolArtifactCandidates({
        toolName: 'Bash',
        cwd: '/workspace/maka',
        args: { command: 'echo "wrote reports/build.log"' },
        result: { stdout: 'reports/build.log' },
      }),
      [],
    );
  });

  test('extractStdoutRedirectPath ignores stderr and fd redirects', () => {
    assert.strictEqual(extractStdoutRedirectPath('echo ok > out.txt'), 'out.txt');
    assert.strictEqual(extractStdoutRedirectPath('echo ok >> ./out.txt'), './out.txt');
    assert.strictEqual(extractStdoutRedirectPath('echo ok 2> err.log'), null);
    assert.strictEqual(extractStdoutRedirectPath('echo ok >&2'), null);
  });
});

describe('recordToolArtifactsSafely', () => {
  test('recorder failure emits a generalized warning and never throws', async () => {
    const warnings: string[] = [];
    await recordToolArtifactsSafely(
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolUseId: 'tool-1',
        toolName: 'Write',
        cwd: '/workspace/maka',
        args: { path: 'secret.txt' },
        result: { ok: true, path: '/workspace/maka/secret.txt' },
      },
      async () => {
        throw new Error('EACCES: sk-secret-token-should-not-leak');
      },
      (message) => warnings.push(message),
    );

    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0]?.includes('Artifact recorder skipped:'), true);
    assert.strictEqual(warnings[0]?.includes('sk-secret-token-should-not-leak'), false);
  });
});

describe('ToolRuntime artifact recorder scheduling', () => {
  test('ordinary tool results do not wait for a slow artifact recorder', async () => {
    const calls: unknown[] = [];
    const { runtime, events } = makeToolRuntime({
      recordToolArtifacts: (input) => {
        calls.push(input);
        return new Promise(() => {});
      },
    });
    const outcome = await Promise.race([
      runtime
        .settleToolCall({
          tool: writeArtifactTool(),
          turnId: 'turn-1',
          toolCallId: 'tool-1',
          input: { path: 'notes.md', content: 'hello' },
          abortSignal: new AbortController().signal,
          eventSink: {
            push: (event) => events.push(event),
            pushAndWaitUntilConsumed: async (event) => {
              events.push(event);
            },
          },
        })
        .then(() => 'done' as const),
      delay(20).then(() => 'timeout' as const),
    ]);

    assert.strictEqual(outcome, 'done');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      events.some((event) => event.type === 'tool_result' && event.toolUseId === 'tool-1'),
      true,
    );
  });
});

function makeToolRuntime(overrides: Partial<ToolRuntimeInput> = {}): {
  runtime: ToolRuntime;
  events: SessionEvent[];
} {
  const events: SessionEvent[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: testHeader(),
    connection: testConnection(),
    modelId: 'mock-model',
    appendMessage: async () => {},
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
    ...overrides,
  });
  return { runtime, events };
}

function writeArtifactTool(): MakaTool {
  return {
    name: 'Write',
    description: 'write file',
    parameters: {},
    impl: async (args) => {
      const path =
        typeof (args as { path?: unknown }).path === 'string'
          ? (args as { path: string }).path
          : 'notes.md';
      return { ok: true, path: `/workspace/maka/${path}`, bytes: 5 };
    },
  };
}

function testHeader(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace/maka',
    cwd: '/workspace/maka',
    createdAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'mock-model',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function testConnection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'mock-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
