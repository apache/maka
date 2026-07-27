import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRunHeader } from '@maka/core';
import { createAgentRunStore, createRuntimeEventStore } from '@maka/storage';
import { RuntimeReadModel } from '../runtime-read-model.js';

const sessionId = 'legacy-runtime-event-session';
const runId = 'legacy-runtime-event-run';
const turnId = 'legacy-runtime-event-turn';
const invocationId = 'legacy-runtime-event-invocation';
const fixtureUrl = new URL(
  '../../src/__tests__/fixtures/legacy-runtime-event-subagent-waiting-permission.jsonl',
  import.meta.url,
);

const header: AgentRunHeader = {
  runId,
  invocationId,
  sessionId,
  turnId,
  status: 'completed',
  backendKind: 'fake',
  llmConnectionSlug: 'fake',
  modelId: 'fake-model',
  cwd: '/tmp/legacy-runtime-event-workspace',
  permissionMode: 'ask',
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_003,
  completedAt: 1_800_000_000_003,
};

test('reopens a persisted legacy subagent RuntimeEvent without rewriting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-persisted-compat-'));
  try {
    await createAgentRunStore(root).createRun(header);
    const ledgerPath = join(root, 'sessions', sessionId, 'runs', runId, 'runtime-events.jsonl');
    await copyFile(fixtureUrl, ledgerPath);
    const originalBytes = await readFile(ledgerPath);

    const view = await new RuntimeReadModel({
      runStore: createAgentRunStore(root),
      runtimeEventStore: createRuntimeEventStore(root),
    }).getSessionView(sessionId);

    const persistedResponse = view.events.find(
      (event) => event.content?.kind === 'function_response',
    );
    assert.equal(
      persistedResponse?.content?.kind === 'function_response' &&
        typeof persistedResponse.content.result === 'object' &&
        persistedResponse.content.result !== null
        ? (persistedResponse.content.result as { status?: unknown }).status
        : undefined,
      'waiting_permission',
    );

    const messageResult = view.messages.find((message) => message.type === 'tool_result');
    assert.equal(
      messageResult?.type === 'tool_result' && messageResult.content.kind === 'subagent'
        ? messageResult.content.status
        : undefined,
      'waiting_for_user',
    );
    assert.deepEqual(
      view.messages.map((message) => message.type),
      ['tool_call', 'tool_result', 'turn_state'],
    );

    const replayResult = view.replayPlan.items.find((item) => item.kind === 'tool_result');
    assert.equal(
      replayResult?.kind === 'tool_result' &&
        typeof replayResult.output === 'object' &&
        replayResult.output !== null
        ? (replayResult.output as { status?: unknown }).status
        : undefined,
      'waiting_for_user',
    );

    const hardReadDiagnosticCodes = new Set([
      'incomplete_event',
      'unsupported_event',
      'tool_use_id_mismatch',
    ]);
    assert.equal(
      view.diagnostics.some((diagnostic) => hardReadDiagnosticCodes.has(diagnostic.code)),
      false,
    );
    const blockingReplayDiagnosticCodes = new Set([
      'unsupported_role',
      'unsupported_content',
      'tool_id_mismatch',
    ]);
    assert.equal(
      view.replayPlan.diagnostics.some((diagnostic) =>
        blockingReplayDiagnosticCodes.has(diagnostic.code),
      ),
      false,
    );
    assert.deepEqual(await readFile(ledgerPath), originalBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
