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
import { afterEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CLIENT_CAPABILITIES_META_KEY, ProtocolError } from '@modelcontextprotocol/client';
import { inputRequired } from '@modelcontextprotocol/server';
import { MCP_CONFIG_VERSION } from '@maka/core/mcp';
import type { InteractionFormResult } from '@maka/core/interaction';
import { McpClientManager } from '../index.js';
import { createMcpFormFixture, mcpFixtureFormRequest } from '../__fixtures__/form-server.js';

const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

const accepted: InteractionFormResult = {
  action: 'accept',
  values: { name: 'Ada', email: 'ada@example.com', confirm: true },
};

async function setup(legacy = false) {
  const fixture = await createMcpFormFixture({ legacy });
  resources.push(() => fixture.close());
  const manager = new McpClientManager({ timeouts: { callToolMs: 1_000 } });
  resources.push(() => manager.close());
  await manager.sync({
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      forms: {
        transport: 'streamable-http',
        url: fixture.url,
        protocol: legacy ? 'legacy' : 'auto',
      },
    },
  });
  const binding = manager.toolSnapshot().tools[0]!.binding;
  return { fixture, manager, binding };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('real modern form round trip preserves original arguments, IDs, state and per-call capability', async () => {
  const { fixture, manager, binding } = await setup();
  const args = { source: { value: 'original' } };
  const result = await manager.callTool(binding, args, {
    requestInteraction: async (form) => {
      assert.deepEqual(form.requester, { name: 'ask_user', source: 'forms' });
      assert.deepEqual(
        form.fields.map((field) => field.name),
        ['name', 'email', 'confirm'],
      );
      assert.equal(JSON.stringify(form).includes('opaque-state'), false);
      args.source.value = 'changed';
      return accepted;
    },
  });
  assert.equal(result.content[0]?.type, 'text');
  assert.equal(fixture.calls.length, 2);
  assert.notEqual(fixture.calls[0]!.id, fixture.calls[1]!.id);
  for (const call of fixture.calls) {
    assert.deepEqual(call.params.arguments, { source: { value: 'original' } });
    assert.deepEqual(call.params._meta?.[CLIENT_CAPABILITIES_META_KEY], {
      elicitation: { form: {} },
    });
  }
  assert.equal(fixture.calls[1]!.params.requestState, 'opaque-state');
  assert.deepEqual(fixture.calls[1]!.params.inputResponses, {
    form: { action: 'accept', content: accepted.values },
  });
});

for (const action of ['decline', 'cancel'] as const) {
  test(`explicit ${action} is a protocol response, not global Stop`, async () => {
    const { fixture, manager, binding } = await setup();
    await manager.callTool(binding, {}, { requestInteraction: async () => ({ action }) });
    assert.deepEqual(fixture.calls[1]!.params.inputResponses, { form: { action } });
  });
}

test('handler-less call does not advertise elicitation and does not retry', async () => {
  const { fixture, manager, binding } = await setup();
  await assert.rejects(manager.callTool(binding, {}), /server rejected/);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0]!.params._meta?.[CLIENT_CAPABILITIES_META_KEY], {});
});

test('multiple rounds replace old responses and preserve exact opaque state', async () => {
  const { fixture, manager, binding } = await setup();
  const first = ' round-one \n opaque\u0000 ';
  const second = 'round-two-state';
  fixture.respond = () =>
    fixture.calls.length === 1
      ? inputRequired({
          inputRequests: { z: mcpFixtureFormRequest(), a: mcpFixtureFormRequest() },
          requestState: first,
        })
      : fixture.calls.length === 2
        ? inputRequired({ inputRequests: { next: mcpFixtureFormRequest() }, requestState: second })
        : { content: [] };
  let forms = 0;
  await manager.callTool(
    binding,
    {},
    {
      requestInteraction: async () => {
        forms++;
        return accepted;
      },
    },
  );
  assert.equal(forms, 3);
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls[1]!.params.requestState, first);
  assert.deepEqual(Object.keys(fixture.calls[1]!.params.inputResponses!), ['a', 'z']);
  assert.equal(fixture.calls[2]!.params.requestState, second);
  assert.deepEqual(Object.keys(fixture.calls[2]!.params.inputResponses!), ['next']);
  assert.equal(new Set(fixture.calls.map(({ id }) => id)).size, 3);
});

test('state-only rounds are bounded and retain an empty state exactly', async () => {
  const { fixture, manager, binding } = await setup();
  fixture.respond = () => inputRequired({ requestState: '' });
  await assert.rejects(
    manager.callTool(
      binding,
      {},
      {
        requestInteraction: async () => assert.fail('unexpected form'),
      },
    ),
    /round limit/,
  );
  assert.equal(fixture.calls.length, 9);
  assert.equal(fixture.calls[1]!.params.requestState, '');
  assert.equal(Object.hasOwn(fixture.calls[1]!.params, 'inputResponses'), false);
});

test('invalid sibling fails preflight without displaying the valid first form', async () => {
  const { fixture, manager, binding } = await setup();
  fixture.respond = () =>
    inputRequired({
      inputRequests: {
        first: mcpFixtureFormRequest(),
        second: {
          ...mcpFixtureFormRequest(),
          params: { ...mcpFixtureFormRequest().params, message: 'm'.repeat(2_049) },
        },
      },
      requestState: 'opaque',
    });
  await assert.rejects(
    manager.callTool(
      binding,
      {},
      {
        requestInteraction: async () => assert.fail('preflight was not atomic'),
      },
    ),
  );
  assert.equal(fixture.calls.length, 1);
});

test('invalid accepted answer never reaches server', async () => {
  const { fixture, manager, binding } = await setup();
  await assert.rejects(
    manager.callTool(
      binding,
      {},
      {
        requestInteraction: async () => ({
          action: 'accept',
          values: { name: 'Ada', email: 'invalid', confirm: true },
        }),
      },
    ),
  );
  assert.equal(fixture.calls.length, 1);
});

for (const invalidate of [
  'stop',
  'disconnect',
  'reconnect',
  'close',
  'changed refresh',
  'exhaust',
] as const) {
  test(`${invalidate} aborts a pending callback even when it ignores cancellation`, async () => {
    const { fixture, manager, binding } = await setup();
    const shown = deferred<void>();
    const answer = deferred<InteractionFormResult>();
    const controller = new AbortController();
    const call = manager.callTool(
      binding,
      {},
      {
        signal: controller.signal,
        requestInteraction: async () => {
          shown.resolve();
          return answer.promise;
        },
      },
    );
    const rejected = assert.rejects(
      call,
      invalidate === 'exhaust' ? /retention exhausted/ : /aborted|stale/,
    );
    await shown.promise;
    if (invalidate === 'stop') controller.abort();
    else if (invalidate === 'disconnect') await manager.disconnect('forms');
    else if (invalidate === 'reconnect') await manager.reconnect('forms');
    else if (invalidate === 'close') await manager.close();
    else if (invalidate === 'exhaust') {
      fixture.respond = () => inputRequired({ requestState: 's'.repeat(16 * 1024 + 1) });
      await assert.rejects(
        manager.callTool(
          binding,
          {},
          {
            requestInteraction: async () => assert.fail('exhausting call must not publish a form'),
          },
        ),
        /retention exhausted/,
      );
    } else {
      fixture.definition = { ...fixture.definition, description: 'new definition' };
      await manager.refreshTools('forms');
    }
    await Promise.race([
      rejected,
      delay(500).then(() => assert.fail('pending invocation did not abort')),
    ]);
    answer.resolve(accepted);
    await delay(10);
    assert.equal(fixture.calls.length, invalidate === 'exhaust' ? 2 : 1);
  });
}

test('unchanged refresh preserves the pending invocation', async () => {
  const { fixture, manager, binding } = await setup();
  await manager.callTool(
    binding,
    {},
    {
      requestInteraction: async () => {
        await manager.refreshTools('forms');
        assert.equal(manager.toolSnapshot().tools[0]!.binding, binding);
        return accepted;
      },
    },
  );
  assert.equal(fixture.calls.length, 2);
});

test('abort just after answer commitment prevents the next network leg', async () => {
  const { fixture, manager, binding } = await setup();
  const controller = new AbortController();
  await assert.rejects(
    manager.callTool(
      binding,
      {},
      {
        signal: controller.signal,
        requestInteraction: async () => {
          controller.abort();
          return accepted;
        },
      },
    ),
    /aborted/,
  );
  assert.equal(fixture.calls.length, 1);
});

test('user wait does not consume the network timeout', async () => {
  const { fixture, manager, binding } = await setup();
  await manager.callTool(
    binding,
    {},
    {
      timeoutMs: 100,
      requestInteraction: async () => {
        await delay(150);
        return accepted;
      },
    },
  );
  assert.equal(fixture.calls.length, 2);
});

test('separate invocations on one connection keep answers and states isolated', async () => {
  const { fixture, manager, binding } = await setup();
  fixture.respond = (params) =>
    params.inputResponses
      ? { content: [{ type: 'text', text: String(params.inputResponses.form?.action) }] }
      : inputRequired({
          inputRequests: { form: mcpFixtureFormRequest() },
          requestState: `state-${params.arguments?.id}`,
        });
  await Promise.all(
    ['left', 'right'].map((id) =>
      manager.callTool(
        binding,
        { id },
        {
          requestInteraction: async () => ({ action: id === 'left' ? 'decline' : 'cancel' }),
        },
      ),
    ),
  );
  const retries = fixture.calls.filter(({ params }) => params.inputResponses);
  assert.equal(retries.length, 2);
  for (const { params } of retries) {
    assert.equal(params.requestState, `state-${params.arguments?.id}`);
    assert.equal(
      params.inputResponses!.form?.action,
      params.arguments?.id === 'left' ? 'decline' : 'cancel',
    );
  }
});

for (const state of ['private-long-state', '§']) {
  for (const outcome of ['success', 'tool-error', 'protocol-error'] as const) {
    test(`scrubs ${state.length > 1 ? 'long' : 'short'} state reflected in ${outcome}`, async () => {
      const { fixture, manager, binding } = await setup();
      fixture.respond = (params) => {
        if (!params.inputResponses)
          return inputRequired({
            inputRequests: { form: mcpFixtureFormRequest() },
            requestState: state,
          });
        if (outcome === 'protocol-error')
          throw new ProtocolError(-32000, `reflected ${state}`, { state });
        return {
          content: [{ type: 'text', text: `reflected ${state}` }],
          structuredContent: { echoed: state },
          ...(outcome === 'tool-error' ? { isError: true } : {}),
        };
      };
      if (outcome === 'success') {
        const result = await manager.callTool(
          binding,
          {},
          { requestInteraction: async () => accepted },
        );
        assert.equal(JSON.stringify(result).includes(state), false);
      } else {
        await assert.rejects(
          manager.callTool(binding, {}, { requestInteraction: async () => accepted }),
          (error: unknown) => {
            assert(error instanceof Error);
            assert.equal(error.message.includes(state), false);
            if (error.cause instanceof Error)
              assert.equal(error.cause.message.includes(state), false);
            assert.equal(JSON.stringify(error).includes(state), false);
            return true;
          },
        );
      }
    });
  }
}

for (const state of ['opaque-secret-state', 'opaque\nstate', '[redacted]']) {
  for (const location of ['message', 'property key', 'default'] as const) {
    test(`state ${JSON.stringify(state)} echoed into a form ${location} fails before projection`, async () => {
      const { fixture, manager, binding } = await setup();
      const request = mcpFixtureFormRequest();
      if (location === 'message') request.params.message = state;
      else if (location === 'property key') {
        Object.defineProperty(request.params.requestedSchema.properties, state, {
          value: { type: 'string' },
          enumerable: true,
        });
      } else {
        Object.assign(request.params.requestedSchema.properties.name, { default: state });
      }
      fixture.respond = (params) =>
        params.inputResponses
          ? { content: [] }
          : inputRequired({ inputRequests: { form: request }, requestState: state });
      let shown = 0;
      await assert.rejects(
        manager.callTool(
          binding,
          {},
          {
            requestInteraction: async () => {
              shown++;
              return accepted;
            },
          },
        ),
        /private continuation/,
      );
      assert.equal(shown, 0);
      assert.equal(fixture.calls.length, 1);
    });
  }
}

for (const state of ['opaque\nstate', '[redacted]']) {
  test(`a later call cannot project earlier connection state ${JSON.stringify(state)}`, async () => {
    const { fixture, manager, binding } = await setup();
    fixture.respond = (params) =>
      params.inputResponses
        ? { content: [] }
        : inputRequired({
            inputRequests: { form: mcpFixtureFormRequest() },
            requestState: state,
          });
    await manager.callTool(binding, {}, { requestInteraction: async () => accepted });
    const request = mcpFixtureFormRequest();
    request.params.message = state;
    fixture.respond = (params) =>
      params.inputResponses
        ? { content: [] }
        : inputRequired({
            inputRequests: { form: request },
            requestState: 'new-private-state',
          });
    let shown = 0;
    await assert.rejects(
      manager.callTool(
        binding,
        {},
        {
          requestInteraction: async () => {
            shown++;
            return accepted;
          },
        },
      ),
      /private continuation/,
    );
    assert.equal(shown, 0);
    assert.equal(fixture.calls.length, 3);
  });
}

test('retained state cannot escape through a later output-schema preparation error', async () => {
  const { fixture, manager, binding } = await setup();
  await manager.callTool(binding, {}, { requestInteraction: async () => accepted });
  fixture.definition = {
    ...fixture.definition,
    outputSchema: { type: 'object', $ref: 'opaque-state' },
  };
  await manager.refreshTools('forms');
  const refreshed = manager.toolSnapshot().tools[0]!.binding;
  await assert.rejects(manager.callTool(refreshed, {}), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /invalid output schema/);
    assert(error.cause instanceof Error);
    assert.doesNotMatch(error.cause.message, /opaque-state/);
    return true;
  });
  assert.equal(fixture.calls.length, 2);
});

test('retained state cannot escape through a later header-argument error', async () => {
  const { fixture, manager, binding } = await setup();
  await manager.callTool(binding, {}, { requestInteraction: async () => accepted });
  fixture.definition = {
    ...fixture.definition,
    inputSchema: {
      type: 'object',
      properties: { 'opaque-state': { type: 'integer', 'x-mcp-header': 'Shard' } },
    },
  };
  await manager.refreshTools('forms');
  const refreshed = manager.toolSnapshot().tools[0]!.binding;
  await assert.rejects(
    manager.callTool(refreshed, { 'opaque-state': Number.MAX_SAFE_INTEGER + 1 }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /unsafe integer/);
      assert.doesNotMatch(error.message, /opaque-state/);
      return true;
    },
  );
  assert.equal(fixture.calls.length, 2);
});

for (const interactive of [false, true]) {
  test(`retention exhaustion fences an already pending ${interactive ? 'interactive' : 'ordinary'} call`, async () => {
    const { fixture, manager, binding } = await setup();
    const waiting = deferred<void>();
    const release = deferred<void>();
    let stateNumber = 0;
    fixture.respond = async (params) => {
      if (params.arguments?.hold) {
        waiting.resolve();
        await release.promise;
        return { content: [{ type: 'text', text: 'state-65' }] };
      }
      return params.inputResponses
        ? { content: [] }
        : inputRequired({
            inputRequests: { form: mcpFixtureFormRequest() },
            requestState: `state-${++stateNumber}`,
          });
    };
    for (let call = 0; call < 64; call++) {
      await manager.callTool(binding, {}, { requestInteraction: async () => accepted });
    }
    const pending = assert.rejects(
      manager.callTool(
        binding,
        { hold: true },
        {
          ...(interactive ? { requestInteraction: async () => accepted } : {}),
        },
      ),
      /retention exhausted/,
    );
    await waiting.promise;
    try {
      await assert.rejects(
        manager.callTool(
          binding,
          {},
          {
            requestInteraction: async () => accepted,
          },
        ),
        /retention exhausted/,
      );
    } finally {
      release.resolve();
    }
    await pending;
    const requests = fixture.calls.length;
    await assert.rejects(manager.callTool(binding, {}), /retention exhausted/);
    assert.equal(fixture.calls.length, requests);
  });
}

for (const limit of ['state', 'count', 'bytes'] as const) {
  test(`rejects excessive ${limit} before displaying a form`, async () => {
    const { fixture, manager, binding } = await setup();
    fixture.respond = () =>
      inputRequired({
        requestState: limit === 'state' ? 's'.repeat(16 * 1024 + 1) : 'opaque',
        inputRequests:
          limit === 'count'
            ? Object.fromEntries(
                Array.from({ length: 9 }, (_, index) => [String(index), mcpFixtureFormRequest()]),
              )
            : {
                form: {
                  ...mcpFixtureFormRequest(),
                  params: {
                    ...mcpFixtureFormRequest().params,
                    message: limit === 'bytes' ? 'm'.repeat(64 * 1024) : 'Please fill',
                  },
                },
              },
      });
    await assert.rejects(
      manager.callTool(
        binding,
        {},
        {
          requestInteraction: async () => assert.fail('over-limit form reached callback'),
        },
      ),
      /limit/,
    );
    assert.equal(fixture.calls.length, 1);
  });
}

test('the retry network leg still has its own timeout', async () => {
  const { fixture, manager, binding } = await setup();
  const respond = fixture.respond;
  fixture.respond = async (params) => {
    if (params.inputResponses) await delay(250);
    return respond(params);
  };
  await assert.rejects(
    manager.callTool(
      binding,
      {},
      {
        timeoutMs: 100,
        requestInteraction: async () => accepted,
      },
    ),
    /timed out/,
  );
  assert.equal(fixture.calls.length, 2);
});

test('old state is scrubbed even after a later round replaces it', async () => {
  const { fixture, manager, binding } = await setup();
  fixture.respond = () =>
    fixture.calls.length === 1
      ? inputRequired({
          inputRequests: { form: mcpFixtureFormRequest() },
          requestState: 'first-private-state',
        })
      : fixture.calls.length === 2
        ? inputRequired({
            inputRequests: { next: mcpFixtureFormRequest() },
            requestState: 'second-private-state',
          })
        : { content: [{ type: 'text', text: 'first-private-state second-private-state' }] };
  const result = await manager.callTool(binding, {}, { requestInteraction: async () => accepted });
  assert.doesNotMatch(JSON.stringify(result), /first-private-state|second-private-state/);
});

test('a new round without state does not reuse previous state', async () => {
  const { fixture, manager, binding } = await setup();
  fixture.respond = () =>
    fixture.calls.length === 1
      ? inputRequired({
          inputRequests: { form: mcpFixtureFormRequest() },
          requestState: 'first-private-state',
        })
      : fixture.calls.length === 2
        ? inputRequired({ inputRequests: { next: mcpFixtureFormRequest() } })
        : { content: [] };
  await manager.callTool(binding, {}, { requestInteraction: async () => accepted });
  assert.equal(Object.hasOwn(fixture.calls[2]!.params, 'requestState'), false);
});

test('interactive retry retains SEP-2243 headers and final output validation', async () => {
  const { fixture, manager } = await setup();
  fixture.definition = {
    ...fixture.definition,
    inputSchema: {
      type: 'object',
      properties: { shard: { type: 'integer', 'x-mcp-header': 'Shard' } },
    },
    outputSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
  };
  await manager.refreshTools('forms');
  const binding = manager.toolSnapshot().tools[0]!.binding;
  // The initial deferred result has no structuredContent. Only the complete
  // result is subject to the original frozen tool's output schema.
  await assert.rejects(
    manager.callTool(
      binding,
      { shard: 42 },
      {
        requestInteraction: async () => accepted,
      },
    ),
    /invalid tool result/,
  );
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(
    fixture.callHeaders.map((headers) => headers['mcp-param-shard']),
    ['42', '42'],
  );
});

test('a supplied form callback never advertises elicitation on a legacy connection', async () => {
  const { fixture, manager, binding } = await setup(true);
  fixture.respond = () => ({ content: [{ type: 'text', text: 'legacy complete' }] });
  assert.equal(manager.status('forms')?.negotiatedProtocol?.era, 'legacy');
  await manager.callTool(
    binding,
    {},
    {
      requestInteraction: async () => assert.fail('legacy callback must remain disabled'),
    },
  );
  assert.deepEqual(fixture.initializeCapabilities, {});
  assert.equal(fixture.calls[0]!.params._meta?.[CLIENT_CAPABILITIES_META_KEY], undefined);
  assert.equal(fixture.calls.length, 1);
});
