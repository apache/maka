/**
 * Model-facing refusal text for the non-Computer-Use tool families.
 *
 * Every assertion here is about what the model can *do* after reading a
 * refusal, not about an exact sentence. The shared defect these guard against
 * is a refusal that names a host-internal concept (an injected capability
 * function, a scope rule, a worker) and offers no next action, which leaves the
 * model with nothing to try but the same call again.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createManagedExecutionBoundary, createWorkspaceWritePermissionProfile } from '@maka/core';
import { createSqliteShellRunStore } from '@maka/storage';

import { buildBuiltinTools } from '../builtin-tools.js';
import {
  AGENT_LIST_TOOL_NAME,
  AGENT_OUTPUT_TOOL_NAME,
  AGENT_SPAWN_TOOL_NAME,
  buildSubagentOutputTool,
  buildSubagentProjectionTools,
  buildSubagentSpawnTool,
} from '../subagent-tools.js';
import { AGENT_SWARM_TOOL_NAME, buildAgentSwarmTool } from '../agent-swarm-tools.js';
import { buildAskUserQuestionTool } from '../ask-user-question-tool.js';
import { buildRequestSandboxBoundaryTool } from '../sandbox-boundary-tool.js';
import { buildGoalTools, GOAL_SET_TOOL_NAME, GOAL_STATUS_TOOL_NAME } from '../goal-tools.js';
import { GoalManager } from '../goal-state.js';
import { ShellRunProcessManager } from '../shell-run-manager.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';

const NO_ABORT = new AbortController().signal;
const TEMPORARY_WORKSPACES = new Set<string>();

after(async () => {
  await Promise.all(
    [...TEMPORARY_WORKSPACES].map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'maka-refusal-text-'));
  TEMPORARY_WORKSPACES.add(path);
  return path;
}

function ctx(extra: Partial<MakaToolContext> = {}): MakaToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: '/tmp',
    toolCallId: 'tool-1',
    abortSignal: NO_ABORT,
    emitOutput: () => {},
    ...extra,
  } as MakaToolContext;
}

async function refusalOf(run: () => unknown | Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to be refused');
}

/** Host-internal identifiers that must never reach the model. */
const HOST_INTERNAL_WORDS = [
  'spawnChildSession',
  'spawnChildAgent',
  'listChildAgents',
  'readChildAgentOutput',
  'retryChildAgent',
  'prepareChildAgentResume',
  'requestSandboxBoundary',
  'askUserQuestion',
  'runtime context',
  'AgentRun',
  'Filesystem worker',
];

function assertNoHostInternals(text: string): void {
  for (const word of HOST_INTERNAL_WORDS) {
    assert.ok(!text.includes(word), `refusal must not mention host internal "${word}": ${text}`);
  }
}

/**
 * A usable refusal names the tool the model actually called and tells it what
 * to do next. "Do something else" only counts if the text points at a concrete
 * alternative: another tool name, a parameter, or plain reply text.
 */
function assertActionable(text: string, toolName: string, alternatives: readonly string[]): void {
  assertNoHostInternals(text);
  assert.ok(text.includes(toolName), `refusal must name the tool ${toolName}: ${text}`);
  assert.ok(
    alternatives.some((alternative) => text.includes(alternative)),
    `refusal must point at one of ${alternatives.join(' / ')}: ${text}`,
  );
}

describe('E1 — capability-missing refusals name the tool and a fallback', () => {
  test('agent_spawn', async () => {
    const tool = buildSubagentSpawnTool();
    const text = await refusalOf(() =>
      tool.impl({ profile: 'local_read', task: 'look at a file' }, ctx()),
    );
    assertActionable(text, AGENT_SPAWN_TOOL_NAME, ['yourself']);
  });

  test('agent_list', async () => {
    const tool = buildSubagentProjectionTools().find(
      (candidate) => candidate.name === AGENT_LIST_TOOL_NAME,
    ) as MakaTool;
    const text = await refusalOf(() => tool.impl({}, ctx()));
    assertActionable(text, AGENT_LIST_TOOL_NAME, [AGENT_SPAWN_TOOL_NAME]);
  });

  test('agent_output', async () => {
    const tool = buildSubagentOutputTool();
    const text = await refusalOf(() => tool.impl({ locator: 'legacy_run', run_id: 'r' }, ctx()));
    assertActionable(text, AGENT_OUTPUT_TOOL_NAME, [AGENT_SPAWN_TOOL_NAME, AGENT_SWARM_TOOL_NAME]);
  });

  test('agent_swarm spawn', async () => {
    const tool = buildAgentSwarmTool();
    const text = await refusalOf(() =>
      tool.impl(
        {
          items: [
            {
              item_id: 'item-0',
              profile: 'local_read',
              task: 'task-0',
              write_back: 'summary',
              isolation: 'same_workspace',
            },
          ],
        },
        ctx(),
      ),
    );
    assertActionable(text, AGENT_SWARM_TOOL_NAME, ['yourself']);
  });

  test('agent_swarm resume points at the parameter to drop', async () => {
    const tool = buildAgentSwarmTool();
    const text = await refusalOf(() =>
      tool.impl(
        { resume_run_ids: ['run-1'] } as never,
        ctx({ spawnChildSession: (async () => ({})) as never }),
      ),
    );
    assertActionable(text, AGENT_SWARM_TOOL_NAME, ['resume_run_ids']);
  });

  test('AskUserQuestion', async () => {
    const tool = buildAskUserQuestionTool();
    const text = await refusalOf(() =>
      tool.impl(
        {
          questions: [{ question: 'a?', options: [{ label: 'one' }, { label: 'two' }] }] as never,
        },
        ctx(),
      ),
    );
    assertActionable(text, 'AskUserQuestion', ['reply text']);
  });

  test('request_sandbox_boundary', async () => {
    const tool = buildRequestSandboxBoundaryTool();
    const text = await refusalOf(() =>
      tool.impl({ expansion: {} as never, justification: 'need it' }, ctx()),
    );
    assertActionable(text, 'request_sandbox_boundary', ['tell the user']);
  });
});

describe('E2 — goal turn-ownership refusals', () => {
  function goalTools(seed?: 'active' | 'paused'): MakaTool[] {
    const goalManager = new GoalManager({ generateId: () => 'g-1', now: () => 1000 });
    if (seed) {
      goalManager.create('session-1', 'tests pass', {});
      if (seed === 'paused') goalManager.pause('session-1');
    }
    return buildGoalTools({
      goalManager,
      // Both authorization gates decline. This is the exact case the old text
      // described with two different internal nouns ("Goal activation" vs
      // "Goal control") and no recovery step.
      goalContinuation: { activateGoal: () => undefined, mutateGoal: () => undefined } as never,
      now: () => 1000,
    });
  }

  const gates: ReadonlyArray<[string, 'active' | 'paused' | undefined, Record<string, unknown>]> = [
    [GOAL_SET_TOOL_NAME, undefined, { condition: 'tests pass' }],
    ['GoalClear', 'active', {}],
    ['GoalPause', 'active', {}],
    ['GoalResume', 'paused', {}],
  ];

  for (const [name, seed, args] of gates) {
    test(`${name} declines with a checkable next action`, async () => {
      const tool = goalTools(seed).find((candidate) => candidate.name === name)!;
      const text = String(await tool.impl(args as never, ctx()));

      // The gate really fired, rather than an earlier "no goal" branch.
      assert.ok(/changed while this turn was running/.test(text), text);
      // Recovery: one named tool the model can actually call.
      assert.ok(text.includes(GOAL_STATUS_TOOL_NAME), `must point at GoalStatus: ${text}`);
      // The two internal nouns are gone, and with them the false distinction.
      assert.ok(!/owns Goal (activation|control)/.test(text), text);
    });
  }
});

describe('E3 — an internal filesystem mismatch does not read as an argument complaint', () => {
  async function refuseWith(name: string, args: unknown): Promise<string> {
    const cwd = await workspace();
    const tools = buildBuiltinTools({
      // Answer every request with a result of the wrong kind, which is the
      // exact condition the old "Filesystem worker returned a mismatched X
      // result." message described.
      filesystemWorker: { execute: async () => ({ kind: 'glob', files: [] }) } as never,
    });
    const tool = tools.find((candidate) => candidate.name === name)!;
    return await refusalOf(() =>
      tool.impl(
        args as never,
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          toolCallId: `tool-${name}`,
          cwd,
          permissionMode: 'ask',
          executionBoundary: createManagedExecutionBoundary(
            createWorkspaceWritePermissionProfile(),
            0,
          ),
          abortSignal: NO_ABORT,
          emitOutput: () => {},
        } as never,
      ),
    );
  }

  test('Edit says the file is unchanged and that old_string is not the problem', async () => {
    const text = await refuseWith('Edit', {
      path: 'a.txt',
      old_string: 'x',
      new_string: 'y',
    });
    assertNoHostInternals(text);
    assert.ok(text.includes('Edit'), text);
    assert.ok(/unchanged/.test(text), text);
    assert.ok(text.includes('old_string'), `must rule out the old_string retry: ${text}`);
    assert.ok(text.includes('Bash'), `must offer a way out: ${text}`);
  });

  test('Write says nothing was written and offers a way out', async () => {
    const text = await refuseWith('Write', { path: 'a.txt', content: 'x' });
    assertNoHostInternals(text);
    assert.ok(/nothing was written/.test(text), text);
    assert.ok(text.includes('Bash'), text);
  });
});

describe('E5 — background task refs and capacity', () => {
  test('a bad ref gets the canonical form instead of an echo', async () => {
    const manager = new ShellRunProcessManager({
      store: createSqliteShellRunStore(await workspace()),
      newId: () => 'shell-run-1',
      now: () => 1,
    });
    const text = await refusalOf(() =>
      manager.stopBackgroundTask('session-1', 'task-3-secret-value', NO_ABORT),
    );
    assert.ok(text.includes('maka://runtime/background-tasks/<id>'), text);
    assert.ok(!text.includes('task-3-secret-value'), `must not echo the rejected ref: ${text}`);
  });

  test('a full shell slot names StopBackgroundTask', async () => {
    const cwd = await workspace();
    const manager = new ShellRunProcessManager({
      store: createSqliteShellRunStore(cwd),
      newId: () => 'shell-run-1',
      now: () => 1,
      maxLiveShellRuns: 0,
    });
    const text = await refusalOf(() =>
      manager.runBackgroundBash({
        sessionId: 'session-1',
        sourceRunId: 'run-1',
        sourceTurnId: 'turn-1',
        sourceToolCallId: 'tool-1',
        cwd,
        command: 'true',
        emitOutput: () => {},
        abortSignal: NO_ABORT,
      } as never),
    );
    assert.ok(text.includes('StopBackgroundTask'), text);
  });

  test('a full PTY slot names StopBackgroundTask', async () => {
    const cwd = await workspace();
    const manager = new ShellRunProcessManager({
      store: createSqliteShellRunStore(cwd),
      newId: () => 'shell-run-1',
      now: () => 1,
      maxLivePtyRuns: 0,
    });
    const text = await refusalOf(() =>
      manager.runBackgroundBash({
        sessionId: 'session-1',
        sourceRunId: 'run-1',
        sourceTurnId: 'turn-1',
        sourceToolCallId: 'tool-1',
        cwd,
        command: 'true',
        pty: true,
        emitOutput: () => {},
        abortSignal: NO_ABORT,
      } as never),
    );
    assert.ok(text.includes('StopBackgroundTask'), text);
    assert.ok(/PTY/.test(text), text);
  });
});

describe('E6 — agent_output locator rejections name the missing fields', () => {
  const cases: ReadonlyArray<[string, readonly string[]]> = [
    ['child_session_latest', ['child_session_id']],
    ['child_session_run', ['child_session_id', 'run_id']],
    ['legacy_run', ['run_id']],
    ['legacy_turn', ['turn_id']],
  ];

  for (const [locator, fields] of cases) {
    test(`locator=${locator}`, () => {
      const schema = buildSubagentOutputTool().parameters as unknown as {
        safeParse: (value: unknown) => {
          success: boolean;
          error?: { issues: Array<{ message: string }> };
        };
      };
      const parsed = schema.safeParse({ locator });
      assert.equal(parsed.success, false);
      const message = (parsed.error?.issues ?? []).map((issue) => issue.message).join(' | ');
      for (const field of fields) {
        assert.ok(message.includes(field), `expected ${field} in: ${message}`);
      }
      assert.ok(!/matching identity fields/.test(message), message);
    });
  }
});
