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
import { readWorkHubRequestIntent } from '../workhub-creation-intent.js';
import {
  createExactNameSessionResolver,
  type WorkHubResolverSession,
} from '../workhub-session-resolver.js';

const session = (ref: string, sessionName: string, updatedAt = 1): WorkHubResolverSession => ({
  ref,
  sessionName,
  projectName: 'demo',
  updatedAt,
});

const resolveText = (text: string, sessions: readonly WorkHubResolverSession[]) => {
  const reference = readWorkHubRequestIntent(text).stop.target;
  assert.ok(reference, text);
  return createExactNameSessionResolver().resolve({ reference: { text: reference }, sessions });
};

test('the exact-name resolver recalls one visible Session by opaque reference', () => {
  assert.deepEqual(
    resolveText('Stop Payments', [session('s1', 'Payments'), session('s2', 'Login')]),
    { kind: 'ranked', candidates: [{ ref: 's1', evidence: { kind: 'named', remainder: '' } }] },
  );
  assert.deepEqual(resolveText('停止支付任务', [session('s1', '支付任务')]), {
    kind: 'ranked',
    candidates: [{ ref: 's1', evidence: { kind: 'named', remainder: '' } }],
  });
});

test('a reference that names nothing visible resolves to none', () => {
  assert.deepEqual(resolveText('Stop using the deprecated API', [session('s1', 'Payments')]), {
    kind: 'none',
  });
  assert.deepEqual(resolveText('Stop Payments', []), { kind: 'none' });
});

test('equal exact matches are ambiguity rather than an unjustified ranking', () => {
  assert.deepEqual(
    resolveText('Stop Payments', [session('s1', 'Payments'), session('s2', 'Payments')]),
    {
      kind: 'ambiguous',
      candidates: [
        { ref: 's1', evidence: { kind: 'named', remainder: '' } },
        { ref: 's2', evidence: { kind: 'named', remainder: '' } },
      ],
    },
  );
});
