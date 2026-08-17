import { z } from 'zod';
import type { ExtensionActivationContext } from './extension-lifecycle-kernel.js';
import type { ExtensionDispatchMode } from './extension-dispatch.js';

export type ExtensionEventDispatchMode = ExtensionDispatchMode;

export interface ExtensionEventInvocationContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly permissionMode: string;
  readonly origin: 'provider' | 'code_mode' | 'host';
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
  readonly signal: AbortSignal;
  /** Host-owned recursion guard; Extension workers do not control this value. */
  readonly eventDepth?: number;
}

export interface ExtensionEventDefinition {
  readonly name: string;
  readonly description: string;
  /** Legacy definitions default to notification-style emit. */
  readonly mode?: ExtensionEventDispatchMode;
  readonly payloadSchema: Readonly<Record<string, unknown>>;
  readonly resultSchema?: Readonly<Record<string, unknown>>;
}

export interface ExtensionEventListenerContribution {
  readonly id: string;
  readonly event: string;
  readonly handler: string;
  readonly priority: number;
  readonly timeoutMs: number;
  invoke(payload: unknown, context: ExtensionEventInvocationContext): Promise<unknown>;
}

export interface ExtensionEventDefinitionInspection extends Omit<ExtensionEventDefinition, 'mode'> {
  readonly mode: ExtensionEventDispatchMode;
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly revision: string;
}

export interface ExtensionEventListenerInspection extends ExtensionEventListenerContribution {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly revision: string;
}

interface RegisteredEvent extends ExtensionEventDefinitionInspection {
  readonly token: symbol;
  readonly schema: z.ZodType;
  readonly resultValidator?: z.ZodType;
}

interface RegisteredListener extends ExtensionEventListenerInspection {
  readonly token: symbol;
}

export class ExtensionEventContributionError extends Error {
  readonly name = 'ExtensionEventContributionError';

  constructor(
    readonly code: 'invalid_event' | 'event_conflict' | 'event_not_found' | 'invalid_payload',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Lifecycle-owned registry for plugin-defined Event contracts and Listeners. */
export class ExtensionEventContributionRegistry {
  readonly #events = new Map<string, RegisteredEvent[]>();
  readonly #listeners = new Map<string, RegisteredListener[]>();

  registerEvent(
    context: ExtensionActivationContext,
    definition: ExtensionEventDefinition,
  ): () => void {
    validateExtensionEventDefinition(context.extensionId, definition);
    let schema: z.ZodType;
    let resultValidator: z.ZodType | undefined;
    try {
      schema = z.fromJSONSchema(definition.payloadSchema);
      if (definition.resultSchema) resultValidator = z.fromJSONSchema(definition.resultSchema);
    } catch (error) {
      throw new ExtensionEventContributionError(
        'invalid_event',
        `Event payload schema is unsupported: ${definition.name}`,
        { cause: error },
      );
    }
    const current = this.#events.get(context.scopeId) ?? [];
    const conflict = current.find(
      (entry) =>
        entry.name === definition.name &&
        (entry.bindingId !== context.bindingId || entry.extensionId !== context.extensionId),
    );
    if (conflict) {
      throw new ExtensionEventContributionError(
        'event_conflict',
        `Event "${definition.name}" is already provided by ${conflict.extensionId}@${conflict.revision}`,
      );
    }
    const entry: RegisteredEvent = Object.freeze({
      bindingId: context.bindingId,
      scopeId: context.scopeId,
      extensionId: context.extensionId,
      revision: context.revision,
      name: definition.name,
      description: definition.description,
      mode: definition.mode ?? 'emit',
      payloadSchema: structuredClone(definition.payloadSchema),
      ...(definition.resultSchema
        ? { resultSchema: structuredClone(definition.resultSchema) }
        : {}),
      schema,
      ...(resultValidator ? { resultValidator } : {}),
      token: Symbol(definition.name),
    });
    this.#events.set(context.scopeId, [...current, entry]);
    return () => removeRegistered(this.#events, context.scopeId, entry.token);
  }

  registerListener(
    context: ExtensionActivationContext,
    listener: ExtensionEventListenerContribution,
  ): () => void {
    validateExtensionEventListener(listener);
    const current = this.#listeners.get(context.scopeId) ?? [];
    const conflict = current.find(
      (entry) =>
        entry.event === listener.event &&
        entry.id === listener.id &&
        (entry.bindingId !== context.bindingId || entry.extensionId !== context.extensionId),
    );
    if (conflict) {
      throw new ExtensionEventContributionError(
        'event_conflict',
        `Listener "${listener.id}" for ${listener.event} is already owned by ${conflict.extensionId}@${conflict.revision}`,
      );
    }
    const entry: RegisteredListener = Object.freeze({
      bindingId: context.bindingId,
      scopeId: context.scopeId,
      extensionId: context.extensionId,
      revision: context.revision,
      ...listener,
      token: Symbol(listener.id),
    });
    this.#listeners.set(context.scopeId, [...current, entry]);
    return () => removeRegistered(this.#listeners, context.scopeId, entry.token);
  }

  inspectEvents(
    scopeIds: readonly string[],
    committed?: readonly { readonly bindingId: string; readonly revision: string }[],
  ): readonly ExtensionEventDefinitionInspection[] {
    const revisions = committedRevisions(committed);
    const resolved = new Map<string, RegisteredEvent>();
    for (const scopeId of scopeIds) {
      for (const entry of this.#events.get(scopeId) ?? []) {
        if (revisions && revisions.get(entry.bindingId) !== entry.revision) continue;
        resolved.set(entry.name, entry);
      }
    }
    return Object.freeze(
      [...resolved.values()]
        .map(({ token: _token, schema: _schema, resultValidator: _result, ...entry }) =>
          Object.freeze(entry),
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  inspectListeners(
    scopeIds: readonly string[],
    committed?: readonly { readonly bindingId: string; readonly revision: string }[],
  ): readonly ExtensionEventListenerInspection[] {
    const revisions = committedRevisions(committed);
    const resolved = new Map<string, RegisteredListener>();
    for (const scopeId of scopeIds) {
      for (const entry of this.#listeners.get(scopeId) ?? []) {
        if (revisions && revisions.get(entry.bindingId) !== entry.revision) continue;
        resolved.set(`${entry.event}\0${entry.extensionId}\0${entry.id}`, entry);
      }
    }
    return Object.freeze(
      [...resolved.values()]
        .map(({ token: _token, ...entry }) => Object.freeze(entry))
        .sort(compareListener),
    );
  }

  parsePayload(
    scopeIds: readonly string[],
    committed: readonly { readonly bindingId: string; readonly revision: string }[],
    event: string,
    payload: unknown,
  ): unknown {
    let encoded: string;
    try {
      encoded = JSON.stringify(payload);
    } catch (error) {
      throw new ExtensionEventContributionError(
        'invalid_payload',
        `Event payload is not JSON: ${event}`,
        { cause: error },
      );
    }
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 256 * 1024) {
      throw new ExtensionEventContributionError(
        'invalid_payload',
        `Event payload exceeds its size limit: ${event}`,
      );
    }
    const revisions = committedRevisions(committed)!;
    let definition: RegisteredEvent | undefined;
    for (const scopeId of scopeIds) {
      const candidate = (this.#events.get(scopeId) ?? []).find(
        (entry) => entry.name === event && revisions.get(entry.bindingId) === entry.revision,
      );
      if (candidate) definition = candidate;
    }
    if (!definition) {
      throw new ExtensionEventContributionError(
        'event_not_found',
        `Active Extension event is not defined: ${event}`,
      );
    }
    const parsed = definition.schema.safeParse(payload);
    if (!parsed.success) {
      throw new ExtensionEventContributionError(
        'invalid_payload',
        `Event payload does not match ${event}: ${z.prettifyError(parsed.error)}`,
      );
    }
    return structuredClone(parsed.data);
  }

  resolveDefinition(
    scopeIds: readonly string[],
    committed: readonly { readonly bindingId: string; readonly revision: string }[],
    event: string,
  ): ExtensionEventDefinitionInspection {
    const definition = this.#definition(scopeIds, committed, event);
    const { token: _token, schema: _schema, resultValidator: _result, ...inspection } = definition;
    return Object.freeze(inspection);
  }

  parseResult(
    scopeIds: readonly string[],
    committed: readonly { readonly bindingId: string; readonly revision: string }[],
    event: string,
    value: unknown,
  ): unknown {
    const definition = this.#definition(scopeIds, committed, event);
    const validator =
      definition.mode === 'transform' ? definition.schema : definition.resultValidator;
    if (!validator) return structuredClone(value);
    if ((definition.mode === 'parallel' || definition.mode === 'serial') && Array.isArray(value)) {
      return Object.freeze(
        value.map((item) => {
          const parsed = validator.safeParse(item);
          if (!parsed.success) {
            throw new ExtensionEventContributionError(
              'invalid_payload',
              `Event result does not match ${event}: ${z.prettifyError(parsed.error)}`,
            );
          }
          return structuredClone(parsed.data);
        }),
      );
    }
    const parsed = validator.safeParse(value);
    if (!parsed.success) {
      throw new ExtensionEventContributionError(
        'invalid_payload',
        `Event result does not match ${event}: ${z.prettifyError(parsed.error)}`,
      );
    }
    return structuredClone(parsed.data);
  }

  #definition(
    scopeIds: readonly string[],
    committed: readonly { readonly bindingId: string; readonly revision: string }[],
    event: string,
  ): RegisteredEvent {
    const revisions = committedRevisions(committed)!;
    let definition: RegisteredEvent | undefined;
    for (const scopeId of scopeIds) {
      const candidate = (this.#events.get(scopeId) ?? []).find(
        (entry) => entry.name === event && revisions.get(entry.bindingId) === entry.revision,
      );
      if (candidate) definition = candidate;
    }
    if (!definition) {
      throw new ExtensionEventContributionError(
        'event_not_found',
        `Active Extension event is not defined: ${event}`,
      );
    }
    return definition;
  }
}

export function contributeExtensionEvent(
  context: ExtensionActivationContext,
  registry: ExtensionEventContributionRegistry,
  definition: ExtensionEventDefinition,
): void {
  ownRegistration(context, `event:${definition.name}`, registry.registerEvent(context, definition));
}

export function contributeExtensionEventListener(
  context: ExtensionActivationContext,
  registry: ExtensionEventContributionRegistry,
  listener: ExtensionEventListenerContribution,
): void {
  ownRegistration(
    context,
    `listener:${listener.event}:${listener.id}`,
    registry.registerListener(context, listener),
  );
}

export function validateExtensionEventDefinition(
  extensionId: string,
  definition: ExtensionEventDefinition,
): void {
  if (!definition || typeof definition !== 'object') invalid('Event definition is required');
  if (!canonicalName(definition.name)) invalid('Event name is invalid');
  if (!definition.name.startsWith(`${extensionId}.`)) {
    invalid(`Event name must be owned by the Extension namespace: ${extensionId}.`);
  }
  if (
    typeof definition.description !== 'string' ||
    Buffer.byteLength(definition.description, 'utf8') > 4096
  ) {
    invalid('Event description is invalid');
  }
  if (!definition.payloadSchema || typeof definition.payloadSchema !== 'object') {
    invalid('Event payload schema is required');
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(definition.payloadSchema);
  } catch (error) {
    throw new ExtensionEventContributionError('invalid_event', 'Event payload schema is invalid', {
      cause: error,
    });
  }
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) invalid('Event payload schema is too large');
  const mode = definition.mode ?? 'emit';
  if (!['emit', 'parallel', 'serial', 'bail', 'transform', 'observe', 'gate'].includes(mode)) {
    invalid('Event dispatch mode is invalid');
  }
  if ((mode === 'parallel' || mode === 'serial' || mode === 'bail') && !definition.resultSchema) {
    invalid(`${mode} Event requires a result schema`);
  }
  if (definition.resultSchema) {
    let resultEncoded: string;
    try {
      resultEncoded = JSON.stringify(definition.resultSchema);
    } catch (error) {
      throw new ExtensionEventContributionError('invalid_event', 'Event result schema is invalid', {
        cause: error,
      });
    }
    if (Buffer.byteLength(resultEncoded, 'utf8') > 64 * 1024)
      invalid('Event result schema is too large');
  }
}

export function validateExtensionEventListener(listener: ExtensionEventListenerContribution): void {
  if (!listener || typeof listener !== 'object') invalid('Event Listener is required');
  if (!canonicalId(listener.id)) invalid('Event Listener id is invalid');
  if (!canonicalName(listener.event)) invalid('Event Listener event is invalid');
  if (!canonicalId(listener.handler)) invalid('Event Listener handler is invalid');
  if (!Number.isSafeInteger(listener.priority) || Math.abs(listener.priority) > 10_000) {
    invalid('Event Listener priority is invalid');
  }
  if (
    !Number.isSafeInteger(listener.timeoutMs) ||
    listener.timeoutMs < 10 ||
    listener.timeoutMs > 120_000
  ) {
    invalid('Event Listener timeout is invalid');
  }
  if (typeof listener.invoke !== 'function') invalid('Event Listener invoke function is required');
}

function ownRegistration(
  context: ExtensionActivationContext,
  id: string,
  unregister: () => void,
): void {
  try {
    context.ownEffect(id, unregister);
  } catch (error) {
    unregister();
    throw error;
  }
}

function removeRegistered<T extends { readonly token: symbol }>(
  registry: Map<string, T[]>,
  scopeId: string,
  token: symbol,
): void {
  const active = registry.get(scopeId);
  if (!active) return;
  const next = active.filter((entry) => entry.token !== token);
  if (next.length > 0) registry.set(scopeId, next);
  else registry.delete(scopeId);
}

function committedRevisions(
  committed?: readonly { readonly bindingId: string; readonly revision: string }[],
): Map<string, string> | undefined {
  return committed
    ? new Map(committed.map(({ bindingId, revision }) => [bindingId, revision]))
    : undefined;
}

function compareListener(
  left: ExtensionEventListenerInspection,
  right: ExtensionEventListenerInspection,
): number {
  return (
    left.event.localeCompare(right.event) ||
    right.priority - left.priority ||
    left.extensionId.localeCompare(right.extensionId) ||
    left.revision.localeCompare(right.revision) ||
    left.id.localeCompare(right.id)
  );
}

function canonicalId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function canonicalName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 192 &&
    /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u.test(value)
  );
}

function invalid(message: string): never {
  throw new ExtensionEventContributionError('invalid_event', message);
}
