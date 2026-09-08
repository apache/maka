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
import { runRoutingComparison, session } from './workhub-controller-fixture.js';

test('comparison hydrates the same transcript and candidate set into every fresh controller', async () => {
  const sessions = [session('payment', { sessionName: '支付回调幂等性' })];
  const transcript = [{ messageId: 'history', turnId: 'history', text: '此前讨论了支付重试', result: '保留幂等性约束', state: 'completed' as const, updatedAt: 1 }];
  const before = structuredClone({ sessions, transcript });
  let intentCalls = 0;
  const candidateSetId = `sha256:${'c'.repeat(64)}`;
  const observations = await runRoutingComparison({ repetitions: 2, sessions, transcript, candidateSetId,
    cases: [{ caseId: 'payment', text: '支付回调幂等性：补充重复投递测试' }],
    model: { async decide(input) {
      if (input.stage === 'resolver') return { kind: 'ranked', candidateRefs: ['candidate-payment'] };
      intentCalls += 1;
      assert.deepEqual(input.coordinationTranscript, [{ userText: transcript[0]!.text, assistantText: transcript[0]!.result }]);
      return { intent: 'work' };
    } },
  });
  assert.equal(intentCalls, 4);
  assert.equal(observations.length, 6);
  assert.equal(new Set(observations.map(({ result }) => result.strategyId)).size, 3);
  for (const { result, proposals } of observations) {
    assert.equal(result.kind, 'submitted');
    if (result.kind === 'submitted') assert.equal(result.target.sessionId, 'payment');
    assert.equal(proposals.length, 1);
    const proposal = proposals[0]!.proposal;
    assert.equal(proposal.disposition, "delegate_existing");
    if (proposal.disposition === "delegate_existing") assert.equal(proposals[0]!.candidateSetId, candidateSetId);
  }
  assert.deepEqual({ sessions, transcript }, before);
});
