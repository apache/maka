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
  const coordinateSchema = provider.offers()[0]?.tools[0]?.inputSchema.properties as
    | Record<string, { items?: unknown }>
    | undefined;
  assert.equal(Array.isArray(coordinateSchema?.coordinate?.items), true);
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
  });
}
