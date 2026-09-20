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
import { fetchConnectionUsage } from '../connection-usage.js';

/** An effect fetch answering the given `path -> json` routes, 404 elsewhere. */
function routes(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(new URL(url).pathname);
    const body = answers[new URL(url).pathname];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchFn, calls };
}

/** An effect fetch answering a fixed status for every path (to model a 401/403). */
function statusFetch(status: number) {
  return (async () =>
    new Response(JSON.stringify({ error: 'no' }), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

const GO_OK = {
  '/alpha/whoami': { success: true, user: { id: 'u', userName: 'joob1nhk13d9' } },
  '/alpha/usage/summary': {
    totalCount: 3552,
    failedCount: 5,
    successRate: 99.85923423423422,
    totalCost: 5.852315282,
    totalTokensIn: 428_987_308,
    totalTokensOut: 2_971_687,
  },
  '/alpha/billing/credits': {
    credits: { monthlyCredits: 4.42673573, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: {
      limited: true,
      fiveHour: { used: 0.256638598, cap: 3, exceeded: false, resetAt: 1_789_746_210_944 },
      weekly: { used: 0.387957292, cap: 6, exceeded: false, resetAt: 1_790_314_995_070 },
    },
  },
  '/alpha/billing/subscriptions': {
    success: true,
    data: { planId: 'individual-go', currentPeriodEnd: '2026-10-10T10:39:47.000Z' },
  },
};

const CREDENTIAL = {
  providerType: 'commandcode-go' as const,
  apiKey: 'key',
  baseUrl: 'https://api.commandcode.ai',
};

test('maps the GO account endpoints into windows and stats', async () => {
  const { fetchFn } = routes(GO_OK);
  const result = await fetchConnectionUsage({ ...CREDENTIAL, fetch: fetchFn });
  assert.equal(result.kind, 'report');
  if (result.kind !== 'report') return;
  const { report } = result;

  assert.equal(report.accountLabel, 'joob1nhk13d9');
  assert.equal(report.planLabel, 'Go');
  assert.deepEqual(
    report.windows.map((w) => w.id),
    ['fiveHour', 'weekly', 'monthly'],
  );
  assert.deepEqual(report.windows[0], {
    id: 'fiveHour',
    used: 0.256638598,
    cap: 3,
    unit: 'credits',
    resetsAt: 1_789_746_210_944,
  });
  // The monthly window's cap is the plan's allowance; consumed is
  // cap − remaining balance (10 − 4.42673573).
  const monthly = report.windows.find((w) => w.id === 'monthly');
  assert.ok(monthly);
  assert.equal(monthly.cap, 10);
  assert.ok(Math.abs(monthly.used - 5.57326427) < 1e-6);
  assert.equal(monthly.resetsAt, Date.parse('2026-10-10T10:39:47.000Z'));

  assert.deepEqual(report.stats, {
    requests: 3552,
    failed: 5,
    successRate: 99.85923423423422,
    cost: 5.852315282,
    tokensIn: 428_987_308,
    tokensOut: 2_971_687,
  });
});

test('omits a window the account never reported rather than zeroing it', async () => {
  const { fetchFn } = routes({
    ...GO_OK,
    '/alpha/billing/credits': {
      credits: { monthlyCredits: 4.42673573 },
      windowLimits: { limited: true, weekly: { used: 1, cap: 6, resetAt: 1_790_314_995_070 } },
    },
  });
  const result = await fetchConnectionUsage({ ...CREDENTIAL, fetch: fetchFn });
  assert.equal(result.kind, 'report');
  if (result.kind !== 'report') return;
  assert.deepEqual(
    result.report.windows.map((w) => w.id),
    ['weekly', 'monthly'],
  );
});

test('omits the monthly window when the plan is unknown (no limit to divide by)', async () => {
  const { fetchFn } = routes({
    ...GO_OK,
    '/alpha/billing/subscriptions': { success: true, data: { planId: 'mystery-plan' } },
  });
  const result = await fetchConnectionUsage({ ...CREDENTIAL, fetch: fetchFn });
  assert.equal(result.kind, 'report');
  if (result.kind !== 'report') return;
  assert.deepEqual(
    result.report.windows.map((w) => w.id),
    ['fiveHour', 'weekly'],
  );
  assert.equal(result.report.planLabel, undefined);
});

test('degrades per endpoint: one failing endpoint does not sink the report', async () => {
  const { fetchFn } = routes({
    '/alpha/whoami': GO_OK['/alpha/whoami'],
    '/alpha/billing/credits': GO_OK['/alpha/billing/credits'],
    // summary and subscriptions 404
  });
  const result = await fetchConnectionUsage({ ...CREDENTIAL, fetch: fetchFn });
  assert.equal(result.kind, 'report');
  if (result.kind !== 'report') return;
  assert.equal(result.report.stats, undefined);
  assert.equal(result.report.planLabel, undefined);
  assert.deepEqual(
    result.report.windows.map((w) => w.id),
    ['fiveHour', 'weekly'],
  );
});

test('is unavailable when every endpoint fails', async () => {
  const { fetchFn } = routes({});
  assert.deepEqual(await fetchConnectionUsage({ ...CREDENTIAL, fetch: fetchFn }), {
    kind: 'unavailable',
    reason: 'network',
  });
});

test('is unavailable without a credential, and never fetches', async () => {
  const { fetchFn, calls } = routes(GO_OK);
  assert.deepEqual(
    await fetchConnectionUsage({ ...CREDENTIAL, apiKey: undefined, fetch: fetchFn }),
    { kind: 'unavailable', reason: 'no-credential' },
  );
  assert.equal(calls.length, 0);
});

test('is unsupported for a provider with no usage endpoints wired', async () => {
  const { fetchFn } = routes(GO_OK);
  assert.deepEqual(
    await fetchConnectionUsage({
      providerType: 'commandcode',
      apiKey: 'key',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      fetch: fetchFn,
    }),
    { kind: 'unavailable', reason: 'unsupported' },
  );
});

test('reports a wholly-refused key as unauthorized, not as a network failure', async () => {
  // Every endpoint answers 401. The user's fix is the credential on this very
  // page, so the reason has to say so rather than blaming the connection.
  const result = await fetchConnectionUsage({ ...CREDENTIAL, fetch: statusFetch(401) });
  assert.deepEqual(result, { kind: 'unavailable', reason: 'unauthorized' });
});

test('still reports a plain transport failure as network', async () => {
  const failing = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof globalThis.fetch;
  assert.deepEqual(await fetchConnectionUsage({ ...CREDENTIAL, fetch: failing }), {
    kind: 'unavailable',
    reason: 'network',
  });
});

test('a partially-scoped key returns what it can and flags the refusal', async () => {
  // whoami answers; the billing endpoints 403. The read is real but incomplete,
  // so it is reported with the refusal flagged rather than presented as whole.
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const body = GO_OK[path as keyof typeof GO_OK];
    if (path === '/alpha/whoami') {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('forbidden', { status: 403 });
  }) as unknown as typeof globalThis.fetch;

  const result = await fetchConnectionUsage({ ...CREDENTIAL, fetch: fetchFn });
  assert.equal(result.kind, 'report');
  if (result.kind !== 'report') return;
  assert.equal(result.report.accountLabel, 'joob1nhk13d9', 'the part that was readable is kept');
  assert.equal(result.report.partiallyUnauthorized, true, 'the refusal must be flagged');
});

test('a fully-readable report does not carry the partial-refusal flag', async () => {
  const { fetchFn } = routes(GO_OK);
  const result = await fetchConnectionUsage({ ...CREDENTIAL, fetch: fetchFn });
  assert.equal(result.kind, 'report');
  if (result.kind !== 'report') return;
  assert.equal(result.report.partiallyUnauthorized, undefined);
});
