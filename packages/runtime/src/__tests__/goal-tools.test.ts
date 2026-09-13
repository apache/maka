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
import { GoalManager } from '../goal-state.js';
import { GoalContinuationCoordinator, volatileGoalDurability } from '../goal-continuation.js';
import {
  buildGoalTools,
  GOAL_SET_TOOL_NAME,
  GOAL_PAUSE_TOOL_NAME,
  GOAL_RESUME_TOOL_NAME,
} from '../goal-tools.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';

const SESSION = 'sess-1';

function ctx(turnId = 't'): MakaToolContext {
  return {
    sessionId: SESSION,
    turnId,
    cwd: '/',
    toolCallId: 'tc',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function findTool(tools: MakaTool[], name: string): MakaTool {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t!;
}

function makeTools() {
  const mgr = new GoalManager({ generateId: () => 'g-1', now: () => 5000 });
  const goalContinuation = new GoalContinuationCoordinator({
    goalManager: mgr,
    evaluator: { evaluate: async () => '{"met":false,"reason":"not evaluated"}' },
    getRecentContext: async () => '',
    durability: volatileGoalDurability,
    admitTurn: () => ({ kind: 'unavailable', reason: 'tool test' }),
  });
  assert.equal(goalContinuation.beginObservedTurn(SESSION, 't').kind, 'registered');
  const tools = buildGoalTools({
    goalManager: mgr,
    goalContinuation,
    now: () => 5000,
  });
  return { mgr, tools, goalContinuation };
}

describe('goal tools', () => {
  test('GoalSet leaves the token baseline for the first carried Turn to settle', async () => {
    const { mgr, tools } = makeTools();
    const set = findTool(tools, GOAL_SET_TOOL_NAME);
    await set.impl({ condition: 'x' }, ctx());
    const goal = mgr.get(SESSION);
    // The Turn holding this tool call has already spent tokens the Goal did
    // not cause, so there is no honest baseline to record yet.
    assert.equal(goal?.tokensBaselinePending, true);
    assert.equal(goal?.tokensAtStart, 0);
  });

  test('GoalSet reports an unfinished Goal instead of replacing it', async () => {
    const { mgr, tools } = makeTools();
    const set = findTool(tools, GOAL_SET_TOOL_NAME);
    await set.impl({ condition: 'first' }, ctx());
    const first = mgr.get(SESSION);

    const out = (await set.impl({ condition: 'replacement' }, ctx())) as string;

    assert.match(out, /unfinished goal/);
    assert.strictEqual(mgr.get(SESSION), first);
  });

  test('GoalPause / GoalResume lifecycle', async () => {
    const { mgr, tools, goalContinuation } = makeTools();
    await findTool(tools, GOAL_SET_TOOL_NAME).impl({ condition: 'x' }, ctx());

    const pauseOut = (await findTool(tools, GOAL_PAUSE_TOOL_NAME).impl({}, ctx())) as string;
    assert.ok(pauseOut.includes('paused'));
    assert.equal(mgr.get(SESSION)?.status, 'paused');

    assert.equal(goalContinuation.beginObservedTurn(SESSION, 'resume-turn').kind, 'registered');
    const resumeOut = (await findTool(tools, GOAL_RESUME_TOOL_NAME).impl(
      {},
      ctx('resume-turn'),
    )) as string;
    assert.ok(resumeOut.includes('resumed'));
    assert.equal(mgr.get(SESSION)?.status, 'active');
  });
});
