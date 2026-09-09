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
import test from 'node:test';
import { createWorkHubController, port, session } from './workhub-controller-fixture.js';
import {
  boundedRoutingInput,
  createWorkHubR24RoutingStrategy,
  createWorkHubR3ARoutingStrategy,
  createWorkHubR3BRoutingStrategy,
  readWorkHubRoutingEvidence,
  type WorkHubRoutingInput,
  type WorkHubRoutingStrategy,
  type WorkHubModelRoutingRequest,
} from '../../renderer/features/workhub/index.js';

const sessions = [
  {
    target: { sessionId: 'login' },
    projectName: 'maka',
    sessionName: '登录刷新令牌',
    state: 'active' as const,
    updatedAt: 2,
  },
  {
    target: { sessionId: 'payment' },
    projectName: 'maka',
    sessionName: '支付回调幂等性',
    state: 'active' as const,
    updatedAt: 1,
  },
];
function fixture(text = '请实现账本边界检查器'): WorkHubRoutingInput {
  return {
    text,
    sessions,
    originPromptBySessionId: new Map(),
    candidateRefBySessionId: new Map([
      ['login', 'candidate-login'],
      ['payment', 'candidate-payment'],
    ]),
    coordinationTranscript: [],
  };
}
async function run(strategy: WorkHubRoutingStrategy, raw = fixture()) {
  const sessions = port(raw.sessions.map((value) => session(value.target.sessionId, value)));
  sessions.routingEvidence = async () => [...raw.originPromptBySessionId].map(([sessionId, originPrompt]) => ({ target: { sessionId }, originPrompt }));
  sessions.create = async ({ name }) => session('created', { sessionName: name });
  const controller = createWorkHubController({ sessions, routingStrategy: strategy });
  return controller.submit({ newSessionFallbackTitle: 'New work', requestId: 'combination', text: raw.text });
}
const model = {
  async decide(input: WorkHubModelRoutingRequest) {
    return input.stage === 'intent'
      ? { intent: 'work' }
      : { kind: 'ranked', candidateRefs: ['candidate-payment'] };
  },
};

test('a strategy combines two independent ports and has no decision or focus owner', async () => {
  const baseline = createWorkHubR24RoutingStrategy();
  const r3 = createWorkHubR3ARoutingStrategy({ model });
  assert.deepEqual(Object.keys(r3).sort(), ['intent', 'resolver', 'strategyId']);
  const intentOnly = { ...baseline, intent: r3.intent };
  const resolverOnly = { ...baseline, resolver: r3.resolver };
  assert.equal((await run(intentOnly, fixture('支付回调幂等性：补充测试'))).kind, 'submitted');
  const result = await run(resolverOnly);
  assert.equal(result.kind, 'submitted');
  if (result.kind === 'submitted') assert.equal(result.target.sessionId, 'payment');
});

test('R3-A calls separate intent and recall components; neither sees Session IDs', async () => {
  const requests: WorkHubModelRoutingRequest[] = [];
  const strategy = createWorkHubR3ARoutingStrategy({
    model: {
      async decide(input) {
        requests.push(input);
        return model.decide(input);
      },
    },
  });
  await run(strategy);
  assert.deepEqual(
    requests.map(({ stage }) => stage),
    ['intent', 'resolver'],
  );
  assert.equal('candidates' in requests[0]!, false);
  assert.equal('disposition' in requests[1]!, false);
  assert.equal(JSON.stringify(requests).includes('sessionId'), false);
});

test('R3-B replaces only Intent and reuses the deterministic Resolver', async () => {
  const stages: string[] = [];
  const strategy = createWorkHubR3BRoutingStrategy({
    model: {
      async decide(input) {
        stages.push(input.stage);
        return { intent: 'work' };
      },
    },
  });
  assert.equal((await run(strategy, fixture('支付回调幂等性：补充测试'))).kind, 'submitted');
  assert.deepEqual(stages, ['intent']);
});

test('all combinations see the same bounded candidate snapshot, including deterministic recall', async () => {
  const raw = fixture();
  const large = Array.from({ length: 14 }, (_, i) => ({
    ...sessions[0]!,
    target: { sessionId: `session-${i}` },
    sessionName: `工作 ${i}`,
    updatedAt: 14 - i,
  }));
  const input = boundedRoutingInput({
    ...raw,
    text: '工作 13',
    sessions: large,
    candidateRefBySessionId: new Map(
      large.map((session, i) => [session.target.sessionId, `ref-${i}`]),
    ),
  });
  assert.equal(input.sessions.length, 12);
  for (const strategy of [
    createWorkHubR24RoutingStrategy(),
    createWorkHubR3ARoutingStrategy({ model }),
    createWorkHubR3BRoutingStrategy({ model }),
  ]) {
    const seen: string[][] = [];
    const wrapped = {
      ...strategy,
      resolver: {
        async resolve(value: Parameters<typeof strategy.resolver.resolve>[0]) {
          seen.push(value.candidates.map(({ candidateRef }) => candidateRef));
          return strategy.resolver.resolve(value);
        },
      },
    };
    await readWorkHubRoutingEvidence(wrapped, input);
    assert.deepEqual(seen, [Array.from({ length: 12 }, (_, i) => `ref-${i}`)]);
  }
});

test('model text is bounded at the adapter while deterministic components keep full text', async () => {
  const input = boundedRoutingInput({
    ...fixture('😀'.repeat(3000)),
    sessions: sessions.map((session) => ({
      ...session,
      sessionName: '名'.repeat(1000),
      latestResult: '结'.repeat(1000),
    })),
    originPromptBySessionId: new Map([['login', '源'.repeat(1000)]]),
    coordinationTranscript: Array.from({ length: 20 }, () => ({ userText: '文'.repeat(1000) })),
  });
  assert.equal(Array.from(input.text).length, 3000);
  const requests: WorkHubModelRoutingRequest[] = [];
  await readWorkHubRoutingEvidence(createWorkHubR3ARoutingStrategy({ model: { async decide(value) { requests.push(value); return value.stage === "intent" ? { intent: "work" } : { kind: "none" }; } } }), input);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((value) => Array.from(value.text).length === 2000));
  assert.equal(input.coordinationTranscript.length, 12);
  assert.ok(input.sessions.every((session) => session.sessionName.length <= 600));
  assert.equal(input.originPromptBySessionId.get('login')?.length, 600);
});

for (const response of [
  null,
  [],
  { disposition: 'create_new' },
  { intent: 'work', target: 'payment' },
]) {
  test(`malformed intent cannot issue a proposal: ${JSON.stringify(response)}`, async () => {
    const strategy = createWorkHubR3ARoutingStrategy({ model: { decide: async () => response } });
    const evidence = await readWorkHubRoutingEvidence(strategy, boundedRoutingInput(fixture()));
    assert.equal(evidence.classification, 'uncertain');
    assert.equal(evidence.resolution.kind, 'ambiguous');
    assert.equal((await run(strategy)).kind, 'clarification');
  });
}
for (const response of [
  null,
  { kind: 'ranked', candidateRefs: ['invented'] },
  { kind: 'ranked', candidateRefs: ['candidate-payment', 'candidate-payment'] },
  { kind: 'ranked', candidateRefs: [] },
  { kind: 'none', disposition: 'create_new' },
  { kind: 'ranked', candidateRefs: ['candidate-payment'], target: 'payment' },
]) {
  test(`malformed recall fails closed: ${JSON.stringify(response)}`, async () => {
    const strategy = createWorkHubR3ARoutingStrategy({
      model: {
        decide: async (input) => (input.stage === 'intent' ? { intent: 'work' } : response),
      },
    });
    const evidence = await readWorkHubRoutingEvidence(strategy, boundedRoutingInput(fixture()));
    assert.equal(evidence.classification, 'uncertain');
    assert.equal(evidence.resolution.kind, 'ambiguous');
    assert.equal((await run(strategy)).kind, 'clarification');
  });
}

test('Policy retains ambiguity, exact naming and focus with model recall in the real controller', async () => {
  const strategy = createWorkHubR3ARoutingStrategy({ model });
  assert.equal((await run(strategy, fixture('创建一个新任务，不过我还不确定是否要做'))).kind, 'clarification');
  const controller = createWorkHubController({ sessions: port(sessions.map((value) => session(value.target.sessionId, value))), routingStrategy: strategy });
  const exact = await controller.submit({ newSessionFallbackTitle: 'New work', requestId: 'exact', text: '登录刷新令牌：补充测试' });
  assert.equal(exact.kind, 'submitted');
  if (exact.kind === 'submitted') assert.equal(exact.target.sessionId, 'login');
  const focused = await controller.submit({ newSessionFallbackTitle: 'New work', requestId: 'focused', text: '继续它' });
  assert.equal(focused.kind, 'submitted');
  if (focused.kind === 'submitted') assert.equal(focused.target.sessionId, 'login');
});

test('a ranked list is not a selected target: Policy clarifies multiple recalled candidates', async () => {
  const strategy = createWorkHubR3ARoutingStrategy({
    model: {
      decide: async (input) =>
        input.stage === 'intent'
          ? { intent: 'work' }
          : { kind: 'ranked', candidateRefs: ['candidate-payment', 'candidate-login'] },
    },
  });
  assert.equal((await run(strategy)).kind, 'clarification');
});

test('model work intent cannot turn trusted discussion into creation or delegation', async () => {
  const strategy = createWorkHubR3ARoutingStrategy({ model });
  const result = await run(strategy, fixture('讨论一下量子纠缠的概念'));
  assert.notEqual(result.kind, 'submitted');
});

test('trusted explicit creation is decided by Policy, never returned by a model', async () => {
  const result = await run(
    createWorkHubR3ARoutingStrategy({ model }),
    fixture('创建一个新工作，检查账本边界'),
  );
  assert.equal(result.kind, 'submitted');
  if (result.kind === 'submitted') assert.equal(result.target.sessionId, 'created');
});

test('model exceptions become uncertain evidence rather than creating work', async () => {
  const strategy = createWorkHubR3ARoutingStrategy({
    model: {
      decide: async () => {
        throw new Error('offline');
      },
    },
  });
  assert.equal((await run(strategy)).kind, 'clarification');
});
