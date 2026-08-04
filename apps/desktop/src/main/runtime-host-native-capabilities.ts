import { Buffer } from 'node:buffer';
import type { ComputerUseToolSet, MakaTool } from '@maka/runtime';
import type { ClientCapabilityProvider } from '@maka/runtime-host/client';
import type {
  ClientCapabilityCallFrame,
  ClientCapabilityCallResult,
  ClientCapabilityContentBlock,
  ClientCapabilityOffer,
} from '@maka/runtime-host/protocol';
import { toJSONSchema, z } from 'zod';

const CAPABILITY_VERSION = '0';
const BROWSER_OFFER_ID = 'desktop_browser';
const COMPUTER_USE_OFFER_ID = 'desktop_computer_use';

interface NativeCapabilityGroup {
  readonly offerId: string;
  readonly label: string;
  readonly description: string;
  readonly tools: readonly MakaTool[];
  readonly clearSession?: (sessionId: string) => void;
}

interface NativeToolBinding {
  readonly group: NativeCapabilityGroup;
  readonly tool: MakaTool;
}

type DesktopToolModelOutput = Awaited<ReturnType<NonNullable<MakaTool['toModelOutput']>>>;
type DesktopToolContentPart = Extract<DesktopToolModelOutput, { type: 'content' }>['value'][number];

export interface DesktopNativeCapabilityProviderInput {
  readonly browserTools: readonly MakaTool[];
  readonly computerUseTools: ComputerUseToolSet;
}

/** Adapt Desktop-owned Maka tools to the open Client Capability protocol. */
export function createDesktopNativeCapabilityProvider(
  input: DesktopNativeCapabilityProviderInput,
): ClientCapabilityProvider {
  const groups = capabilityGroups(input);
  const offers = Object.freeze(groups.map(capabilityOffer));
  const bindings = indexBindings(groups);
  const activeInvocations = new Set<AbortController>();
  const usedSessions = new Map<NativeCapabilityGroup, Set<string>>();
  let closed = false;

  return {
    offers: () => offers,
    call: async (frame, options) => {
      if (closed) throw new Error('Desktop native capability provider is closed');
      const binding = bindings.get(bindingKey(frame));
      if (!binding) throw new Error('Desktop native capability is not offered');

      const invocation = new AbortController();
      activeInvocations.add(invocation);
      const signal = AbortSignal.any([options.signal, invocation.signal]);
      try {
        signal.throwIfAborted();
        const parameters = requireZodSchema(binding.tool);
        const args = await parameters.parseAsync(frame.arguments);
        signal.throwIfAborted();
        await options.accept();
        signal.throwIfAborted();
        if (binding.group.clearSession) {
          let sessions = usedSessions.get(binding.group);
          if (!sessions) {
            sessions = new Set();
            usedSessions.set(binding.group, sessions);
          }
          sessions.add(frame.sessionId);
        }
        const output = await binding.tool.impl(args, {
          sessionId: frame.sessionId,
          turnId: frame.turnId,
          cwd: frame.cwd,
          toolCallId: frame.toolCallId,
          abortSignal: signal,
          emitOutput() {},
        });
        return projectToolResult(binding.tool, frame.toolCallId, args, output);
      } finally {
        activeInvocations.delete(invocation);
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const invocation of activeInvocations) {
        invocation.abort(new Error('Desktop native capability provider closed'));
      }
      activeInvocations.clear();
      const sessionCleanup =
        [...usedSessions].flatMap(([group, sessions]) =>
          [...sessions].map(async (sessionId) => group.clearSession?.(sessionId)),
        );
      usedSessions.clear();
      await Promise.all(sessionCleanup);
    },
  };
}

function capabilityGroups(input: DesktopNativeCapabilityProviderInput): NativeCapabilityGroup[] {
  return [
    ...(input.browserTools.length > 0
      ? [
          {
            offerId: BROWSER_OFFER_ID,
            label: 'Browser',
            description: 'Operate the embedded browser owned by this Desktop client.',
            tools: input.browserTools,
          },
        ]
      : []),
    ...(input.computerUseTools.length > 0
      ? [
          {
            offerId: COMPUTER_USE_OFFER_ID,
            label: 'Computer Use',
            description: 'Observe and operate the desktop through this Desktop client.',
            tools: input.computerUseTools,
            clearSession: (sessionId: string) => input.computerUseTools.clearSession(sessionId),
          },
        ]
      : []),
  ];
}

function capabilityOffer(group: NativeCapabilityGroup): ClientCapabilityOffer {
  return Object.freeze({
    offerId: group.offerId,
    version: CAPABILITY_VERSION,
    affinity: 'session',
    label: group.label,
    description: group.description,
    tools: Object.freeze(
      group.tools.map((tool) =>
        Object.freeze({
          serverId: group.offerId,
          name: tool.name,
          description: tool.description,
          inputSchema: toolInputSchema(tool),
          ...(tool.displayName ? { annotations: Object.freeze({ title: tool.displayName }) } : {}),
        }),
      ),
    ),
  });
}

function toolInputSchema(tool: MakaTool): Record<string, unknown> {
  const schema = toJSONSchema(requireZodSchema(tool), {
    io: 'input',
    target: 'draft-07',
    unrepresentable: 'any',
    cycles: 'ref',
    reused: 'inline',
  });
  if (schema.type !== 'object') {
    throw new Error(`Desktop native capability tool schema must be an object: ${tool.name}`);
  }
  return Object.freeze(schema);
}

function requireZodSchema(tool: MakaTool): z.ZodType {
  if (!(tool.parameters instanceof z.ZodType)) {
    throw new Error(`Desktop native capability tool has an invalid schema: ${tool.name}`);
  }
  return tool.parameters;
}

function indexBindings(groups: readonly NativeCapabilityGroup[]): Map<string, NativeToolBinding> {
  const bindings = new Map<string, NativeToolBinding>();
  for (const group of groups) {
    for (const tool of group.tools) {
      const key = bindingKey({
        offerId: group.offerId,
        serverId: group.offerId,
        toolName: tool.name,
      });
      if (bindings.has(key)) {
        throw new Error(`Duplicate Desktop native capability tool: ${group.offerId}/${tool.name}`);
      }
      bindings.set(key, { group, tool });
    }
  }
  return bindings;
}

function bindingKey(frame: Pick<ClientCapabilityCallFrame, 'offerId' | 'serverId' | 'toolName'>): string {
  return `${frame.offerId}\0${frame.serverId}\0${frame.toolName}`;
}

async function projectToolResult(
  tool: MakaTool,
  toolCallId: string,
  input: unknown,
  output: unknown,
): Promise<ClientCapabilityCallResult> {
  const modelOutput = tool.toModelOutput
    ? await tool.toModelOutput({
        toolCallId,
        input,
        output,
      })
    : undefined;
  if (!modelOutput) {
    return typeof output === 'string'
      ? { content: [{ type: 'text', text: output }] }
      : { content: [], structuredContent: output };
  }
  switch (modelOutput.type) {
    case 'text':
    case 'error-text':
      return { content: [{ type: 'text', text: modelOutput.value }] };
    case 'json':
    case 'error-json':
      return { content: [], structuredContent: modelOutput.value };
    case 'execution-denied':
      return {
        content: [{ type: 'text', text: modelOutput.reason ?? 'Execution denied' }],
      };
    case 'content':
      return { content: modelOutput.value.map(projectContentPart) };
  }
}

function projectContentPart(part: DesktopToolContentPart): ClientCapabilityContentBlock {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'file':
      if (part.data.type !== 'data') {
        throw new Error('Desktop native capability cannot return referenced or URL files');
      }
      return projectBinaryContent(part.data.data, part.mediaType);
    case 'file-data':
    case 'image-data':
      return projectBinaryContent(part.data, part.mediaType);
    default:
      throw new Error(`Desktop native capability cannot return ${part.type} content`);
  }
}

function projectBinaryContent(
  data: string | Uint8Array | ArrayBuffer | Buffer,
  mimeType: string,
): ClientCapabilityContentBlock {
  const encoded =
    typeof data === 'string'
      ? data
      : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('base64');
  if (mimeType.startsWith('image/')) return { type: 'image', data: encoded, mimeType };
  if (mimeType.startsWith('audio/')) return { type: 'audio', data: encoded, mimeType };
  throw new Error(`Desktop native capability cannot return file type ${mimeType}`);
}
