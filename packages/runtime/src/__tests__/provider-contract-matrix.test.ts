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
import type { IncomingMessage } from 'node:http';
import { after, describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import {
  PROVIDER_CONTRACT_MATRIX_PLAN,
  type ProviderContractDiscoveryPlan,
  type ProviderContractRow,
  type ProviderContractGeneratedCell,
  type ProviderContractWire,
} from './provider-contract-matrix.js';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { generateText, isStepCount, tool } from 'ai';
import { z } from 'zod';
import { fetchProviderModels } from '../model-fetcher.js';
import { getAIModel } from '../model-factory.js';
import {
  closeAllJsonServers,
  readBody,
  respondJson,
  startJsonServer,
} from './conformance-harness.js';
import { PROVIDER_CONTRACT_OVERRIDE_BINDINGS } from './provider-contract-overrides.js';

const REASONING_TEXT = 'I should call echo with the requested text.';
const FINAL_TEXT = 'Echoed hello.';
const API_KEY = 'contract-matrix-test-key';

const plan = PROVIDER_CONTRACT_MATRIX_PLAN;

after(closeAllJsonServers);

describe('provider conformance matrix — override cells execute their bound contract', () => {
  for (const binding of PROVIDER_CONTRACT_OVERRIDE_BINDINGS) {
    test(`${binding.keys.join(' + ')} · ${binding.title}`, async () => {
      await binding.run();
    });
  }
});

describe('provider conformance matrix — discovery', () => {
  for (const row of plan.rows) {
    const cell = row.cells.discovery;
    if (cell.state === 'generated' && cell.discovery) {
      test(`${row.providerType} · discovery · generated (${cell.discovery.protocol})`, async () => {
        await runGeneratedDiscovery(
          row,
          cell as ProviderContractGeneratedCell & {
            discovery: NonNullable<ProviderContractGeneratedCell['discovery']>;
          },
        );
      });
    } else if (
      cell.state === 'not-applicable' &&
      cell.reverseAssertion === 'must-not-request-models-endpoint'
    ) {
      test(`${row.providerType} · discovery · N/A (${cell.reason}) does not call /models`, async () => {
        await assertFallbackDiscoveryMakesNoRequest(row);
      });
    }
  }
});

describe('provider conformance matrix — wire (exact-model-id + tool-loop + reasoning-replay)', () => {
  for (const row of plan.rows) {
    const wireDims = (['exact-model-id', 'tool-loop', 'reasoning-replay'] as const).filter(
      (dimension) => row.cells[dimension].state === 'generated',
    );
    if (wireDims.length === 0) continue;
    const wire = wireOfRow(row);
    test(`${row.providerType} · ${wire} · ${wireDims.join(' + ')}`, async () => {
      await runGeneratedWire(row, wireDims);
    });
    for (const edge of row.edgeWireSamples) {
      test(`${row.providerType} · ${edge.wire} · edge sample "${edge.modelId}"`, async () => {
        await runEdgeWireSample(row, edge);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Generated discovery execution
// ---------------------------------------------------------------------------

/**
 * The per-run credential expectation a generated discovery cell expands into.
 * `default` runs once with the provider credential; `none` runs once with no
 * credential on the wire; `optional` (optional_api_key providers such as
 * LocalAI) runs twice — a configured key must reach the wire, and an absent key
 * must leave the request credential-free rather than sending a dummy value.
 */
interface DiscoveryCredentialCase {
  label: 'provider-auth' | 'no-auth' | 'optional-with-key' | 'optional-without-key';
  apiKey: string;
  expectCredential: boolean;
}

function discoveryCredentialCases(
  auth: ProviderContractDiscoveryPlan['auth'],
): DiscoveryCredentialCase[] {
  switch (auth) {
    case 'default':
      return [{ label: 'provider-auth', apiKey: API_KEY, expectCredential: true }];
    case 'none':
      return [{ label: 'no-auth', apiKey: API_KEY, expectCredential: false }];
    case 'optional':
      return [
        { label: 'optional-with-key', apiKey: API_KEY, expectCredential: true },
        { label: 'optional-without-key', apiKey: '', expectCredential: false },
      ];
  }
}

async function runGeneratedDiscovery(
  row: ProviderContractRow,
  cell: ProviderContractGeneratedCell & {
    discovery: NonNullable<ProviderContractGeneratedCell['discovery']>;
  },
): Promise<void> {
  const sample = row.sampleModelId;
  const discovery = cell.discovery;
  // `array-or-data` (mistral) means the same endpoint may answer either
  // `{data:[...]}` or a bare array; both fixtures must parse to the exact id.
  const payloadShapes: ReadonlyArray<'data-object' | 'bare-array'> =
    discovery.responseShape === 'array-or-data' ? ['data-object', 'bare-array'] : ['data-object'];
  for (const shape of payloadShapes) {
    for (const credentialCase of discoveryCredentialCases(discovery.auth)) {
      const where = `${row.providerType} discovery (${shape} payload, ${credentialCase.label})`;
      // Handler assertion failures are recorded and rethrown after the fetch so
      // the test fails with the request-contract message instead of a generic
      // "failed to fetch models" wrapper.
      const handlerErrors: unknown[] = [];
      let requestCount = 0;
      const server = await startJsonServer((request, response) => {
        requestCount += 1;
        try {
          assertDiscoveryRequest(row, discovery, credentialCase, request);
        } catch (error) {
          handlerErrors.push(error);
        }
        respondJson(
          response,
          200,
          discoveryPayload(discovery.protocol, sample, discovery.filter, shape),
        );
      });
      const connection = baseConnection(row, server.url);
      const models = await fetchProviderModels(connection, credentialCase.apiKey);
      if (handlerErrors.length > 0) throw handlerErrors[0];
      assert.ok(requestCount >= 1, `${where} must request the model list`);
      assert.deepEqual(
        models.map((model) => model.id),
        [sample],
        `${where} should return exactly the scripted exact id`,
      );
    }
  }
}

/**
 * Assert the discovery request against the full derived cell — path, query, and
 * auth — mirroring `model-fetcher.ts`'s real URL/header construction:
 *
 *   - openai:    `{baseUrl}{path ?? '/models'}?{query}` with a Bearer credential
 *                when the credential case expects one (lm-studio declares
 *                `authKind: 'none'` and LocalAI without a configured key sends
 *                nothing, so those wires carry no credential).
 *   - anthropic: `{baseUrl}/v1/models` with the `x-api-key` credential header.
 *   - google:    `{baseUrl}/v1beta/models?key={apiKey}` — the credential rides
 *                the `key` query parameter, never a header.
 */
function assertDiscoveryRequest(
  row: ProviderContractRow,
  discovery: ProviderContractDiscoveryPlan,
  credentialCase: DiscoveryCredentialCase,
  request: IncomingMessage,
): void {
  const where = `${row.providerType} discovery (${credentialCase.label})`;
  assert.equal(request.method, 'GET', `${where} must GET the model list`);
  const url = new URL(request.url ?? '', 'http://contract.test');

  // Path: the declared path, or the protocol's default models path.
  assert.equal(
    url.pathname,
    expectedDiscoveryPathname(discovery),
    `${where} must request the declared models path`,
  );

  // Query: exactly the declared parameters (google adds its key-query credential).
  const expectedQuery: Record<string, string> = { ...(discovery.query ?? {}) };
  if (discovery.protocol === 'google' && credentialCase.expectCredential)
    expectedQuery.key = API_KEY;
  assert.deepEqual(
    Object.fromEntries(url.searchParams),
    expectedQuery,
    `${where} must send exactly the declared query parameters`,
  );

  // Auth: credential-free cases (public lists, `authKind: 'none'`, and
  // optional_api_key with no configured key) must not inject any credential —
  // not even a dummy value; credentialed cases must carry the protocol's
  // credential exactly as model-fetcher constructs it.
  const authorization = request.headers.authorization;
  const xApiKey = request.headers['x-api-key'];
  const xGoogApiKey = request.headers['x-goog-api-key'];
  if (!credentialCase.expectCredential) {
    assert.equal(authorization, undefined, `${where} must not send an Authorization header`);
    assert.equal(xApiKey, undefined, `${where} must not send an x-api-key header`);
    assert.equal(xGoogApiKey, undefined, `${where} must not send an x-goog-api-key header`);
    return;
  }
  switch (discovery.protocol) {
    case 'openai':
      assert.equal(authorization, `Bearer ${API_KEY}`, `${where} must send its Bearer credential`);
      break;
    case 'anthropic':
      assert.equal(xApiKey, API_KEY, `${where} must send its x-api-key credential`);
      break;
    case 'google':
      // Credential is the `key` query parameter asserted above; no auth header.
      assert.equal(
        authorization,
        undefined,
        `${where} must carry its credential in the key query, not a header`,
      );
      break;
    case 'cohere':
      assert.fail(`${where}: cohere discovery is never generated`);
  }
}

function expectedDiscoveryPathname(discovery: ProviderContractDiscoveryPlan): string {
  switch (discovery.protocol) {
    case 'anthropic':
      return '/v1/models';
    case 'google':
      return '/v1beta/models';
    default: {
      const path = discovery.path ?? '/models';
      return path.startsWith('/') ? path : `/${path}`;
    }
  }
}

function discoveryPayload(
  protocol: string,
  sample: string,
  filter: string | undefined,
  shape: 'data-object' | 'bare-array',
): unknown {
  if (protocol === 'anthropic') return { data: [{ id: sample }] };
  if (protocol === 'google') return { models: [{ name: `models/${sample}` }] };
  // openai protocol — shape the survivor + a decoy the filter must drop.
  if (filter === 'tool-capable') {
    return {
      object: 'list',
      data: [
        { id: sample, providers: [{ status: 'live', supports_tools: true }] },
        { id: 'contract-decoy-no-tools', providers: [{ status: 'live', supports_tools: false }] },
      ],
    };
  }
  if (filter === 'language-models') {
    return {
      object: 'list',
      data: [
        { id: sample, type: 'language' },
        { id: 'contract-decoy-embedding', type: 'embedding' },
      ],
    };
  }
  if (filter === 'fallback-models') {
    return {
      object: 'list',
      data: [{ id: sample }, { id: 'contract-decoy-not-in-fallback' }],
    };
  }
  if (shape === 'bare-array') return [{ id: sample }];
  return { object: 'list', data: [{ id: sample }] };
}

async function assertFallbackDiscoveryMakesNoRequest(row: ProviderContractRow): Promise<void> {
  let requestCount = 0;
  const server = await startJsonServer((_request, response) => {
    requestCount += 1;
    respondJson(response, 500, { error: 'fallback discovery must not reach the network' });
  });
  const connection = baseConnection(row, server.url);
  const models = await fetchProviderModels(connection, API_KEY);
  assert.equal(
    requestCount,
    0,
    `${row.providerType} fallback discovery must not request any endpoint`,
  );
  assert.ok(
    models.length > 0,
    `${row.providerType} fallback discovery should return the static snapshot`,
  );
  assert.ok(
    models.some((model) => model.id === row.sampleModelId),
    `${row.providerType} fallback snapshot should include its sample model`,
  );
}

// ---------------------------------------------------------------------------
// Generated wire execution
// ---------------------------------------------------------------------------

function wireOfRow(row: ProviderContractRow): ProviderContractWire {
  for (const dimension of ['tool-loop', 'exact-model-id', 'reasoning-replay'] as const) {
    const cell = row.cells[dimension];
    if (cell.state === 'generated' && cell.wire) return cell.wire;
  }
  throw new Error(`${row.providerType} has no generated wire cell`);
}

/**
 * The credential cases a generated wire run expands into, derived from the
 * registry `authKind` — mirroring {@link discoveryCredentialCases}:
 *
 *   - `none`             one run with no credential: the wire must carry no
 *                        credential header at all.
 *   - `optional_api_key` two runs: a configured key must reach the wire in the
 *                        protocol's carrier, and an absent key must leave every
 *                        request credential-free (no dummy value).
 *   - otherwise          one run: the provider credential must reach every
 *                        inference request in the protocol's carrier (Bearer for
 *                        the OpenAI and Cohere wires, x-api-key — or Bearer for
 *                        `auth: 'bearer'` adapters — for Anthropic,
 *                        x-goog-api-key for Google).
 */
interface WireCredentialCase {
  label: 'provider-auth' | 'no-auth' | 'optional-with-key' | 'optional-without-key';
  apiKey: string;
  expectCredential: boolean;
}

function wireCredentialCases(row: ProviderContractRow): WireCredentialCase[] {
  switch (PROVIDER_DEFAULTS[row.providerType].authKind) {
    case 'none':
      return [{ label: 'no-auth', apiKey: '', expectCredential: false }];
    case 'optional_api_key':
      return [
        { label: 'optional-with-key', apiKey: API_KEY, expectCredential: true },
        { label: 'optional-without-key', apiKey: '', expectCredential: false },
      ];
    default:
      return [{ label: 'provider-auth', apiKey: API_KEY, expectCredential: true }];
  }
}

async function runGeneratedWire(
  row: ProviderContractRow,
  wireDims: ReadonlyArray<'exact-model-id' | 'tool-loop' | 'reasoning-replay'>,
): Promise<void> {
  const wire = wireOfRow(row);
  const wantsReasoning = wireDims.includes('reasoning-replay');
  const replayCell = row.cells['reasoning-replay'];
  const replayField =
    replayCell.state === 'generated' && replayCell.reasoningReplay
      ? replayCell.reasoningReplay.replayField
      : undefined;
  for (const credential of wireCredentialCases(row)) {
    await runWireOnce(row, wire, row.sampleModelId, credential, wantsReasoning, replayField);
  }
}

/**
 * Declared edge-shaped ids run the same executor end-to-end (exact-model-id +
 * tool-loop) on the wire the plan resolved for that id; reasoning replay stays
 * owned by the primary sample run.
 */
async function runEdgeWireSample(
  row: ProviderContractRow,
  edge: { modelId: string; wire: ProviderContractWire },
): Promise<void> {
  for (const credential of wireCredentialCases(row)) {
    await runWireOnce(row, edge.wire, edge.modelId, credential, false, undefined);
  }
}

async function runWireOnce(
  row: ProviderContractRow,
  wire: ProviderContractWire,
  modelId: string,
  credential: WireCredentialCase,
  wantsReasoning: boolean,
  replayField: 'reasoning' | 'reasoning_content' | undefined,
): Promise<void> {
  switch (wire) {
    case 'openai-chat':
      return runOpenAiChatWire(row, modelId, credential, wantsReasoning, replayField);
    case 'anthropic-messages':
      return runAnthropicMessagesWire(row, modelId, credential);
    case 'google-generate':
      return runGoogleGenerateWire(row, modelId, credential);
    case 'cohere-v2':
      return runCohereV2Wire(row, modelId, credential);
  }
}

/** Every credential header a maka wire could carry; all but the expected carrier must be absent. */
const WIRE_CREDENTIAL_HEADERS = [
  'authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
] as const;

const WIRE_CARRIER_HEADER = {
  'authorization-bearer': 'authorization',
  'x-api-key': 'x-api-key',
  'x-goog-api-key': 'x-goog-api-key',
} as const;

/**
 * Assert the request carries exactly the expected credential: credential-free
 * cases must send no credential header at all (no dummy value), and
 * credentialed cases must send the credential in the protocol's carrier and in
 * no other credential header.
 */
function assertWireCredential(
  row: ProviderContractRow,
  credential: WireCredentialCase,
  request: IncomingMessage,
  carrier: keyof typeof WIRE_CARRIER_HEADER,
): void {
  const where = `${row.providerType} · wire (${credential.label})`;
  const expectedHeader = credential.expectCredential ? WIRE_CARRIER_HEADER[carrier] : undefined;
  for (const header of WIRE_CREDENTIAL_HEADERS) {
    if (header !== expectedHeader) {
      assert.equal(
        request.headers[header],
        undefined,
        `${where} must not send a ${header} credential header`,
      );
    }
  }
  if (!expectedHeader) return;
  assert.equal(
    request.headers[expectedHeader],
    carrier === 'authorization-bearer' ? `Bearer ${API_KEY}` : API_KEY,
    `${where} must send its credential as ${carrier}`,
  );
}

const echoTool = tool({
  description: 'Echo text',
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
});

/**
 * Opaque provider-shaped tool-call id, deliberately without the `call_`
 * prefix: the loop must replay whatever id the provider issued verbatim, not
 * an id that merely looks OpenAI-shaped.
 */
const OPAQUE_TOOL_CALL_ID = 'D681PevKs9';

/**
 * Sentinel pathname on every stub base URL. The runners assert the final
 * request path is exactly this prefix plus the protocol suffix, proving the
 * runtime preserves a configured base URL's pathname instead of collapsing it
 * to the origin.
 */
const WIRE_BASE_PATH = '/contract-base';

async function runOpenAiChatWire(
  row: ProviderContractRow,
  modelId: string,
  credential: WireCredentialCase,
  wantsReasoning: boolean,
  replayField: 'reasoning' | 'reasoning_content' | undefined,
): Promise<void> {
  const requestBodies: Array<Record<string, unknown>> = [];
  // Request-contract violations (method, path, credential) are recorded and
  // rethrown after the call so the test fails with the contract message
  // instead of a destroyed-socket error.
  const handlerErrors: unknown[] = [];
  const server = await startJsonServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(
        new URL(request.url ?? '', 'http://contract.test').pathname,
        `${WIRE_BASE_PATH}/v1/chat/completions`,
        `${row.providerType} must preserve the configured base URL pathname`,
      );
      assertWireCredential(row, credential, request, 'authorization-bearer');
    } catch (error) {
      handlerErrors.push(error);
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      respondJson(response, 200, {
        id: 'chatcmpl-tool',
        object: 'chat.completion',
        created: 1,
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              ...(wantsReasoning ? { reasoning_content: REASONING_TEXT } : {}),
              tool_calls: [
                {
                  id: OPAQUE_TOOL_CALL_ID,
                  type: 'function',
                  function: { name: 'echo', arguments: '{"text":"hello"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
      return;
    }
    respondJson(response, 200, {
      id: 'chatcmpl-final',
      object: 'chat.completion',
      created: 2,
      model: modelId,
      choices: [
        { index: 0, message: { role: 'assistant', content: FINAL_TEXT }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
  });
  const connection = baseConnection(row, `${server.url}${WIRE_BASE_PATH}/v1`);
  const result = await generateText({
    model: getAIModel({ connection, apiKey: credential.apiKey, modelId }),
    prompt: 'Call echo with hello.',
    stopWhen: isStepCount(2),
    tools: { echo: echoTool },
  });

  if (handlerErrors.length > 0) throw handlerErrors[0];
  assert.equal(requestBodies.length, 2, `${row.providerType} should make two chat requests`);
  assert.deepEqual(
    requestBodies.map((body) => body.model),
    [modelId, modelId],
    `${row.providerType} must send the exact model id on both requests`,
  );
  assert.deepEqual(
    (requestBodies[0].tools as Array<{ function: { name: string } }>).map(
      (entry) => entry.function.name,
    ),
    ['echo'],
  );
  assert.deepEqual(
    (requestBodies[1].messages as Array<{ role: string; content: string }>).find(
      ({ role }) => role === 'tool',
    ),
    { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: OPAQUE_TOOL_CALL_ID },
    `${row.providerType} must replay the tool result against the provider's opaque call id`,
  );
  assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
  assert.equal(result.text, FINAL_TEXT);
  if (wantsReasoning && replayField) {
    assert.equal(
      result.steps[0]?.reasoningText,
      REASONING_TEXT,
      `${row.providerType} should surface reasoning`,
    );
    const assistant = (requestBodies[1].messages as Array<Record<string, unknown>>).find(
      ({ role }) => role === 'assistant',
    );
    assert.ok(assistant, `${row.providerType} must replay the assistant turn`);
    assert.equal(
      assistant?.[replayField],
      REASONING_TEXT,
      `${row.providerType} must replay reasoning in the "${replayField}" field`,
    );
  }
}

async function runAnthropicMessagesWire(
  row: ProviderContractRow,
  modelId: string,
  credential: WireCredentialCase,
): Promise<void> {
  const sample = modelId;
  // The native Anthropic adapter carries the credential as x-api-key by
  // default; providers declaring `auth: 'bearer'` carry an Authorization
  // Bearer token instead (getAIModel passes authToken).
  const adapter = PROVIDER_DEFAULTS[row.providerType].runtimeAdapter;
  const carrier =
    adapter.kind === 'anthropic' && adapter.auth === 'bearer'
      ? ('authorization-bearer' as const)
      : ('x-api-key' as const);
  const requestBodies: Array<Record<string, unknown>> = [];
  // Second-turn contract violations are asserted in the handler before the
  // final response, recorded, and rethrown after the call so the test fails
  // with the wire-contract message instead of a destroyed-socket error.
  const handlerErrors: unknown[] = [];
  const server = await startJsonServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(
        new URL(request.url ?? '', 'http://contract.test').pathname,
        `${WIRE_BASE_PATH}/v1/messages`,
        `${row.providerType} must preserve the configured base URL pathname`,
      );
      assertWireCredential(row, credential, request, carrier);
    } catch (error) {
      handlerErrors.push(error);
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      respondJson(response, 200, {
        id: 'msg_tool',
        type: 'message',
        role: 'assistant',
        model: sample,
        content: [{ type: 'tool_use', id: 'toolu_echo', name: 'echo', input: { text: 'hello' } }],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 4 },
      });
      return;
    }
    // Turn two must replay the tool result, keyed to the first-turn tool_use id,
    // before the wire answers with the final text.
    try {
      const toolResults = (body.messages as Array<{ role: string; content: unknown }>)
        .flatMap((message) =>
          Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [],
        )
        .filter((block) => block.type === 'tool_result');
      assert.equal(
        toolResults.length,
        1,
        `${row.providerType} · tool-loop: turn two must replay exactly one tool_result block`,
      );
      assert.equal(
        toolResults[0]?.tool_use_id,
        'toolu_echo',
        `${row.providerType} · tool-loop: the tool_result must reference the first-turn tool_use id`,
      );
      const toolResultContent = JSON.stringify(toolResults[0]?.content);
      assert.ok(
        toolResultContent.includes('echoed') && toolResultContent.includes('hello'),
        `${row.providerType} · tool-loop: the tool_result must carry the echo output, got ${toolResultContent}`,
      );
    } catch (error) {
      handlerErrors.push(error);
    }
    respondJson(response, 200, {
      id: 'msg_final',
      type: 'message',
      role: 'assistant',
      model: sample,
      content: [{ type: 'text', text: FINAL_TEXT }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  });
  const connection = baseConnection(row, `${server.url}${WIRE_BASE_PATH}/v1`);
  const result = await generateText({
    model: getAIModel({ connection, apiKey: credential.apiKey, modelId: sample }),
    prompt: 'Call echo with hello.',
    stopWhen: isStepCount(2),
    tools: { echo: echoTool },
  });

  if (handlerErrors.length > 0) throw handlerErrors[0];
  assert.equal(requestBodies.length, 2, `${row.providerType} should make two messages requests`);
  assert.deepEqual(
    requestBodies.map((body) => body.model),
    [sample, sample],
    `${row.providerType} must send the exact model id on both requests`,
  );
  assert.deepEqual(
    (requestBodies[0].tools as Array<{ name: string }>).map((entry) => entry.name),
    ['echo'],
  );
  assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
  assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
  assert.equal(result.text, FINAL_TEXT);
}

async function runGoogleGenerateWire(
  row: ProviderContractRow,
  modelId: string,
  credential: WireCredentialCase,
): Promise<void> {
  const sample = modelId;
  const requestUrls: string[] = [];
  // See runAnthropicMessagesWire for why second-turn violations are recorded.
  const handlerErrors: unknown[] = [];
  const server = await startJsonServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(
        new URL(request.url ?? '', 'http://contract.test').pathname,
        `${WIRE_BASE_PATH}/v1beta/models/${sample}:generateContent`,
        `${row.providerType} must preserve the configured base URL pathname`,
      );
      assertWireCredential(row, credential, request, 'x-goog-api-key');
    } catch (error) {
      handlerErrors.push(error);
    }
    requestUrls.push(request.url ?? '');
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    if (requestUrls.length === 1) {
      respondJson(response, 200, {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'echo', args: { text: 'hello' } } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
      });
      return;
    }
    // Turn two must replay a functionResponse part for the first-turn `echo`
    // functionCall before the wire answers with the final text.
    try {
      const functionResponses = (body.contents as Array<{ parts?: Array<Record<string, unknown>> }>)
        .flatMap((content) => content.parts ?? [])
        .map((part) => part.functionResponse as { name?: string; response?: unknown } | undefined)
        .filter((part): part is { name?: string; response?: unknown } => part !== undefined);
      assert.equal(
        functionResponses.length,
        1,
        `${row.providerType} · tool-loop: turn two must replay exactly one functionResponse part`,
      );
      assert.equal(
        functionResponses[0]?.name,
        'echo',
        `${row.providerType} · tool-loop: the functionResponse must correspond to the first-turn echo functionCall`,
      );
      const functionResponseJson = JSON.stringify(functionResponses[0]?.response);
      assert.ok(
        functionResponseJson.includes('echoed') && functionResponseJson.includes('hello'),
        `${row.providerType} · tool-loop: the functionResponse must carry the echo output, got ${functionResponseJson}`,
      );
    } catch (error) {
      handlerErrors.push(error);
    }
    respondJson(response, 200, {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: FINAL_TEXT }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
    });
  });
  const connection = baseConnection(row, `${server.url}${WIRE_BASE_PATH}`);
  const result = await generateText({
    model: getAIModel({ connection, apiKey: credential.apiKey, modelId: sample }),
    prompt: 'Call echo with hello.',
    stopWhen: isStepCount(2),
    tools: { echo: echoTool },
  });

  if (handlerErrors.length > 0) throw handlerErrors[0];
  assert.ok(
    requestUrls.length >= 2,
    `${row.providerType} should make two generateContent requests`,
  );
  assert.ok(
    requestUrls.every((url) => url.includes(`models/${sample}`)),
    `${row.providerType} must send the exact model id in the generateContent path`,
  );
  assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
  assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
  assert.equal(result.text, FINAL_TEXT);
}

async function runCohereV2Wire(
  row: ProviderContractRow,
  modelId: string,
  credential: WireCredentialCase,
): Promise<void> {
  const sample = modelId;
  const requestBodies: Array<Record<string, unknown>> = [];
  // See runAnthropicMessagesWire for why second-turn violations are recorded.
  const handlerErrors: unknown[] = [];
  const server = await startJsonServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(
        new URL(request.url ?? '', 'http://contract.test').pathname,
        `${WIRE_BASE_PATH}/v2/chat`,
        `${row.providerType} must preserve the configured base URL pathname`,
      );
      assertWireCredential(row, credential, request, 'authorization-bearer');
    } catch (error) {
      handlerErrors.push(error);
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      respondJson(response, 200, {
        generation_id: 'cohere-tool-turn',
        finish_reason: 'TOOL_CALL',
        message: {
          role: 'assistant',
          content: [],
          tool_plan: 'Call echo.',
          tool_calls: [
            {
              id: 'call_echo',
              type: 'function',
              function: { name: 'echo', arguments: '{"text":"hello"}' },
            },
          ],
        },
        usage: {
          billed_units: { input_tokens: 8, output_tokens: 4 },
          tokens: { input_tokens: 8, output_tokens: 4 },
        },
      });
      return;
    }
    // Turn two must replay the tool result message, keyed to the first-turn
    // call id, before the wire answers with the final text.
    try {
      const toolMessages = (body.messages as Array<Record<string, unknown>>).filter(
        (message) => message.role === 'tool',
      );
      assert.equal(
        toolMessages.length,
        1,
        `${row.providerType} · tool-loop: turn two must replay exactly one tool message`,
      );
      assert.equal(
        toolMessages[0]?.tool_call_id,
        'call_echo',
        `${row.providerType} · tool-loop: the tool message must reference the first-turn call id`,
      );
      const toolMessageContent = JSON.stringify(toolMessages[0]?.content);
      assert.ok(
        toolMessageContent.includes('echoed') && toolMessageContent.includes('hello'),
        `${row.providerType} · tool-loop: the tool message must carry the echo output, got ${toolMessageContent}`,
      );
    } catch (error) {
      handlerErrors.push(error);
    }
    respondJson(response, 200, {
      generation_id: 'cohere-final-turn',
      finish_reason: 'COMPLETE',
      message: { role: 'assistant', content: [{ type: 'text', text: FINAL_TEXT }] },
      usage: {
        billed_units: { input_tokens: 12, output_tokens: 3 },
        tokens: { input_tokens: 12, output_tokens: 3 },
      },
    });
  });
  const connection = baseConnection(row, `${server.url}${WIRE_BASE_PATH}/v2`);
  const result = await generateText({
    model: getAIModel({ connection, apiKey: credential.apiKey, modelId: sample }),
    prompt: 'Call echo with hello.',
    stopWhen: isStepCount(2),
    tools: { echo: echoTool },
  });

  if (handlerErrors.length > 0) throw handlerErrors[0];
  assert.equal(requestBodies.length, 2, `${row.providerType} should make two chat requests`);
  assert.deepEqual(
    requestBodies.map((body) => body.model),
    [sample, sample],
    `${row.providerType} must send the exact model id on both requests`,
  );
  assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
  assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
  assert.equal(result.text, FINAL_TEXT);
}

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------

function baseConnection(row: ProviderContractRow, baseUrl: string): LlmConnection {
  return {
    slug: `${row.providerType}-contract`,
    name: row.providerType,
    providerType: row.providerType,
    baseUrl,
    defaultModel: row.sampleModelId,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
