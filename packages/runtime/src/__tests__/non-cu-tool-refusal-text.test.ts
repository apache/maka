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
import { buildAskUserQuestionTool } from '../ask-user-question-tool.js';
import { buildRequestSandboxBoundaryTool } from '../sandbox-boundary-tool.js';
import { buildGoalTools, GOAL_SET_TOOL_NAME, GOAL_STATUS_TOOL_NAME } from '../goal-tools.js';
import type { GoalControlDecline } from '../goal-continuation.js';
import { GoalContinuationCoordinator, volatileGoalDurability } from '../goal-continuation.js';
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
  return (await errorOf(run)).message;
}

async function errorOf(run: () => unknown | Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
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
    assertActionable(text, AGENT_OUTPUT_TOOL_NAME, ['summary']);
  });

  test('the missing host callback still reaches an operator', async () => {
    const spawned = await errorOf(() =>
      buildSubagentSpawnTool().impl({ profile: 'local_read', task: 'look' }, ctx()),
    );
    assert.equal(
      (spawned.cause as Error | undefined)?.message,
      'spawnChildSession capability is unavailable in this runtime context',
    );
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
    gates: { activation: GoalControlDecline; mutation: GoalControlDecline },
    isAvailable?: () => boolean,
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
      //
      // The two gates answer separately on purpose. A stub that returns the
      // same reason from both cannot see a tool wired to the wrong one, and
      // routing GoalClear through the activation gate would then leave every
      // test green while the model was told it "cannot arm a second one".
      goalContinuation: {
        activateGoal: () => undefined,
        mutateGoal: () => undefined,
        activationStanding: () => ({ kind: 'declined', reason: gates.activation }),
        mutationStanding: () => ({ kind: 'declined', reason: gates.mutation }),
      } as never,
      ...(isAvailable ? { isAvailable } : {}),
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
    const tool = goalTools(seed, { activation: reason, mutation: reason }).find(
      (candidate) => candidate.name === name,
    )!;
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

  test('a turn that is already bound to a goal is told so, and reading it is still useful', async () => {
    // GoalStatus does tell the model something it does not know here — that a
    // goal exists and this turn is bound to it — so it is still offered. It is
    // offered as the last step, not as a way back to GoalSet, because the
    // binding cannot be undone within the turn (see E2b).
    const text = await refusal(
      GOAL_SET_TOOL_NAME,
      undefined,
      { condition: 'x' },
      'goal_already_armed',
    );

    assert.ok(/already bound to a goal/.test(text), text);
    assert.ok(text.includes(GOAL_STATUS_TOOL_NAME), text);
    assert.ok(/do not call GoalSet again in this turn/.test(text), text);
  });

  test('GoalResume is not told it tried to arm a second goal', async () => {
    // `goal_already_armed` comes from the activation gate, and GoalResume goes
    // through that gate — but it asked to arm nothing, and the turn may hold
    // the lease only because it started while a goal was active. The cause is
    // shared; what there is to say about it is not.
    const text = await refusal('GoalResume', 'paused', {}, 'goal_already_armed');

    assert.ok(!/arm a second one/.test(text), `GoalResume armed nothing: ${text}`);
    assert.ok(!/already armed/.test(text), `the lease can be inherited, not armed: ${text}`);
    assert.ok(/already bound to a goal/.test(text), text);
    assert.ok(text.includes(GOAL_STATUS_TOOL_NAME), text);
    assert.ok(/Do not call GoalResume again in this turn/.test(text), text);
  });

  test('each tool reports the gate it actually goes through', async () => {
    // GoalSet and GoalResume are activations; GoalClear and GoalPause mutate
    // the generation the turn observed. Wiring one to the other gate produces a
    // refusal about the wrong thing, and a stub that answers both gates
    // identically cannot tell.
    const split = { activation: 'goal_already_armed', mutation: 'goal_not_observed' } as const;
    const say = async (
      name: string,
      seed: 'active' | 'paused' | undefined,
      args: Record<string, unknown> = {},
    ) =>
      String(
        await goalTools(seed, split)
          .find((candidate) => candidate.name === name)!
          .impl(args as never, ctx()),
      );

    const activates = /already bound to a goal/;
    const mutates = /began before the current goal existed/;
    assert.match(await say(GOAL_SET_TOOL_NAME, undefined, { condition: 'x' }), activates);
    assert.match(await say('GoalResume', 'paused'), activates);
    assert.match(await say('GoalClear', 'active'), mutates);
    assert.match(await say('GoalPause', 'active'), mutates);
  });

  test('a shut-down goal authority does not invite the model to keep calling', async () => {
    // `beginDrain` is one-way: the flag is set once, the continuation
    // coordinator is disposed with it, and nothing clears it. "Goal authority
    // is unavailable." read as a passing condition worth another call.
    const tools = goalTools(
      'active',
      { activation: 'goal_changed', mutation: 'goal_changed' },
      () => false,
    );
    for (const name of ['GoalClear', 'GoalPause', GOAL_SET_TOOL_NAME]) {
      const args = name === GOAL_SET_TOOL_NAME ? { condition: 'x' } : {};
      const text = String(
        await tools.find((candidate) => candidate.name === name)!.impl(args as never, ctx()),
      );
      assertNoHostInternals(text);
      assert.ok(/Do not call this tool again/.test(text), `${name}: ${text}`);
      assert.ok(!/^Goal authority is unavailable\.$/.test(text), `${name}: ${text}`);
      assert.ok(!text.includes(GOAL_STATUS_TOOL_NAME), `${name}: ${text}`);
    }
  });
});

/**
 * The seam E2 cannot reach.
 *
 * E2 hands `buildGoalTools` a stub whose `activationStanding` returns a chosen
 * cause, which settles what the sentence says about a cause but not whether
 * that cause can be got out of. Only the real coordinator knows that, because
 * the answer lives in when `observedControlLease` is rewritten — once at
 * `beginObservedTurn`, and after that only by a mutation that succeeded.
 *
 * So these drive `GoalContinuationCoordinator` and `GoalManager` themselves,
 * take the refusal the model would read, and then do what a model that believed
 * it would do.
 */
describe('E2b — the goal refusals that a real coordinator produces are read to the end', () => {
  function realGoalTools() {
    let id = 0;
    const goalManager = new GoalManager({ generateId: () => `g-${++id}`, now: () => 1000 });
    const coordinator = new GoalContinuationCoordinator({
      goalManager,
      evaluator: { evaluate: async () => '{}', close: async () => {} },
      getRecentContext: async () => 'recent context',
      durability: volatileGoalDurability,
      admitTurn: () => ({ kind: 'unavailable', reason: 'not in this test' }),
      scheduler: { setTimeout: () => 0, clearTimeout: () => {} },
    } as never);
    const tools = buildGoalTools({ goalManager, goalContinuation: coordinator, now: () => 1000 });
    return {
      coordinator,
      call: async (name: string, turnId: string, args: Record<string, unknown> = {}) =>
        String(
          await tools
            .find((candidate) => candidate.name === name)!
            .impl(args as never, ctx({ turnId })),
        ),
    };
  }

  test('goal_changed does not invite a GoalSet that declines forever', async () => {
    const { coordinator, call } = realGoalTools();
    // One turn registers before any goal exists; a second arms one and clears
    // it. The lease has moved on, nothing is active, and the first turn is now
    // past the "unfinished goal is active" guard and into the gate.
    coordinator.beginObservedTurn('session-1', 'turn-a');
    coordinator.beginObservedTurn('session-1', 'turn-b');
    await call(GOAL_SET_TOOL_NAME, 'turn-b', { condition: 'someone else' });
    await call('GoalClear', 'turn-b');
    assert.equal(
      (coordinator.activationStanding('session-1', 'turn-a') as { reason?: string }).reason,
      'goal_changed',
      'the scenario must really produce goal_changed',
    );

    const first = await call(GOAL_SET_TOOL_NAME, 'turn-a', { condition: 'mine' });
    assertNoHostInternals(first);
    // Reading is still worth doing, and is still offered.
    assert.ok(first.includes(GOAL_STATUS_TOOL_NAME), first);

    // The whole finding: a model that does what the sentence says next must not
    // arrive back at this call. `mutateGoal` is what refreshes the observed
    // lease, and every mutation this turn can reach declines too, so nothing
    // the model calls changes the answer.
    assert.ok(
      /do not call GoalSet again in this turn/.test(first),
      `goal_changed is permanent within the turn and must say so: ${first}`,
    );
    assert.equal(await call(GOAL_SET_TOOL_NAME, 'turn-a', { condition: 'mine' }), first);
    await call('GoalClear', 'turn-a');
    assert.equal(
      await call(GOAL_SET_TOOL_NAME, 'turn-a', { condition: 'mine' }),
      first,
      'no call available to this turn can change the refusal',
    );
  });

  test('the GoalSet arm of goal_already_armed does not invite a retry either', async () => {
    const { coordinator, call } = realGoalTools();
    // Reachable from GoalSet only once the armed goal has left `active` —
    // otherwise the "unfinished goal is active" guard answers first. A later
    // turn clears it, which leaves turn-a holding a controlLease it cannot
    // release: releasing it needs a mutation, and the moved lease declines
    // every mutation this turn makes.
    coordinator.beginObservedTurn('session-1', 'turn-a');
    await call(GOAL_SET_TOOL_NAME, 'turn-a', { condition: 'mine' });
    coordinator.beginObservedTurn('session-1', 'turn-c');
    await call('GoalClear', 'turn-c');
    assert.equal(
      (coordinator.activationStanding('session-1', 'turn-a') as { reason?: string }).reason,
      'goal_already_armed',
    );

    const first = await call(GOAL_SET_TOOL_NAME, 'turn-a', { condition: 'again' });
    assertNoHostInternals(first);
    assert.ok(/already bound to a goal/.test(first), first);
    assert.ok(
      /do not call GoalSet again in this turn/.test(first),
      `goal_already_armed is permanent within the turn and must say so: ${first}`,
    );
    await call('GoalClear', 'turn-a');
    assert.equal(await call(GOAL_SET_TOOL_NAME, 'turn-a', { condition: 'again' }), first);
  });
});

describe('E3 — an internal filesystem mismatch does not read as an argument complaint', () => {
  async function failureOf(name: string, args: unknown): Promise<Error> {
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
    try {
      await tool.impl(
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
      );
    } catch (error) {
      assert.ok(error instanceof Error, String(error));
      return error;
    }
    throw new Error('expected the call to be refused');
  }

  async function refuseWith(name: string, args: unknown): Promise<string> {
    return (await failureOf(name, args)).message;
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

    // The fallback may not be prescribed outright. `local_read` children are
    // given Read, Glob and Grep and nothing else, so "use Bash to do the same
    // work" is, for the caller most likely to be running a bare Grep, an
    // instruction it cannot follow — and the refusal then leaves it with no
    // move at all. Offer the shell on a condition the model can check, and end
    // on something every caller can do.
    assert.ok(!/use Bash/.test(grep), `must not prescribe a tool the caller may not have: ${grep}`);
    assert.ok(/shell tool if you have one/.test(grep), grep);
    assert.ok(/otherwise report that Grep is failing/.test(grep), grep);

    const glob = await refuseWith('Glob', { pattern: '**/*.ts' });
    assertNoHostInternals(glob);
    assert.ok(/does not mean no files match/.test(glob), glob);
  });

  test('every one of them says whose fault it is not', async () => {
    // The sentence that keeps a model from "fixing" arguments that were fine.
    // Nothing asserted it, so it could have been dropped from all five
    // messages without turning a test red.
    for (const [name, args] of [
      ['Grep', { pattern: 'needle' }],
      ['Glob', { pattern: '**/*.ts' }],
      ['Read', { path: 'a.txt' }],
      ['Write', { path: 'a.txt', content: 'x' }],
      ['Edit', { path: 'a.txt', old_string: 'x', new_string: 'y' }],
    ] as const) {
      const text = await refuseWith(name, args);
      assert.ok(
        text.includes('This is an internal failure, not a problem with your arguments'),
        `${name} must not read as an argument complaint: ${text}`,
      );
    }
  });

  test('the worker-protocol violation still reaches an operator', async () => {
    // The model-facing sentence cannot name the worker, but an operator reading
    // a log needs to know this was a mismatched result and not, say, a missing
    // file. It travels as the cause, which is out of the model's sight and in
    // every stack trace.
    for (const [name, args] of [
      ['Grep', { pattern: 'needle' }],
      ['Glob', { pattern: '**/*.ts' }],
      ['Read', { path: 'a.txt' }],
      ['Write', { path: 'a.txt', content: 'x' }],
      ['Edit', { path: 'a.txt', old_string: 'x', new_string: 'y' }],
    ] as const) {
      const error = await failureOf(name, args);
      assertNoHostInternals(error.message);
      assert.ok(error.cause instanceof Error, `${name} lost the operator signal`);
      assert.equal(error.cause.message, `Filesystem worker returned a mismatched ${name} result.`);
    }
  });
});

describe('E5 — background task refs and capacity', () => {
  test('a bad ref gets the canonical form instead of an echo', async () => {
    const manager = new ShellRunProcessManager({
      store: createSqliteShellRunStore(await workspace()),
      newId: () => 'shell-run-1',
      now: () => 1,
    });
    const error = await errorOf(() =>
      manager.stopBackgroundTask('session-1', 'task-3-secret-value', NO_ABORT),
    );
    assert.ok(error.message.includes('maka://runtime/background-tasks/<id>'), error.message);
    assert.ok(
      !error.message.includes('task-3-secret-value'),
      `must not echo the rejected ref: ${error.message}`,
    );
    // The ref itself is the only thing that distinguishes this failure from the
    // other two call sites in a log, so it travels as the cause rather than
    // being dropped — the same split `builtin-tools.ts` uses.
    assert.ok(error.cause instanceof Error, 'the rejected ref must still reach an operator');
    assert.equal(
      (error.cause as Error).message,
      'Unsupported runtime background task ref: task-3-secret-value',
    );
  });

  test('the Read({ref}) path gets the canonical form too', async () => {
    // `classifyRuntimeResourceRef` waves through anything shaped
    // `maka://runtime/<something>`, so a mistyped path segment lands here and
    // not on `stopBackgroundTask`. This is the likeliest place to mistype a
    // ref, and it was the one still echoing the rejected string back.
    const manager = new ShellRunProcessManager({
      store: createSqliteShellRunStore(await workspace()),
      newId: () => 'shell-run-1',
      now: () => 1,
    });
    const text = await refusalOf(() =>
      manager.readRuntimeResource(
        'session-1',
        'maka://runtime/backgroundtasks/task-3-secret-value',
        NO_ABORT,
      ),
    );
    assert.ok(text.includes('maka://runtime/background-tasks/<id>'), text);
    assert.ok(!text.includes('task-3-secret-value'), `must not echo the rejected ref: ${text}`);
  });

  test('a full shell slot gives a session-independent recovery action', async () => {
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
    // The counters are manager-wide, so the session that hits the cap may own
    // none of the runs holding it: the move that always exists is waiting.
    assert.ok(/shared across sessions/.test(text), `must not promise an unavailable move: ${text}`);
    assert.ok(/Wait for a running background task to finish/.test(text), text);
  });

  test('a full PTY slot offers a non-interactive fallback', async () => {
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
    assert.ok(/PTY/.test(text), text);
    assert.ok(/shared across sessions/.test(text), text);
    // The one move that is both available and immediate: the same command
    // without `pty`, which the caller reaches by dropping a parameter it
    // already knows about rather than by finding a tool.
    assert.ok(/non-interactive background task/.test(text), text);
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
