import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection, SessionEvent, SessionHeader, ToolInvocationRecord } from '@maka/core';
import {
  AGENT_SWARM_DEFAULT_CONCURRENCY,
  AGENT_SWARM_DEFAULT_ITEM_TIMEOUT_MS,
  AGENT_SWARM_MAX_CONCURRENCY,
  AGENT_SWARM_MAX_ITEMS,
  AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER,
  AGENT_SWARM_TOOL_NAME,
  buildAgentSwarmTool,
  type AgentSwarmExplicitItemInput,
  type AgentSwarmToolInput,
  type AgentSwarmToolResult,
} from '../agent-swarm-tools.js';
import {
  AGENT_WORKSPACE_SAME_WORKSPACE,
  AGENT_WORKSPACE_WORKTREE,
  AGENT_WRITE_BACK_PATCH,
  AGENT_WRITE_BACK_SUMMARY,
  IMPLEMENTATION_AGENT_PROFILE,
  LOCAL_READ_AGENT_PROFILE,
  requireBuiltinAgentDefinitionByProfile,
} from '../agent-catalog.js';
import { buildChildAgentTools, AGENT_TOOL_NAMES } from '../subagent-tools.js';
import type { SpawnChildAgentResult } from '../session-manager.js';
import { PermissionEngine } from '../permission-engine.js';
import type { RunTraceLike } from '../run-trace.js';
import {
  MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN,
  ToolRuntime,
  type MakaTool,
  type MakaToolContext,
} from '../tool-runtime.js';

describe('AgentSwarm adapter', () => {
  test('declares a bounded schema and joins the deferred parent Agent group', () => {
    const tool = buildAgentSwarmTool();
    const schema = tool.parameters as {
      safeParse(input: unknown): {
        success: boolean;
        data?: AgentSwarmToolInput;
      };
    };

    assert.equal(tool.name, AGENT_SWARM_TOOL_NAME);
    assert.equal(tool.permissionRequired, true);
    assert.equal(tool.categoryHint, 'subagent');
    assert.equal(AGENT_SWARM_DEFAULT_ITEM_TIMEOUT_MS, 2 * 60 * 60 * 1_000);
    assert.equal(([...AGENT_TOOL_NAMES] as string[]).includes(AGENT_SWARM_TOOL_NAME), true);
    assert.deepEqual(
      schema.safeParse({
        items: [
          {
            item_id: 'auth',
            profile: LOCAL_READ_AGENT_PROFILE,
            task: 'Inspect auth.',
          },
        ],
      }).data,
      {
        items: [
          {
            item_id: 'auth',
            profile: LOCAL_READ_AGENT_PROFILE,
            task: 'Inspect auth.',
          },
        ],
        max_concurrency: AGENT_SWARM_DEFAULT_CONCURRENCY,
      },
    );
    assert.equal(
      schema.safeParse({
        items: Array.from({ length: AGENT_SWARM_MAX_ITEMS + 1 }, (_, index) => swarmItem(index)),
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        items: [swarmItem(0), swarmItem(0)],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        items: [swarmItem(0)],
        max_concurrency: AGENT_SWARM_MAX_CONCURRENCY + 1,
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        items: [
          {
            ...swarmItem(0),
            write_back: AGENT_WRITE_BACK_PATCH,
          },
        ],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        items: [
          {
            ...swarmItem(0),
            isolation: AGENT_WORKSPACE_WORKTREE,
          },
        ],
      }).success,
      false,
    );
  });

  test('preflights the complete batch before starting any child', async () => {
    const tool = buildAgentSwarmTool();
    let starts = 0;

    await assert.rejects(
      Promise.resolve(
        tool.impl(
          {
            items: [
              swarmItem(0),
              {
                item_id: 'implementation',
                profile: IMPLEMENTATION_AGENT_PROFILE,
                task: 'Edit the repository.',
                write_back: AGENT_WRITE_BACK_PATCH,
                isolation: AGENT_WORKSPACE_WORKTREE,
              },
            ],
          },
          context({
            spawnChildSession: async () => {
              starts += 1;
              return childResult(0);
            },
          }),
        ),
      ),
      /worktree child executor/,
    );
    assert.equal(starts, 0);
  });

  test('accepts prompt_template with string items and rejects ambiguous template input', () => {
    const tool = buildAgentSwarmTool();
    const schema = tool.parameters as {
      safeParse(input: unknown): {
        success: boolean;
        data?: AgentSwarmToolInput;
      };
    };

    assert.deepEqual(
      schema.safeParse({
        prompt_template: `Review ${AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER}.`,
        profile: LOCAL_READ_AGENT_PROFILE,
        items: [' runtime ', ' ui '],
      }).data,
      {
        prompt_template: `Review ${AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER}.`,
        profile: LOCAL_READ_AGENT_PROFILE,
        items: ['runtime', 'ui'],
        max_concurrency: AGENT_SWARM_DEFAULT_CONCURRENCY,
      },
    );
    assert.equal(
      schema.safeParse({
        profile: LOCAL_READ_AGENT_PROFILE,
        items: ['runtime', 'ui'],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        prompt_template: 'Review this.',
        profile: LOCAL_READ_AGENT_PROFILE,
        items: ['runtime', 'ui'],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        prompt_template: `Review ${AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER}.`,
        items: ['runtime', 'ui'],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        prompt_template: `Review ${AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER}.`,
        profile: LOCAL_READ_AGENT_PROFILE,
        items: ['same', 'same'],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        prompt_template: `Review ${AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER}.`,
        profile: LOCAL_READ_AGENT_PROFILE,
        items: [swarmItem(0)],
      }).success,
      false,
    );
  });

  test('normalizes prompt_template items through the existing ordered execution path', async () => {
    const prompts: string[] = [];
    const spawnRefs: Array<{ swarmId: string; itemId: string } | undefined> = [];
    const tool = buildAgentSwarmTool();
    const result = await tool.impl(
      {
        prompt_template: `Compare ${AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER} with ${AGENT_SWARM_PROMPT_TEMPLATE_PLACEHOLDER}.`,
        profile: LOCAL_READ_AGENT_PROFILE,
        items: ['runtime', 'desktop'],
        max_concurrency: 2,
      },
      context({
        spawnChildSession: async (input) => {
          prompts.push(input.prompt);
          const index = prompts.length - 1;
          spawnRefs.push(input.swarm);
          await input.onReady?.({
            childSessionId: `child-session-${index}`,
            runId: `run-${index}`,
            turnId: `turn-${index}`,
            agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
            agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
          });
          return {
            ...childResult(index),
            childSessionId: `child-session-${index}`,
          };
        },
      }),
    );

    assert.deepEqual(prompts, ['Compare runtime with runtime.', 'Compare desktop with desktop.']);
    assert.deepEqual(spawnRefs, [
      { swarmId: 'tool-swarm', itemId: 'item-1' },
      { swarmId: 'tool-swarm', itemId: 'item-2' },
    ]);
    assert.deepEqual(
      result.items.map((item) => ({
        itemId: item.itemId,
        index: item.index,
        childSessionId: item.childSessionId,
        runId: item.runId,
        status: item.status,
      })),
      [
        {
          itemId: 'item-1',
          index: 0,
          childSessionId: 'child-session-0',
          runId: 'run-0',
          status: 'completed',
        },
        {
          itemId: 'item-2',
          index: 1,
          childSessionId: 'child-session-1',
          runId: 'run-1',
          status: 'completed',
        },
      ],
    );
  });

  test('accepts resume-only input and enforces the shared total item bound', () => {
    const schema = buildAgentSwarmTool().parameters as {
      safeParse(input: unknown): { success: boolean; data?: AgentSwarmToolInput };
    };
    expectSchemaSuccess(
      schema.safeParse({
        resume_run_ids: {
          'run-a': 'Continue the runtime review.',
          'run-b': 'Continue the UI review.',
        },
      }),
      {
        resume_run_ids: {
          'run-a': 'Continue the runtime review.',
          'run-b': 'Continue the UI review.',
        },
        max_concurrency: AGENT_SWARM_DEFAULT_CONCURRENCY,
      },
    );
    assert.equal(
      schema.safeParse({
        items: Array.from({ length: AGENT_SWARM_MAX_ITEMS }, (_, index) => swarmItem(index)),
        resume_run_ids: { extra: 'Continue.' },
      }).success,
      false,
    );
  });

  test('preflights every resume before starting resumed or new child work', async () => {
    let starts = 0;
    const tool = buildAgentSwarmTool();
    await assert.rejects(
      Promise.resolve(
        tool.impl(
          {
            resume_run_ids: {
              'run-good': 'Continue good.',
              'run-unsafe': 'Continue unsafe.',
            },
            items: [swarmItem(0)],
          },
          context({
            prepareChildAgentResume: async (sourceRunId) => {
              if (sourceRunId === 'run-unsafe') throw new Error('unsafe resume history');
              return preparedResume(sourceRunId);
            },
            resumeChildAgent: async () => {
              starts += 1;
              return childResult(10);
            },
            spawnChildSession: async () => {
              starts += 1;
              return childResult(0);
            },
          }),
        ),
      ),
      /unsafe resume history/,
    );
    assert.equal(starts, 0);
  });

  test('rejects resume inputs that resolve to the same linked child Session before starting work', async () => {
    let starts = 0;
    const tool = buildAgentSwarmTool();
    await assert.rejects(
      Promise.resolve(
        tool.impl(
          {
            resume_run_ids: {
              'run-a': 'Continue A.',
              'run-b': 'Continue B.',
            },
          },
          context({
            prepareChildAgentResume: async (sourceRunId) => ({
              ...preparedResume(sourceRunId),
              execution: {
                kind: 'child_session',
                sessionId: 'shared-child-session',
                currentRunId: sourceRunId,
              },
            }),
            resumeChildAgent: async () => {
              starts += 1;
              return childResult(0);
            },
          }),
        ),
      ),
      /cannot resume child Session shared-child-session more than once/,
    );
    assert.equal(starts, 0);
  });

  test('orders resumed children before new items and preserves resume evidence', async () => {
    const calls: string[] = [];
    const tool = buildAgentSwarmTool();
    const result = await tool.impl(
      {
        resume_run_ids: { 'source-run': 'Continue the source review.' },
        items: [swarmItem(0)],
        max_concurrency: 2,
      },
      context({
        prepareChildAgentResume: async (sourceRunId) => preparedResume(sourceRunId),
        resumeChildAgent: async (input) => {
          calls.push(`resume:${input.sourceRunId}:${input.prompt}`);
          await input.onReady?.({
            turnId: 'turn-resumed',
            agentId: 'local-read',
            agentName: 'Local Read',
          });
          return {
            ...childResult(10),
            turnId: 'turn-resumed',
            runId: 'new-run',
            resumedFromRunId: input.sourceRunId,
          };
        },
        spawnChildSession: async (input) => {
          calls.push(`spawn:${input.prompt}`);
          await input.onReady?.({
            childSessionId: 'child-session',
            runId: 'child-run',
            turnId: 'turn-0',
            agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
            agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
          });
          return childResult(0);
        },
      }),
    );

    assert.deepEqual(calls, ['resume:source-run:Continue the source review.', 'spawn:task-0']);
    assert.deepEqual(
      result.items.map((item) => ({
        itemId: item.itemId,
        index: item.index,
        runId: item.runId,
        resumedFromRunId: item.resumedFromRunId,
      })),
      [
        {
          itemId: 'resume-1',
          index: 0,
          runId: 'new-run',
          resumedFromRunId: 'source-run',
        },
        { itemId: 'item-0', index: 1, runId: 'run-0', resumedFromRunId: undefined },
      ],
    );
  });

  test('continues a fresh swarm child by its returned runId and keeps the child Session ref', async () => {
    const tool = buildAgentSwarmTool();
    const result = await tool.impl(
      {
        resume_run_ids: {
          'fresh-child-run': 'Continue the fresh child.',
        },
      },
      context({
        prepareChildAgentResume: async (sourceRunId) => ({
          sourceRunId,
          execution: {
            kind: 'child_session',
            sessionId: 'fresh-child-session',
            currentRunId: sourceRunId,
          },
          agentId: 'local-read',
          agentName: 'Local Read',
          profile: LOCAL_READ_AGENT_PROFILE,
        }),
        resumeChildAgent: async (input) => {
          await input.onReady?.({
            childSessionId: 'fresh-child-session',
            turnId: 'fresh-resumed-turn',
            runId: 'fresh-resumed-run',
            agentId: 'local-read',
            agentName: 'Local Read',
          });
          return {
            ...childResult(0),
            childSessionId: 'fresh-child-session',
            turnId: 'fresh-resumed-turn',
            runId: 'fresh-resumed-run',
            resumedFromRunId: input.sourceRunId,
          };
        },
      }),
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.items[0]?.childSessionId, 'fresh-child-session');
    assert.equal(result.items[0]?.runId, 'fresh-resumed-run');
    assert.equal(result.items[0]?.resumedFromRunId, 'fresh-child-run');
  });

  test('fails at the tool boundary when child spawning is unavailable', async () => {
    const tool = buildAgentSwarmTool();

    await assert.rejects(
      Promise.resolve(tool.impl({ items: [swarmItem(0)] }, context())),
      /spawnChildSession capability is unavailable/,
    );
  });

  test('preserves input order and successful refs across partial failure', async () => {
    const clock = sequence([100, 180]);
    const tool = buildAgentSwarmTool({ now: clock });
    const gates = Array.from({ length: 3 }, () => deferred<SpawnChildAgentResult>());
    const started: number[] = [];
    const completionOrder: number[] = [];
    const traceEvents: TestTraceEvent[] = [];
    const pending = (async () =>
      await tool.impl(
        {
          items: [swarmItem(0), swarmItem(1), swarmItem(2)],
          max_concurrency: 3,
        },
        context({
          emitRunTrace: (type, message, data) => {
            traceEvents.push({ type, message, data });
          },
          spawnChildSession: async (input) => {
            const index = Number(input.prompt.slice('task-'.length));
            started.push(index);
            await input.onReady?.({
              childSessionId: 'child-session',
              runId: 'child-run',
              turnId: `turn-${index}`,
              agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
              agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
            });
            const result = await gates[index]!.promise;
            completionOrder.push(index);
            return result;
          },
        }),
      ))();

    await waitFor(() => started.length === 3);
    gates[2]!.resolve(childResult(2));
    await waitFor(() => completionOrder.length === 1);
    gates[0]!.resolve(childResult(0));
    await waitFor(() => completionOrder.length === 2);
    gates[1]!.resolve(childResult(1, 'failed'));

    const result = await pending;
    assert.deepEqual(completionOrder, [2, 0, 1]);
    assert.equal(result.status, 'partial');
    assert.deepEqual(
      result.items.map((item) => ({
        itemId: item.itemId,
        index: item.index,
        runId: item.runId,
        status: item.status,
        summary: item.summary,
      })),
      [
        {
          itemId: 'item-0',
          index: 0,
          runId: 'run-0',
          status: 'completed',
          summary: 'summary-0',
        },
        {
          itemId: 'item-1',
          index: 1,
          runId: 'run-1',
          status: 'failed',
          summary: 'summary-1',
        },
        {
          itemId: 'item-2',
          index: 2,
          runId: 'run-2',
          status: 'completed',
          summary: 'summary-2',
        },
      ],
    );
    assert.deepEqual(
      result.items.map((item) => item.artifactIds),
      [['artifact-0'], ['artifact-1'], ['artifact-2']],
    );
    assert.deepEqual(
      {
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
      },
      { startedAt: 100, completedAt: 180, durationMs: 80 },
    );
    assert.deepEqual(
      traceEvents
        .filter((event) => event.data?.swarmStage === 'item_completed')
        .map((event) => ({
          index: Number(event.data?.index),
          status: event.data?.status,
        }))
        .sort((left, right) => left.index - right.index)
        .map((event) => event.status),
      ['completed', 'failed', 'completed'],
    );
    assert.deepEqual(
      traceEvents.find((event) => event.data?.swarmStage === 'batch_completed')?.data,
      {
        swarmStage: 'batch_completed',
        status: 'partial',
        itemCount: 3,
        startedItemCount: 3,
        completedItemCount: 2,
        failedItemCount: 1,
        cancelledItemCount: 0,
        artifactCount: 3,
        durationMs: 80,
        resumedItemCount: 0,
      },
    );
  });

  test('isolates a thrown child startup while retaining successful siblings', async () => {
    const tool = buildAgentSwarmTool();
    const result = await tool.impl(
      {
        items: [swarmItem(0), swarmItem(1), swarmItem(2)],
        max_concurrency: 2,
      },
      context({
        spawnChildSession: async (input) => {
          const index = Number(input.prompt.slice('task-'.length));
          if (index === 1) throw new Error('provider startup failed');
          await input.onReady?.({
            childSessionId: 'child-session',
            runId: 'child-run',
            turnId: `turn-${index}`,
            agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
            agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
          });
          return childResult(index);
        },
      }),
    );

    assert.equal(result.status, 'partial');
    assert.deepEqual(
      result.items.map((item) => item.status),
      ['completed', 'failed', 'completed'],
    );
    assert.equal(result.items[1]?.started, false);
    assert.match(result.items[1]?.summary ?? '', /provider startup failed/);
    assert.equal(result.items[1]?.failureClass, 'Error');
  });

  test('keeps adaptive rate-limit retry for legacy resumed child runs', async () => {
    const traceEvents: TestTraceEvent[] = [];
    const prompts: string[] = [];
    const retrySources: string[] = [];
    const siblingGate = deferred<SpawnChildAgentResult>();
    const tool = buildAgentSwarmTool({
      adaptiveSwarmPolicy: {
        initialLaunchLimit: 2,
        initialLaunchIntervalMs: 1,
        rateLimitRetryBaseMs: 1,
        rateLimitRetryFactor: 2,
        capacityShrinkIntervalMs: 1,
        capacityRecoveryIntervalMs: 100,
      },
    });
    const pending = tool.impl(
      {
        resume_run_ids: {
          'source-run-0': 'task-0',
          'source-run-1': 'task-1',
        },
        max_concurrency: 2,
      },
      context({
        emitRunTrace: (type, message, data) => traceEvents.push({ type, message, data }),
        prepareChildAgentResume: async (sourceRunId) => preparedResume(sourceRunId),
        resumeChildAgent: async (input) => {
          prompts.push(input.prompt);
          const index = Number(input.prompt.slice('task-'.length));
          await input.onReady?.({
            turnId: `turn-${index}`,
            agentId: 'local-read',
            agentName: 'Local Read',
          });
          if (index === 1) return await siblingGate.promise;
          return {
            ...childResult(0, 'failed'),
            failureClass: 'RateLimit',
            summary: 'provider 429',
          };
        },
        retryChildAgent: async (input) => {
          retrySources.push(input.sourceRunId);
          await input.onReady?.({
            turnId: 'turn-0-retry',
            agentId: 'local-read',
            agentName: 'Local Read',
          });
          return {
            ...childResult(0),
            turnId: 'turn-0-retry',
            runId: 'run-0-retry',
            artifactIds: ['artifact-retry'],
          };
        },
      }),
    );

    await waitFor(() => traceEvents.some((event) => event.data?.swarmStage === 'item_suspended'));
    siblingGate.resolve(childResult(1));
    const result = await pending;

    assert.deepEqual(prompts, ['task-0', 'task-1']);
    assert.deepEqual(retrySources, ['run-0']);
    assert.equal(result.status, 'completed');
    assert.equal(result.items[0]?.runId, 'run-0-retry');
    assert.deepEqual(result.items[0]?.artifactIds, ['artifact-0', 'artifact-retry']);
    assert.ok(traceEvents.some((event) => event.data?.swarmStage === 'capacity_changed'));
  });

  test('adaptively retries a rate-limited run inside the same child Session', async () => {
    let retries = 0;
    const retryExecutions: unknown[] = [];
    const traceEvents: TestTraceEvent[] = [];
    const siblingGate = deferred<SpawnChildAgentResult>();
    const pending = buildAgentSwarmTool({
      adaptiveSwarmPolicy: {
        initialLaunchLimit: 2,
        initialLaunchIntervalMs: 1,
        rateLimitRetryBaseMs: 1,
        rateLimitRetryFactor: 2,
        capacityShrinkIntervalMs: 1,
        capacityRecoveryIntervalMs: 100,
      },
    }).impl(
      { items: [swarmItem(0), swarmItem(1)], max_concurrency: 2 },
      context({
        emitRunTrace: (type, message, data) => traceEvents.push({ type, message, data }),
        spawnChildSession: async (input) =>
          input.prompt === 'task-1'
            ? await siblingGate.promise
            : {
                ...childResult(0, 'failed'),
                childSessionId: 'child-session-0',
                failureClass: 'RateLimit',
                summary: 'provider 429',
              },
        retryChildAgent: async (input) => {
          retries += 1;
          retryExecutions.push(input.execution);
          return {
            ...childResult(0),
            childSessionId: 'child-session-0',
            turnId: 'turn-0-retry',
            runId: 'run-0-retry',
          };
        },
      }),
    );

    await waitFor(() => traceEvents.some((event) => event.data?.swarmStage === 'item_suspended'));
    siblingGate.resolve({
      ...childResult(1),
      childSessionId: 'child-session-1',
    });
    const result = await pending;

    assert.equal(retries, 1);
    assert.deepEqual(retryExecutions, [
      {
        kind: 'child_session',
        sessionId: 'child-session-0',
        currentRunId: 'run-0',
      },
    ]);
    assert.equal(result.status, 'completed');
    assert.equal(result.items[0]?.childSessionId, 'child-session-0');
    assert.equal(result.items[0]?.runId, 'run-0-retry');
    assert.equal(result.items[0]?.failureClass, undefined);
  });

  test('distinguishes active cancellation from items that never started', async () => {
    const controller = new AbortController();
    const tool = buildAgentSwarmTool();
    const started: number[] = [];
    const traceEvents: TestTraceEvent[] = [];
    const pending = invokeAgentSwarm(
      tool,
      {
        items: [swarmItem(0), swarmItem(1), swarmItem(2), swarmItem(3)],
        max_concurrency: 2,
      },
      context({
        abortSignal: controller.signal,
        emitRunTrace: (type, message, data) => {
          traceEvents.push({ type, message, data });
        },
        spawnChildSession: async (input) => {
          const index = Number(input.prompt.slice('task-'.length));
          started.push(index);
          await input.onReady?.({
            childSessionId: 'child-session',
            runId: 'child-run',
            turnId: `turn-${index}`,
            agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
            agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
          });
          await onceAborted(controller.signal);
          return childResult(index, 'cancelled');
        },
      }),
    );

    await waitFor(() => started.length === 2);
    controller.abort(new Error('parent cancelled'));
    const result = await withTimeout(pending, 'cancelled AgentSwarm did not join active children');

    assert.equal(result.status, 'cancelled');
    assert.deepEqual(started, [0, 1]);
    assert.deepEqual(
      result.items.map((item) => ({
        started: item.started,
        turnId: item.turnId,
        runId: item.runId,
        status: item.status,
      })),
      [
        {
          started: true,
          turnId: 'turn-0',
          runId: 'run-0',
          status: 'cancelled',
        },
        {
          started: true,
          turnId: 'turn-1',
          runId: 'run-1',
          status: 'cancelled',
        },
        {
          started: false,
          turnId: undefined,
          runId: undefined,
          status: 'cancelled',
        },
        {
          started: false,
          turnId: undefined,
          runId: undefined,
          status: 'cancelled',
        },
      ],
    );
    assert.equal(traceEvents.filter((event) => event.data?.swarmStage === 'item_queued').length, 2);
    const batchTrace = traceEvents.find(
      (event) => event.data?.swarmStage === 'batch_completed',
    )?.data;
    assert.equal(batchTrace?.status, 'cancelled');
    assert.equal(batchTrace?.itemCount, 4);
    assert.equal(batchTrace?.startedItemCount, 2);
    assert.equal(batchTrace?.completedItemCount, 0);
    assert.equal(batchTrace?.failedItemCount, 0);
    assert.equal(batchTrace?.cancelledItemCount, 4);
    assert.equal(batchTrace?.artifactCount, 2);
    assert.equal(typeof batchTrace?.durationMs, 'number');
  });

  test('fails only the timed-out item and continues queued siblings', async () => {
    const parent = new AbortController();
    const starts: string[] = [];
    const traceEvents: TestTraceEvent[] = [];
    const runtime = buildRuntime(
      async (input) => {
        starts.push(input.prompt);
        const index = Number(input.prompt.slice('task-'.length));
        await input.onReady?.({
          childSessionId: 'child-session',
          runId: 'child-run',
          turnId: `turn-${index}`,
          agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
          agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
        });
        if (index === 0) {
          await onceAborted(input.abortSignal);
          return childResult(index, 'cancelled');
        }
        return childResult(index);
      },
      { traceEvents },
    );

    const result = (await executeTool(
      runtime,
      {
        ...buildAgentSwarmTool({ itemTimeoutMs: 20 }),
        permissionRequired: false,
      },
      { items: [swarmItem(0), swarmItem(1)], max_concurrency: 1 },
      parent,
    )) as AgentSwarmToolResult;

    assert.equal(parent.signal.aborted, false);
    assert.deepEqual(starts, ['task-0', 'task-1']);
    assert.equal(result.status, 'partial');
    assert.deepEqual(
      result.items.map((item) => ({ status: item.status, failureClass: item.failureClass })),
      [
        { status: 'failed', failureClass: 'Timeout' },
        { status: 'completed', failureClass: undefined },
      ],
    );
    assert.match(result.items[0]?.summary ?? '', /timed out after 20 ms/i);
    assert.ok(
      traceEvents.some(
        (event) =>
          event.data?.swarmStage === 'item_completed' && event.data?.failureClass === 'Timeout',
      ),
    );
  });

  test('composes local width with the shared child-run permit pool', async () => {
    const active = new Set<string>();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const traceEvents: TestTraceEvent[] = [];
    let maxActive = 0;
    const runtime = buildRuntime(
      async (input) => {
        started.push(input.prompt);
        active.add(input.prompt);
        maxActive = Math.max(maxActive, active.size);
        await input.onReady?.({
          childSessionId: 'child-session',
          runId: 'child-run',
          turnId: `turn-${input.prompt}`,
          agentId: requireBuiltinAgentDefinitionByProfile(input.agentProfile).id,
          agentName: requireBuiltinAgentDefinitionByProfile(input.agentProfile).name,
        });
        return await new Promise((resolve) => {
          releases.set(input.prompt, () => {
            active.delete(input.prompt);
            resolve(childResultForPrompt(input.prompt));
          });
        });
      },
      { traceEvents },
    );
    const single = executeTool(runtime, singleChildProbeTool(), {}, new AbortController());
    await waitFor(() => started.length === 1);

    const swarm = executeTool(
      runtime,
      {
        ...buildAgentSwarmTool(),
        permissionRequired: false,
      },
      {
        items: Array.from({ length: 5 }, (_, index) => swarmItem(index)),
        max_concurrency: 5,
      },
      new AbortController(),
    );
    await waitFor(() => started.length === MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);

    assert.equal(maxActive, MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
    assert.equal(
      started.filter((prompt) => prompt.startsWith('task-')).length,
      MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN - 1,
    );

    releases.get('single')?.();
    await waitFor(() => started.length === 6);
    assert.equal(maxActive, MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);

    for (const release of releases.values()) release();
    await Promise.all([single, swarm]);
    assert.equal(active.size, 0);
    assert.ok(
      traceEvents.some(
        (event) =>
          event.data?.boundary === 'shared_child_run_permit' && event.data?.stage === 'waiting',
      ),
    );
    assert.ok(
      traceEvents.some(
        (event) =>
          event.data?.boundary === 'child_run_execution' && event.data?.stage === 'started',
      ),
    );
    assert.ok(traceEvents.some((event) => event.data?.swarmStage === 'batch_completed'));
  });

  test('traces subagent admission rejection separately from child-run capacity', async () => {
    const traceEvents: TestTraceEvent[] = [];
    const releases: Array<() => void> = [];
    let starts = 0;
    const runtime = buildRuntime(
      async () => {
        starts += 1;
        const index = starts;
        return await new Promise((resolve) => {
          releases.push(() => resolve(childResult(index)));
        });
      },
      { traceEvents },
    );
    const tool = singleChildProbeTool();
    const pending = Array.from({ length: MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN + 1 }, (_, index) =>
      executeTool(runtime, tool, {}, new AbortController(), [], `tool-admission-${index}`),
    );

    await waitFor(() => starts === MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
    assert.deepEqual(await pending.at(-1), {
      error: '只读探索并发过多：同一轮最多 5 个子代理。请等待已有探索完成后再继续。',
    });
    assert.ok(
      traceEvents.some(
        (event) =>
          event.data?.boundary === 'subagent_tool_admission' &&
          event.data?.errorClass === 'RuntimeLimit',
      ),
    );
    for (const release of releases) release();
    await Promise.all(pending.slice(0, -1));
  });

  test('persists partial as settled and cancellation as interrupted', async () => {
    const events: SessionEvent[] = [];
    const telemetry: ToolInvocationRecord[] = [];
    const runtime = buildRuntime(
      async (input) => {
        const index = Number(input.prompt.slice('task-'.length));
        return childResult(index, index === 1 ? 'failed' : 'completed');
      },
      {
        recordToolInvocation: (record) => telemetry.push(record),
      },
    );
    const swarmTool = {
      ...buildAgentSwarmTool(),
      permissionRequired: false,
    };
    await executeTool(
      runtime,
      swarmTool,
      {
        items: [swarmItem(0), swarmItem(1)],
        max_concurrency: 2,
      },
      new AbortController(),
      events,
      'tool-partial',
    );

    const cancelledController = new AbortController();
    cancelledController.abort(new Error('stop before start'));
    await executeTool(
      runtime,
      swarmTool,
      { items: [swarmItem(2)] },
      cancelledController,
      events,
      'tool-cancelled',
    );

    assert.equal(
      events.find(
        (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
          event.type === 'tool_result' && event.toolUseId === 'tool-partial',
      )?.isError,
      false,
    );
    assert.equal(
      events.find(
        (event): event is Extract<SessionEvent, { type: 'tool_result' }> =>
          event.type === 'tool_result' && event.toolUseId === 'tool-cancelled',
      )?.isError,
      true,
    );
    assert.deepEqual(
      telemetry.find((record) => record.toolCallId === 'tool-partial')?.resultSummary,
      {
        kind: 'agent_swarm',
        status: 'partial',
        itemCount: 2,
        startedItemCount: 2,
        completedItemCount: 1,
        failedItemCount: 1,
        cancelledItemCount: 0,
        artifactCount: 2,
      },
    );
    assert.equal(
      telemetry.find((record) => record.toolCallId === 'tool-cancelled')?.resultSummary?.status,
      'cancelled',
    );
  });

  test('one denied parent permission starts zero children', async () => {
    const events: SessionEvent[] = [];
    let starts = 0;
    const permissionEngine = new PermissionEngine({
      newId: nextId(),
      now: () => 1,
    });
    const runtime = buildRuntime(
      async () => {
        starts += 1;
        return childResult(0);
      },
      { permissionEngine, permissionMode: 'ask' },
    );
    const pending = executeTool(
      runtime,
      buildAgentSwarmTool(),
      { items: [swarmItem(0), swarmItem(1)] },
      new AbortController(),
      events,
      'tool-denied',
    );

    await waitFor(() => events.some((event) => event.type === 'permission_request'));
    const requests = events.filter(
      (event): event is Extract<SessionEvent, { type: 'permission_request' }> =>
        event.type === 'permission_request',
    );
    assert.equal(requests.length, 1);
    permissionEngine.recordResponse('turn-1', {
      requestId: requests[0]!.requestId,
      decision: 'deny',
    });

    assert.deepEqual(await pending, { error: '用户已拒绝权限请求' });
    assert.equal(starts, 0);
  });

  test('child tool construction excludes agent_swarm', () => {
    const tools = buildChildAgentTools([
      ...['Read', 'Glob', 'Grep', 'WebSearch'].map((name) => ({
        name,
        description: name,
        parameters: {},
        permissionRequired: false,
        categoryHint: 'read' as const,
        impl: async () => ({}),
      })),
      buildAgentSwarmTool(),
    ]);

    assert.equal(
      tools.some((tool) => tool.name === AGENT_SWARM_TOOL_NAME),
      false,
    );
  });

  test('binds child-session creation to the owning parent run, turn, tool call, and swarm item', async () => {
    const calls: Array<
      Parameters<NonNullable<ConstructorParameters<typeof ToolRuntime>[0]['spawnChildSession']>>[0]
    > = [];
    const runtime = buildRuntime(async (input) => {
      calls.push(input);
      const definition = requireBuiltinAgentDefinitionByProfile(input.agentProfile);
      await input.onReady?.({
        childSessionId: 'child-session-1',
        turnId: 'child-turn-1',
        runId: 'child-run-1',
        agentId: definition.id,
        agentName: definition.name,
      });
      return {
        ...childResult(1),
        childSessionId: 'child-session-1',
        turnId: 'child-turn-1',
        runId: 'child-run-1',
      };
    });

    const result = (await executeTool(
      runtime,
      {
        ...buildAgentSwarmTool(),
        permissionRequired: false,
      },
      { items: [swarmItem(1)] },
      new AbortController(),
      [],
      'swarm-tool-call',
    )) as AgentSwarmToolResult;

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.parentRunId, 'parent-run');
    assert.equal(calls[0]?.parentTurnId, 'turn-1');
    assert.equal(calls[0]?.toolCallId, 'swarm-tool-call');
    assert.deepEqual(calls[0]?.swarm, {
      swarmId: 'swarm-tool-call',
      itemId: 'item-1',
    });
    assert.equal(result.items[0]?.childSessionId, 'child-session-1');
    assert.equal(result.items[0]?.runId, 'child-run-1');
  });
});

function swarmItem(index: number): AgentSwarmExplicitItemInput {
  return {
    item_id: `item-${index}`,
    profile: LOCAL_READ_AGENT_PROFILE,
    task: `task-${index}`,
    write_back: AGENT_WRITE_BACK_SUMMARY,
    isolation: AGENT_WORKSPACE_SAME_WORKSPACE,
  };
}

function childResult(
  index: number,
  status: SpawnChildAgentResult['status'] = 'completed',
): SpawnChildAgentResult {
  return {
    agentId: 'local-read',
    agentName: 'Local Read',
    turnId: `turn-${index}`,
    runId: `run-${index}`,
    status,
    permissionMode: 'explore',
    summary: `summary-${index}`,
    artifactIds: [`artifact-${index}`],
    startedAt: index * 10,
    completedAt: index * 10 + 5,
    durationMs: 5,
    eventCount: 1,
    ...(status === 'failed' ? { failureClass: 'ChildFailed' } : {}),
  };
}

function childResultForPrompt(prompt: string): SpawnChildAgentResult {
  const index = prompt === 'single' ? 99 : Number(prompt.slice('task-'.length));
  return childResult(index);
}

function preparedResume(sourceRunId: string) {
  return {
    sourceRunId,
    execution: {
      kind: 'legacy_child_run' as const,
      sessionId: 'session-1',
      runId: sourceRunId,
    },
    agentId: 'local-read',
    agentName: 'Local Read',
    profile: LOCAL_READ_AGENT_PROFILE,
  };
}

function expectSchemaSuccess(
  parsed: { success: boolean; data?: AgentSwarmToolInput },
  expected: AgentSwarmToolInput & { max_concurrency: number },
): void {
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, expected);
}

function context(overrides: Partial<MakaToolContext> = {}): MakaToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'parent-turn',
    cwd: '/tmp',
    toolCallId: 'tool-swarm',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
    ...overrides,
  };
}

async function invokeAgentSwarm(
  tool: ReturnType<typeof buildAgentSwarmTool>,
  input: AgentSwarmToolInput,
  ctx: MakaToolContext,
): Promise<AgentSwarmToolResult> {
  return await tool.impl(input, ctx);
}

function singleChildProbeTool(): MakaTool {
  return {
    name: 'single_child_probe',
    description: 'test-only single child probe',
    parameters: {},
    permissionRequired: false,
    categoryHint: 'subagent',
    impl: async (_input, ctx) => {
      if (!ctx.spawnChildSession) throw new Error('missing spawn capability');
      return await ctx.spawnChildSession({
        agentProfile: LOCAL_READ_AGENT_PROFILE,
        prompt: 'single',
      });
    },
  };
}

function buildRuntime(
  spawnChildSession: NonNullable<ConstructorParameters<typeof ToolRuntime>[0]['spawnChildSession']>,
  options: {
    permissionEngine?: PermissionEngine;
    permissionMode?: SessionHeader['permissionMode'];
    traceEvents?: TestTraceEvent[];
    recordToolInvocation?: ConstructorParameters<typeof ToolRuntime>[0]['recordToolInvocation'];
  } = {},
): ToolRuntime {
  const permissionEngine =
    options.permissionEngine ??
    new PermissionEngine({
      newId: nextId(),
      now: () => 1,
    });
  permissionEngine.beginTurn('turn-1');
  return new ToolRuntime({
    sessionId: 'session-1',
    header: testHeader(options.permissionMode),
    connection: testConnection(),
    modelId: 'mock-model',
    appendMessage: async () => {},
    permissionEngine,
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
    getCurrentRunId: () => 'parent-run',
    spawnChildSession,
    ...(options.traceEvents ? { getRunTrace: () => testTrace(options.traceEvents!) } : {}),
    ...(options.recordToolInvocation ? { recordToolInvocation: options.recordToolInvocation } : {}),
  });
}

interface TestTraceEvent {
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

function testTrace(events: TestTraceEvent[]): RunTraceLike {
  return {
    emit: (_phase, type, message, data) => {
      events.push({ type, message, data });
    },
  };
}

async function executeTool(
  runtime: ToolRuntime,
  tool: MakaTool,
  input: unknown,
  controller: AbortController,
  events: SessionEvent[] = [],
  toolCallId = 'tool-test',
): Promise<unknown> {
  return (
    await runtime.settleToolCall({
      tool,
      turnId: 'turn-1',
      toolCallId,
      input,
      abortSignal: controller.signal,
      eventSink: { push: (event) => events.push(event) },
    })
  ).result;
}

function testHeader(permissionMode: SessionHeader['permissionMode'] = 'execute'): SessionHeader {
  return {
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
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'mock-model',
    permissionMode,
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

function nextId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise!(value),
  };
}

function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

async function onceAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function withTimeout<Value>(
  promise: Promise<Value>,
  message: string,
  timeoutMs = 1_000,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
