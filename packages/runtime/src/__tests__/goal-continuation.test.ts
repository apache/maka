/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GoalManager, type GoalManagerDeps } from '../goal-state.js';
import {
  buildGoalTools,
  GOAL_CLEAR_TOOL_NAME,
  GOAL_PAUSE_TOOL_NAME,
  GOAL_RESUME_TOOL_NAME,
  GOAL_SET_TOOL_NAME,
} from '../goal-tools.js';
import {
  GoalContinuationCoordinator,
  volatileGoalDurability,
  type GoalContinuationDeps,
  type GoalContinuationScheduler,
  type GoalTurnAdmission,
  type GoalTurnOutcome,
} from '../goal-continuation.js';
import type { GoalEvaluation } from '../goal-evaluator.js';
import type { MakaToolContext } from '../tool-runtime.js';

const SESSION = 'sess-1';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controlledCall<T>() {
  const result = deferred<T>();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  return {
    invoke: () => {
      markStarted();
      return result.promise;
    },
    started,
    settled: result.promise.then(
      () => undefined,
      () => undefined,
    ),
    resolve: result.resolve,
    reject: result.reject,
  };
}

class ManualScheduler implements GoalContinuationScheduler {
  private nextId = 0;
  readonly entries: Array<{
    id: number;
    callback: () => void;
    delayMs: number;
    cleared: boolean;
  }> = [];

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.entries.push({ id, callback, delayMs, cleared: false });
    return id;
  }

  clearTimeout(handle: unknown): void {
    const entry = this.entries.find((candidate) => candidate.id === handle);
    if (entry) entry.cleared = true;
  }

  pendingDelays(): number[] {
    return this.entries.filter((entry) => !entry.cleared).map((entry) => entry.delayMs);
  }

  fireNext(): void {
    const entry = this.entries.find((candidate) => !candidate.cleared);
    assert.ok(entry, 'expected a pending timer');
    entry.cleared = true;
    entry.callback();
  }
}

interface AdmittedTurn {
  sessionId: string;
  prompt: string;
  turnId: string;
  completion: ReturnType<typeof deferred<GoalTurnOutcome>>;
}

function prepareAdmission(
  admitted: AdmittedTurn[],
  sessionId: string,
  prompt: string,
  turnId: string,
): GoalTurnAdmission {
  const completion = deferred<GoalTurnOutcome>();
  return {
    kind: 'prepared',
    turnId,
    execution: { sessionId, turnId, runId: `run-${turnId}` },
    start: () => {
      admitted.push({ sessionId, prompt, turnId, completion });
      return completion.promise;
    },
  };
}

function setup(opts?: {
  evaluations?: Partial<GoalEvaluation>[];
  tokenCount?: number;
  onChange?: GoalManagerDeps['onChange'];
  taskGate?: GoalContinuationDeps['taskGate'];
}) {
  let id = 0;
  const manager = new GoalManager({
    generateId: () => `g-${++id}`,
    now: () => 1000,
    onChange: opts?.onChange,
  });
  const scheduler = new ManualScheduler();
  const evaluationQueue = [...(opts?.evaluations ?? [])];
  const defaultEvaluation: GoalEvaluation = {
    met: false,
    impossible: false,
    progress: true,
    waiting: false,
    evaluatorFailed: false,
    reason: 'keep going',
  };
  const attemptedPrompts: string[] = [];
  const admitted: AdmittedTurn[] = [];
  let ownedTurnSequence = 0;
  let admissionImpl: (sessionId: string, prompt: string) => GoalTurnAdmission = (
    sessionId,
    prompt,
  ) => {
    const turnId = `turn-owned-${++ownedTurnSequence}`;
    return prepareAdmission(admitted, sessionId, prompt, turnId);
  };
  const deps: GoalContinuationDeps = {
    goalManager: manager,
    evaluator: {
      evaluate: async () => {
        const next = { ...defaultEvaluation, ...evaluationQueue.shift() };
        return JSON.stringify(next);
      },
      close: async () => {},
    },
    getRecentContext: async () => 'recent context',
    durability: volatileGoalDurability,
    getTokenCount: opts?.tokenCount !== undefined ? () => opts.tokenCount! : undefined,
    admitTurn: (sessionId, prompt) => {
      attemptedPrompts.push(prompt);
      return admissionImpl(sessionId, prompt);
    },
    scheduler,
    ...(opts?.taskGate ? { taskGate: opts.taskGate } : {}),
  };
  const coordinator = new GoalContinuationCoordinator(deps);
  return {
    manager,
    scheduler,
    deps,
    coordinator,
    attemptedPrompts,
    admitted,
    setAdmission: (next: typeof admissionImpl) => {
      admissionImpl = next;
    },
    queueEvaluations: (...next: Partial<GoalEvaluation>[]) => evaluationQueue.push(...next),
  };
}

async function waitFor(condition: () => boolean, message = 'condition was not met'): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function settleExternal(
  coordinator: GoalContinuationCoordinator,
  sessionId: string,
  outcome: GoalTurnOutcome,
): Promise<void> {
  assert.ok(outcome.turnId, 'an external turn must have a stable identity before it starts');
  const registration = coordinator.beginObservedTurn(sessionId, outcome.turnId);
  assert.equal(registration.kind, 'registered');
  return registration.settle(outcome);
}

function registerObservedTurn(
  coordinator: GoalContinuationCoordinator,
  sessionId: string,
  turnId: string,
) {
  const registration = coordinator.beginObservedTurn(sessionId, turnId);
  assert.equal(registration.kind, 'registered');
  return registration.settle;
}

function goalToolContext(turnId: string): MakaToolContext {
  return {
    sessionId: SESSION,
    turnId,
    cwd: '/',
    toolCallId: `tool-${turnId}`,
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function goalToolsFor(manager: GoalManager, coordinator: GoalContinuationCoordinator) {
  return buildGoalTools({
    goalManager: manager,
    goalContinuation: coordinator,
  });
}

describe('GoalContinuationCoordinator settlement', () => {
  test('binds a Goal created by the same external turn before it settles', async () => {
    const { manager, coordinator } = setup({
      evaluations: [{ met: true, reason: 'same-turn Goal verified' }],
    });
    const settle = registerObservedTurn(coordinator, SESSION, 'turn-owner');
    const tools = goalToolsFor(manager, coordinator);
    const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    assert.ok(set);

    await set.impl({ condition: 'ship' }, goalToolContext('turn-owner'));
    await settle({ kind: 'completed', turnId: 'turn-owner' });

    assert.equal(manager.get(SESSION)?.status, 'achieved');
  });

  test('an unbound turn cannot settle a Goal created by a concurrent turn', async () => {
    const { manager, coordinator, deps } = setup({
      evaluations: [{ met: true, reason: 'owner verified' }],
    });
    let evaluations = 0;
    const evaluate = deps.evaluator.evaluate;
    deps.evaluator.evaluate = (...args) => {
      evaluations++;
      return evaluate(...args);
    };
    const settleOther = registerObservedTurn(coordinator, SESSION, 'turn-other');
    const settleOwner = registerObservedTurn(coordinator, SESSION, 'turn-owner');
    const set = goalToolsFor(manager, coordinator).find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    assert.ok(set);
    await set.impl({ condition: 'ship' }, goalToolContext('turn-owner'));

    await settleOther({
      kind: 'completed',
      turnId: 'turn-other',
    });
    assert.equal(evaluations, 0);
    await settleOwner({
      kind: 'completed',
      turnId: 'turn-owner',
    });
    assert.equal(evaluations, 1);
    assert.equal(manager.get(SESSION)?.status, 'achieved');
  });

  test('an older unbound turn cannot activate a Goal after another turn activated and cleared one', async () => {
    const { manager, coordinator } = setup();
    registerObservedTurn(coordinator, SESSION, 'turn-old');
    registerObservedTurn(coordinator, SESSION, 'turn-owner');
    const tools = goalToolsFor(manager, coordinator);
    const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    const clear = tools.find((tool) => tool.name === GOAL_CLEAR_TOOL_NAME);
    assert.ok(set);
    assert.ok(clear);

    await set.impl({ condition: 'first' }, goalToolContext('turn-owner'));
    await clear.impl({}, goalToolContext('turn-owner'));
    const output = String(
      await set.impl({ condition: 'replacement' }, goalToolContext('turn-old')),
    );

    // A real race: another turn armed and cleared a goal, so the generation
    // this turn observed is gone. Reading the current goal is worth doing and
    // can change what the model does next, so this is where a look-again
    // instruction is honest.
    assert.match(output, /the session goal changed while this turn was running/);
    assert.match(output, /Call GoalStatus/);
    assert.equal(manager.get(SESSION)?.status, 'cleared');
    assert.equal(manager.get(SESSION)?.condition, 'first');
  });

  test('a turn registered against a paused Goal cannot activate after another turn clears it', async () => {
    const { manager, coordinator } = setup();
    manager.create(SESSION, 'paused goal');
    manager.pause(SESSION);
    registerObservedTurn(coordinator, SESSION, 'turn-old');
    registerObservedTurn(coordinator, SESSION, 'turn-clear');
    const tools = goalToolsFor(manager, coordinator);
    const clear = tools.find((tool) => tool.name === GOAL_CLEAR_TOOL_NAME);
    const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    assert.ok(clear);
    assert.ok(set);

    assert.match(String(await clear.impl({}, goalToolContext('turn-clear'))), /Goal cleared/);
    const output = String(
      await set.impl({ condition: 'replacement' }, goalToolContext('turn-old')),
    );

    assert.match(output, /the session goal changed while this turn was running/);
    assert.equal(manager.get(SESSION)?.condition, 'paused goal');
    assert.equal(manager.get(SESSION)?.status, 'cleared');
  });

  test('an old Goal turn cannot pause or clear a replacement Goal', async () => {
    const { manager, coordinator } = setup();
    manager.create(SESSION, 'first');
    registerObservedTurn(coordinator, SESSION, 'turn-old');
    registerObservedTurn(coordinator, SESSION, 'turn-clear');
    const tools = goalToolsFor(manager, coordinator);
    const clear = tools.find((tool) => tool.name === GOAL_CLEAR_TOOL_NAME);
    const pause = tools.find((tool) => tool.name === GOAL_PAUSE_TOOL_NAME);
    const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
    assert.ok(clear);
    assert.ok(pause);
    assert.ok(set);

    await clear.impl({}, goalToolContext('turn-clear'));
    registerObservedTurn(coordinator, SESSION, 'turn-replacement');
    await set.impl({ condition: 'replacement' }, goalToolContext('turn-replacement'));

    assert.match(
      String(await pause.impl({}, goalToolContext('turn-old'))),
      /the session goal changed while this turn was running/,
    );
    assert.match(
      String(await clear.impl({}, goalToolContext('turn-old'))),
      /the session goal changed while this turn was running/,
    );
    assert.equal(manager.get(SESSION)?.condition, 'replacement');
    assert.equal(manager.get(SESSION)?.status, 'active');
  });

  test('a removed external turn cannot create or resume a Goal through the real tools', async (t) => {
    await t.test('GoalSet after permanent removal', async () => {
      const { manager, coordinator } = setup();
      registerObservedTurn(coordinator, SESSION, 'turn-deleted');
      const set = goalToolsFor(manager, coordinator).find(
        (tool) => tool.name === GOAL_SET_TOOL_NAME,
      );
      assert.ok(set);

      const removal = coordinator.beginSessionClose(SESSION, 'remove');
      manager.remove(SESSION);
      removal.commit();
      const output = String(
        await set.impl({ condition: 'must not exist' }, goalToolContext('turn-deleted')),
      );

      // The loop this replaced: the session was closed and removed, so this
      // turn has no registration and never will. Told to call GoalStatus and
      // retry "if there is still no active goal", the model gets "No goal set
      // for this session", satisfies the condition, retries, and receives the
      // identical refusal forever. The refusal must not ask for that.
      assert.match(output, /does not run under the session goal boundary/);
      assert.match(output, /Do not call this tool again in this turn/);
      assert.doesNotMatch(output, /call GoalSet again/i);
      assert.equal(manager.get(SESSION), undefined);
    });

    await t.test('GoalResume after archive and replacement', async () => {
      const { manager, coordinator } = setup();
      manager.create(SESSION, 'old');
      manager.pause(SESSION);
      registerObservedTurn(coordinator, SESSION, 'turn-archived');
      const resume = goalToolsFor(manager, coordinator).find(
        (tool) => tool.name === GOAL_RESUME_TOOL_NAME,
      );
      assert.ok(resume);

      const archive = coordinator.beginSessionClose(SESSION, 'archive');
      manager.remove(SESSION);
      archive.commit();
      coordinator.unarchiveSession(SESSION);
      manager.create(SESSION, 'replacement');
      manager.pause(SESSION);
      const output = String(await resume.impl({}, goalToolContext('turn-archived')));

      assert.match(output, /does not run under the session goal boundary/);
      assert.match(output, /Do not call this tool again in this turn/);
      assert.doesNotMatch(output, /call GoalResume again/i);
      assert.equal(manager.get(SESSION)?.condition, 'replacement');
      assert.equal(manager.get(SESSION)?.status, 'paused');
    });
  });

  /**
   * Every cause the refusal text can name, produced by the real coordinator.
   *
   * The refusal-text suite drives these through a fake whose `activationStanding`
   * and `mutationStanding` return whatever they are handed, which proves the
   * sentences and nothing about whether the coordinator can reach them. Three of
   * the five had no test that it can, and one of those three could not: the
   * shutdown sentence was written for a branch that `dispose()` had already made
   * unreachable, and the turn read a different sentence that was false about it.
   */
  describe('every decline cause is reachable from the real coordinator', () => {
    test('a shut-down coordinator says so, instead of denying the turn was registered', async () => {
      const { manager, coordinator } = setup();
      registerObservedTurn(coordinator, SESSION, 'turn-live');
      const tools = goalToolsFor(manager, coordinator);
      const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
      const clear = tools.find((tool) => tool.name === GOAL_CLEAR_TOOL_NAME);
      assert.ok(set);
      assert.ok(clear);
      await set.impl({ condition: 'ship' }, goalToolContext('turn-live'));

      coordinator.dispose();
      const output = String(await clear.impl({}, goalToolContext('turn-live')));

      assert.match(output, /the goal system is shutting down/);
      // The sentence this turn used to get. It was registered under the Goal
      // boundary — it armed the goal it is now trying to clear.
      assert.doesNotMatch(output, /does not run under the session goal boundary/);
    });

    test('a turn already bound to a goal is not told it tried to arm a second one', async () => {
      const { manager, coordinator } = setup();
      // Two things have to hold at once, and neither involves the model arming
      // anything. `beginObservedTurn` binds the lease by itself when a goal is
      // already active, and only `mutateGoal` releases it — so the pause has to
      // come from somewhere that is not a Goal tool. The autonomous evaluation
      // loop and the host-side pause control are both exactly that.
      manager.create(SESSION, 'ship');
      registerObservedTurn(coordinator, SESSION, 'turn-inherited');
      manager.pause(SESSION);

      const resume = goalToolsFor(manager, coordinator).find(
        (tool) => tool.name === GOAL_RESUME_TOOL_NAME,
      );
      assert.ok(resume);
      const output = String(await resume.impl({}, goalToolContext('turn-inherited')));

      assert.equal(manager.get(SESSION)?.status, 'paused');
      // GoalResume asked to arm nothing, and this turn armed nothing.
      assert.doesNotMatch(output, /arm a second one/);
      assert.doesNotMatch(output, /already armed/);
      assert.match(output, /already bound to a goal/);
      assert.match(output, /Do not call GoalResume again in this turn/);
    });

    test('GoalSet on a turn that is still bound to a finished goal is refused as a second arming', async () => {
      const { manager, coordinator } = setup();
      manager.create(SESSION, 'first');
      registerObservedTurn(coordinator, SESSION, 'turn-inherited');
      // Same shape: the goal reaches a terminal status without passing through
      // `mutateGoal`, so the turn keeps the lease it was bound to at
      // registration and GoalSet gets past its own unfinished-goal guard.
      manager.clear(SESSION);

      const set = goalToolsFor(manager, coordinator).find(
        (tool) => tool.name === GOAL_SET_TOOL_NAME,
      );
      assert.ok(set);
      const output = String(
        await set.impl({ condition: 'second' }, goalToolContext('turn-inherited')),
      );

      assert.match(output, /cannot arm a second one/);
      assert.match(output, /Call GoalStatus/);
      assert.equal(manager.get(SESSION)?.status, 'cleared');
    });

    test('a turn that started before the goal existed is told that, not that it is unregistered', async () => {
      const { manager, coordinator } = setup();
      registerObservedTurn(coordinator, SESSION, 'turn-early');
      registerObservedTurn(coordinator, SESSION, 'turn-later');
      const tools = goalToolsFor(manager, coordinator);
      const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
      const clear = tools.find((tool) => tool.name === GOAL_CLEAR_TOOL_NAME);
      assert.ok(set);
      assert.ok(clear);

      await set.impl({ condition: 'later goal' }, goalToolContext('turn-later'));
      const output = String(await clear.impl({}, goalToolContext('turn-early')));

      assert.match(output, /began before the current goal existed/);
      assert.match(output, /Do not call this tool again in this turn/);
      assert.equal(manager.get(SESSION)?.status, 'active');
    });
  });

  test('closed sessions reject fresh turns until explicitly reopened', () => {
    const { coordinator } = setup();
    coordinator.beginSessionClose(SESSION, 'archive').commit();

    assert.deepEqual(coordinator.beginObservedTurn(SESSION, 'turn-closed'), {
      kind: 'unavailable',
      reason: 'Goal continuation session is closed.',
    });

    coordinator.unarchiveSession(SESSION);
    assert.equal(coordinator.beginObservedTurn(SESSION, 'turn-reopened').kind, 'registered');
  });

  test('a rolled-back session close leaves revoked continuation visibly paused', async (t) => {
    await t.test('busy continuation intent', async () => {
      const { manager, coordinator, setAdmission, attemptedPrompts } = setup();
      const idle = deferred<void>();
      setAdmission(() => ({ kind: 'busy', whenIdle: idle.promise }));
      manager.create(SESSION, 'ship');

      await settleExternal(coordinator, SESSION, {
        kind: 'completed',
        turnId: 'turn-external',
      });
      await waitFor(
        () => attemptedPrompts.length === 1,
        'continuation did not reach the busy gate',
      );

      const archive = coordinator.beginSessionClose(SESSION, 'archive');
      archive.rollback();
      idle.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(manager.get(SESSION)?.status, 'paused');
      assert.equal(
        manager.get(SESSION)?.lastReason,
        'Goal continuation paused because session archive did not complete.',
      );
      assert.equal(attemptedPrompts.length, 1);

      registerObservedTurn(coordinator, SESSION, 'turn-resume');
      const resume = goalToolsFor(manager, coordinator).find(
        (tool) => tool.name === GOAL_RESUME_TOOL_NAME,
      );
      assert.ok(resume);
      assert.match(String(await resume.impl({}, goalToolContext('turn-resume'))), /Goal resumed/);
      assert.equal(manager.get(SESSION)?.status, 'active');
    });

    await t.test('in-flight evaluator', async () => {
      const { manager, coordinator, deps, admitted } = setup();
      const evaluation = controlledCall<string>();
      deps.evaluator.evaluate = evaluation.invoke;
      manager.create(SESSION, 'ship');
      const settlement = settleExternal(coordinator, SESSION, {
        kind: 'completed',
        turnId: 'turn-evaluating',
      });
      await evaluation.started;

      const removal = coordinator.beginSessionClose(SESSION, 'remove');
      removal.rollback();
      await settlement;
      evaluation.resolve('{"met":true,"reason":"late"}');
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(manager.get(SESSION)?.status, 'paused');
      assert.equal(
        manager.get(SESSION)?.lastReason,
        'Goal continuation paused because session removal did not complete.',
      );
      assert.equal(admitted.length, 0);
    });
  });

  test('transfers same-turn authority across its own lifecycle mutation', async (t) => {
    await t.test('pause then resume', async () => {
      const { manager, coordinator } = setup({
        evaluations: [{ met: true, reason: 'resumed Goal verified' }],
      });
      const settle = registerObservedTurn(coordinator, SESSION, 'turn-control');
      const tools = goalToolsFor(manager, coordinator);
      const context = goalToolContext('turn-control');
      const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
      const pause = tools.find((tool) => tool.name === GOAL_PAUSE_TOOL_NAME);
      const resume = tools.find((tool) => tool.name === GOAL_RESUME_TOOL_NAME);
      assert.ok(set);
      assert.ok(pause);
      assert.ok(resume);

      await set.impl({ condition: 'ship' }, context);
      await pause.impl({}, context);
      assert.match(String(await resume.impl({}, context)), /Goal resumed/);
      await settle({ kind: 'completed', turnId: 'turn-control' });

      assert.equal(manager.get(SESSION)?.status, 'achieved');
    });

    await t.test('clear then replace', async () => {
      const { manager, coordinator } = setup({
        evaluations: [{ met: true, reason: 'replacement Goal verified' }],
      });
      manager.create(SESSION, 'old Goal');
      const settle = registerObservedTurn(coordinator, SESSION, 'turn-control');
      const tools = goalToolsFor(manager, coordinator);
      const context = goalToolContext('turn-control');
      const clear = tools.find((tool) => tool.name === GOAL_CLEAR_TOOL_NAME);
      const set = tools.find((tool) => tool.name === GOAL_SET_TOOL_NAME);
      assert.ok(clear);
      assert.ok(set);

      await clear.impl({}, context);
      assert.match(String(await set.impl({ condition: 'replacement Goal' }, context)), /Goal set/);
      await settle({ kind: 'completed', turnId: 'turn-control' });

      assert.equal(manager.get(SESSION)?.condition, 'replacement Goal');
      assert.equal(manager.get(SESSION)?.status, 'achieved');
    });
  });

  test('an impossible verdict terminates without admission', async () => {
    const { manager, coordinator, admitted } = setup({
      evaluations: [{ impossible: true, reason: 'required dependency does not exist' }],
    });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-impossible',
    });

    assert.equal(manager.get(SESSION)?.status, 'impossible');
    assert.equal(admitted.length, 0);
  });

  test('nonterminal settlement updates counters and admits one real continuation', async () => {
    const { manager, coordinator, admitted } = setup({
      evaluations: [{ progress: false, reason: 'one check remains' }],
    });
    manager.create(SESSION, 'ship', { blockCap: 3 });

    await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });
    await waitFor(() => admitted.length === 1, 'continuation was not admitted');

    assert.equal(manager.get(SESSION)?.iterations, 1);
    assert.equal(manager.get(SESSION)?.consecutiveNoProgress, 1);
    assert.equal(admitted.length, 1);
    assert.match(admitted[0]!.prompt, /one check remains/);
  });

  test('evaluator failure remains neutral and fail-open', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    deps.evaluator.evaluate = async () => {
      throw new Error('provider outage');
    };
    manager.create(SESSION, 'ship', { blockCap: 1 });

    await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });
    await waitFor(() => admitted.length === 1, 'fail-open continuation was not admitted');

    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(manager.get(SESSION)?.consecutiveNoProgress, 0);
    assert.equal(admitted.length, 1);
  });

  test('context failure pauses the exact Goal with a visible reason', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    deps.getRecentContext = async () => {
      throw new Error('storage unavailable');
    };
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });

    assert.equal(manager.get(SESSION)?.status, 'paused');
    assert.match(manager.get(SESSION)?.lastReason ?? '', /storage unavailable/);
    assert.equal(admitted.length, 0);
  });

  test('queued completions are evaluated FIFO and collapse to the newest pending intent', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    const firstEvaluation = controlledCall<string>();
    let calls = 0;
    deps.evaluator.evaluate = async () => {
      calls++;
      if (calls === 1) return firstEvaluation.invoke();
      return JSON.stringify({
        met: false,
        impossible: false,
        progress: true,
        waiting: false,
        reason: 'second result',
      });
    };
    manager.create(SESSION, 'ship');

    const first = settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await firstEvaluation.started;
    const second = settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-2' });
    firstEvaluation.resolve(
      JSON.stringify({
        met: false,
        impossible: false,
        progress: true,
        waiting: false,
        reason: 'first result',
      }),
    );
    await Promise.all([first, second]);
    await waitFor(() => admitted.length === 1, 'newest continuation was not admitted');

    assert.equal(manager.get(SESSION)?.iterations, 2);
    assert.equal(admitted.length, 1);
    assert.match(admitted[0]!.prompt, /second result/);
    assert.doesNotMatch(admitted[0]!.prompt, /first result/);
  });

  test('queues failures behind earlier evidence and discards later queued outcomes', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    const evaluation = controlledCall<string>();
    let evaluations = 0;
    deps.evaluator.evaluate = () => {
      evaluations++;
      return evaluation.invoke();
    };
    manager.create(SESSION, 'ship');

    const first = settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-first' });
    await evaluation.started;
    const failure = settleExternal(coordinator, SESSION, {
      kind: 'errored',
      turnId: 'turn-failure',
      reason: 'provider failed',
    });
    const later = settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-later' });

    assert.equal(manager.get(SESSION)?.status, 'active');
    evaluation.resolve(
      JSON.stringify({
        met: false,
        impossible: false,
        progress: true,
        waiting: false,
        reason: 'first result',
      }),
    );
    await Promise.all([first, failure, later]);
    assert.equal(manager.get(SESSION)?.status, 'paused');
    assert.equal(evaluations, 1);
    assert.equal(admitted.length, 0);
  });

  test('pause and resume invalidate every outcome queued under the previous control lease', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    const evaluation = controlledCall<string>();
    let evaluations = 0;
    deps.evaluator.evaluate = () => {
      evaluations++;
      return evaluation.invoke();
    };
    manager.create(SESSION, 'ship');

    const first = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-first',
    });
    await evaluation.started;
    const failure = settleExternal(coordinator, SESSION, {
      kind: 'errored',
      turnId: 'turn-failure',
      reason: 'provider failed',
    });
    const later = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-later',
    });

    assert.ok(manager.pause(SESSION));
    assert.ok(manager.resume(SESSION));
    evaluation.resolve(
      JSON.stringify({
        met: true,
        impossible: false,
        progress: true,
        waiting: false,
        reason: 'old evidence must not apply',
      }),
    );

    await Promise.all([first, failure, later]);
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(manager.get(SESSION)?.iterations, 0);
    assert.equal(evaluations, 1);
    assert.equal(admitted.length, 0);
  });

  test('a pre-pause external turn cannot settle the resumed Goal', async () => {
    const { manager, coordinator, deps } = setup();
    let evaluations = 0;
    deps.evaluator.evaluate = async () => {
      evaluations++;
      return '{"met":true,"reason":"must not evaluate"}';
    };
    manager.create(SESSION, 'ship');
    const settleLate = registerObservedTurn(coordinator, SESSION, 'turn-late');

    await settleExternal(coordinator, SESSION, {
      kind: 'errored',
      turnId: 'turn-failure',
      reason: 'provider failed',
    });
    assert.ok(manager.resume(SESSION));
    await settleLate({
      kind: 'completed',
      turnId: 'turn-late',
    });
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(evaluations, 0);
  });

  test('archive invalidates queued and in-flight outcomes before Goal replacement', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    const evaluation = controlledCall<string>();
    let evaluationSignal: AbortSignal | undefined;
    deps.evaluator.evaluate = (_prompt, _sessionId, signal) => {
      evaluationSignal = signal;
      return evaluation.invoke();
    };
    manager.create(SESSION, 'old');

    const inFlight = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-in-flight',
    });
    await evaluation.started;
    const queued = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-queued',
    });

    const archive = coordinator.beginSessionClose(SESSION, 'archive');
    assert.equal(evaluationSignal?.aborted, true);
    assert.equal(manager.remove(SESSION), true);
    archive.commit();
    coordinator.unarchiveSession(SESSION);
    assert.equal(manager.create(SESSION, 'replacement').kind, 'created');

    await Promise.all([inFlight, queued]);

    evaluation.resolve(
      JSON.stringify({
        met: true,
        impossible: false,
        progress: true,
        waiting: false,
        reason: 'old evaluator must not apply',
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.get(SESSION)?.condition, 'replacement');
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(admitted.length, 0);
  });

  test('model pause and clear abort an older evaluator without revoking their own turn', async (t) => {
    for (const action of ['pause', 'clear'] as const) {
      await t.test(action, async () => {
        const { manager, coordinator, deps, admitted } = setup();
        const evaluation = controlledCall<string>();
        let evaluationSignal: AbortSignal | undefined;
        deps.evaluator.evaluate = (_prompt, _sessionId, signal) => {
          evaluationSignal = signal;
          return evaluation.invoke();
        };
        manager.create(SESSION, 'ship');
        const priorSettlement = settleExternal(coordinator, SESSION, {
          kind: 'completed',
          turnId: 'turn-evaluating',
        });
        await evaluation.started;

        const settleControl = registerObservedTurn(coordinator, SESSION, 'turn-control');
        const tools = goalToolsFor(manager, coordinator);
        const context = goalToolContext('turn-control');
        const toolName = action === 'pause' ? GOAL_PAUSE_TOOL_NAME : GOAL_CLEAR_TOOL_NAME;
        const tool = tools.find((candidate) => candidate.name === toolName);
        assert.ok(tool);
        assert.match(String(await tool.impl({}, context)), /Goal/);
        assert.equal(evaluationSignal?.aborted, true);
        await priorSettlement;

        if (action === 'pause') {
          const resume = tools.find((candidate) => candidate.name === GOAL_RESUME_TOOL_NAME);
          assert.ok(resume);
          assert.match(String(await resume.impl({}, context)), /Goal resumed/);
          assert.match(String(await tool.impl({}, context)), /Goal paused/);
        } else {
          const set = tools.find((candidate) => candidate.name === GOAL_SET_TOOL_NAME);
          assert.ok(set);
          assert.match(String(await set.impl({ condition: 'replacement' }, context)), /Goal set/);
          assert.match(String(await tool.impl({}, context)), /Goal cleared/);
        }

        await settleControl({ kind: 'completed', turnId: 'turn-control' });
        assert.equal(manager.get(SESSION)?.status, action === 'pause' ? 'paused' : 'cleared');
        assert.equal(admitted.length, 0);
      });
    }
  });

  test('archive consumes an external turn that has not reached the FIFO', async () => {
    const { manager, coordinator, deps } = setup();
    let evaluations = 0;
    deps.evaluator.evaluate = async () => {
      evaluations++;
      return '{"met":true,"reason":"old turn must not evaluate"}';
    };
    manager.create(SESSION, 'old');
    const settleOld = registerObservedTurn(coordinator, SESSION, 'turn-still-draining');

    const archive = coordinator.beginSessionClose(SESSION, 'archive');
    assert.equal(manager.remove(SESSION), true);
    archive.commit();
    coordinator.unarchiveSession(SESSION);
    assert.equal(manager.create(SESSION, 'replacement').kind, 'created');

    await settleOld({
      kind: 'completed',
      turnId: 'turn-still-draining',
    });
    assert.equal(manager.get(SESSION)?.condition, 'replacement');
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(evaluations, 0);
  });

  test('dispose revokes an evaluator and all later injection', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    const evaluation = controlledCall<string>();
    deps.evaluator.evaluate = evaluation.invoke;
    manager.create(SESSION, 'ship');

    const pending = settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await evaluation.started;
    coordinator.dispose();
    evaluation.resolve(
      '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"late"}',
    );

    await pending;
    assert.equal(manager.get(SESSION)?.iterations, 0);
    assert.equal(admitted.length, 0);
  });

  test('close waits for accepted evaluator resource cleanup', async () => {
    const { manager, coordinator, deps, admitted } = setup();
    const evaluation = controlledCall<string>();
    deps.evaluator.evaluate = evaluation.invoke;
    deps.evaluator.close = () => evaluation.settled;
    manager.create(SESSION, 'ship');

    const pending = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });
    await evaluation.started;
    let closeSettled = false;
    const closing = coordinator.close().then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false);

    evaluation.resolve(
      '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"late"}',
    );
    await closing;
    await pending;
    assert.equal(manager.get(SESSION)?.iterations, 0);
    assert.equal(admitted.length, 0);
  });
});

describe('GoalContinuationCoordinator admission and completion', () => {
  test('aborted, suspended, and errored external turns pause the current Goal without evaluation', async (t) => {
    const outcomes: GoalTurnOutcome[] = [
      { kind: 'aborted', turnId: 'turn-aborted' },
      {
        kind: 'suspended',
        turnId: 'turn-suspended',
        reason: 'Turn is waiting for user permission.',
      },
      { kind: 'errored', turnId: 'turn-errored', reason: 'provider failed' },
    ];
    for (const outcome of outcomes) {
      await t.test(outcome.kind, async () => {
        const { manager, coordinator, deps, admitted } = setup();
        let evaluations = 0;
        deps.evaluator.evaluate = async () => {
          evaluations++;
          throw new Error('must not evaluate');
        };
        manager.create(SESSION, 'ship');

        await settleExternal(coordinator, SESSION, outcome);

        assert.equal(manager.get(SESSION)?.status, 'paused');
        assert.match(
          manager.get(SESSION)?.lastReason ?? '',
          /aborted|waiting for user permission|provider failed/,
        );
        assert.equal(evaluations, 0);
        assert.equal(admitted.length, 0);
      });
    }
  });

  test('busy preserves the intent and retries only after the host becomes idle', async () => {
    const { manager, coordinator, admitted, setAdmission, attemptedPrompts } = setup({
      evaluations: [{ reason: 'ready to continue' }],
    });
    const idle = deferred<void>();
    let attempts = 0;
    setAdmission((sessionId, prompt) => {
      attempts++;
      if (attempts === 1) return { kind: 'busy', whenIdle: idle.promise };
      return prepareAdmission(admitted, sessionId, prompt, `turn-owned-${attempts}`);
    });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => attempts === 1, 'busy admission was not attempted');
    assert.equal(attempts, 1);
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(admitted.length, 0);

    idle.resolve();
    await waitFor(() => attempts === 2, 'idle wake did not retry admission');
    assert.equal(attempts, 2);
    assert.equal(admitted.length, 1);
    assert.equal(attemptedPrompts.length, 2);
  });

  test('new completion evidence outranks an intent waiting on busy', async () => {
    const { manager, coordinator, admitted, setAdmission } = setup({
      evaluations: [{ reason: 'old intent' }, { reason: 'new intent' }],
    });
    const idle = deferred<void>();
    let attempts = 0;
    setAdmission((sessionId, prompt) => {
      attempts++;
      if (attempts === 1) return { kind: 'busy', whenIdle: idle.promise };
      return prepareAdmission(admitted, sessionId, prompt, `turn-owned-${attempts}`);
    });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => attempts === 1, 'first admission was not attempted');
    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-2' });
    idle.resolve();
    await waitFor(() => admitted.length === 1, 'new evidence was not admitted after idle');

    assert.equal(manager.get(SESSION)?.iterations, 2);
    assert.equal(admitted.length, 1);
    assert.match(admitted[0]!.prompt, /new intent/);
    assert.doesNotMatch(admitted[0]!.prompt, /old intent/);
  });

  test('a stale owned-turn failure cannot erase a newer intent waiting on busy', async () => {
    const { manager, coordinator, admitted, setAdmission } = setup({
      evaluations: [{ reason: 'owned turn' }, { reason: 'new external evidence' }],
    });
    const idle = deferred<void>();
    let attempts = 0;
    setAdmission((sessionId, prompt) => {
      attempts++;
      if (attempts === 2) return { kind: 'busy', whenIdle: idle.promise };
      return prepareAdmission(admitted, sessionId, prompt, `turn-owned-${attempts}`);
    });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'owned turn was not admitted');
    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-2' });
    await waitFor(() => attempts === 2, 'newer intent did not reach the busy host');

    admitted[0]!.completion.resolve({ kind: 'aborted', turnId: admitted[0]!.turnId });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.get(SESSION)?.status, 'active');

    idle.resolve();
    await waitFor(() => attempts === 3, 'stale failure erased the newer busy intent');
    assert.equal(admitted.length, 2);
    assert.match(admitted[1]!.prompt, /new external evidence/);
  });

  test('unavailable admission pauses instead of leaving a false active Goal', async () => {
    const { manager, coordinator, setAdmission } = setup();
    setAdmission(() => ({ kind: 'unavailable', reason: 'TUI switched sessions' }));
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(
      () => manager.get(SESSION)?.status === 'paused',
      'unavailable host did not pause Goal',
    );

    assert.equal(manager.get(SESSION)?.status, 'paused');
    assert.equal(manager.get(SESSION)?.lastReason, 'TUI switched sessions');
  });

  test('a checkpoint change during task inspection discards the stale intent', async () => {
    const taskRead = controlledCall<string[]>();
    let taskReads = 0;
    const { manager, coordinator, admitted } = setup({
      taskGate: {
        listActionableTaskKeys: () => {
          taskReads++;
          return taskRead.invoke();
        },
      },
    });
    manager.create(SESSION, 'ship');

    const settlement = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });
    await taskRead.started;
    manager.pause(SESSION);
    manager.resume(SESSION);
    taskRead.resolve([]);

    await settlement;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(taskReads, 1);
    assert.equal(admitted.length, 0);
  });

  test('a completed Goal-owned turn re-enters the FIFO with its real turn id', async () => {
    const { manager, coordinator, admitted, queueEvaluations } = setup({
      evaluations: [{ reason: 'first' }],
    });
    queueEvaluations({ met: true, reason: 'verified by second turn' });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'continuation was not admitted');
    assert.equal(admitted.length, 1);
    admitted[0]!.completion.resolve({ kind: 'completed', turnId: admitted[0]!.turnId });
    await waitFor(() => manager.get(SESSION)?.status === 'achieved', 'owned turn was not settled');

    assert.equal(manager.get(SESSION)?.status, 'achieved');
    assert.equal(admitted.length, 1);
  });

  test('an admitted Goal-owned turn transfers its checkpoint across pause and resume', async () => {
    const { manager, coordinator, admitted, queueEvaluations } = setup({
      evaluations: [{ reason: 'continue' }],
    });
    queueEvaluations({ met: true, reason: 'resumed owned turn verified' });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'continuation was not admitted');
    const tools = goalToolsFor(manager, coordinator);
    const pause = tools.find((tool) => tool.name === GOAL_PAUSE_TOOL_NAME);
    const resume = tools.find((tool) => tool.name === GOAL_RESUME_TOOL_NAME);
    assert.ok(pause);
    assert.ok(resume);
    const context = goalToolContext(admitted[0]!.turnId);

    assert.match(String(await pause.impl({}, context)), /Goal paused/);
    assert.match(String(await resume.impl({}, context)), /Goal resumed/);
    admitted[0]!.completion.resolve({ kind: 'completed', turnId: admitted[0]!.turnId });
    await waitFor(() => manager.get(SESSION)?.status === 'achieved');

    assert.equal(manager.get(SESSION)?.status, 'achieved');
  });

  test('archive consumes an admitted Goal-owned turn before its completion arrives', async () => {
    const { manager, coordinator, admitted } = setup();
    manager.create(SESSION, 'first');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'continuation was not admitted');
    const ownedTurnId = admitted[0]!.turnId;

    const archive = coordinator.beginSessionClose(SESSION, 'archive');
    manager.remove(SESSION);
    archive.commit();
    coordinator.unarchiveSession(SESSION);
    manager.create(SESSION, 'replacement');
    admitted[0]!.completion.resolve({ kind: 'completed', turnId: ownedTurnId });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(manager.get(SESSION)?.condition, 'replacement');
    assert.equal(manager.get(SESSION)?.iterations, 0);
  });

  test('a completed Goal-owned turn is consumed without crossing pause and resume', async () => {
    const { manager, coordinator, admitted, deps } = setup({
      evaluations: [
        { reason: 'first' },
        { met: true, reason: 'stale owned completion must not evaluate' },
      ],
    });
    let evaluations = 0;
    const evaluate = deps.evaluator.evaluate;
    deps.evaluator.evaluate = (...args) => {
      evaluations++;
      return evaluate(...args);
    };
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'owned turn was not admitted');
    manager.pause(SESSION);
    manager.resume(SESSION);
    admitted[0]!.completion.resolve({ kind: 'completed', turnId: admitted[0]!.turnId });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(evaluations, 1);
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(manager.get(SESSION)?.iterations, 1);
    assert.equal(admitted.length, 1);
  });

  test('resolved failure and rejected Goal-owned turns pause without retrying', async (t) => {
    for (const scenario of ['aborted', 'rejected'] as const) {
      await t.test(scenario, async () => {
        const { manager, coordinator, admitted } = setup();
        manager.create(SESSION, 'ship');
        await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
        await waitFor(() => admitted.length === 1, 'continuation was not admitted');

        if (scenario === 'aborted') {
          admitted[0]!.completion.resolve({ kind: 'aborted', turnId: admitted[0]!.turnId });
        } else {
          admitted[0]!.completion.reject(new Error('stream rejected'));
        }
        await waitFor(
          () => manager.get(SESSION)?.status === 'paused',
          `${scenario} did not pause Goal`,
        );

        assert.equal(manager.get(SESSION)?.status, 'paused');
        assert.equal(admitted.length, 1);
        assert.match(manager.get(SESSION)?.lastReason ?? '', /aborted|stream rejected/);
      });
    }
  });
});

describe('GoalContinuationCoordinator waiting and task gate', () => {
  test('waiting is visible and uses 5s → 10s backoff instead of immediate turns', async () => {
    const { manager, coordinator, scheduler, admitted, queueEvaluations } = setup({
      evaluations: [{ waiting: true, progress: false, reason: 'CI running' }],
    });
    queueEvaluations({ waiting: true, progress: false, reason: 'CI still running' });
    manager.create(SESSION, 'CI passes');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => scheduler.pendingDelays().length === 1, 'waiting retry was not scheduled');
    assert.equal(manager.get(SESSION)?.status, 'waiting');
    assert.deepEqual(scheduler.pendingDelays(), [5_000]);
    assert.equal(admitted.length, 0);

    scheduler.fireNext();
    await waitFor(() => admitted.length === 1, 'waiting retry did not admit a turn');
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(admitted.length, 1);
    admitted[0]!.completion.resolve({ kind: 'completed', turnId: admitted[0]!.turnId });
    await waitFor(() => scheduler.pendingDelays()[0] === 10_000, 'second wait did not back off');

    assert.equal(manager.get(SESSION)?.status, 'waiting');
    assert.deepEqual(scheduler.pendingDelays(), [10_000]);
    assert.equal(manager.get(SESSION)?.consecutiveNoProgress, 0);
  });

  test('a real user turn preempts waiting and cancels its retry', async () => {
    const { manager, coordinator, scheduler, admitted, queueEvaluations } = setup({
      evaluations: [{ waiting: true, progress: false, reason: 'CI running' }],
    });
    queueEvaluations({ waiting: false, progress: true, reason: 'CI passed' });
    manager.create(SESSION, 'CI passes');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => scheduler.pendingDelays().length === 1, 'waiting retry was not scheduled');
    assert.deepEqual(scheduler.pendingDelays(), [5_000]);

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-user' });
    await waitFor(() => admitted.length === 1, 'user evidence did not preempt waiting');
    assert.equal(manager.get(SESSION)?.status, 'active');
    assert.equal(admitted.length, 1);
    assert.match(admitted[0]!.prompt, /CI passed/);
    assert.deepEqual(scheduler.pendingDelays(), []);
  });

  test('task reminder is consumed and traced only after admission starts', async () => {
    const idle = deferred<void>();
    const decisions: string[] = [];
    const { manager, coordinator, admitted, setAdmission } = setup({
      taskGate: {
        listActionableTaskKeys: async () => ['T1'],
        recordDecision: async (trace) => {
          decisions.push(trace.decision);
        },
      },
    });
    let attempts = 0;
    setAdmission((sessionId, prompt) => {
      attempts++;
      if (attempts === 1) return { kind: 'busy', whenIdle: idle.promise };
      return prepareAdmission(admitted, sessionId, prompt, `turn-owned-${attempts}`);
    });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => attempts === 1, 'busy admission was not attempted');
    assert.deepEqual(decisions, []);

    idle.resolve();
    await waitFor(() => decisions.length === 1, 'started admission was not traced');
    assert.deepEqual(decisions, ['reminder_injected']);
    assert.match(admitted[0]!.prompt, /Actionable task keys: T1/);
  });

  test('task reminder is injected once per Goal across chained turns', async () => {
    const decisions: string[] = [];
    const { manager, coordinator, admitted } = setup({
      taskGate: {
        listActionableTaskKeys: async () => ['T1'],
        recordDecision: async (trace) => {
          decisions.push(trace.decision);
        },
      },
    });
    manager.create(SESSION, 'ship');

    await settleExternal(coordinator, SESSION, { kind: 'completed', turnId: 'turn-1' });
    await waitFor(() => admitted.length === 1, 'first continuation was not admitted');
    admitted[0]!.completion.resolve({ kind: 'completed', turnId: admitted[0]!.turnId });
    await waitFor(() => admitted.length === 2, 'chained continuation was not admitted');

    assert.match(admitted[0]!.prompt, /\[Task reminder\]/);
    assert.doesNotMatch(admitted[1]!.prompt, /\[Task reminder\]/);
    assert.deepEqual(decisions, ['reminder_injected', 'reminder_limit_reached']);
  });

  test('a pending diagnostic trace cannot block a completed owned turn behind it', async () => {
    const trace = controlledCall<void>();
    const { manager, coordinator, admitted } = setup({
      taskGate: {
        listActionableTaskKeys: async () => [],
        recordDecision: () => trace.invoke(),
      },
    });
    manager.create(SESSION, 'ship');

    const settlement = settleExternal(coordinator, SESSION, {
      kind: 'completed',
      turnId: 'turn-1',
    });
    await trace.started;
    await waitFor(() => admitted.length === 1, 'first continuation was not admitted');
    admitted[0]!.completion.resolve({
      kind: 'completed',
      turnId: admitted[0]!.turnId,
    });
    await waitFor(() => admitted.length === 2, 'pending trace retained the session lane');

    await settlement;
  });
});
