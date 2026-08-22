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

/**
 * The goal chip is the desktop kill switch for an autonomous loop: a running
 * goal pulses with live progress, while a paused goal burns nothing and must
 * read as paused (distinct label, no running affordance) with a resume path.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { SessionContextLayer, type SessionContextGoal } from '../session-context-layer.js';

function renderGoalChip(goal: SessionContextGoal): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <SessionContextLayer sessionName="Session" goal={goal} />
    </LocaleProvider>,
  );
}

test('a running goal reads as running and offers pause, with elapsed and tokens', () => {
  const markup = renderGoalChip({
    condition: 'Ship the feature',
    status: 'active',
    iterations: 3,
    maxIterations: 50,
    setAt: Date.now() - 12 * 60_000,
    tokensSpent: 12_000,
    tokenBudget: 100_000,
    onPause: () => undefined,
    onClear: () => undefined,
  });
  assert.ok(markup.includes('Goal 3 of 50'));
  assert.ok(markup.includes('12m'));
  assert.ok(markup.includes('12k / 100k'));
  assert.ok(markup.includes('Autonomous goal running'));
  assert.ok(!markup.includes('Autonomous goal paused'));
  assert.ok(markup.includes('Pause autonomous goal after 3/50 iterations'));
  assert.ok(!markup.includes('Resume autonomous goal'));
  // The clear kill switch stays.
  assert.ok(markup.includes('Clear autonomous goal after 3/50 iterations'));
});

test('a paused goal reads as paused and offers resume, not pause', () => {
  const markup = renderGoalChip({
    condition: 'Ship the feature',
    status: 'paused',
    iterations: 3,
    maxIterations: 50,
    setAt: 1_000,
    pausedAt: 1_000 + 12 * 60_000,
    onResume: () => undefined,
    onClear: () => undefined,
  });
  assert.ok(markup.includes('Autonomous goal paused'));
  assert.ok(!markup.includes('Autonomous goal running'));
  assert.ok(markup.includes('Resume autonomous goal after 3/50 iterations'));
  assert.ok(!markup.includes('Pause autonomous goal'));
  // Elapsed shows (frozen), tokens stay hidden without a budget.
  assert.ok(markup.includes('12m'));
  assert.ok(!markup.includes('12k'));
});

test('a waiting goal reads as waiting without looking active or paused', () => {
  const markup = renderGoalChip({
    condition: 'Wait for CI',
    status: 'waiting',
    iterations: 4,
    maxIterations: 50,
    setAt: Date.now() - 30_000,
    tokensSpent: 12_000,
    tokenBudget: 100_000,
    onPause: () => undefined,
    onClear: () => undefined,
  });
  assert.ok(markup.includes('Autonomous goal waiting for conditions to change'));
  assert.ok(!markup.includes('Autonomous goal running'));
  assert.ok(!markup.includes('Autonomous goal paused'));
  assert.ok(markup.includes('Pause autonomous goal after 4/50 iterations'));
  assert.ok(!markup.includes('Resume autonomous goal'));
  assert.ok(markup.includes('12k / 100k'));
});
