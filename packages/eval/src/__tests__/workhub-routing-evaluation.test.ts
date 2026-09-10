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
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  runWorkHubRoutingEvaluation,
  validateWorkHubRoutingDataset,
  WORKHUB_ROUTING_EVALUATION_SCHEMA_VERSION,
  type WorkHubRoutingDataset,
  type WorkHubRoutingEvaluationArm,
} from '../workhub-routing-evaluation.js';
import {
  createSplitWorkHubRoutingModelArm,
  decodeIntent,
  decodeRecall,
  type WorkHubRoutingModelPort,
  type WorkHubRoutingModelRequest,
  type WorkHubRoutingModelResponse,
} from '../workhub-routing-model.js';

const candidates = [
  {
    candidateRef: 'candidate-auth',
    sessionName: 'Auth hardening',
    workspaceName: 'Maka',
    state: 'running' as const,
    recency: 'today' as const,
    objective: 'Harden authentication',
  },
  {
    candidateRef: 'candidate-payments',
    sessionName: 'Payment webhooks',
    workspaceName: 'Commerce',
    state: 'waiting_for_user' as const,
    recency: 'this_week' as const,
    objective: 'Diagnose duplicate delivery',
  },
];

function model(
  decide: (input: WorkHubRoutingModelRequest) => WorkHubRoutingModelResponse,
): WorkHubRoutingModelPort {
  return {
    async decide(input) {
      return decide(input);
    },
  };
}

test('split model routing keeps intent target-free and recall candidate-bounded', async () => {
  const calls: WorkHubRoutingModelRequest[] = [];
  const arm = createSplitWorkHubRoutingModelArm({
    id: 'model-model',
    intentModel: model((input) => {
      calls.push(input);
      return {
        value: { kind: 'routing', mode: 'continue' },
        usage: usage(3, 1),
        costUsd: 0.01,
      };
    }),
    recallModel: model((input) => {
      calls.push(input);
      return {
        value: {
          kind: 'ranked',
          candidateRefs: ['candidate-auth', 'candidate-payments'],
        },
        usage: usage(5, 2),
        costUsd: 0.02,
      };
    }),
  });

  const result = await arm.evaluate({
    userText: '继续认证加固',
    transcript: [],
    candidates,
  });

  assert.deepEqual(result.intent, { kind: 'routing', mode: 'continue' });
  assert.deepEqual(result.recall, {
    kind: 'ranked',
    candidateRefs: ['candidate-auth', 'candidate-payments'],
  });
  assert.deepEqual(result.outcome, {
    kind: 'routing',
    disposition: 'delegate_existing',
    candidateRef: 'candidate-auth',
  });
  assert.equal(calls[0]?.stage, 'intent');
  assert.equal(calls[1]?.stage, 'recall');
  assert.equal('candidates' in calls[0]!, false);
  assert.deepEqual(result.usage, usage(8, 3));
  assert.equal(result.costUsd, 0.03);
});

test('explicit creation never calls recall and ordinary execution cannot create implicitly', async () => {
  let recallCalls = 0;
  const recallModel = model(() => {
    recallCalls += 1;
    return { value: { kind: 'none' } };
  });
  const create = createSplitWorkHubRoutingModelArm({
    id: 'create',
    intentModel: model(() => ({ value: { kind: 'routing', mode: 'create' } })),
    recallModel,
  });
  assert.deepEqual(
    (await create.evaluate({ userText: '新建登录任务', transcript: [], candidates })).outcome,
    { kind: 'routing', disposition: 'create_new' },
  );
  assert.equal(recallCalls, 0);

  const execute = createSplitWorkHubRoutingModelArm({
    id: 'execute',
    intentModel: model(() => ({ value: { kind: 'routing', mode: 'execute' } })),
    recallModel,
  });
  assert.deepEqual(
    (await execute.evaluate({ userText: '修复一个问题', transcript: [], candidates })).outcome,
    { kind: 'routing', disposition: 'clarify' },
  );
  assert.equal(recallCalls, 1);
});

test('linked intent bypasses Session recall and remains a linked operation', async () => {
  const arm = createSplitWorkHubRoutingModelArm({
    id: 'linked',
    intentModel: model(() => ({ value: { kind: 'linked', operation: 'resume' } })),
    recallModel: model(() => {
      throw new Error('Session recall must not resolve a linked delegation');
    }),
  });
  assert.deepEqual(
    await arm.evaluate({ userText: '继续刚才停掉的任务', transcript: [], candidates }),
    {
      intent: { kind: 'linked', operation: 'resume' },
      recall: { kind: 'not_applicable' },
      outcome: { kind: 'linked', operation: 'resume' },
    },
  );
});

test('model output rejects invented refs, duplicate refs, and widened intent shapes', () => {
  const allowed = new Set(candidates.map(({ candidateRef }) => candidateRef));
  assert.throws(() => decodeRecall({ kind: 'ranked', candidateRefs: ['invented'] }, allowed));
  assert.throws(() =>
    decodeRecall({ kind: 'ranked', candidateRefs: ['candidate-auth', 'candidate-auth'] }, allowed),
  );
  assert.throws(() =>
    decodeRecall({ kind: 'ambiguous', candidateRefs: ['candidate-auth'] }, allowed),
  );
  assert.throws(() => decodeIntent({ kind: 'routing', mode: 'create', sessionId: 'forged' }));
});

test('evaluation rejects recall output when the intent does not require recall', async () => {
  const report = await runWorkHubRoutingEvaluation({
    dataset: fixtureDataset(),
    arms: [
      {
        id: 'leaky-stage',
        async evaluate({ userText }) {
          if (userText.includes('继续')) {
            return {
              intent: { kind: 'routing', mode: 'continue' },
              recall: { kind: 'ranked', candidateRefs: ['candidate-auth'] },
              outcome: {
                kind: 'routing',
                disposition: 'delegate_existing',
                candidateRef: 'candidate-auth',
              },
            };
          }
          return {
            intent: { kind: 'routing', mode: 'discuss' },
            recall: { kind: 'ranked', candidateRefs: ['candidate-auth'] },
            outcome: { kind: 'routing', disposition: 'answer_here' },
          };
        },
      },
    ],
    repetitions: 1,
  });
  assert.equal(report.trials[1]?.failure, 'invalid_observation');
});

test('evaluation arms receive an immutable candidate snapshot', async () => {
  let frozen = false;
  await runWorkHubRoutingEvaluation({
    dataset: fixtureDataset(),
    arms: [
      {
        id: 'snapshot-check',
        async evaluate({ candidates: received }) {
          frozen =
            Object.isFrozen(received) && received.every((candidate) => Object.isFrozen(candidate));
          return {
            intent: { kind: 'routing', mode: 'discuss' },
            recall: { kind: 'not_applicable' },
            outcome: { kind: 'routing', disposition: 'answer_here' },
          };
        },
      },
    ],
    repetitions: 1,
  });
  assert.equal(frozen, true);
});

test('evaluation reports intent, recall, action, safety, latency, and cost separately', async () => {
  const dataset = fixtureDataset();
  const safe: WorkHubRoutingEvaluationArm = {
    id: 'safe',
    async evaluate({ userText }) {
      return userText.includes('继续')
        ? {
            intent: { kind: 'routing', mode: 'continue' },
            recall: { kind: 'ranked', candidateRefs: ['candidate-auth'] },
            outcome: {
              kind: 'routing',
              disposition: 'delegate_existing',
              candidateRef: 'candidate-auth',
            },
            usage: usage(4, 2),
            costUsd: 0.01,
          }
        : {
            intent: { kind: 'routing', mode: 'discuss' },
            recall: { kind: 'not_applicable' },
            outcome: { kind: 'routing', disposition: 'answer_here' },
          };
    },
  };
  const unsafe: WorkHubRoutingEvaluationArm = {
    id: 'unsafe',
    async evaluate() {
      return {
        intent: { kind: 'routing', mode: 'execute' },
        recall: { kind: 'ranked', candidateRefs: ['candidate-payments'] },
        outcome: {
          kind: 'routing',
          disposition: 'delegate_existing',
          candidateRef: 'candidate-payments',
        },
      };
    },
  };
  let tick = 0;
  const report = await runWorkHubRoutingEvaluation({
    dataset,
    arms: [safe, unsafe],
    repetitions: 2,
    now: () => tick++,
  });

  assert.equal(report.trials.length, 8);
  assert.deepEqual(report.summaries[0], {
    armId: 'safe',
    repetitions: 2,
    scenarioCoverage: 1,
    intentAccuracy: 1,
    recallKindAccuracy: 1,
    recallAt1: 1,
    recallAt5: 1,
    meanReciprocalRank: 1,
    dispositionAccuracy: 1,
    targetAccuracy: 1,
    outcomeAccuracy: 1,
    unsafeBindCount: 0,
    implicitCreateCount: 0,
    unnecessaryClarificationCount: 0,
    failureCount: 0,
    latencyMs: { p50: 1, p95: 1 },
    usage: {
      samples: 2,
      inputTokens: 8,
      outputTokens: 4,
      totalTokens: 12,
      costUsd: 0.02,
    },
  });
  assert.equal(report.summaries[1]?.unsafeBindCount, 4);
  assert.equal(report.summaries[1]?.outcomeAccuracy, 0);
});

test('dataset validation rejects unknown labels and implicit-create expectations', () => {
  const dataset = fixtureDataset();
  validateWorkHubRoutingDataset(dataset);
  assert.throws(() =>
    validateWorkHubRoutingDataset({
      ...dataset,
      scenarios: [
        {
          ...dataset.scenarios[0]!,
          acceptableCandidateRefs: ['unknown'],
        },
      ],
    }),
  );
});

test('the checked-in ten-Session routing dataset is versioned and valid', async () => {
  const value = JSON.parse(
    await readFile(new URL('../../fixtures/workhub-routing-v2.json', import.meta.url), 'utf8'),
  ) as WorkHubRoutingDataset;
  validateWorkHubRoutingDataset(value);
  assert.equal(value.candidates.length, 10);
  assert.equal(value.scenarios.length, 14);
});

function fixtureDataset(): WorkHubRoutingDataset {
  return {
    schemaVersion: WORKHUB_ROUTING_EVALUATION_SCHEMA_VERSION,
    id: 'fixture-v1',
    candidates,
    scenarios: [
      {
        id: 'continue-auth',
        userText: '继续认证加固',
        transcript: [],
        expectedIntent: { kind: 'routing', mode: 'continue' },
        expectedRecallKind: 'ranked',
        acceptableCandidateRefs: ['candidate-auth'],
        forbiddenCandidateRefs: ['candidate-payments'],
        expectedOutcome: {
          kind: 'routing',
          disposition: 'delegate_existing',
          candidateRef: 'candidate-auth',
        },
        risk: 'workspace_write',
      },
      {
        id: 'discussion',
        userText: '哪种方案更安全？',
        transcript: [],
        expectedIntent: { kind: 'routing', mode: 'discuss' },
        expectedRecallKind: 'not_applicable',
        acceptableCandidateRefs: [],
        forbiddenCandidateRefs: ['candidate-auth', 'candidate-payments'],
        expectedOutcome: { kind: 'routing', disposition: 'answer_here' },
        risk: 'read_only',
      },
    ],
  };
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}
