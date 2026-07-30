import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import { createSessionStore } from '../session-store.js';
import { createSettingsStore } from '../settings-store.js';

function makeHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka-workspace',
    cwd: '/tmp/maka-workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Usage fixture',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic',
    connectionLocked: true,
    model: 'claude-sonnet-4',
    permissionMode: 'ask',
    schemaVersion: 1,
    ...overrides,
  };
}

async function seedSession(
  workspaceRoot: string,
  header: SessionHeader,
  messages: StoredMessage[],
) {
  const sessionDir = join(workspaceRoot, 'sessions', header.id);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, 'session.jsonl'),
    [header, ...messages].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
}

describe('SettingsStore.usageStats request logs', () => {
  it('uses canonical SQLite metadata for transcript-marker sessions', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-sqlite-'));
    const sessions = createSessionStore(workspaceRoot);
    try {
      const header = await sessions.create({
        cwd: '/tmp/maka-workspace',
        backend: 'ai-sdk',
        llmConnectionSlug: 'sqlite-provider',
        model: 'sqlite-default-model',
        permissionMode: 'ask',
      });
      await sessions.appendMessages(header.id, [
        {
          type: 'assistant',
          id: 'assistant-1',
          turnId: 'turn-1',
          ts: 10,
          text: 'tracked',
          modelId: 'sqlite-runtime-model',
        },
        {
          type: 'token_usage',
          id: 'usage-1',
          turnId: 'turn-1',
          ts: 20,
          input: 8,
          output: 2,
        },
      ]);

      const stats = await createSettingsStore(workspaceRoot).usageStats('all');

      assert.equal(stats.summary.totalTokens, 10);
      assert.equal(stats.logs[0]?.provider, 'sqlite-provider');
      assert.equal(stats.logs[0]?.model, 'sqlite-runtime-model');
    } finally {
      await sessions.close?.();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('includes tool invocation rows without inflating model usage totals', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-'));
    try {
      await seedSession(workspaceRoot, makeHeader(), [
        {
          type: 'assistant',
          id: 'assistant-1',
          turnId: 'turn-1',
          ts: 10,
          text: 'I will inspect it.',
          modelId: 'claude-sonnet-4-runtime',
        },
        {
          type: 'tool_call',
          id: 'tool-1',
          turnId: 'turn-1',
          ts: 11,
          toolName: 'Bash',
          displayName: '终端',
          args: { cmd: 'pwd' },
        },
        {
          type: 'tool_result',
          id: 'tool-result-1',
          turnId: 'turn-1',
          ts: 15,
          toolUseId: 'tool-1',
          isError: true,
          durationMs: 37,
          content: { kind: 'text', text: 'failed' },
        },
        {
          type: 'token_usage',
          id: 'usage-1',
          turnId: 'turn-1',
          ts: 20,
          input: 120,
          output: 30,
          cacheMissInput: 105,
          cacheRead: 10,
          cacheCreation: 5,
          reasoning: 4,
          costUsd: 0.01,
        },
      ]);

      const stats = await createSettingsStore(workspaceRoot).usageStats('all');

      assert.equal(stats.summary.totalRequests, 1, 'summary counts model requests only');
      assert.equal(stats.summary.totalTokens, 150);
      assert.equal(stats.summary.totalCostUsd, 0.01);
      assert.equal(stats.summary.cacheMiss, 105);
      assert.equal(stats.summary.cacheRead, 10);
      assert.equal(stats.summary.cacheCreation, 5);
      assert.equal(stats.summary.reasoning, 4);
      assert.equal(stats.byProvider.length, 1, 'provider aggregates remain model-only');
      assert.equal(stats.byModel.length, 1, 'model aggregates remain model-only');

      const modelLog = stats.logs.find((log) => log.kind === 'model');
      assert.ok(modelLog);
      assert.equal(modelLog.sessionId, 'session-1');
      assert.equal(modelLog.turnId, 'turn-1');
      assert.equal(modelLog.model, 'claude-sonnet-4-runtime');
      assert.equal(modelLog.inputTokens, 120);
      assert.equal(modelLog.outputTokens, 30);
      assert.equal(modelLog.cacheMiss, 105);
      assert.equal(modelLog.cacheRead, 10);
      assert.equal(modelLog.cacheCreation, 5);
      assert.equal(modelLog.reasoning, 4);

      const toolLog = stats.logs.find((log) => log.kind === 'tool');
      assert.ok(toolLog);
      assert.equal(toolLog.id, 'tool:tool-1');
      assert.equal(toolLog.sessionId, 'session-1');
      assert.equal(toolLog.turnId, 'turn-1');
      assert.equal(toolLog.provider, 'anthropic');
      assert.equal(toolLog.model, 'claude-sonnet-4');
      assert.equal(toolLog.toolName, '终端');
      assert.equal(toolLog.inputTokens, 0);
      assert.equal(toolLog.outputTokens, 0);
      assert.equal(toolLog.latencyMs, 37);
      assert.equal(toolLog.status, 'error');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('merges tool stats by tool name across sessions instead of one row per session', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-bytool-'));
    try {
      // Two sessions each call Bash; the second also calls Read. Tool-call ids
      // are only unique within a session, so both sessions reuse `bash`/`read`
      // ids to prove result matching stays session-scoped after the merge.
      const bashTurn = (sessionId: string, error: boolean, duration: number): StoredMessage[] => [
        {
          type: 'tool_call',
          id: 'bash',
          turnId: 't1',
          ts: 10,
          toolName: 'Bash',
          displayName: '终端',
          args: {},
        },
        {
          type: 'tool_result',
          id: 'bash-result',
          turnId: 't1',
          ts: 10 + duration,
          toolUseId: 'bash',
          isError: error,
          durationMs: duration,
          content: { kind: 'text', text: error ? 'failed' : 'ok' },
        },
      ];

      await seedSession(workspaceRoot, makeHeader({ id: 'session-a' }), [
        ...bashTurn('session-a', false, 20),
        {
          type: 'tool_call',
          id: 'read',
          turnId: 't1',
          ts: 12,
          toolName: 'Read',
          displayName: '读取',
          args: {},
        },
        {
          type: 'tool_result',
          id: 'read-result',
          turnId: 't1',
          ts: 40,
          toolUseId: 'read',
          isError: false,
          durationMs: 28,
          content: { kind: 'text', text: 'ok' },
        },
      ]);
      await seedSession(workspaceRoot, makeHeader({ id: 'session-b' }), [
        ...bashTurn('session-b', true, 40),
      ]);

      const stats = await createSettingsStore(workspaceRoot).usageStats('all');

      // One row per tool name — never a duplicate Bash row per session.
      assert.equal(stats.byTool.length, 2, 'byTool must have one row per unique tool');
      const bash = stats.byTool.find((row) => row.tool === 'Bash');
      assert.ok(bash, 'a single merged Bash row must exist');
      assert.equal(bash.calls, 2, 'Bash calls merge across sessions');
      assert.equal(bash.success, 1, 'the successful Bash call is counted');
      assert.equal(bash.errors, 1, 'the failed Bash call is counted');
      assert.equal(bash.avgDurationMs, 30, 'Bash duration averages (20 + 40) / 2 across sessions');

      const read = stats.byTool.find((row) => row.tool === 'Read');
      assert.ok(read);
      assert.equal(read.calls, 1);
      assert.equal(read.avgDurationMs, 28);

      // Rows are ordered by call count desc so the busiest tool leads.
      assert.deepEqual(
        stats.byTool.map((row) => row.tool),
        ['Bash', 'Read'],
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('keeps valid usage rows when one session message line is corrupt', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-corrupt-line-'));
    try {
      const header = makeHeader();
      const sessionDir = join(workspaceRoot, 'sessions', header.id);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify(header),
          JSON.stringify({
            type: 'assistant',
            id: 'assistant-1',
            turnId: 'turn-1',
            ts: 10,
            text: 'tracked',
            modelId: 'runtime-model',
          }),
          '{"type":"tool_call"',
          JSON.stringify({
            type: 'token_usage',
            id: 'usage-1',
            turnId: 'turn-1',
            ts: 20,
            input: 10,
            output: 5,
            cacheRead: 2,
            costUsd: 0.02,
          }),
        ].join('\n') + '\n',
      );

      const stats = await createSettingsStore(workspaceRoot).usageStats('all');

      assert.equal(stats.summary.totalRequests, 1);
      assert.equal(stats.summary.totalTokens, 15);
      assert.equal(stats.summary.cacheRead, 2);
      assert.equal(stats.summary.totalCostUsd, 0.02);
      assert.equal(stats.logs[0]?.model, 'runtime-model');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('ignores malformed usage rows instead of poisoning totals', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-settings-usage-bad-token-row-'));
    try {
      const header = makeHeader();
      const sessionDir = join(workspaceRoot, 'sessions', header.id);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'session.jsonl'),
        [
          JSON.stringify(header),
          JSON.stringify({
            type: 'token_usage',
            id: 'bad-usage',
            turnId: 'turn-1',
            ts: 20,
            input: '10',
            output: 5,
          }),
          JSON.stringify({
            type: 'token_usage',
            id: 'good-usage',
            turnId: 'turn-2',
            ts: 30,
            input: 7,
            output: 3,
          }),
        ].join('\n') + '\n',
      );

      const stats = await createSettingsStore(workspaceRoot).usageStats('all');

      assert.equal(stats.summary.totalRequests, 1);
      assert.equal(stats.summary.totalTokens, 10);
      assert.equal(stats.logs.length, 1);
      assert.equal(stats.logs[0]?.id, 'good-usage');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
