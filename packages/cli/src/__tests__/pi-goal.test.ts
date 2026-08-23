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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GOAL_STATUSES, type GoalStatus } from '@maka/core/goal';
import type { GoalProjection } from '@maka/runtime-host/protocol';
import { formatTokenCount } from '../pi-transcript-format.js';
import { stripAnsi } from '../tui-ansi.js';
import {
  formatGoalElapsed,
  goalAttachedNoticeText,
  goalElapsedMs,
  goalPausedNoticeText,
  goalStatusLabel,
  goalStatusLineText,
  goalSummaryLines,
  isLiveGoalStatus,
} from '../pi-goal.js';

function goal(overrides: Partial<GoalProjection> = {}): GoalProjection {
  return {
    goalId: 'goal-1',
    revision: 1,
    sessionId: 'session-1',
    condition: 'Ship the feature',
    status: 'active',
    setAt: 1_000,
    iterations: 3,
    maxIterations: 50,
    consecutiveNoProgress: 0,
    blockCap: 8,
    tokenBudget: null,
    tokensSpent: 0,
    lastReason: null,
    achievedAt: null,
    pausedAt: null,
    ...overrides,
  };
}

describe('pi-goal display helpers', () => {
  test('strips generic ESC character-set sequences from displayed text', () => {
    assert.equal(stripAnsi('\x1b(0goal'), 'goal');
  });

  test('every declared goal status has a label and a live/terminal classification', () => {
    // Exhaustiveness guard: a new GoalStatus must make a deliberate choice in
    // both places instead of silently falling through.
    for (const status of GOAL_STATUSES) {
      assert.equal(typeof goalStatusLabel(status), 'string', status);
      assert.notEqual(goalStatusLabel(status), '', status);
      assert.equal(typeof isLiveGoalStatus(status), 'boolean', status);
    }
    assert.deepEqual(
      GOAL_STATUSES.filter((status) => isLiveGoalStatus(status)),
      ['active', 'waiting', 'paused'],
    );
  });

  test('elapsed freezes at pausedAt for a paused goal and never goes negative', () => {
    const paused = goal({ status: 'paused', setAt: 1_000, pausedAt: 61_000 });
    assert.equal(goalElapsedMs(paused, 600_000), 60_000);
    assert.equal(goalElapsedMs(goal({ setAt: 10_000 }), 5_000), 0);
  });

  test('formatGoalElapsed is compact', () => {
    assert.equal(formatGoalElapsed(0), '0s');
    assert.equal(formatGoalElapsed(59_000), '59s');
    assert.equal(formatGoalElapsed(60_000), '1m');
    assert.equal(formatGoalElapsed(90 * 60_000), '1h 30m');
    assert.equal(formatGoalElapsed(2 * 3_600_000), '2h');
    assert.equal(formatGoalElapsed(26 * 3_600_000), '1d 2h');
  });

  test('status-line text: active shows elapsed, waiting and paused show the state name', () => {
    const now = 61_000;
    assert.equal(goalStatusLineText(goal({ setAt: 1_000 }), now), 'goal 3/50 1m');
    assert.equal(goalStatusLineText(goal({ status: 'waiting' }), now), 'goal waiting 3/50');
    assert.equal(
      goalStatusLineText(goal({ status: 'paused', pausedAt: 31_000 }), now),
      'goal paused 3/50',
    );
  });

  test('summary lines include budget only when set and the evaluator note only when present', () => {
    const plain = goalSummaryLines(goal(), 61_000);
    assert.equal(plain.length, 2);
    assert.match(plain[0]!, /^Goal: Ship the feature$/);
    assert.match(plain[1]!, /active · 3\/50 iterations · 1m$/);

    const detailed = goalSummaryLines(
      goal({ tokenBudget: 100_000, tokensSpent: 45_200, lastReason: 'tests still failing' }),
      61_000,
    );
    assert.deepEqual(detailed.slice(2), [
      'Tokens: 45k / 100k',
      'Last evaluator note: tests still failing',
    ]);
  });

  test('summary collapses embedded whitespace and labels a cleared goal as cleared', () => {
    const messy = goalSummaryLines(
      goal({ condition: 'Ship the\n  feature', lastReason: 'line one\nline   two' }),
      61_000,
    );
    assert.equal(messy[0], 'Goal: Ship the feature');
    assert.equal(messy.at(-1), 'Last evaluator note: line one line two');

    const hostile = goalSummaryLines(
      goal({
        condition: 'Ship\x1b[2J the\x00 feature',
        lastReason: 'safe\x1b]0;spoofed title\x07\nUnicode ✓',
      }),
      61_000,
    );
    assert.equal(hostile[0], 'Goal: Ship the feature');
    assert.equal(hostile.at(-1), 'Last evaluator note: safe Unicode ✓');
    for (const line of hostile) {
      assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/u);
    }

    // A cleared goal keeps its terminal record; the summary must not present
    // the condition as if it were still armed.
    const cleared = goalSummaryLines(goal({ status: 'cleared' }), 61_000);
    assert.equal(cleared[0], 'Cleared goal: Ship the feature');
    assert.match(cleared[1]!, /^Status: cleared /);
  });

  test('summary hides elapsed for terminal verdicts that carry no freeze timestamp', () => {
    const terminal = [
      'cleared',
      'impossible',
      'stalled',
      'budget_limited',
      'max_iterations',
    ] as const;
    for (const status of terminal) {
      const lines = goalSummaryLines(goal({ status }), 61_000);
      assert.equal(lines[1], `Status: ${goalStatusLabel(status)} · 3/50 iterations`, status);
    }
  });

  test('summary keeps the frozen elapsed for an achieved goal', () => {
    const lines = goalSummaryLines(goal({ status: 'achieved', achievedAt: 61_000 }), 600_000);
    assert.match(lines[1]!, /achieved · 3\/50 iterations · 1m$/);
  });

  test('token formatting is the shared status-line formatter', () => {
    assert.equal(formatTokenCount(45_200), '45k');
  });

  test('pause and attach notices name the loop and its controls', () => {
    assert.equal(
      goalPausedNoticeText(goal({ lastReason: 'Goal-associated turn was aborted.' })),
      'Goal paused (3/50). Goal-associated turn was aborted. /goal resume continues it, /goal clear stops it.',
    );
    assert.equal(
      goalPausedNoticeText(goal({ lastReason: null })),
      'Goal paused (3/50). /goal resume continues it, /goal clear stops it.',
    );
    // Embedded newlines collapse so the notice stays one line.
    assert.equal(
      goalAttachedNoticeText(goal({ condition: 'Ship the\n  feature' })),
      'Autonomous goal is running (3/50): Ship the feature — /goal shows details, /goal pause pauses it.',
    );
    // Long conditions are capped with an ellipsis.
    const long = goalAttachedNoticeText(goal({ condition: 'x'.repeat(200) }));
    assert.ok(long.includes('…') && long.length <= 210);
  });
});
