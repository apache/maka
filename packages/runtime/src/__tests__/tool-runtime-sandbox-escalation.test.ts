import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';

import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';

import { ApprovalCoordinator, type AutoApprovalReviewer } from '../approval-reviewer.js';
import { PermissionEngine } from '../permission-engine.js';
import { planDeclaredBashSandboxEscalation } from '../sandbox-escalation.js';
import { ToolRuntime, type MakaTool, type MakaToolContext } from '../tool-runtime.js';

const command = 'printf approved > /outside/result.txt';
const declaration = {
  mode: 'require_escalated',
  justification: 'Write the exact requested output.',
} as const;
const args = { command, sandbox_permissions: declaration };

describe('ToolRuntime sandbox escalation orchestration', () => {
  test('auto-reviews execute mode, emits no interactive request, and exposes one exact grant', async () => {
    let receivedContext: MakaToolContext['permissionContext'];
    const h = harness({
      review: async () => ({
        outcome: 'allow',
        riskLevel: 'high',
        rationale: 'Authorized exact action.',
      }),
    });
    const result = await settle(
      h,
      bashTool((_args, context) => {
        receivedContext = context.permissionContext;
        return { ok: true };
      }),
      'turn-1',
      'tool-1',
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(
      h.events.some((event) => event.type === 'permission_request'),
      false,
    );
    assert.equal(receivedContext?.sandboxEscalationGrant?.command, command);
    assert.equal(receivedContext?.sandboxEscalationGrant?.cwd, '/tmp');
    const decision = h.messages.find((message) => message.type === 'permission_decision');
    assert.equal(decision?.reviewer, 'auto_review');
    assert.equal(decision?.riskLevel, 'high');
  });

  test('auto-review denial never invokes the command and blocks a same-turn duplicate', async () => {
    let called = false;
    let reviews = 0;
    const h = harness({
      review: async () => {
        reviews += 1;
        return { outcome: 'deny', riskLevel: 'critical', rationale: 'User intent is ambiguous.' };
      },
    });
    const tool = bashTool(() => {
      called = true;
      return { ok: true };
    });

    const first = await settle(h, tool, 'turn-1', 'tool-1');
    const repeated = await settle(h, tool, 'turn-1', 'tool-2');

    assert.equal(called, false);
    assert.deepEqual(first, { error: '自动审批已拒绝权限请求：User intent is ambiguous.' });
    assert.deepEqual(repeated, {
      error:
        '相同的 sandbox 提权请求已在当前轮次中被自动审批拒绝；需要用户发送新的消息后才能重新申请。',
    });
    assert.equal(reviews, 1);
    assert.equal(
      h.events.some((event) => event.type === 'permission_request'),
      false,
    );
  });

  test('fails closed on reviewer failure and permits a new review next turn', async () => {
    let reviews = 0;
    let executions = 0;
    const h = harness({
      review: async () => {
        reviews += 1;
        if (reviews === 1) throw new Error('reviewer unavailable');
        return { outcome: 'allow', riskLevel: 'high', rationale: 'Authorized in the new turn.' };
      },
    });
    const tool = bashTool(() => {
      executions += 1;
      return { ok: true };
    });
    const first = await settle(h, tool, 'turn-1', 'tool-1');
    assert.deepEqual(first, {
      error: '自动审批已拒绝权限请求：Automatic approval review failed closed.',
    });

    h.runtime.endTurn('turn-1');
    h.runtime.beginTurn('turn-2');
    const next = await settle(h, tool, 'turn-2', 'tool-2');
    assert.deepEqual(next, { ok: true });
    assert.equal(reviews, 2);
    assert.equal(executions, 1);
  });
});

function bashTool(impl: MakaTool['impl']): MakaTool {
  return {
    name: 'Bash',
    description: 'test',
    parameters: z.object({
      command: z.string(),
      sandbox_permissions: z.object({
        mode: z.literal('require_escalated'),
        justification: z.string(),
      }),
    }),
    permissionRequired: true,
    planSandboxEscalation: (_args, context) =>
      planDeclaredBashSandboxEscalation({
        declaration,
        command,
        cwd: context.cwd,
        mode: context.mode,
        args: context.args,
      }),
    impl,
  };
}

function settle(
  fixture: ReturnType<typeof harness>,
  tool: MakaTool,
  turnId: string,
  toolCallId: string,
): Promise<unknown> {
  return fixture.runtime
    .settleToolCall({
      tool,
      turnId,
      toolCallId,
      input: args,
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => fixture.events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          fixture.events.push(event);
        },
      },
    })
    .then((settlement) => settlement.result);
}

function harness(autoReviewer: AutoApprovalReviewer) {
  let id = 0;
  const events: SessionEvent[] = [];
  const messages: StoredMessage[] = [];
  const permissionEngine = new PermissionEngine({
    newId: () => `permission-${++id}`,
    now: () => 100,
  });
  const header: SessionHeader = {
    id: 'session-1',
    workspaceRoot: '/tmp',
    cwd: '/tmp',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'c',
    connectionLocked: true,
    model: 'm',
    permissionMode: 'execute',
    schemaVersion: 1,
  };
  const runtime = new ToolRuntime({
    sessionId: 'session-1',
    header,
    connection: { providerType: 'openai', slug: 'c' } as never,
    modelId: 'm',
    appendMessage: async (message) => {
      messages.push(message);
    },
    permissionEngine,
    newId: () => `runtime-${++id}`,
    now: () => 100,
    getPermissionPauseTarget: () => null,
    approvalCoordinator: new ApprovalCoordinator({ autoReviewer }),
    getAutoApprovalReviewContext: () => ({ userIntent: 'Write the exact output.' }),
  });
  runtime.beginTurn('turn-1');
  return { runtime, events, messages };
}
