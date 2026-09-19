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
import {
  runTraeContract,
  runTraeSdkQueueContract,
  traeCatalogFixture,
  traeConnection,
  traeResponse,
} from './trae-provider-fixture.js';
import { parseTraeCatalog } from '../trae/catalog.js';
import { getAIModel } from '../model-factory.js';
import {
  startTraeDeviceAuthorization,
  pollTraeDeviceAuthorization,
  refreshTraeTokens,
} from '../trae/authorization.js';
import { thinkingVariantsForConnection } from '@maka/core/model-thinking';
import { reconcileConnectionAfterModelFetch } from '@maka/core/llm-connections';
import { normalizeConnectionModelDiscoveryResult } from '@maka/core/runtime-policy';

test('Trae native catalog and two-step tool contract', runTraeContract);
test('Trae queue crosses the real SDK and ModelAdapter boundary', runTraeSdkQueueContract);
test('Trae filters disabled and hidden models and persists real routes and reasoning controls', () => {
  const row = traeCatalogFixture.config_info_list[0]!;
  const models = parseTraeCatalog({
    config_info_list: [
      row,
      { ...row, config_name: 'hidden', is_invisible_to_user: true },
      { ...row, config_name: 'disabled', config_switch: false },
      { ...row, config_name: 'no-max', display_config: { ...row.display_config, max_mode: false } },
    ],
  });
  assert.equal(models.length, 3);
  assert.equal(models[2]?.trae?.mode, 'standard');
  assert.deepEqual(
    normalizeConnectionModelDiscoveryResult({ models, source: 'fetched', fetchedAt: 1 }).models,
    models,
  );
  assert.deepEqual(thinkingVariantsForConnection(traeConnection(), models[0]!.id), [
    'low',
    'medium',
    'high',
    'ultra',
  ]);
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { providerType: 'trae', enabledModelIds: [], hasModelInventory: false },
      models,
    ).enabledModelIds,
    models.map((model) => model.id),
  );
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { providerType: 'trae', enabledModelIds: [models[1]!.id], hasModelInventory: true },
      models,
    ).enabledModelIds,
    [models[1]!.id],
  );
});

test('Trae rejects premature EOF, empty output, malformed tool arguments and truncated SSE frames', async () => {
  const connection = traeConnection();
  for (const response of [
    traeResponse([['output', { response: 'unfinished' }]]),
    traeResponse([['done', {}]]),
    traeResponse([
      ['output', { tool_calls: [{ index: 0, function_call: { name: 'read', arguments: '{' } }] }],
      ['done', { finish_reason: 'tool_calls' }],
    ]),
    new Response('event: done\ndata: {}'),
  ]) {
    const model = getAIModel({
      connection,
      modelId: connection.defaultModel,
      apiKey: 'token',
      fetch: async () => response,
    });
    await assert.rejects(async () =>
      model.doGenerate({
        prompt: [],
        tools: [{ type: 'function', name: 'read', inputSchema: {} }],
      }),
    );
  }
});

test('Trae device enrollment and token rotation preserve device identity without exposing credentials', async () => {
  let now = 1800000000000;
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const replies = [
    {
      code: 0,
      data: {
        service_account_create_url: 'https://cloud.bytedance.net/device',
        ticket: 'ticket',
        expire_at: now + 900_000,
      },
    },
    { message: 'authorization_pending' },
    {
      code: 0,
      data: {
        token_info: {
          access_token: 'access',
          refresh_token: 'refresh',
          expire_at: now + 3_600_000,
        },
      },
    },
    {
      code: 0,
      data: {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expire_at: now + 7_200_000,
      },
    },
  ];
  const fetchFn: typeof fetch = async (url, init) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    const next = replies.shift();
    return Response.json(next, { status: next?.message ? 400 : 200 });
  };
  const signal = new AbortController().signal;
  const authorization = await startTraeDeviceAuthorization({ fetchFn, signal, now: () => now });
  assert.equal(authorization.expiresAt, now + 900_000);
  let admitted = 0;
  let pending = 0;
  const tokens = await pollTraeDeviceAuthorization({
    authorization,
    fetchFn,
    signal,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    onPollAdmission: () => {
      admitted++;
    },
    onPollRetry: () => {
      pending++;
    },
  });
  assert.equal(admitted, 2);
  assert.equal(pending, 1);
  assert.equal(tokens.expires_at, 1800000000000 + 3_600_000);
  const refreshed = await refreshTraeTokens({ tokens, fetchFn, now: () => now });
  assert.equal(refreshed.access_token, 'new-access');
  assert.equal(refreshed.expires_at, 1800000000000 + 7_200_000);
  assert.equal(refreshed.device_code, authorization.deviceCode);
  assert.deepEqual(requests[3]?.body, { refresh_token: 'refresh' });
  assert.ok(
    requests.every(
      (request) =>
        request.headers.get('x-real-psm') === `bytecloud.auth.${authorization.deviceCode}`,
    ),
  );
  assert.equal(requests[0]?.body.device_code, authorization.deviceCode);
});

test('Trae normalizes expiry units and rejects expired or malformed authorization windows', async () => {
  const now = 1800000000000;
  const start = (expiry: unknown) =>
    startTraeDeviceAuthorization({
      signal: new AbortController().signal,
      now: () => now,
      fetchFn: async () =>
        Response.json({
          code: 0,
          data: {
            service_account_create_url:
              'https://cloud.bytedance.net/open/ai/service_account/create_and_bind',
            ticket: 'fixture-ticket',
            code: 'fixture-code',
            expire_at: expiry,
          },
        }),
    });
  for (const expiry of [now + 900_000, now / 1000 + 900]) {
    assert.equal((await start(expiry)).expiresAt, now + 900_000);
  }
  for (const expiry of [now - 1000, now / 1000 - 1, now + 86_400_001, 0, null, 'invalid']) {
    await assert.rejects(start(expiry), { category: 'invalid_response' });
  }
  assert.equal((await start(undefined)).expiresAt, now + 300_000);

  for (const expiryFields of [
    { expire_at: now + 3_600_000 },
    { expire_at: now / 1000 + 3600 },
    { expires_in: 3600 },
  ]) {
    const refreshed = await refreshTraeTokens({
      tokens: {
        access_token: 'old',
        refresh_token: 'refresh',
        device_code: 'device',
        expires_at: now,
      },
      now: () => now,
      fetchFn: async () =>
        Response.json({
          code: 0,
          data: { access_token: 'new', refresh_token: 'rotated', ...expiryFields },
        }),
    });
    assert.equal(refreshed.expires_at, now + 3_600_000);
  }
});

test('Trae rejects untrusted authorization URLs and cancel stops pending polling', async () => {
  await assert.rejects(
    startTraeDeviceAuthorization({
      signal: new AbortController().signal,
      fetchFn: async () =>
        Response.json({
          code: 0,
          data: { service_account_create_url: 'https://example.com/device', ticket: 't' },
        }),
    }),
  );
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(
    pollTraeDeviceAuthorization({
      authorization: {
        deviceCode: 'd',
        ticket: 't',
        verificationUrl: '',
        userCode: '',
        expiresAt: Date.now() + 60000,
      },
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
      fetchFn: async () => {
        requests++;
        return Response.json({});
      },
    }),
  );
  assert.equal(requests, 0);
});

test('cancelling an idle queued Trae stream cancels its upstream body', async () => {
  const connection = traeConnection();
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('event: queue_begin\ndata: {"position":2}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const model = getAIModel({
    connection,
    modelId: connection.defaultModel,
    apiKey: 'token',
    fetch: async () => new Response(body),
  });
  const response = await model.doStream({ prompt: [], abortSignal: controller.signal });
  const reader = response.stream.getReader();
  assert.equal((await reader.read()).value?.type, 'stream-start');
  assert.equal((await reader.read()).value?.type, 'raw');
  const pending = reader.read();
  controller.abort();
  await assert.rejects(pending);
  assert.equal(cancelled, true);
});

test('Trae load uses upstream percentages, preserves unknown and survives the catalog codec', () => {
  const row = traeCatalogFixture.config_info_list[0]!;
  for (const [hot, expected] of [
    [0, 0],
    [73.6, 74],
    [101, 101],
    [173.6, 174],
    [250, 250],
    [Infinity, undefined],
    [-1, 0],
    [NaN, undefined],
    ['25', undefined],
    [undefined, undefined],
  ] as const) {
    const models = parseTraeCatalog({
      config_info_list: [{ ...row, display_config: { ...row.display_config, hot_info: { hot } } }],
    });
    const roundTrip = normalizeConnectionModelDiscoveryResult({
      models,
      source: 'fetched',
      fetchedAt: 1234,
    });
    assert.equal(roundTrip.models[0]?.trae?.loadPercent, expected);
    assert.equal(roundTrip.models[1]?.trae?.loadPercent, expected);
  }
});
