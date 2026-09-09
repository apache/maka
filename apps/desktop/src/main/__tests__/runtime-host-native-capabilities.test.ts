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
import { buildComputerUseTools, type ComputerUseToolSet } from '@maka/runtime/computer-use-tools';
import { type CuDispatchBackend } from '@maka/runtime/computer-use-types';
import { type MakaTool, type MakaToolContext } from '@maka/runtime/tool-runtime';
import type { ClientCapabilityProvider } from '@maka/runtime-host/client';
import {
  decodeClientCapabilityReplaceInput,
  type ClientCapabilityAdmissionEvidence,
  type ClientCapabilityCallFrame,
  type ClientCapabilityServiceCallFrame,
} from '@maka/runtime-host/protocol';
import { z } from 'zod';
import { buildClientSettingsTools } from '../client-settings-tools.js';
import { browserOriginAdmission } from '../browser/browser-origin-admission.js';
import { buildRiveWorkflowTool } from '../rive-workflow-tool.js';
import { createDesktopNativeCapabilityProvider } from '../runtime-host-native-capabilities.js';

function jsonSchema(schema: Record<string, unknown>): {
  jsonSchema: Record<string, unknown>;
} {
  return { jsonSchema: schema };
}

test('publishes self-described session-affine Browser and Computer Use offers', () => {
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [tool('browser_snapshot', z.object({ includeHidden: z.boolean().optional() }), async () => 'ok')],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(async () => ({ text: 'ok' })),
    releaseComputerUseSession() {},
  });

  assert.deepEqual(
    provider.offers().map((offer) => ({
      offerId: offer.offerId,
      version: offer.version,
      affinity: offer.affinity,
      toolNames: offer.tools.map((descriptor) => descriptor.name),
      serverIds: offer.tools.map((descriptor) => descriptor.serverId),
      activityKinds: offer.tools.map((descriptor) => descriptor.activityKind),
    })),
    [
      {
        offerId: 'desktop_browser',
        version: '0',
        affinity: 'session',
        toolNames: ['browser_snapshot'],
        serverIds: ['desktop_browser'],
        activityKinds: [undefined],
      },
      {
        offerId: 'desktop_computer_use',
        version: '0',
        affinity: 'session',
        toolNames: ['maka_computer'],
        serverIds: ['desktop_computer_use'],
        activityKinds: ['computer'],
      },
    ],
  );
  const browserSchema = provider.offers()[0]?.tools[0]?.inputSchema;
  assert.equal(browserSchema?.type, 'object');
  assert.equal(browserSchema?.required, undefined);
  assert.deepEqual(Object.keys((browserSchema?.properties as object | undefined) ?? {}), ['includeHidden']);
  assert.doesNotThrow(() =>
    decodeClientCapabilityReplaceInput({
      registrationId: 'registration-1',
      offers: provider.offers(),
    }),
  );
});

test('remote providers do not request Host paths and use a Client-owned cwd', async () => {
  let invokedCwd: string | undefined;
  const provider = createDesktopNativeCapabilityProvider(
    {
      browserTools: [
        tool('browser_navigate', z.object({ url: z.string() }), async (_args, context) => {
          invokedCwd = context.cwd;
          return 'ok';
        }),
      ],
      resolveBrowserUrl: () => 'https://example.com/',
      releaseBrowserSession() {},
      computerUseTools: computerTools(),
      releaseComputerUseSession() {},
    },
    { hostPathAccess: 'none', clientCwd: '/client/runtime-host' },
  );

  assert.equal(provider.offers()[0]?.hostPathAccess, 'none');
  await call(provider, capabilityFrame({ cwd: undefined }));
  assert.equal(invokedCwd, '/client/runtime-host');
  await assert.rejects(
    () => call(provider, capabilityFrame({ cwd: '/srv/host-project' })),
    /does not accept a Host path/,
  );
});

test('publishes the real Computer Use schema through the Client Capability protocol', () => {
  const computerUseTools = buildComputerUseTools({ backend: computerBackend() });
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools,
    releaseComputerUseSession: (sessionId) => computerUseTools.clearSession(sessionId),
  });

  assert.doesNotThrow(() =>
    decodeClientCapabilityReplaceInput({
      registrationId: 'registration-1',
      offers: provider.offers(),
    }),
  );
  const actionSchema = provider.offers()[0]?.tools[0]?.inputSchema.properties as
    | Record<string, { enum?: unknown }>
    | undefined;
  assert.equal(
    Array.isArray(actionSchema?.action?.enum) &&
      actionSchema.action.enum.includes('click_element') &&
      !actionSchema.action.enum.includes('left_click'),
    true,
  );
});

test('projects and publishes jsonSchema-wrapped MCP proxy tool descriptors', () => {
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
    additionalGroups: () => [
      {
        offerId: 'desktop_mcp',
        label: 'MCP',
        description: 'MCP tools',
        tools: [
          {
            name: 'fixture_tool',
            displayName: 'fixture_tool',
            description: 'fixture_tool description',
            parameters: jsonSchema({
              $id: 'https://example.com/tool.schema.json',
              type: 'object',
              properties: {
                prefix: {
                  type: 'string',
                  default: 'ready',
                  enum: ['ready', 'done'],
                  examples: ['ready'],
                  pattern: '^[a-z]+$',
                },
              },
              patternProperties: {
                '^x-': { type: 'string' },
              },
            }),
            impl: async () => 'ok',
          },
        ],
      },
    ],
  });

  assert.doesNotThrow(() =>
    decodeClientCapabilityReplaceInput({
      registrationId: 'registration-1',
      offers: provider.offers(),
    }),
  );
  const published = provider.offers()[0]?.tools[0]?.inputSchema;
  const properties = published?.properties as
    | Record<string, { default?: unknown; enum?: unknown; examples?: unknown }>
    | undefined;
  const prefixSchema = properties?.prefix;
  assert.equal(published?.$id, undefined);
  assert.equal(prefixSchema?.default, 'ready');
  assert.deepEqual(prefixSchema?.enum, ['ready', 'done']);
  assert.deepEqual(prefixSchema?.examples, ['ready']);
  assert.deepEqual(published?.patternProperties, { '^x-': { type: 'string' } });
});

test('forwards JSON Schema native capability arguments to the MCP authority', async () => {
  let receivedArguments: unknown;
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
    additionalGroups: () => [
      {
        offerId: 'desktop_mcp',
        label: 'MCP',
        description: 'MCP tools',
        tools: [
          {
            name: 'server_validated',
            displayName: 'server_validated',
            description: 'server_validated description',
            parameters: jsonSchema({
              type: 'object',
              required: ['token'],
              properties: { token: { type: 'string' } },
            }),
            impl: async (args: unknown) => {
              receivedArguments = args;
              return 'server result';
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    await call(
      provider,
      capabilityFrame({
        offerId: 'desktop_mcp',
        serverId: 'desktop_mcp',
        toolName: 'server_validated',
        arguments: {},
      }),
    ),
    { content: [{ type: 'text', text: 'server result' }] },
  );
  assert.deepEqual(receivedArguments, {});
});

test('skips non-object root jsonSchema tools without dropping the offer', () => {
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
    additionalGroups: () => [
      {
        offerId: 'desktop_mcp',
        label: 'MCP',
        description: 'MCP tools',
        tools: [
          {
            name: 'bad_tool',
            displayName: 'bad_tool',
            description: 'bad_tool description',
            parameters: jsonSchema({
              type: 'string',
            }),
            impl: async () => 'nope',
          },
          {
            name: 'good_tool',
            displayName: 'good_tool',
            description: 'good_tool description',
            parameters: jsonSchema({
              type: 'object',
              properties: { value: { type: 'string' } },
            }),
            impl: async () => 'ok',
          },
        ],
      },
    ],
  });

  const tools = provider.offers().flatMap((offer) => offer.tools);
  assert.deepEqual(
    tools.map((descriptor) => descriptor.name),
    ['good_tool'],
  );
});

test('skips malformed record-shaped schemas without dropping healthy MCP tools', () => {
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
    additionalGroups: () => [
      {
        offerId: 'desktop_mcp',
        label: 'MCP',
        description: 'MCP tools',
        tools: [
          {
            name: 'bad_tool',
            displayName: 'bad_tool',
            description: 'bad_tool description',
            parameters: jsonSchema({ type: 'object', properties: [] as never }),
            impl: async () => 'bad',
          },
          {
            name: 'good_tool',
            displayName: 'good_tool',
            description: 'good_tool description',
            parameters: jsonSchema({
              type: 'object',
              properties: { value: { type: 'string' } },
            }),
            impl: async () => 'good',
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    provider.offers().flatMap((offer) => offer.tools).map((tool) => tool.name),
    ['good_tool'],
  );
});

test('skips unsupported schema type tools without dropping the offer', () => {
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
    additionalGroups: () => [
      {
        offerId: 'desktop_mcp',
        label: 'MCP',
        description: 'MCP tools',
        tools: [
          {
            name: 'bad_tool',
            displayName: 'bad_tool',
            description: 'bad_tool description',
            parameters: 42,
            impl: async () => 'nope',
          },
          {
            name: 'good_tool',
            displayName: 'good_tool',
            description: 'good_tool description',
            parameters: jsonSchema({
              type: 'object',
              properties: { value: { type: 'string' } },
            }),
            impl: async () => 'ok',
          },
        ],
      },
    ],
  });

  const tools = provider.offers().flatMap((offer) => offer.tools);
  assert.deepEqual(
    tools.map((descriptor) => descriptor.name),
    ['good_tool'],
  );
});

test('skips a malformed MCP tool without dropping the other offers', async () => {
  let healthyCalls = 0;
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [
      tool('browser_snapshot', z.object({}), async () => {
        healthyCalls += 1;
        return 'snapshot';
      }),
    ],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
    additionalGroups: () => [
      {
        offerId: 'desktop_mcp',
        label: 'MCP',
        description: 'MCP tools',
        tools: [
          {
            name: 'bad_tool',
            displayName: 'bad_tool',
            description: 'bad_tool description',
            parameters: jsonSchema({
              type: 'object',
              properties: { value: { type: 'string' } },
              patternProperties: { '(': { type: 'string' } },
            }),
            impl: async () => 'nope',
          },
          {
            name: 'good_tool',
            displayName: 'good_tool',
            description: 'good_tool description',
            parameters: jsonSchema({
              type: 'object',
              properties: { value: { type: 'string' } },
            }),
            impl: async () => 'ok',
          },
        ],
      },
    ],
  });

  // The malformed tool is skipped; the healthy tool stays published and
  // callable, and the empty-offer case never poisons the registration.
  const tools = provider.offers().flatMap((offer) => offer.tools);
  assert.deepEqual(
    tools.map((descriptor) => descriptor.name),
    ['browser_snapshot', 'good_tool'],
  );
  assert.doesNotThrow(() =>
    decodeClientCapabilityReplaceInput({
      registrationId: 'registration-1',
      offers: provider.offers(),
    }),
  );

  await call(
    provider,
    capabilityFrame({
      offerId: 'desktop_mcp',
      serverId: 'desktop_mcp',
      toolName: 'good_tool',
      arguments: { value: 'hello' },
    }),
  );
  await call(
    provider,
    capabilityFrame({
      offerId: 'desktop_browser',
      serverId: 'desktop_browser',
      toolName: 'browser_snapshot',
      arguments: {},
    }),
  );
  assert.equal(healthyCalls, 1);
});

test('empty allOf/anyOf/oneOf are projected away so the schema still publishes', () => {
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
    additionalGroups: () => [
      {
        offerId: 'desktop_mcp',
        label: 'MCP',
        description: 'MCP tools',
        tools: [
          {
            name: 'fixture_tool',
            displayName: 'fixture_tool',
            description: 'fixture_tool description',
            parameters: jsonSchema({
              type: 'object',
              properties: {
                x: { type: 'string', allOf: [], anyOf: [], oneOf: [] },
              },
            }),
            impl: async () => 'ok',
          },
        ],
      },
    ],
  });

  assert.doesNotThrow(() =>
    decodeClientCapabilityReplaceInput({
      registrationId: 'registration-1',
      offers: provider.offers(),
    }),
  );
  const published = provider.offers()[0]?.tools[0]?.inputSchema as
    | { properties?: { x?: Record<string, unknown> } }
    | undefined;
  const x = published?.properties?.x;
  assert.deepEqual(x, { type: 'string' });
  assert.equal(x !== undefined && 'allOf' in x, false);
  assert.equal(x !== undefined && 'anyOf' in x, false);
  assert.equal(x !== undefined && 'oneOf' in x, false);
});

test('publishes every production Desktop-owned tool schema through the protocol', () => {
  const settingsTools = buildClientSettingsTools({
    async read() {
      throw new Error('not invoked');
    },
    async update() {
      throw new Error('not invoked');
    },
    async confirm() {
      return false;
    },
  });
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
    additionalGroups: () => [
      {
        offerId: 'desktop_settings',
        label: 'Client settings',
        description: 'Client settings',
        tools: settingsTools,
      },
      {
        offerId: 'desktop_rive',
        label: 'Rive',
        description: 'Rive workflows',
        tools: [buildRiveWorkflowTool()],
      },
    ],
  });

  assert.doesNotThrow(() =>
    decodeClientCapabilityReplaceInput({
      registrationId: 'registration-1',
      offers: provider.offers(),
    }),
  );
});

test('publishes and admits additional Desktop native-effect services', async () => {
  let admitted = false;
  const provider = createDesktopNativeCapabilityProvider(
    {
      browserTools: [],
      resolveBrowserUrl: () => 'https://example.com/',
      releaseBrowserSession() {},
      computerUseTools: computerTools(),
      releaseComputerUseSession() {},
      additionalServices: (scope) => [
        {
          serviceId: 'maka_scheduled_task_native_effect',
          version: '1',
          async call(method, input) {
            return { method, id: input.id, hostId: scope.hostId };
          },
        },
      ],
    },
    { targetScope: { hostId: 'host-1', targetEpoch: 'epoch-1' } },
  );
  assert.deepEqual(provider.services?.(), [
    { serviceId: 'maka_scheduled_task_native_effect', version: '1' },
  ]);
  assert.ok(provider.callService);
  const result = await provider.callService(serviceFrame(), {
    signal: new AbortController().signal,
    accept: async () => {
      admitted = true;
    },
  });
  assert.equal(admitted, true);
  assert.deepEqual(result, { method: 'notify_local', id: 'task-1', hostId: 'host-1' });
});

test('validates before admission and invokes the exact offered tool with Host context', async () => {
  let admitted = false;
  let invoked = false;
  const resolvedUrls: string[] = [];
  let acceptedEvidence: ClientCapabilityAdmissionEvidence | undefined;
  let received:
    | {
        args: unknown;
        context: Pick<MakaToolContext, 'sessionId' | 'turnId' | 'cwd' | 'toolCallId'>;
      }
    | undefined;
  const provider = createDesktopNativeCapabilityProvider(
    {
      browserTools: [
        tool('browser_navigate', z.object({ url: z.string().url() }), async (args, context) => {
          assert.equal(admitted, true);
          assert.deepEqual(browserOriginAdmission(context.sessionId), {
            sessionId: 'host-a:session-1',
            url: 'https://example.com/path',
          });
          invoked = true;
          received = {
            args,
            context: {
              sessionId: context.sessionId,
              turnId: context.turnId,
              cwd: context.cwd,
              toolCallId: context.toolCallId,
            },
          };
          return 'Loaded';
        }),
      ],
      resolveBrowserUrl: ({ sessionId, toolName, arguments: args }) => {
        assert.equal(sessionId, 'host-a:session-1');
        assert.equal(toolName, 'browser_navigate');
        const url = String(args.url);
        resolvedUrls.push(url);
        return url;
      },
      releaseBrowserSession() {},
      computerUseTools: computerTools(),
      releaseComputerUseSession() {},
    },
    { nativeSessionId: (sessionId) => `host-a:${sessionId}` },
  );

  await assert.rejects(
    () => call(provider, capabilityFrame({ arguments: { url: 'not a url' } }), () => undefined),
    /Invalid URL/u,
  );
  assert.equal(invoked, false);
  assert.equal(admitted, false);
  assert.deepEqual(resolvedUrls, []);

  const result = await call(
    provider,
    capabilityFrame({ arguments: { url: 'https://example.com/path' } }),
    (evidence) => {
      acceptedEvidence = evidence;
      admitted = true;
    },
  );
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Loaded' }] });
  assert.deepEqual(received, {
    args: { url: 'https://example.com/path' },
    context: {
      sessionId: 'host-a:session-1',
      turnId: 'turn-1',
      cwd: '/workspace',
      toolCallId: 'tool-call-1',
    },
  });
  assert.deepEqual(acceptedEvidence, {
    kind: 'browser_url',
    url: 'https://example.com/path',
  });
  assert.deepEqual(resolvedUrls, [
    'https://example.com/path',
    'https://example.com/path',
  ]);
});

test('does not execute Browser work when its Origin changes while admission is pending', async () => {
  let resolveCount = 0;
  let invoked = false;
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [
      tool('browser_snapshot', z.object({}), async () => {
        invoked = true;
        return 'snapshot';
      }),
    ],
    resolveBrowserUrl: () =>
      resolveCount++ === 0 ? 'https://first.example/page' : 'https://second.example/page',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
  });

  await assert.rejects(
    () =>
      call(
        provider,
        capabilityFrame({ toolName: 'browser_snapshot', arguments: {} }),
      ),
    /Browser origin changed while admission was pending/u,
  );
  assert.equal(invoked, false);
});

test('watches Computer Use turns without widening Browser lifecycle', async () => {
  const usedSessions: string[] = [];
  const computerUseTurns: Array<[string, string]> = [];
  let computerUseSessionId: string | undefined;
  const provider = createDesktopNativeCapabilityProvider(
    {
      browserTools: [tool('browser_snapshot', z.object({}), async () => 'snapshot')],
      resolveBrowserUrl: () => 'https://example.com/',
      releaseBrowserSession() {},
      computerUseTools: computerTools(async (_args, context) => {
        computerUseSessionId = context.sessionId;
        return { text: 'observed' };
      }),
      releaseComputerUseSession() {},
    },
    {
      onSessionUsed: (sessionId) => usedSessions.push(sessionId),
      onComputerUseTurnUsed: (sessionId, turnId) =>
        computerUseTurns.push([sessionId, turnId]),
      nativeSessionId: (sessionId) => `host-a:${sessionId}`,
    },
  );

  await call(
    provider,
    capabilityFrame({ toolName: 'browser_snapshot', arguments: {} }),
  );
  assert.deepEqual(usedSessions, ['session-1']);
  assert.deepEqual(computerUseTurns, []);

  await call(
    provider,
    computerFrame({ sessionId: 'session-2', turnId: 'turn-2' }),
  );
  assert.deepEqual(usedSessions, ['session-1', 'session-2']);
  assert.deepEqual(computerUseTurns, [['session-2', 'turn-2']]);
  assert.equal(computerUseSessionId, 'host-a:session-2');
});

test('projects Computer Use screenshots and releases all native resources for a Session', async () => {
  const browserReleased: string[] = [];
  const computerReleased: string[] = [];
  let invocationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    invocationStarted = resolve;
  });
  const computerUseTools = computerTools(
    async (args: { wait?: boolean }, context) => {
      if (args.wait) {
        invocationStarted();
        await new Promise<never>((_resolve, reject) => {
          context.abortSignal.addEventListener('abort', () => reject(context.abortSignal.reason), {
            once: true,
          });
        });
      }
      return {
        text: 'captured',
        screenshot: { base64: 'aW1hZ2U=', mimeType: 'image/png' },
      };
    },
    (sessionId) => computerReleased.push(sessionId),
  );
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [tool('browser_snapshot', z.object({}), async () => 'snapshot')],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession: (sessionId) => {
      browserReleased.push(sessionId);
    },
    computerUseTools,
    releaseComputerUseSession: (sessionId) => computerUseTools.clearSession(sessionId),
  });

  await provider.releaseSession('manual-session');
  assert.deepEqual(browserReleased, ['manual-session']);
  assert.deepEqual(computerReleased, ['manual-session']);

  await call(
    provider,
    capabilityFrame({
      sessionId: 'browser-session',
      toolName: 'browser_snapshot',
      arguments: {},
    }),
  );
  await provider.releaseSession('browser-session');
  assert.deepEqual(browserReleased, ['manual-session', 'browser-session']);
  assert.deepEqual(computerReleased, ['manual-session', 'browser-session']);

  const completed = await call(provider, computerFrame({ sessionId: 'completed-session', arguments: {} }));
  assert.deepEqual(completed, {
    content: [
      { type: 'text', text: 'captured' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ],
  });
  await provider.releaseSession('completed-session');
  assert.deepEqual(browserReleased, ['manual-session', 'browser-session', 'completed-session']);
  assert.deepEqual(computerReleased, ['manual-session', 'browser-session', 'completed-session']);

  const inFlight = call(provider, computerFrame({ sessionId: 'active-session', arguments: { wait: true } }));
  await started;
  await provider.close();
  await assert.rejects(inFlight, /provider closed/u);
  assert.deepEqual(browserReleased, [
    'manual-session',
    'browser-session',
    'completed-session',
    'active-session',
  ]);
  assert.deepEqual(computerReleased, [
    'manual-session',
    'browser-session',
    'completed-session',
    'active-session',
  ]);
  await provider.close();
  await assert.rejects(() => call(provider, capabilityFrame()), /provider is closed/u);
});

test('does not advertise unavailable capability groups or dispatch unknown identities', async () => {
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [tool('browser_snapshot', z.object({}), async () => 'ok')],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
  });
  assert.deepEqual(
    provider.offers().map((offer) => offer.offerId),
    ['desktop_browser'],
  );

  let admitted = false;
  await assert.rejects(
    () =>
      call(provider, capabilityFrame({ serverId: 'another_client' }), () => {
        admitted = true;
      }),
    /not offered/u,
  );
  assert.equal(admitted, false);
});

test('dispatches through the same immutable tool snapshot it advertised', async () => {
  let additionalGroups = [
    {
      offerId: 'desktop_mcp',
      label: 'MCP',
      description: 'MCP tools',
      tools: [tool('old_tool', z.object({}), async () => 'old implementation')],
    },
  ];
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
    additionalGroups: () => additionalGroups,
  });
  additionalGroups = [
    {
      offerId: 'desktop_mcp',
      label: 'MCP',
      description: 'MCP tools',
      tools: [tool('new_tool', z.object({}), async () => 'new implementation')],
    },
  ];

  assert.deepEqual(provider.offers()[0]?.tools.map(({ name }) => name), [
    'old_tool',
  ]);
  assert.deepEqual(
    await call(
      provider,
      capabilityFrame({
        offerId: 'desktop_mcp',
        serverId: 'desktop_mcp',
        toolName: 'old_tool',
      }),
    ),
    { content: [{ type: 'text', text: 'old implementation' }] },
  );
  await assert.rejects(
    () =>
      call(
        provider,
        capabilityFrame({
          offerId: 'desktop_mcp',
          serverId: 'desktop_mcp',
          toolName: 'new_tool',
        }),
      ),
    /not offered/u,
  );
});

test('chunks a dynamic capability group beyond the single-offer tool limit', async () => {
  const mcpTools = Array.from({ length: 65 }, (_, index) =>
    tool(`mcp_tool_${String(index).padStart(3, '0')}`, z.object({}), async () => `tool-${index}`),
  );
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [tool('browser_snapshot', z.object({}), async () => 'ok')],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: [] as never,
    releaseComputerUseSession() {},
    additionalGroups: () => [
      {
        offerId: 'desktop_mcp',
        label: 'MCP',
        description: 'MCP tools connected by this Desktop client.',
        tools: mcpTools,
        dynamic: true,
      },
    ],
  });

  assert.deepEqual(
    provider.offers().map((offer) => [offer.offerId, offer.tools.length] as const),
    [
      ['desktop_browser', 1],
      ['desktop_mcp', 64],
      ['desktop_mcp_2', 1],
    ],
  );
  // Chunked offers keep the group's server identity.
  assert.equal(provider.offers()[2]?.tools[0]?.serverId, 'desktop_mcp');
  assert.equal(provider.offers()[2]?.tools[0]?.name, 'mcp_tool_064');
  assert.doesNotThrow(() =>
    decodeClientCapabilityReplaceInput({
      registrationId: 'registration-1',
      offers: provider.offers(),
    }),
  );
  // A tool in a later chunk dispatches through its chunk offerId.
  assert.deepEqual(
    await call(
      provider,
      capabilityFrame({
        offerId: 'desktop_mcp_2',
        serverId: 'desktop_mcp',
        toolName: 'mcp_tool_064',
        arguments: {},
      }),
    ),
    { content: [{ type: 'text', text: 'tool-64' }] },
  );
  await provider.close();
});

test('omits trailing dynamic tools beyond the manifest tool budget and keeps fixed groups', async () => {
  const diagnostics: string[] = [];
  const mcpTools = Array.from({ length: 300 }, (_, index) =>
    tool(`mcp_tool_${String(index).padStart(3, '0')}`, z.object({}), async () => 'ok'),
  );
  const provider = createDesktopNativeCapabilityProvider(
    {
      browserTools: [tool('browser_snapshot', z.object({}), async () => 'ok')],
      resolveBrowserUrl: () => 'https://example.com/',
      releaseBrowserSession() {},
      computerUseTools: [] as never,
      releaseComputerUseSession() {},
      additionalGroups: () => [
        {
          offerId: 'desktop_mcp',
          label: 'MCP',
          description: 'MCP tools connected by this Desktop client.',
          tools: mcpTools,
          dynamic: true,
        },
      ],
    },
    { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
  );

  const offers = provider.offers();
  assert.equal(offers[0]?.offerId, 'desktop_browser');
  assert.equal(offers[0]?.tools.length, 1);
  let toolCount = 0;
  for (const offer of offers) toolCount += offer.tools.length;
  assert.equal(toolCount, 256);
  assert.equal(offers.at(-1)?.tools.at(-1)?.name, 'mcp_tool_254');
  assert.doesNotThrow(() =>
    decodeClientCapabilityReplaceInput({
      registrationId: 'registration-1',
      offers,
    }),
  );
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0] ?? '', /omitted 45 MCP tool/u);
  assert.match(diagnostics[0] ?? '', /mcp_tool_255/u);
  await provider.close();
});

test('omits trailing dynamic tools beyond the manifest byte budget', () => {
  const diagnostics: string[] = [];
  const mcpTools = Array.from({ length: 80 }, (_, index) => ({
    ...tool(`mcp_tool_${String(index).padStart(3, '0')}`, z.object({}), async () => 'ok'),
    description: `mcp_tool_${index} ${'x'.repeat(1_000)}`,
  }));
  const provider = createDesktopNativeCapabilityProvider(
    {
      browserTools: [],
      resolveBrowserUrl: () => 'https://example.com/',
      releaseBrowserSession() {},
      computerUseTools: [] as never,
      releaseComputerUseSession() {},
      additionalGroups: () => [
        {
          offerId: 'desktop_mcp',
          label: 'MCP',
          description: 'MCP tools connected by this Desktop client.',
          tools: mcpTools,
          dynamic: true,
        },
      ],
    },
    { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
  );

  const offers = provider.offers();
  const kept = offers.flatMap((offer) => offer.tools.map((descriptor) => descriptor.name));
  assert.ok(kept.length > 0 && kept.length < 80);
  assert.deepEqual(
    kept,
    mcpTools.slice(0, kept.length).map((candidate) => candidate.name),
  );
  assert.doesNotThrow(() =>
    decodeClientCapabilityReplaceInput({
      registrationId: 'registration-1',
      offers,
    }),
  );
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0] ?? '', /omitted [1-9]\d* MCP tool/u);
});

test('reports dynamic tools the decoder rejects instead of dropping them silently', () => {
  const diagnostics: string[] = [];
  const provider = createDesktopNativeCapabilityProvider(
    {
      browserTools: [],
      resolveBrowserUrl: () => 'https://example.com/',
      releaseBrowserSession() {},
      computerUseTools: [] as never,
      releaseComputerUseSession() {},
      additionalGroups: () => [
        {
          offerId: 'desktop_mcp',
          label: 'MCP',
          description: 'MCP tools connected by this Desktop client.',
          dynamic: true,
          tools: [
            tool('good_tool', z.object({}), async () => 'ok'),
            {
              ...tool('bad_tool', z.object({}), async () => 'ok'),
              description: 'x'.repeat(8_193),
            },
          ],
        },
      ],
    },
    { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
  );

  assert.deepEqual(
    provider.offers()[0]?.tools.map((descriptor) => descriptor.name),
    ['good_tool'],
  );
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0] ?? '', /omitted desktop_mcp tool bad_tool/u);
  assert.match(diagnostics[0] ?? '', /Invalid description/u);
});

test('publishes identified tools under their real normalized MCP identity', async () => {
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: [] as never,
    releaseComputerUseSession() {},
    additionalGroups: () => [
      {
        offerId: 'desktop_mcp_fixture',
        label: 'MCP: fixture',
        description: 'MCP tools connected by this Desktop client.',
        dynamic: true,
        tools: [
          {
            tool: tool('mcp__fixture__echo', z.object({}), async () => 'echo result'),
            serverId: 'fixture',
            toolName: 'echo',
          },
          {
            tool: tool('mcp__my_server__run', z.object({}), async () => 'run result'),
            serverId: 'my.server',
            toolName: 'run',
          },
        ],
      },
    ],
  });

  const published = provider.offers()[0]?.tools ?? [];
  assert.equal(published[0]?.serverId, 'fixture');
  assert.equal(published[0]?.name, 'echo');
  // Unsafe identities are normalized to wire-safe entity ids.
  assert.match(published[1]?.serverId ?? '', /^my_server_[0-9a-f]{24}$/u);
  const normalizedServerId = published[1]?.serverId ?? assert.fail('Expected normalized serverId');

  assert.deepEqual(
    await call(
      provider,
      capabilityFrame({
        offerId: 'desktop_mcp_fixture',
        serverId: 'fixture',
        toolName: 'echo',
        arguments: {},
      }),
    ),
    { content: [{ type: 'text', text: 'echo result' }] },
  );
  assert.deepEqual(
    await call(
      provider,
      capabilityFrame({
        offerId: 'desktop_mcp_fixture',
        serverId: normalizedServerId,
        toolName: 'run',
        arguments: {},
      }),
    ),
    { content: [{ type: 'text', text: 'run result' }] },
  );
  await provider.close();
});

test('chunks and degrades a dynamic capability group deterministically', () => {
  const mcpTools = Array.from({ length: 70 }, (_, index) =>
    tool(`mcp_tool_${String(index).padStart(3, '0')}`, z.object({}), async () => 'ok'),
  );
  const create = () =>
    createDesktopNativeCapabilityProvider({
      browserTools: [],
      resolveBrowserUrl: () => 'https://example.com/',
      releaseBrowserSession() {},
      computerUseTools: [] as never,
      releaseComputerUseSession() {},
      additionalGroups: () => [
        {
          offerId: 'desktop_mcp',
          label: 'MCP',
          description: 'MCP tools connected by this Desktop client.',
          tools: mcpTools,
          dynamic: true,
        },
      ],
    });
  const first = create();
  const second = create();
  assert.deepEqual(first.offers(), second.offers());
});

test('fails loudly when a fixed capability group exceeds the manifest budget', () => {
  assert.throws(
    () =>
      createDesktopNativeCapabilityProvider({
        browserTools: Array.from({ length: 65 }, (_, index) =>
          tool(`browser_tool_${index}`, z.object({}), async () => 'ok'),
        ),
        resolveBrowserUrl: () => 'https://example.com/',
        releaseBrowserSession() {},
        computerUseTools: [] as never,
        releaseComputerUseSession() {},
      }),
    /Invalid Client Capability offer tools/u,
  );
});

test('reports provider retirement once after its registration is released', async () => {
  let retirements = 0;
  const provider = createDesktopNativeCapabilityProvider(
    {
      browserTools: [tool('snapshot', z.object({}), async () => 'snapshot')],
      resolveBrowserUrl: () => 'https://example.com/',
      releaseBrowserSession() {},
      computerUseTools: computerTools(),
      releaseComputerUseSession() {},
    },
    {
      onClosed: () => {
        retirements += 1;
      },
    },
  );

  await provider.close();
  await provider.close();

  assert.equal(retirements, 1);
});

test('settles every native Session cleanup before reporting a release failure', async () => {
  let resolveComputerRelease: (() => void) | undefined;
  const computerRelease = new Promise<void>((resolve) => {
    resolveComputerRelease = resolve;
  });
  let computerReleased = false;
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {
      throw new Error('browser release failed');
    },
    computerUseTools: computerTools(),
    async releaseComputerUseSession() {
      await computerRelease;
      computerReleased = true;
    },
  });

  const releasing = provider.releaseSession('session-1');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(computerReleased, false);
  resolveComputerRelease?.();
  await assert.rejects(releasing, /browser release failed/u);
  assert.equal(computerReleased, true);
});

test('forwards Host cancellation to an admitted Desktop invocation', async () => {
  let invocationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    invocationStarted = resolve;
  });
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [
      tool('browser_navigate', z.object({ url: z.string() }), async (_args, context) => {
        invocationStarted();
        await new Promise<never>((_resolve, reject) => {
          context.abortSignal.addEventListener(
            'abort',
            () => reject(context.abortSignal.reason),
            { once: true },
          );
        });
      }),
    ],
    resolveBrowserUrl: () => 'https://example.com/',
    releaseBrowserSession() {},
    computerUseTools: computerTools(),
    releaseComputerUseSession() {},
  });
  const controller = new AbortController();
  if (!provider.call) throw new Error('Expected a callable provider');
  const inFlight = provider.call(capabilityFrame(), {
    signal: controller.signal,
    accept: async () => undefined,
    requestInteraction: async () => assert.fail('Unexpected provider interaction'),
  });

  await started;
  controller.abort(new Error('Host cancelled invocation'));
  await assert.rejects(inFlight, /Host cancelled invocation/u);
});

function tool<P, R>(
  name: string,
  parameters: z.ZodType<P>,
  impl: (args: P, context: MakaToolContext) => Promise<R>,
): MakaTool<P, R> {
  return {
    name,
    displayName: name,
    description: `${name} description`,
    parameters,
    impl,
  };
}

function serviceFrame(): ClientCapabilityServiceCallFrame {
  return {
    kind: 'client.capability.service_call',
    invocationId: 'invocation-service-1',
    registrationId: 'registration-1',
    serviceId: 'maka_scheduled_task_native_effect',
    version: '1',
    method: 'notify_local',
    input: { id: 'task-1' },
  };
}

function computerTools(
  impl?: (args: { wait?: boolean }, context: MakaToolContext) => Promise<unknown>,
  clearSession: (sessionId: string) => void = () => undefined,
): ComputerUseToolSet {
  const tools = (impl
    ? [
        {
          ...tool('maka_computer', z.object({ wait: z.boolean().optional() }), impl),
          activityKind: 'computer' as const,
          toModelOutput: ({ output }: { output: unknown }) => {
            const result = output as {
              text: string;
              screenshot?: { base64: string; mimeType: string };
            };
            return {
              type: 'content' as const,
              value: [
                { type: 'text' as const, text: result.text },
                ...(result.screenshot
                  ? [
                      {
                        type: 'file' as const,
                        data: {
                          type: 'data' as const,
                          data: result.screenshot.base64,
                        },
                        mediaType: result.screenshot.mimeType,
                      },
                    ]
                  : []),
              ],
            };
          },
        },
      ]
    : []) as unknown as ComputerUseToolSet;
  tools.clearSession = clearSession;
  tools.sessionEvents = {} as ComputerUseToolSet['sessionEvents'];
  return tools;
}

function computerBackend(): CuDispatchBackend {
  return {
    async preflight() {
      return { accessibility: true, screenRecording: true };
    },
    async run() {
      return { outcome: { ok: true, tier: 'ax', verified: true } };
    },
  };
}

function capabilityFrame(overrides: Partial<ClientCapabilityCallFrame> = {}): ClientCapabilityCallFrame {
  return {
    kind: 'client.capability.call',
    invocationId: 'invocation-1',
    registrationId: 'registration-1',
    offerId: 'desktop_browser',
    serverId: 'desktop_browser',
    toolName: 'browser_navigate',
    arguments: { url: 'https://example.com' },
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    cwd: '/workspace',
    ...overrides,
  };
}

function computerFrame(overrides: Partial<ClientCapabilityCallFrame> = {}): ClientCapabilityCallFrame {
  return capabilityFrame({
    offerId: 'desktop_computer_use',
    serverId: 'desktop_computer_use',
    toolName: 'maka_computer',
    arguments: {},
    ...overrides,
  });
}

async function call(
  provider: ClientCapabilityProvider,
  frame: ClientCapabilityCallFrame,
  accept: (evidence: ClientCapabilityAdmissionEvidence) => void = () => undefined,
) {
  if (!provider.call) throw new Error('Expected a callable provider');
  return provider.call(frame, {
    signal: new AbortController().signal,
    accept: async (evidence) => accept(evidence),
    requestInteraction: async () => assert.fail('Unexpected provider interaction'),
  });
}
