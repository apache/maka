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
import { createHash } from 'node:crypto';
import { TRAE_ACCOUNTS } from '@maka/core/llm-connections';
import {
  TraeTokenEndpointError,
  loginTraePublicAccount,
  refreshTraePublicTokens,
} from '../trae/public-authorization.js';
import {
  createTraePublicFetch,
  traePublicDeviceIdentity,
  traePublicProfile,
  type TraePublicAccount,
} from '../trae/public-protocol.js';
import {
  parseOAuthSubscriptionTokens,
  serializeOAuthSubscriptionTokens,
} from '../subscription-credentials.js';
import { createTraeModel } from '../trae/model.js';
import { traeToolSchema } from '../trae/messages.js';
import {
  fetchTraeModels,
  traeCatalogFixture,
  traeConnection,
  traeResponse,
} from './trae-provider-fixture.js';

const accounts = TRAE_ACCOUNTS.filter((x): x is TraePublicAccount => x !== 'employee');
const now = 1800000000000;
const tokenResponse = () =>
  Response.json({
    Result: { Token: 'access', RefreshToken: 'refresh', TokenExpireAt: (now + 3600000) / 1000 },
  });

for (const account of accounts) {
  test(`Trae ${account}: loopback PKCE, callback binding, refresh and credential roundtrip`, async () => {
    const profile = traePublicProfile(account);
    let challenge = '';
    let callbackUrl = '';
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const tokens = await loginTraePublicAccount({
      account,
      now: () => now,
      fetchFn: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (String(url).endsWith('/GetLoginGuidance'))
          return Response.json({ Result: { LoginHost: profile.loginOrigin } });
        requests.push({ url: String(url), body });
        assert.equal(createHash('sha256').update(body.CodeVerifier).digest('base64url'), challenge);
        assert.equal(body.ClientID, profile.clientId);
        assert.equal(body.AuthCode, 'one-time-code');
        assert.equal(body.DeviceInfo.PlatformCode, profile.solo ? 'SOLO_PC' : 'IDE_PC');
        return tokenResponse();
      },
      present: async (raw) => {
        const url = new URL(raw);
        assert.equal(url.origin, profile.loginOrigin);
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(url.searchParams.get('auth_from'), profile.solo ? 'solo' : 'trae');
        assert.equal(url.searchParams.get('CodeVerifier'), null);
        challenge = url.searchParams.get('code_challenge')!;
        callbackUrl = url.searchParams.get('auth_callback_url')!;
        // The authorization page validates the callback against
        // `^http://127.0.0.1:(\d+)/authorize$` before it makes any request.
        assert.equal(new URL(callbackUrl).pathname, '/authorize');
        assert.equal((await fetch(new URL('/authorize/extra', callbackUrl))).status, 404);
        // Without a random path, the login trace id is the binding: it is required.
        assert.equal((await fetch(callbackUrl)).status, 400);
        const callback = new URL(callbackUrl);
        callback.searchParams.set('loginTraceID', 'wrong-trace');
        assert.equal((await fetch(callback)).status, 400);
        callback.searchParams.set('loginTraceID', url.searchParams.get('login_trace_id')!);
        callback.searchParams.set('userRegion', profile.region);
        callback.searchParams.set('authCodeInfo', JSON.stringify({ AuthCode: 'one-time-code' }));
        // Callback-supplied hosts are not used for credential exchange.
        callback.searchParams.set('host', 'https://untrusted.example');
        assert.equal((await fetch(callback)).status, 200);
      },
    });
    assert.equal(requests[0]?.url, `${profile.authOrigin}/trae/api/v3/oauth/ExchangeToken`);
    assert.equal(tokens.trae?.account, account);
    assert.equal(tokens.trae?.authOrigin, profile.authOrigin);
    assert.deepEqual(
      parseOAuthSubscriptionTokens(serializeOAuthSubscriptionTokens(tokens)),
      tokens,
    );
    await assert.rejects(fetch(callbackUrl));
    const refreshed = await refreshTraePublicTokens({
      tokens,
      now: () => now,
      fetchFn: async (url, init) => {
        assert.equal(String(url), `${profile.authOrigin}/cloudide/api/v3/trae/oauth/ExchangeToken`);
        assert.equal(JSON.parse(String(init?.body)).ClientID, profile.clientId);
        assert.equal(JSON.parse(String(init?.body)).RefreshToken, 'refresh');
        return Response.json({
          Result: { Token: 'new-access', RefreshToken: 'new-refresh', TokenExpireDuration: 7200 },
        });
      },
    });
    assert.deepEqual(refreshed.trae, tokens.trae);
    assert.equal(refreshed.refresh_token, 'new-refresh');
    assert.equal(refreshed.expires_at, now + 7200000);
  });

  test(`Trae ${account}: function-bound directory, native tools, reasoning, queue and usage`, async () => {
    const profile = traePublicProfile(account);
    const identity = { account, machineId: '1'.repeat(32), deviceId: '2'.repeat(32) };
    const seenFunctions: string[] = [];
    const base = { ...traeConnection(), traeAccount: account };
    const models = await fetchTraeModels(base, 'access', {
      fetch: createTraePublicFetch(
        async (url, init) => {
          assert.equal(new URL(String(url)).origin, profile.baseUrl);
          assert.equal(new Headers(init?.headers).get('authorization'), 'Cloud-IDE-JWT access');
          assert.equal(new Headers(init?.headers).get('x-jwt-token'), null);
          const fn = JSON.parse(String(init?.body)).function;
          seenFunctions.push(fn);
          const source = structuredClone(traeCatalogFixture.config_info_list[0]!);
          return Response.json({
            config_info_list: [source, { ...source, config_name: `unique-${fn}` }],
          });
        },
        'access',
        identity,
      ),
    });
    assert.deepEqual(seenFunctions, profile.functions);
    assert.equal(models.length, 1 + profile.functions.length);
    assert.ok(models.every((m) => m.trae?.mode === 'standard'));
    assert.ok(!models[0]!.trae!.reasoningEfforts.includes('ultra'));
    const selected = models.at(-1)!;
    const bodies: Record<string, any>[] = [];
    const model = createTraeModel({
      connection: { ...base, models },
      modelId: selected.id,
      apiKey: 'access',
      fetch: createTraePublicFetch(
        async (url, init) => {
          assert.equal(String(url), `${profile.baseUrl}/api/agent/v3/llm_utils_chat`);
          assert.equal(init?.redirect, 'error');
          const body = JSON.parse(String(init?.body));
          bodies.push(body);
          assert.equal(body.function, selected.trae!.function);
          assert.equal(body.config_name, selected.trae!.configName);
          assert.equal(body.model_name, undefined);
          assert.equal(body.access_type, undefined);
          return bodies.length === 1
            ? traeResponse(
                [
                  ['request_wait_in_queue', { position: 2 }],
                  ['output', { reasoning_content: 'native reasoning' }],
                  [
                    'output',
                    {
                      tool_calls: [
                        {
                          id: 'tool-id',
                          function_call: { name: 'read_file', arguments: '{"path":' },
                        },
                      ],
                    },
                  ],
                  [
                    'output',
                    {
                      tool_calls: [{ id: 'tool-id', function_call: { arguments: '"README.md"}' } }],
                    },
                  ],
                  ['token_usage', { prompt_tokens: 100, completion_tokens: 20 }],
                  ['done', { finish_reason: 'tool_calls' }],
                ],
                true,
              )
            : traeResponse([
                ['output', { response: 'done' }],
                ['done', { finish_reason: 'stop' }],
              ]);
        },
        'access',
        identity,
      ),
    });
    const first = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Read README' }] }],
      tools: [
        {
          type: 'function',
          name: 'read_file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      providerOptions: { trae: { reasoningEffort: 'high' } },
    });
    assert.equal(first.finishReason.unified, 'tool-calls');
    assert.equal(first.usage.inputTokens.total, 100);
    assert.equal(bodies[0]!.reasoning_effort, 'high');
    assert.equal(typeof bodies[0]!.tools[0].function.parameters, 'string');
    const call = first.content.find((x) => x.type === 'tool-call');
    assert.ok(call && call.type === 'tool-call');
    const second = await model.doGenerate({
      prompt: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'native reasoning' },
            {
              type: 'tool-call',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: JSON.parse(call.input),
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: { type: 'text', value: 'README contents' },
            },
          ],
        },
      ],
    });
    assert.deepEqual(second.content, [{ type: 'text', text: 'done' }]);
    assert.equal(bodies[1]!.messages[0].reasoning_content, 'native reasoning');
    assert.equal(bodies[1]!.messages[1].tool_call_id, call.toolCallId);
    await assert.rejects(
      createTraePublicFetch(
        async () => {
          throw new Error('must not send');
        },
        'access',
        identity,
      )('https://untrusted.example'),
      /region/,
    );
  });
}

test('Trae issuer fallback is remembered for refresh and US accounts are refused', async () => {
  const exchangeTokens = () =>
    Response.json({
      Result: { Token: 'access', RefreshToken: 'refresh', TokenExpireDuration: 3600 },
    });
  const login = (userRegion: string, fetchFn: typeof fetch) =>
    loginTraePublicAccount({
      account: 'sg',
      now: () => now,
      fetchFn,
      present: async (raw) => {
        const url = new URL(raw);
        const callback = new URL(url.searchParams.get('auth_callback_url')!);
        callback.searchParams.set('loginTraceID', url.searchParams.get('login_trace_id')!);
        callback.searchParams.set('userRegion', userRegion);
        callback.searchParams.set('authCodeInfo', JSON.stringify({ AuthCode: 'one-time-code' }));
        assert.equal((await fetch(callback)).status, 200);
      },
    });

  // International accounts try the global issuers in order and record the one that signed.
  const origins: string[] = [];
  const fallback = await login('sg', async (url) => {
    if (String(url).endsWith('/GetLoginGuidance')) return Response.json({});
    const origin = new URL(String(url)).origin;
    origins.push(origin);
    // An issuer that does not know the code answers 400; the next one is asked.
    if (origin === 'https://growsg-normal.trae.ai')
      return Response.json(
        {
          ResponseMetadata: {
            Error: { Code: '10101', Message: 'Invalid param: {__Message.field}.' },
          },
        },
        { status: 400 },
      );
    return exchangeTokens();
  });
  assert.deepEqual(origins, ['https://growsg-normal.trae.ai', 'https://grow-normal.trae.ai']);
  assert.equal(fallback.trae?.authOrigin, 'https://grow-normal.trae.ai');

  // Refresh returns to the issuer that signed the login, and survives the credential roundtrip.
  const stored = parseOAuthSubscriptionTokens(serializeOAuthSubscriptionTokens(fallback));
  assert.equal(stored?.trae?.authOrigin, 'https://grow-normal.trae.ai');
  const refreshed = await refreshTraePublicTokens({
    tokens: stored!,
    now: () => now,
    fetchFn: async (url) => {
      assert.equal(new URL(String(url)).origin, 'https://grow-normal.trae.ai');
      return exchangeTokens();
    },
  });
  assert.equal(refreshed.trae?.authOrigin, 'https://grow-normal.trae.ai');
  // Only known issuers are accepted back from storage.
  assert.equal(
    parseOAuthSubscriptionTokens(
      JSON.stringify({
        ...fallback,
        trae: { ...fallback.trae, authOrigin: 'https://evil.example' },
      }),
    ),
    null,
  );

  // A US account is refused before any exchange: its gateway has no native chat API.
  await assert.rejects(
    login('us', async () => {
      assert.fail('must not exchange a US account');
    }),
    /US, which Maka does not support/,
  );
  // The callback tag alone marks a TTP account as US.
  await assert.rejects(
    loginTraePublicAccount({
      account: 'sg',
      now: () => now,
      fetchFn: async () => assert.fail('must not exchange a TTP account'),
      present: async (raw) => {
        const url = new URL(raw);
        const callback = new URL(url.searchParams.get('auth_callback_url')!);
        callback.searchParams.set('loginTraceID', url.searchParams.get('login_trace_id')!);
        callback.searchParams.set('userTag', 'usttp');
        callback.searchParams.set('authCodeInfo', JSON.stringify({ AuthCode: 'one-time-code' }));
        await fetch(callback);
      },
    }),
    /US, which Maka does not support/,
  );
});

test('Trae reports the primary issuer verdict and stops at an account refusal', async () => {
  const login = (fetchFn: typeof fetch) =>
    loginTraePublicAccount({
      account: 'sg',
      now: () => now,
      fetchFn,
      present: async (raw) => {
        const url = new URL(raw);
        const callback = new URL(url.searchParams.get('auth_callback_url')!);
        callback.searchParams.set('loginTraceID', url.searchParams.get('login_trace_id')!);
        callback.searchParams.set('userRegion', 'sg');
        callback.searchParams.set('authCodeInfo', JSON.stringify({ AuthCode: 'one-time-code' }));
        assert.equal((await fetch(callback)).status, 200);
      },
    });
  const exchanges = (verdicts: Record<string, Response>) => {
    const origins: string[] = [];
    const fetchFn: typeof fetch = async (url) => {
      if (String(url).endsWith('/GetLoginGuidance')) return Response.json({});
      const origin = new URL(String(url)).origin;
      origins.push(origin);
      return verdicts[origin]!.clone();
    };
    return { origins, fetchFn };
  };
  const refusal = (status: number, code: string, message: string) =>
    Response.json({ ResponseMetadata: { Error: { Code: code, Message: message } } }, { status });

  // 403 is a verdict on the account: the code is spent, so the second issuer is
  // never asked and the verdict names what to act on.
  const limited = exchanges({
    'https://growsg-normal.trae.ai': refusal(403, '20401', 'Device limit reached.'),
    'https://grow-normal.trae.ai': refusal(400, '10101', 'Invalid param: {__Message.field}.'),
  });
  await assert.rejects(login(limited.fetchFn), (error: unknown) => {
    assert.ok(error instanceof TraeTokenEndpointError);
    assert.equal(error.category, 'invalid_token');
    assert.equal(error.status, 403);
    assert.equal(error.providerCode, '20401');
    assert.match(error.message, /\(403\): invalid_token\. Trae 20401: Device limit reached\.$/);
    return true;
  });
  assert.deepEqual(limited.origins, ['https://growsg-normal.trae.ai']);

  // When every issuer refuses, the first verdict is the one reported, with its
  // message collapsed onto one line.
  const unknown = exchanges({
    'https://growsg-normal.trae.ai': refusal(400, '10101', 'first\nissuer'),
    'https://grow-normal.trae.ai': refusal(400, '10101', 'second issuer'),
  });
  await assert.rejects(login(unknown.fetchFn), (error: unknown) => {
    assert.ok(error instanceof TraeTokenEndpointError);
    assert.equal(error.category, 'provider_rejected');
    assert.match(error.message, /Trae 10101: first issuer$/);
    return true;
  });
  assert.deepEqual(unknown.origins, [
    'https://growsg-normal.trae.ai',
    'https://grow-normal.trae.ai',
  ]);
});

test('Trae logins present the derived device identity of the install', async () => {
  const device = traePublicDeviceIdentity('root-a');
  assert.deepEqual(device, traePublicDeviceIdentity('root-a'));
  assert.notDeepEqual(device, traePublicDeviceIdentity('root-b'));
  assert.match(device.machineId, /^[a-f0-9]{64}$/);
  assert.match(device.deviceId, /^[a-f0-9]{32}$/);
  assert.throws(() => traePublicDeviceIdentity(''), /must not be empty/);

  let exchange: Record<string, unknown> | undefined;
  const tokens = await loginTraePublicAccount({
    account: 'cn',
    device,
    now: () => now,
    fetchFn: async (url, init) => {
      if (String(url).endsWith('/GetLoginGuidance')) return Response.json({});
      exchange = JSON.parse(String(init?.body));
      return tokenResponse();
    },
    present: async (raw) => {
      const url = new URL(raw);
      assert.equal(url.searchParams.get('machine_id'), device.machineId);
      assert.equal(url.searchParams.get('device_id'), device.deviceId);
      const callback = new URL(url.searchParams.get('auth_callback_url')!);
      callback.searchParams.set('loginTraceID', url.searchParams.get('login_trace_id')!);
      callback.searchParams.set('userRegion', 'cn');
      callback.searchParams.set('authCodeInfo', JSON.stringify({ AuthCode: 'one-time-code' }));
      assert.equal((await fetch(callback)).status, 200);
    },
  });
  const info = exchange?.DeviceInfo as Record<string, unknown>;
  assert.equal(info.MachineID, device.machineId);
  assert.equal(info.DeviceID, device.deviceId);
  assert.deepEqual({ machineId: tokens.trae?.machineId, deviceId: tokens.trae?.deviceId }, device);
  assert.deepEqual(
    parseOAuthSubscriptionTokens(serializeOAuthSubscriptionTokens(tokens))?.trae,
    tokens.trae,
  );
});

test('Trae tool schemas are projected onto the subset Gemini-backed routes accept', () => {
  // Mirrors what zod-to-json-schema and MCP servers emit for Maka's own tools;
  // Gemini answered `Unknown name "exclusiveMinimum"` and `Proto field is not
  // repeating` (type arrays) to the raw form, which Trae surfaced as 4027.
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      command: { type: 'string', minLength: 1 },
      cwd: { type: ['string', 'null'], format: 'uri' },
      mode: { const: 'fast' },
      timeout_ms: { type: 'integer', exclusiveMinimum: 0, maximum: 600_000 },
      target: { $ref: '#/$defs/target' },
      shape: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      when: { type: 'string', format: 'date-time' },
      all: { allOf: [{ type: 'string' }], description: 'merged' },
      list: { items: [{ type: 'string' }] },
      flags: {
        type: 'object',
        properties: {
          force: { const: true },
          level: { enum: [1, 2, null], description: 'verbosity' },
          kind: { enum: ['a', null] },
        },
      },
    },
    required: ['command', 'missing'],
    $defs: {
      target: {
        type: 'object',
        properties: { host: { type: 'string' } },
        patternProperties: { '^x-': { type: 'string' } },
      },
    },
  };
  assert.deepEqual(traeToolSchema(schema), {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1 },
      cwd: { type: 'string', nullable: true },
      mode: { type: 'string', enum: ['fast'] },
      timeout_ms: { type: 'integer', minimum: 1, maximum: 600_000 },
      target: { type: 'object', properties: { host: { type: 'string' } } },
      shape: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      when: { type: 'string', format: 'date-time' },
      all: { type: 'string', description: 'merged' },
      list: { type: 'array', items: { type: 'string' } },
      flags: {
        type: 'object',
        properties: {
          force: { type: 'boolean', description: 'Allowed values: true.' },
          level: {
            type: 'integer',
            description: 'verbosity Allowed values: 1, 2.',
            nullable: true,
          },
          kind: { type: 'string', enum: ['a'], nullable: true },
        },
      },
    },
    required: ['command'],
  });
  assert.equal(JSON.stringify(traeToolSchema(schema)).includes('exclusiveMinimum'), false);
  assert.deepEqual(traeToolSchema({ description: 'anything' }), {
    description: 'anything',
    type: 'string',
  });
  assert.deepEqual(traeToolSchema({ enum: [1, 2] }), {
    type: 'integer',
    description: 'Allowed values: 1, 2.',
  });
});

test('Trae browser cancellation closes the callback listener without exchanging credentials', async () => {
  const abort = new AbortController();
  let callbackUrl = '';
  await assert.rejects(
    loginTraePublicAccount({
      account: 'cn',
      signal: abort.signal,
      fetchFn: async (url) => {
        assert.ok(String(url).endsWith('/GetLoginGuidance'));
        return Response.json({ Result: { LoginHost: 'https://www.trae.cn' } });
      },
      present: async (url) => {
        callbackUrl = new URL(url).searchParams.get('auth_callback_url')!;
        abort.abort();
      },
    }),
    /abort/i,
  );
  await assert.rejects(fetch(callbackUrl));
});

test('Trae rejects untrusted guidance, region mismatch, invalid tokens and redirecting token endpoints', async () => {
  await assert.rejects(
    loginTraePublicAccount({
      account: 'sg',
      present: async () => assert.fail('must not open'),
      fetchFn: async () => Response.json({ Result: { LoginHost: 'https://untrusted.example' } }),
    }),
  );
  await assert.rejects(
    loginTraePublicAccount({
      account: 'sg',
      fetchFn: async (url) => {
        assert.ok(String(url).endsWith('/GetLoginGuidance'));
        return Response.json({ Result: { LoginHost: 'https://www.trae.ai' } });
      },
      present: async (url) => {
        const trace = new URL(url).searchParams.get('login_trace_id')!;
        const cb = new URL(new URL(url).searchParams.get('auth_callback_url')!);
        cb.search = `loginTraceID=${trace}&userRegion=cn&authCode=code`;
        await fetch(cb);
      },
    }),
    /region/,
  );
  const tokens = {
    access_token: 'old',
    refresh_token: 'refresh',
    expires_at: now,
    trae: { account: 'sg' as const, machineId: '1'.repeat(32), deviceId: '2'.repeat(32) },
  };
  await assert.rejects(
    refreshTraePublicTokens({
      tokens,
      fetchFn: async (_url, init) => {
        assert.equal(init?.redirect, 'error');
        return Response.json({ Result: { Token: 'token', TokenExpireAt: 0 } });
      },
    }),
  );
  assert.equal(
    parseOAuthSubscriptionTokens(
      JSON.stringify({ ...tokens, trae: { ...tokens.trae, account: 'unknown' } }),
    ),
    null,
  );
});

test('Trae public streams keep separate tool IDs when chunks omit indexes and finish with DONE', async () => {
  const { parseTraeCatalog } = await import('../trae/catalog.js');
  const models = parseTraeCatalog(traeCatalogFixture, 'chat_v3');
  const model = createTraeModel({
    connection: { ...traeConnection(), traeAccount: 'cn', models },
    modelId: models[0]!.id,
    apiKey: 'access',
    fetch: async () =>
      new Response(
        [
          'event: output\ndata: {"tool_calls":[{"id":"a","function_call":{"name":"read_file","arguments":"{\\\"path\\\":\\\"a\\\"}"}}]}\n\n',
          'event: output\ndata: {"tool_calls":[{"id":"b","function_call":{"name":"read_file","arguments":"{\\\"path\\\":\\\"b\\\"}"}}]}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
      ),
  });
  const result = await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'read both' }] }],
    tools: [{ type: 'function', name: 'read_file', inputSchema: { type: 'object' } }],
  });
  assert.deepEqual(
    result.content
      .filter((p) => p.type === 'tool-call')
      .map((p) => [p.toolCallId, JSON.parse(p.input)]),
    [
      ['a', { path: 'a' }],
      ['b', { path: 'b' }],
    ],
  );
});
