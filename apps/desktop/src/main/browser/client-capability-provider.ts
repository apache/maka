import type { MakaTool } from '@maka/runtime';
import type { ClientCapabilityProvider } from '@maka/runtime-host/client';
import type { ClientCapabilityOffer } from '@maka/runtime-host/protocol';
import { toJSONSchema } from 'zod';
import { buildBrowserTools } from './browser-tools.js';
import { releaseBrowserAutomationSession } from './session.js';

/** Desktop's Browser offer for the open-world Client Capability protocol. */
export function createDesktopBrowserCapabilityProvider(): ClientCapabilityProvider {
  const tools = buildBrowserTools();
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const touchedSessions = new Set<string>();
  const offer: ClientCapabilityOffer = {
    offerId: 'desktop_browser',
    version: '0',
    affinity: 'session',
    label: 'Browser',
    description:
      'Observe and operate the conversation embedded browser through snapshot-based references.',
    tools: tools.map(browserToolDescriptor),
  };
  return {
    offers: () => [offer],
    call: async (frame, { signal, accept }) => {
      if (frame.offerId !== offer.offerId || frame.serverId !== offer.offerId) {
        throw new Error('Client Capability call does not match the Desktop Browser offer');
      }
      const tool = toolsByName.get(frame.toolName);
      if (!tool) throw new Error('Desktop Browser tool is unavailable');
      touchedSessions.add(frame.sessionId);
      await accept();
      const output = await tool.impl(frame.arguments, {
        sessionId: frame.sessionId,
        turnId: frame.turnId,
        cwd: frame.cwd,
        toolCallId: frame.toolCallId,
        abortSignal: signal,
        emitOutput: () => undefined,
      });
      return {
        content: [
          {
            type: 'text',
            text: typeof output === 'string' ? output : safeJsonStringify(output),
          },
        ],
      };
    },
    close: async () => {
      const sessions = [...touchedSessions];
      touchedSessions.clear();
      await Promise.all(sessions.map((sessionId) => releaseBrowserAutomationSession(sessionId)));
    },
  };
}

function browserToolDescriptor(tool: MakaTool): ClientCapabilityOffer['tools'][number] {
  return {
    serverId: 'desktop_browser',
    name: tool.name,
    description: tool.description,
    inputSchema: toolInputSchema(tool.parameters),
    ...(tool.displayName ? { annotations: { title: tool.displayName } } : {}),
  };
}

function toolInputSchema(parameters: unknown): Record<string, unknown> {
  const schema = toJSONSchema(parameters as never, {
    io: 'input',
    target: 'draft-07',
    unrepresentable: 'any',
    cycles: 'ref',
    reused: 'inline',
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return JSON.stringify({ value: String(value) });
  }
}
