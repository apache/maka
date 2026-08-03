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
import type { GoalControlDecline } from '../goal-continuation.js';
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

  // ToolRuntime injects `askUserQuestion` and `requestSandboxBoundary`
  // unconditionally — unlike `listChildAgents` and `readChildAgentOutput`
  // beside them, which are spread only when present — so these two branches
  // cannot fire through it. Availability is decided when the tool set is
  // assembled: the CLI adds both only on the TUI surface. The guards stay
  // because the context type declares the callbacks optional and an embedder
  // may build one without them; these two tests cover that contract, not a
  // production path.
  test('AskUserQuestion on a context that does not carry the callback', async () => {
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

  test('request_sandbox_boundary on a context that does not carry the callback', async () => {
    const tool = buildRequestSandboxBoundaryTool();
    const text = await refusalOf(() =>
      tool.impl({ expansion: {} as never, justification: 'need it' }, ctx()),
    );
    assertActionable(text, 'request_sandbox_boundary', ['tell the user']);
  });
});

describe('E2 — goal turn-ownership refusals', () => {
  function goalTools(
    seed: 'active' | 'paused' | undefined,
    reason: GoalControlDecline,
  ): MakaTool[] {
    const goalManager = new GoalManager({ generateId: () => 'g-1', now: () => 1000 });
    if (seed) {
      goalManager.create('session-1', 'tests pass', {});
      if (seed === 'paused') goalManager.pause('session-1');
    }
    return buildGoalTools({
      goalManager,
      // Both authorization gates decline, and the coordinator reports why. The
      // old text described this with two different internal nouns ("Goal
      // activation" vs "Goal control") and no recovery step; the version after
      // that asserted one cause and prescribed a retry for all of them.
      goalContinuation: {
        activateGoal: () => undefined,
        mutateGoal: () => undefined,
        activationStanding: () => ({ kind: 'declined', reason }),
        mutationStanding: () => ({ kind: 'declined', reason }),
      } as never,
      now: () => 1000,
    });
  }

  const gates: ReadonlyArray<[string, 'active' | 'paused' | undefined, Record<string, unknown>]> = [
    [GOAL_SET_TOOL_NAME, undefined, { condition: 'tests pass' }],
    ['GoalClear', 'active', {}],
    ['GoalPause', 'active', {}],
    ['GoalResume', 'paused', {}],
  ];

  async function refusal(
    name: string,
    seed: 'active' | 'paused' | undefined,
    args: Record<string, unknown>,
    reason: GoalControlDecline,
  ): Promise<string> {
    const tool = goalTools(seed, reason).find((candidate) => candidate.name === name)!;
    return String(await tool.impl(args as never, ctx()));
  }

  for (const [name, seed, args] of gates) {
    test(`${name} points at GoalStatus when the goal really did change`, async () => {
      const text = await refusal(name, seed, args, 'goal_changed');

      assertNoHostInternals(text);
      // Recovery: one named tool the model can actually call, and reading is
      // always available.
      assert.ok(text.includes(GOAL_STATUS_TOOL_NAME), `must point at GoalStatus: ${text}`);
      // The two internal nouns are gone, and with them the false distinction.
      assert.ok(!/owns Goal (activation|control)/.test(text), text);
    });

    for (const reason of [
      'turn_not_registered',
      'coordinator_disposed',
      'goal_not_observed',
    ] as const) {
      test(`${name} does not prescribe a retry it cannot satisfy (${reason})`, async () => {
        const text = await refusal(name, seed, args, reason);

        assertNoHostInternals(text);
        // The whole point. These causes are settled facts about this turn, so
        // a re-read tells the model nothing new and the same call returns the
        // same refusal. Asking for either builds an unbounded loop.
        assert.ok(
          text.includes('Do not call this tool again in this turn'),
          `must say the retry is pointless: ${text}`,
        );
        assert.ok(
          !new RegExp(`call ${name} again`, 'i').test(text),
          `must not ask for the call that cannot succeed: ${text}`,
        );
        assert.ok(
          !text.includes(GOAL_STATUS_TOOL_NAME),
          `must not send the model to read state that cannot change the outcome: ${text}`,
        );
      });
    }
  }

  test('a turn that already armed a goal is told so, and reading it is still useful', async () => {
    // The one permanent cause where GoalStatus does tell the model something
    // it does not know: the goal it is asking about exists, and it set it.
    const text = await refusal(
      GOAL_SET_TOOL_NAME,
      undefined,
      { condition: 'x' },
      'goal_already_armed',
    );

    assert.ok(/already armed a goal/.test(text), text);
    assert.ok(text.includes(GOAL_STATUS_TOOL_NAME), text);
    assert.ok(!/call GoalSet again/i.test(text), text);
  });
});

describe('E3 — an internal filesystem mismatch does not read as an argument complaint', () => {
  async function refuseWith(name: string, args: unknown): Promise<string> {
    const cwd = await workspace();
    const tools = buildBuiltinTools({
      // Answer every request with a well-formed result of some other
      // operation, which is the exact condition this branch exists for. Keyed
      // off the request so a Glob request does not get a Glob answer back.
      filesystemWorker: {
        execute: async ({ operation }: { operation: { kind: string } }) =>
          operation.kind === 'glob' ? { kind: 'grep', matches: [] } : { kind: 'glob', files: [] },
      } as never,
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

  test('Edit does not claim the file is unchanged, and rules out the old_string retry', async () => {
    const text = await refuseWith('Edit', {
      path: 'a.txt',
      old_string: 'x',
      new_string: 'y',
    });
    assertNoHostInternals(text);
    assert.ok(text.includes('Edit'), text);
    // The branch fires on a mislabelled success. Real failures throw, so this
    // code has no idea whether the edit landed, and saying it did not is a
    // claim about a file nothing here looked at.
    assert.ok(/cannot tell whether/.test(text), `must not assert disk state: ${text}`);
    assert.ok(!/the file is unchanged/.test(text), `must not assert disk state: ${text}`);
    assert.ok(text.includes('old_string'), `must rule out the old_string retry: ${text}`);
    assert.ok(/Read the file/.test(text), `must send the model to look: ${text}`);
  });

  test('Write does not claim nothing reached the disk', async () => {
    const text = await refuseWith('Write', { path: 'a.txt', content: 'x' });
    assertNoHostInternals(text);
    assert.ok(/cannot tell whether the file was written/.test(text), text);
    assert.ok(!/nothing was written/.test(text), `must not assert disk state: ${text}`);
    assert.ok(/unknown state/.test(text), text);
  });

  test('a failed search does not read as a search that found nothing', async () => {
    // "Grep could not be completed inside Maka, so no matches were produced"
    // reads as a successful empty search, and a model that takes it that way
    // concludes the pattern is absent from the repository.
    const grep = await refuseWith('Grep', { pattern: 'needle' });
    assertNoHostInternals(grep);
    assert.ok(!/no matches were produced/.test(grep), `must not read as an empty result: ${grep}`);
    assert.ok(/does not mean the pattern is absent/.test(grep), grep);
    assert.ok(grep.includes('Bash'), `must offer a way out: ${grep}`);

    const glob = await refuseWith('Glob', { pattern: '**/*.ts' });
    assertNoHostInternals(glob);
    assert.ok(/does not mean no files match/.test(glob), glob);
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
    // The counters are manager-wide and StopBackgroundTask takes a
    // session-scoped ref, so the session that hits the cap may own none of the
    // runs holding it. The sentence may offer that move, but not promise it.
    assert.ok(text.includes('StopBackgroundTask'), text);
    assert.ok(/shared across sessions/.test(text), `must not promise an unavailable move: ${text}`);
    assert.ok(/wait for a running task to finish/.test(text), text);
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
    assert.ok(/shared across sessions/.test(text), text);
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
