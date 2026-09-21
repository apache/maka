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
import { test } from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { SessionHeader } from '@maka/core/session';
import { createJevRoutingModel } from '../server/jev-routing-model.js';

function fixture(
  options: {
    enabled?: boolean;
    privacy?: boolean;
    fail?: boolean;
    confidence?: number;
    intent?: string;
    invalid?: boolean;
    proxyFailure?: boolean;
    missingKey?: boolean;
  } = {},
) {
  const policy = {
    ...createDefaultRuntimePolicy(),
    jev: { enabled: options.enabled ?? true },
    privacy: { incognitoActive: options.privacy ?? false },
  };
  const requests: Array<{ state: Record<string, unknown> }> = [];
  let closed = 0;
  let candidateReads = 0;
  const model = createJevRoutingModel({
    stores: {
      runtimePolicy: { getSnapshot: async () => ({ revision: 1, policy }) },
      operations: {
        resolveHostOutboundExecution: async () =>
          options.proxyFailure
            ? { kind: 'credential_not_configured' }
            : { kind: 'ready', networkProxy: policy.networkProxy, secretMaterial: {} },
        exportCredentialMaterial: async () => (options.missingKey ? null : { secret: 'test-key' }),
      },
    } as never,
    createTransport: () => ({
      close: async () => {
        closed++;
      },
      fetch: async (url, init) => {
        assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        assert.equal(body.model, 'jev-1.13.0');
        assert.ok(init?.signal);
        assert.equal(body.reasoning_effort, undefined);
        if (options.fail) return new Response('provider secret', { status: 503 });
        const keys = Object.keys(body.questions.decision.criteria);
        const choice = options.invalid
          ? 'invented'
          : requests.length === 1
            ? (options.intent ?? 'continue')
            : 'whc_known';
        const probabilities = Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0]));
        return new Response(
          JSON.stringify({
            answers: {
              decision: {
                type: 'choice',
                choice,
                confidence: options.confidence ?? 0.95,
                probabilities,
              },
            },
          }),
        );
      },
    }),
  });
  const run = (signal = new AbortController().signal) =>
    model.decide({
      header: { id: 'private-session-id' } as SessionHeader,
      turnId: 'turn',
      userText: '继续支付工作',
      transcript: [{ role: 'user', text: '支付重试' }],
      abortSignal: signal,
      resolveCandidates: async () => {
        candidateReads++;
        return {
          candidateSetId: 'fresh-set',
          candidates: [
            {
              candidateRef: 'whc_known',
              sessionName: 'Payments',
              workspaceName: 'Maka',
              state: 'idle',
              recency: 'today',
            },
          ],
        };
      },
    });
  return { run, policy, requests, closed: () => closed, candidateReads: () => candidateReads };
}

test('Jev splits bounded intent and recall, preserves candidateSetId and closes transport', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), {
    kind: 'routing',
    disposition: 'delegate_existing',
    candidateSetId: 'fresh-set',
    candidateRef: 'whc_known',
  });
  assert.equal(f.requests.length, 2);
  assert.equal(f.candidateReads(), 1);
  assert.equal(f.closed(), 1);
  assert.equal('candidates' in f.requests[0]!.state, false);
  assert.equal(JSON.stringify(f.requests).includes('private-session-id'), false);
  f.policy.jev.enabled = false;
  assert.equal(await f.run(), undefined);
  assert.equal(f.requests.length, 2);
});

test('disabled, privacy, missing key, proxy failure and cancellation make no provider call', async () => {
  for (const options of [
    { enabled: false },
    { privacy: true },
    { missingKey: true },
    { proxyFailure: true },
  ]) {
    const f = fixture(options);
    assert.equal(await f.run(), undefined);
    assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  assert.equal(await f.run(AbortSignal.abort()), undefined);
  assert.equal(f.requests.length, 0);
});

test('valid uncertainty clarifies rather than falling back or starting work', async () => {
  const f = fixture({ confidence: 0.4 });
  assert.deepEqual(await f.run(), { kind: 'routing', disposition: 'clarify' });
  assert.equal(f.candidateReads(), 0);
  assert.equal(f.closed(), 1);
});

test('service errors and invented outputs return control to the existing route', async () => {
  for (const options of [{ fail: true }, { invalid: true }]) {
    const f = fixture(options);
    assert.equal(await f.run(), undefined);
    assert.equal(f.candidateReads(), 0);
    assert.equal(f.closed(), 1);
  }
});

test('discussion and linked operations do not invoke recall', async () => {
  for (const intent of ['discuss', 'stop', 'resume', 'correct', 'create']) {
    const f = fixture({ intent });
    const expected =
      intent === 'discuss'
        ? { kind: 'routing', disposition: 'answer_here' }
        : intent === 'create'
          ? { kind: 'routing', disposition: 'create_new' }
          : { kind: 'linked', operation: intent };
    assert.deepEqual(await f.run(), expected);
    assert.equal(f.candidateReads(), 0);
  }
});
