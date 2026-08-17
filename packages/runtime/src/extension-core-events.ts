import type { ExtensionDispatchMode } from './extension-dispatch.js';

export const EXTENSION_CORE_EVENTS = Object.freeze({
  'maka.agent.pre-step': 'transform',
  'maka.user-prompt.submit': 'transform',
  'maka.agent.request': 'transform',
  'maka.tools.execute': 'around',
  'maka.llm.stream': 'around',
  'maka.agent.request-error': 'bail',
  'maka.system-prompt.assemble': 'transform',
  'maka.agent.turn-stopping': 'bail',
  'maka.session.created': 'observe',
  'maka.session.event': 'observe',
  'maka.session.flush': 'observe',
  'maka.session.disposed': 'observe',
  'maka.agent.status': 'observe',
  'maka.subagent.start': 'observe',
  'maka.subagent.end': 'observe',
} satisfies Readonly<Record<string, ExtensionDispatchMode>>);

export type ExtensionCoreEventName = keyof typeof EXTENSION_CORE_EVENTS;

export function isExtensionCoreEventName(value: string): value is ExtensionCoreEventName {
  return Object.hasOwn(EXTENSION_CORE_EVENTS, value);
}

export function validateExtensionCoreEventPayload(
  event: ExtensionCoreEventName,
  payload: unknown,
): unknown {
  if (EXTENSION_CORE_EVENTS[event] === 'around') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Core Extension Event payload must be an object: ${event}`);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(payload);
  } catch (error) {
    throw new Error(`Core Extension Event payload must be JSON serializable: ${event}`, {
      cause: error,
    });
  }
  if (Buffer.byteLength(encoded, 'utf8') > 8 * 1024 * 1024) {
    throw new Error(`Core Extension Event payload exceeds its size limit: ${event}`);
  }
  const record = payload as Record<string, unknown>;
  if (event === 'maka.system-prompt.assemble' && typeof record.prompt !== 'string') {
    throw new Error('system-prompt/assemble payload requires prompt');
  }
  return structuredClone(payload);
}
