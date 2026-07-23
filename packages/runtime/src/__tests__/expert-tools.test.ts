import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { ZodTypeAny } from 'zod';
import { getExpertTeam, materializeExpertAgentDefinition } from '../expert-catalog.js';
import {
  EXPERT_DISPATCH_TOOL_NAME,
  buildExpertDispatchTool,
  buildExpertDispatchToolForTeamId,
} from '../expert-tools.js';
import { expect } from '../test-helpers.js';
import type { Task, TaskAgentOutcome, TaskLedgerStore, TaskOwner } from '@maka/core';

const CODE_REVIEW = getExpertTeam('code-review')!;

function fakeCtx(calls: unknown[], result?: Record<string, unknown>) {
  const abortController = new AbortController();
  return {
    sessionId: 'session-1',
    turnId: 'lead-turn',
    cwd: '/tmp/cwd',
    toolCallId: 'tool-1',
    abortSignal: abortController.signal,
    emitOutput: () => {},
    spawnChildAgent: async (input: unknown) => {
      calls.push(input);
      const spec = (input as { spec: { id: string; name: string } }).spec;
      return {
        agentId: spec.id,
        agentName: spec.name,
        turnId: 'child-turn',
        status: 'completed',
        permissionMode: 'explore',
        summary: 'reviewed',
        artifactIds: ['artifact-1'],
        ...result,
      };
    },
  };
}

function recordingTaskLedger(task: Task): {
  taskLedger: TaskLedgerStore;
  outcomes: TaskAgentOutcome[];
} {
  const outcomes: TaskAgentOutcome[] = [];
  const taskLedger = {
    list: async () => [task],
    get: async () => task,
    create: async () => ({ created: [], total: 1 }),
    update: async () => ({ updated: task, total: 1 }),
    claim: async (_sessionId: string, _id: string, owner: TaskOwner) => ({
      updated: { ...task, owner },
      total: 1,
    }),
    claimAvailable: async (_sessionId: string, _id: string, owner: TaskOwner) => ({
      updated: { ...task, owner },
      total: 1,
    }),
    settleAgentOutcome: async (_sessionId: string, _id: string, outcome: TaskAgentOutcome) => {
      outcomes.push(outcome);
      task.owner = outcome.owner;
      return { updated: task, total: 1 };
    },
    subscribe: () => () => {},
  } satisfies TaskLedgerStore;
  return { taskLedger, outcomes };
}

describe('expert_dispatch tool', () => {
  test('exposes a member enum and roster description bound to the team', () => {
    const tool = buildExpertDispatchTool(CODE_REVIEW);
    expect(tool.name).toBe(EXPERT_DISPATCH_TOOL_NAME);
    expect(tool.permissionRequired).toBe(true);
    expect(tool.categoryHint).toBe('subagent');
    expect(tool.description).toContain('correctness-reviewer');
    expect(tool.description).toContain('Code Review Team');
    // The member param is a closed enum of the team's members.
    const parsed = (tool.parameters as ZodTypeAny).safeParse({ member: 'not-a-member', task: 'x' });
    expect(parsed.success).toBe(false);
  });

  test('dispatches a member through spawnChildAgent with the materialized spec', async () => {
    const tool = buildExpertDispatchTool(CODE_REVIEW);
    const calls: unknown[] = [];
    const member = CODE_REVIEW.members[0]!;
    const def = materializeExpertAgentDefinition(CODE_REVIEW, member);

    const result = await tool.impl(
      { member: member.id, task: 'Review the diff in src/foo.ts.' },
      fakeCtx(calls) as never,
    );

    expect(calls).toEqual([
      {
        spec: {
          id: 'expert:code-review:correctness-reviewer',
          name: def.name,
          systemPrompt: def.systemPrompt,
        },
        prompt: 'Review the diff in src/foo.ts.',
      },
    ]);
    expect(result).toMatchObject({
      kind: 'subagent',
      agentId: 'expert:code-review:correctness-reviewer',
      agentName: 'Correctness Reviewer',
      status: 'completed',
      summary: 'reviewed',
    });
    expect((result as { artifactIds: string[] }).artifactIds).toEqual(['artifact-1']);
  });

  test('supports concurrent dispatch of independent members', async () => {
    const tool = buildExpertDispatchTool(CODE_REVIEW);
    const calls: unknown[] = [];
    const ctx = fakeCtx(calls) as never;

    const results = await Promise.all([
      tool.impl({ member: 'correctness-reviewer', task: 'a' }, ctx),
      tool.impl({ member: 'simplification-reviewer', task: 'b' }, ctx),
      tool.impl({ member: 'test-coverage-reviewer', task: 'c' }, ctx),
    ]);

    expect(results).toHaveLength(3);
    expect(calls).toHaveLength(3);
    const dispatchedIds = calls.map((call) => (call as { spec: { id: string } }).spec.id);
    expect(dispatchedIds).toEqual([
      'expert:code-review:correctness-reviewer',
      'expert:code-review:simplification-reviewer',
      'expert:code-review:test-coverage-reviewer',
    ]);
  });

  test('settles a member self-claimed task with the real child run refs without auto-completing it', async () => {
    const task: Task = {
      id: 'task-1',
      key: 'T1',
      subject: 'review correctness',
      status: 'in_progress',
      owner: {
        actor: 'child_agent',
        agentId: 'expert:code-review:correctness-reviewer',
        runId: 'claimed-child-run',
        turnId: 'child-turn',
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const { taskLedger, outcomes } = recordingTaskLedger(task);
    const tool = buildExpertDispatchTool(CODE_REVIEW, { taskLedger });
    const base = fakeCtx([]) as ReturnType<typeof fakeCtx>;
    base.spawnChildAgent = async (raw: unknown) => {
      const input = raw as {
        onReady?: (value: {
          turnId: string;
          agentId: string;
          agentName: string;
        }) => void | Promise<void>;
      };
      await input.onReady?.({
        turnId: 'child-turn',
        agentId: 'expert:code-review:correctness-reviewer',
        agentName: 'Correctness Reviewer',
      });
      return {
        agentId: 'expert:code-review:correctness-reviewer',
        agentName: 'Correctness Reviewer',
        turnId: 'child-turn',
        runId: 'child-run',
        status: 'completed',
        permissionMode: 'explore',
        summary: 'evidence only',
        artifactIds: [],
      };
    };
    await tool.impl({ member: 'correctness-reviewer', task: 'review' }, base as never);
    assert.deepEqual(outcomes, [
      {
        status: 'completed',
        owner: {
          actor: 'child_agent',
          agentId: 'expert:code-review:correctness-reviewer',
          runId: 'child-run',
          turnId: 'child-turn',
        },
        reason: 'evidence only',
      },
    ]);
    assert.equal(task.status, 'in_progress');
  });

  test('settles cancellation, timeout failure, and user-waiting outcomes through the Task Ledger', async () => {
    const cases = [
      { status: 'cancelled', failureClass: 'parent_cancelled' },
      { status: 'failed', failureClass: 'timeout' },
      { status: 'waiting_for_user', failureClass: 'permission_required' },
    ] as const;
    for (const { status, failureClass } of cases) {
      const task: Task = {
        id: `task-${status}`,
        key: `T-${status}`,
        subject: status,
        status: 'in_progress',
        owner: {
          actor: 'child_agent',
          agentId: 'expert:code-review:correctness-reviewer',
          runId: 'claimed-child-run',
          turnId: 'child-turn',
        },
        createdAt: 1,
        updatedAt: 1,
      };
      const { taskLedger, outcomes } = recordingTaskLedger(task);
      const tool = buildExpertDispatchTool(CODE_REVIEW, { taskLedger });
      const ctx = fakeCtx([], { status, failureClass });
      const spawn = ctx.spawnChildAgent;
      ctx.spawnChildAgent = async (raw: unknown) => {
        const input = raw as {
          onReady?: (value: {
            turnId: string;
            agentId: string;
            agentName: string;
          }) => void | Promise<void>;
        };
        await input.onReady?.({
          turnId: 'child-turn',
          agentId: 'expert:code-review:correctness-reviewer',
          agentName: 'Correctness Reviewer',
        });
        return await spawn(raw);
      };

      await tool.impl({ member: 'correctness-reviewer', task: 'review' }, ctx as never);
      assert.deepEqual(outcomes, [
        {
          status,
          owner: {
            actor: 'child_agent',
            agentId: 'expert:code-review:correctness-reviewer',
            runId: 'claimed-child-run',
            turnId: 'child-turn',
          },
          reason: failureClass,
        },
      ]);
    }
  });

  test('records a startup failure for a task claimed before the child throws', async () => {
    const task: Task = {
      id: 'task-failed',
      key: 'T-failed',
      subject: 'failed',
      status: 'in_progress',
      owner: {
        actor: 'child_agent',
        agentId: 'expert:code-review:correctness-reviewer',
        runId: 'claimed-child-run',
        turnId: 'child-turn',
      },
      createdAt: 1,
      updatedAt: 1,
    };
    const { taskLedger, outcomes } = recordingTaskLedger(task);
    const tool = buildExpertDispatchTool(CODE_REVIEW, { taskLedger });
    const ctx = fakeCtx([]);
    ctx.spawnChildAgent = async (raw: unknown) => {
      const input = raw as {
        onReady?: (value: {
          turnId: string;
          agentId: string;
          agentName: string;
        }) => void | Promise<void>;
      };
      await input.onReady?.({
        turnId: 'child-turn',
        agentId: 'expert:code-review:correctness-reviewer',
        agentName: 'Correctness Reviewer',
      });
      throw new Error('child startup failed');
    };

    await assert.rejects(
      async () => await tool.impl({ member: 'correctness-reviewer', task: 'review' }, ctx as never),
      /child startup failed/,
    );
    assert.deepEqual(outcomes, [
      {
        status: 'failed',
        owner: {
          actor: 'child_agent',
          agentId: 'expert:code-review:correctness-reviewer',
          runId: 'claimed-child-run',
          turnId: 'child-turn',
        },
        reason: 'child startup failed',
      },
    ]);
  });

  test('fails clearly when the runtime lacks the spawnChildAgent capability', async () => {
    const tool = buildExpertDispatchTool(CODE_REVIEW);
    await assert.rejects(async () => {
      await tool.impl({ member: 'correctness-reviewer', task: 'x' }, {
        sessionId: 's',
        turnId: 't',
        cwd: '/tmp',
        toolCallId: 'c',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      } as never);
    }, /spawnChildAgent capability is unavailable/);
  });

  test('builds a tool by team id and returns undefined for unknown teams', () => {
    expect(buildExpertDispatchToolForTeamId('code-review')?.name).toBe(EXPERT_DISPATCH_TOOL_NAME);
    expect(buildExpertDispatchToolForTeamId('no-such-team')).toBeUndefined();
  });
});
