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

import { Notebook } from '../../../../src/assistant/index-initiative/notebook.js';

/**
 * Evaluation for assistant discovery (#6360).
 *
 * Judging discovery on repeated notifications alone rewards silence, and #6247
 * item 6 reports that failure: a persistent discovery Session drifts to familiar
 * topics and goes quiet. This harness scores one scenario on four numbers that
 * have to be read together:
 *
 * - misses: known-useful findings that were never told to the user;
 * - repeats: a topic told again with no change, or told while the user's rule
 *   still closes or defers it;
 * - latency: how long the runner took per round;
 * - cost: model calls and tokens the runner reports.
 *
 * Everything goes through the real Notebook, so validation, topic state and
 * delivery receipts behave as in production. What discovery does is pluggable:
 * a Runner receives the notebook as the model would read it and returns the
 * judgement draft. The tests use scripted runners; a live runner that drives the
 * persistent Sessions is what produces a baseline (not included here).
 */

export interface SeedNote {
  topicId: string;
  title: string;
  text: string;
  occurredAt?: string | null;
  sources: string[];
  tags: string[];
}

export interface Round {
  /** World information that becomes known in this round (exploration appends it). */
  notes?: SeedNote[];
  /**
   * A user reply to the last message told about `topicId`, closing it. The
   * harness records and interprets it, so the Runner is judged on what discovery
   * does afterwards, not on reading the reply. If nothing was told about the
   * topic there is nothing to reply to, and the reply is skipped.
   */
  userCloses?: { topicId: string; quote: string };
}

export interface ExpectedFinding {
  id: string;
  topicId: string;
  /** The finding is useful to tell from this round on. */
  fromRound: number;
}

export interface Scenario {
  id: string;
  rounds: Round[];
  expected: ExpectedFinding[];
}

export interface RunnerUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface RunnerResult {
  draft: Record<string, unknown>;
  usage?: RunnerUsage;
}

export type Runner = (input: {
  round: number;
  /** The notebook as the judgement model reads it. */
  view: string;
}) => Promise<RunnerResult> | RunnerResult;

export interface Repeat {
  round: number;
  topicId: string;
  reason: 'unchanged' | 'closed_by_user';
}

export interface EvalReport {
  scenario: string;
  told: { round: number; topicId: string }[];
  misses: string[];
  repeats: Repeat[];
  /** User replies that happened; a silent runner gives the user nothing to reply to. */
  userReplies: number;
  latencyMs: { total: number; perRound: number[] };
  cost: RunnerUsage;
}

const T0 = Date.parse('2026-10-22T10:00:00Z');

export async function evaluate(
  scenario: Scenario,
  runner: Runner,
  options: { now?: () => number } = {},
): Promise<EvalReport> {
  const now = options.now ?? (() => performance.now());
  // One minute per notebook write keeps the notebook clock strictly increasing.
  let tick = 0;
  const notebook = new Notebook(':memory:', () => new Date(T0 + ++tick * 60_000).toISOString());
  const told: EvalReport['told'] = [];
  const repeats: Repeat[] = [];
  const perRound: number[] = [];
  const cost: RunnerUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const lastTold = new Map<string, string>();
  let userReplies = 0;
  try {
    for (const [round, step] of scenario.rounds.entries()) {
      const commit = (id: string, role: string, draft: Record<string, unknown>) =>
        notebook.commitDraft({
          role,
          operationId: `${scenario.id}:${round}:${id}`,
          expectedFeedbackRevision: notebook.revision(),
          draft,
        });
      if (step.notes?.length) commit('world', 'exploration', { notes: step.notes });
      if (step.userCloses) {
        const { topicId, quote } = step.userCloses;
        const delivery = lastTold.get(topicId);
        if (delivery) {
          userReplies++;
          const feedbackId = `${scenario.id}:${round}:feedback`;
          notebook.recordFeedback({ id: feedbackId, text: quote, replyTo: delivery });
          commit('interpret', 'judgement', {
            feedbackDecisions: [
              {
                feedbackId,
                understanding: '用户明确不再关注该主题',
                rules: [
                  {
                    quote,
                    status: 'closed',
                    reason: '用户不再关注',
                    resumeAt: null,
                    topicIds: [topicId],
                    tags: [],
                  },
                ],
              },
            ],
          });
        }
      }
      const started = now();
      const result = await runner({ round, view: notebook.render() });
      perRound.push(now() - started);
      if (result.usage) {
        cost.calls += result.usage.calls;
        cost.inputTokens += result.usage.inputTokens;
        cost.outputTokens += result.usage.outputTokens;
      }
      const committed = commit('judge', 'judgement', result.draft);
      for (const preparedId of committed.preparedIds) {
        const topicIds: string[] = notebook.event(preparedId)!.payload.topicIds;
        // Judge each topic against the state before this message is delivered.
        for (const topicId of topicIds) {
          const state = notebook.state(topicId);
          const prior = lastTold.get(topicId);
          if (['closed', 'deferred'].includes(state.status)) {
            repeats.push({ round, topicId, reason: 'closed_by_user' });
          } else if (
            prior &&
            !notebook
              .events('note')
              .some((e) => e.payload.topicId === topicId && e.seq > notebook.event(prior)!.seq)
          ) {
            repeats.push({ round, topicId, reason: 'unchanged' });
          }
        }
        await notebook.deliver(
          preparedId,
          async ({ messageId }) => ({ delivered: true, messageIds: [`sent:${messageId}`] }),
          'eval',
        );
        for (const topicId of topicIds) {
          told.push({ round, topicId });
          lastTold.set(topicId, `${preparedId}:delivered`);
        }
      }
    }
  } finally {
    notebook.close();
  }
  const misses = scenario.expected
    .filter((f) => !told.some((t) => t.topicId === f.topicId && t.round >= f.fromRound))
    .map((f) => f.id);
  return {
    scenario: scenario.id,
    told,
    misses,
    repeats,
    userReplies,
    latencyMs: { total: perRound.reduce((a, b) => a + b, 0), perRound },
    cost,
  };
}
