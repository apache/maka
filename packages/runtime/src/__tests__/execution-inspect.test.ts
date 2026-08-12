import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  AgentRunEvent,
  AgentRunEventType,
  AgentRunHeader,
  EmittedAgentRunEvent,
} from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { createSessionStore } from '@maka/storage';
import { createSqliteAgentRunStore, createWorkspaceRuntimeStore } from '@maka/storage';
import { inspectAgentRunDocument, renderAgentRunInspectTree } from '../execution-inspect.js';

describe('versioned execution inspect documents', () => {
  test('reports unknown tool outcomes without copying Runtime payloads', async () => {
    await withWorkspace(async (root) => {
      const sessionStore = createSessionStore(root);
      const runStore = createSqliteAgentRunStore(root);
      const runtimeStore = createWorkspaceRuntimeStore(root);
      const session = await sessionStore.create({
        cwd: '/tmp/workspace',
        backend: 'fake',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const header = runHeader(session.id);
      await runStore.createRun(header);
      await runStore.appendEvent(session.id, RUN_ID, runEvent(session.id, 'run_completed'));
      await runtimeStore.appendRuntimeEvent(
        session.id,
        RUN_ID,
        runtimeEvent(session.id, 'call', {
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-pending',
            name: 'Write',
            args: { path: 'private.txt', content: 'DO_NOT_COPY' },
          },
        }),
      );
      await runtimeStore.appendRuntimeEvent(
        session.id,
        RUN_ID,
        runtimeEvent(session.id, 'terminal', {
          role: 'system',
          author: 'system',
          status: 'completed',
          actions: { endInvocation: true },
        }),
      );

      const document = await inspectAgentRunDocument(runStore, runtimeStore, {
        sessionId: session.id,
        agentRunId: RUN_ID,
      });

      assert.equal(document.schemaVersion, 'maka.agent_run_inspect.v1');
      assert.deepEqual(document.tools.callsWithoutResponse, [
        {
          toolCallId: 'tool-pending',
          toolName: 'Write',
          eventId: 'call',
        },
      ]);
      assert.equal(document.sources.runtimeCoverage?.highWater.sequence, 1);
      assert.equal(
        document.diagnostics.some((item) => item.code === 'tool_response_missing'),
        true,
      );
      const json = JSON.stringify(document);
      assert.equal(json.includes('private.txt'), false);
      assert.equal(json.includes('DO_NOT_COPY'), false);
      assert.match(
        renderAgentRunInspectTree(document),
        /outcome and external side effects are unknown/,
      );
    });
  });
});

const RUN_ID = 'run-1';
const TURN_ID = 'turn-1';
const TS = 1_800_000_000_000;

function runHeader(sessionId: string): AgentRunHeader {
  return {
    runId: RUN_ID,
    invocationId: 'invocation-1',
    sessionId,
    turnId: TURN_ID,
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/workspace',
    permissionMode: 'ask',
    createdAt: TS,
    updatedAt: TS + 1,
    completedAt: TS + 1,
  };
}

function runEvent(sessionId: string, type: AgentRunEventType): EmittedAgentRunEvent {
  return { id: `op-${type}`, type, runId: RUN_ID, sessionId, turnId: TURN_ID, ts: TS + 1 };
}

function runtimeEvent(
  sessionId: string,
  id: string,
  overrides: Partial<RuntimeEvent>,
): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: RUN_ID,
    sessionId,
    turnId: TURN_ID,
    ts: TS,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-execution-inspect-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
