import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import type { ToolOutcomeCommit, ToolPreparedCommit } from '../runtime-commit-sink.js';
import type { MakaTool } from '../tool-runtime.js';

import { createTestToolRuntime } from './execution-boundary-test-helpers.js';

/**
 * #2253: a stop that lands while an AskUserQuestion is parked ends the turn
 * before the tool's own unwind runs. endTurn clears the per-turn durable
 * attempt map synchronously, and the question's rejection reaches the
 * executor a microtask later, so the synthetic error result used to be
 * written without its operation identity. A response for a dispatched
 * operation that carries no operationId is exactly what the tool ledger
 * rejects as identity_conflict, and that rejection latched the whole
 * RuntimeEvent store (the amplifier half of the issue, pinned in
 * session-manager-terminal-ledger.test.ts).
 */
describe('ToolRuntime turn-close outcome identity', () => {
  it('keeps the operation identity on a result synthesized after endTurn', async () => {
    const prepared: ToolPreparedCommit[] = [];
    const outcomes: ToolOutcomeCommit[] = [];
    const events: SessionEvent[] = [];
    const messages: StoredMessage[] = [];
    const runtime = createTestToolRuntime({
      sessionId: 'session-1',
      header: header(),
      connection: connection(),
      modelId: 'model-1',
      appendMessage: async (message) => {
        messages.push(message);
      },
      newId: nextId(),
      now: nextNow(),
      getPermissionPauseTarget: () => null,
      runId: 'run-1',
      runtimeCommitSink: {
        commitToolPrepared: async (input) => {
          prepared.push(input);
          return { created: true, runtimeEventSeq: prepared.length };
        },
        commitToolOutcome: async (input) => {
          outcomes.push(input);
          return { created: true, runtimeEventSeq: 100 + outcomes.length };
        },
      },
    });

    const ask: MakaTool = {
      name: 'AskUserQuestion',
      description: 'ask',
      parameters: {},
      recoveryMode: 'never_auto_retry',
      impl: (_args, context) => {
        if (!context.askUserQuestion) throw new Error('askUserQuestion missing from context');
        return context.askUserQuestion([
          { question: 'q?', options: [{ label: 'a' }, { label: 'b' }] },
        ]);
      },
    };

    const settled = runtime.settleToolCall({
      tool: ask,
      turnId: 'turn-1',
      toolCallId: 'provider-call-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => {
          events.push(event);
        },
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });
    // The question is parked once T1 committed and the request event is out.
    await waitFor(
      () => prepared.length === 1 && events.some((event) => event.type === 'user_question_request'),
    );

    // The stop path: endTurn rejects the parked question and resets the
    // per-turn state in the same synchronous body. The tool's unwind runs
    // after both.
    await runtime.endTurn('aborted');
    // Ordering is part of the contract: the run's terminal fact is settled
    // right after the stop resolves, and the store keeps the terminal event
    // as the immutable ledger tail, so the aborted operation's outcome must
    // already be committed by the time endTurn hands back.
    assert.equal(outcomes.length, 1);
    await settled;

    const result = events.find(
      (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
        event.type === 'tool_result',
    );
    assert.ok(result, 'expected a synthesized tool_result for the closed question');
    assert.equal(result.isError, true);
    // The identity link is the whole point: a response for a dispatched
    // operation without its operationId is an identity_conflict to the
    // ledger, which then refuses the write.
    assert.equal(result.operationId, prepared[0]?.operationId);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.operationId, prepared[0]?.operationId);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition never became true');
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace/repo',
    cwd: '/workspace/repo',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'test',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

function nextNow(): () => number {
  let value = 0;
  return () => ++value;
}
