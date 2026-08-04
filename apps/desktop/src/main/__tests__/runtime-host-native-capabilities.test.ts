import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComputerUseToolSet, MakaTool, MakaToolContext } from '@maka/runtime';
import type { ClientCapabilityProvider } from '@maka/runtime-host/client';
import type { ClientCapabilityCallFrame } from '@maka/runtime-host/protocol';
import { z } from 'zod';
import { createDesktopNativeCapabilityProvider } from '../runtime-host-native-capabilities.js';

test('publishes self-described session-affine Browser and Computer Use offers', () => {
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [tool('browser_snapshot', z.object({ includeHidden: z.boolean().optional() }), async () => 'ok')],
    computerUseTools: computerTools(async () => ({ text: 'ok' })),
  });

  assert.deepEqual(
    provider.offers().map((offer) => ({
      offerId: offer.offerId,
      version: offer.version,
      affinity: offer.affinity,
      toolNames: offer.tools.map((descriptor) => descriptor.name),
      serverIds: offer.tools.map((descriptor) => descriptor.serverId),
    })),
    [
      {
        offerId: 'desktop_browser',
        version: '0',
        affinity: 'session',
        toolNames: ['browser_snapshot'],
        serverIds: ['desktop_browser'],
      },
      {
        offerId: 'desktop_computer_use',
        version: '0',
        affinity: 'session',
        toolNames: ['maka_computer'],
        serverIds: ['desktop_computer_use'],
      },
    ],
  );
  const browserSchema = provider.offers()[0]?.tools[0]?.inputSchema;
  assert.equal(browserSchema?.type, 'object');
  assert.equal(browserSchema?.required, undefined);
  assert.deepEqual(Object.keys((browserSchema?.properties as object | undefined) ?? {}), ['includeHidden']);
});

test('validates before admission and invokes the exact offered tool with Host context', async () => {
  let admitted = false;
  let invoked = false;
  let received:
    | {
        args: unknown;
        context: Pick<MakaToolContext, 'sessionId' | 'turnId' | 'cwd' | 'toolCallId'>;
      }
    | undefined;
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [
      tool('browser_navigate', z.object({ url: z.string().url() }), async (args, context) => {
        assert.equal(admitted, true);
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
    computerUseTools: computerTools(),
  });

  await assert.rejects(
    () => call(provider, capabilityFrame({ arguments: { url: 'not a url' } }), () => undefined),
    /Invalid URL/u,
  );
  assert.equal(invoked, false);
  assert.equal(admitted, false);

  const result = await call(provider, capabilityFrame({ arguments: { url: 'https://example.com' } }), () => {
    admitted = true;
  });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Loaded' }] });
  assert.deepEqual(received, {
    args: { url: 'https://example.com' },
    context: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      cwd: '/workspace',
      toolCallId: 'tool-call-1',
    },
  });
});

test('projects Computer Use screenshots and releases only sessions used by that group', async () => {
  const cleared: string[] = [];
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
    (sessionId) => cleared.push(sessionId),
  );
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [tool('browser_snapshot', z.object({}), async () => 'snapshot')],
    computerUseTools,
  });

  const completed = await call(provider, computerFrame({ sessionId: 'completed-session', arguments: {} }));
  assert.deepEqual(completed, {
    content: [
      { type: 'text', text: 'captured' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ],
  });

  const inFlight = call(provider, computerFrame({ sessionId: 'active-session', arguments: { wait: true } }));
  await started;
  await provider.close?.();
  await assert.rejects(inFlight, /provider closed/u);
  assert.deepEqual(cleared.sort(), ['active-session', 'completed-session']);
  await provider.close?.();
  assert.deepEqual(cleared.sort(), ['active-session', 'completed-session']);
  await assert.rejects(() => call(provider, capabilityFrame()), /provider is closed/u);
});

test('does not advertise unavailable capability groups or dispatch unknown identities', async () => {
  const provider = createDesktopNativeCapabilityProvider({
    browserTools: [tool('browser_snapshot', z.object({}), async () => 'ok')],
    computerUseTools: computerTools(),
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
    computerUseTools: computerTools(),
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

function computerTools(
  impl?: (args: { wait?: boolean }, context: MakaToolContext) => Promise<unknown>,
  clearSession: (sessionId: string) => void = () => undefined,
): ComputerUseToolSet {
  const tools = (impl
    ? [
        {
          ...tool('maka_computer', z.object({ wait: z.boolean().optional() }), impl),
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
  accept: () => void = () => undefined,
) {
  if (!provider.call) throw new Error('Expected a callable provider');
  return provider.call(frame, {
    signal: new AbortController().signal,
    accept: async () => accept(),
  });
}
