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
import {
  applyWorkHubRoutingPolicy,
  bindWorkHubRoutingDecision,
  decodeWorkHubIntent,
  decodeWorkHubRecall,
  workHubIntentRequiresRecall,
} from '../workhub-routing.js';

test('Intent stays target-free and only execute or continue invoke Recall', () => {
  const execute = decodeWorkHubIntent({ kind: 'routing', mode: 'execute' });
  assert.equal(workHubIntentRequiresRecall(execute), true);
  assert.equal(
    workHubIntentRequiresRecall(decodeWorkHubIntent({ kind: 'routing', mode: 'create' })),
    false,
  );
  assert.equal(
    workHubIntentRequiresRecall(decodeWorkHubIntent({ kind: 'linked', operation: 'resume' })),
    false,
  );
  assert.throws(
    () => decodeWorkHubIntent({ kind: 'routing', mode: 'execute', candidateRef: 'candidate-a' }),
    /Invalid WorkHub model intent/,
  );
});

test('Recall accepts only bounded opaque candidate refs', () => {
  const allowed = new Set(['candidate-a', 'candidate-b']);
  assert.deepEqual(
    decodeWorkHubRecall({ kind: 'ranked', candidateRefs: ['candidate-b'] }, allowed),
    { kind: 'ranked', candidateRefs: ['candidate-b'] },
  );
  assert.throws(
    () => decodeWorkHubRecall({ kind: 'ranked', candidateRefs: ['session-secret'] }, allowed),
    /Invalid WorkHub model recall/,
  );
  assert.throws(
    () => decodeWorkHubRecall({ kind: 'ambiguous', candidateRefs: ['candidate-a'] }, allowed),
    /Invalid WorkHub model recall/,
  );
});

test('Policy never converts failed Recall into implicit creation', () => {
  const execute = { kind: 'routing', mode: 'execute' } as const;
  assert.deepEqual(applyWorkHubRoutingPolicy(execute, { kind: 'none' }), {
    kind: 'routing',
    disposition: 'clarify',
  });
  assert.deepEqual(
    applyWorkHubRoutingPolicy(execute, { kind: 'ambiguous', candidateRefs: ['a', 'b'] }),
    {
      kind: 'routing',
      disposition: 'clarify',
    },
  );
  assert.deepEqual(
    bindWorkHubRoutingDecision(
      applyWorkHubRoutingPolicy(execute, { kind: 'ranked', candidateRefs: ['candidate-a'] }),
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ),
    {
      kind: 'routing',
      disposition: 'delegate_existing',
      candidateSetId: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      candidateRef: 'candidate-a',
    },
  );
});
