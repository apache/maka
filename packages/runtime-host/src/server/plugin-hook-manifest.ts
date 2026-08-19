import { isCanonicalExtensionId } from '@maka/runtime/plugin-runtime';
import {
  type ExtensionEventDispatchMode,
  validateExtensionEventDefinition,
  validateExtensionEventListener,
} from '@maka/runtime/extension-event-contributions';
import {
  validateExtensionServiceContribution,
  type ExtensionServiceMethodDefinition,
} from '@maka/runtime/extension-service-contributions';
import { validateExtensionTimerContribution } from '@maka/runtime/extension-timer-contributions';
import {
  boundedString,
  compareString,
  exactRecord,
  optionalExactRecord,
  packagePath,
} from './plugin-runtime-manifest.js';

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export interface EventPackageManifestEvent {
  readonly name: string;
  readonly description: string;
  readonly mode: ExtensionEventDispatchMode;
  readonly payloadSchema: Readonly<Record<string, unknown>>;
  readonly resultSchema?: Readonly<Record<string, unknown>>;
}

export interface EventPackageManifestListener {
  readonly id: string;
  readonly event: string;
  readonly handler: string;
  readonly priority: number;
  readonly timeoutMs: number;
}

export interface EventPackageManifestService {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly methods: readonly ExtensionServiceMethodDefinition[];
}

export interface EventPackageManifestTimer {
  readonly id: string;
  readonly handler: string;
  readonly intervalMs: number;
  readonly initialDelayMs: number;
  readonly timeoutMs: number;
  readonly payload?: unknown;
}

export interface EventPackageManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly entry: string;
  readonly events: readonly EventPackageManifestEvent[];
  readonly listeners: readonly EventPackageManifestListener[];
  readonly services: readonly EventPackageManifestService[];
  readonly timers: readonly EventPackageManifestTimer[];
  readonly permissions: {
    readonly workspace: 'none' | 'read' | 'write';
    readonly network: boolean;
  };
}

export interface InstalledEventPackage {
  readonly extensionId: string;
  readonly root: string;
  readonly entry: string;
  readonly manifest: EventPackageManifest;
}

export class PluginHookManifestError extends Error {
  readonly name = 'PluginHookManifestError';

  constructor(
    readonly code: 'not_found' | 'invalid_package' | 'already_installed' | 'persistence_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function decodeEventPackageManifest(value: unknown): EventPackageManifest {
  const root = optionalExactRecord(value, [
    'schemaVersion',
    'id',
    'displayName',
    'description',
    'dependencies',
    'configuration',
    'runtime',
    'ui',
  ]);
  const runtime = optionalExactRecord(root.runtime, [
    'entry',
    'tools',
    'events',
    'listeners',
    'services',
    'timers',
    'permissions',
  ]);
  const record = {
    schemaVersion: root.schemaVersion,
    id: root.id,
    entry: runtime.entry,
    events: runtime.events ?? [],
    listeners: runtime.listeners ?? [],
    services: runtime.services ?? [],
    timers: runtime.timers ?? [],
    permissions: runtime.permissions,
  };
  if (record.schemaVersion !== 1) throw invalidPackage('Event package schemaVersion must be 1');
  const id = boundedString(record.id, 'Event id', 128);
  if (!isCanonicalExtensionId(id)) throw invalidPackage('Event package id is invalid');
  const entry = packagePath(record.entry, 'Event entry');
  if (!entry.endsWith('.mjs')) throw invalidPackage('Event package entry must be an .mjs file');
  if (!Array.isArray(record.events) || record.events.length > 64) {
    throw invalidPackage('Event package events must contain at most 64 definitions');
  }
  if (!Array.isArray(record.listeners) || record.listeners.length > 64) {
    throw invalidPackage('Event package listeners must contain at most 64 definitions');
  }
  const servicesSource = record.services ?? [];
  if (!Array.isArray(servicesSource) || servicesSource.length > 64) {
    throw invalidPackage('Event package services must contain at most 64 definitions');
  }
  const timersSource = record.timers ?? [];
  if (!Array.isArray(timersSource) || timersSource.length > 64) {
    throw invalidPackage('Event package timers must contain at most 64 definitions');
  }
  if (
    record.events.length === 0 &&
    record.listeners.length === 0 &&
    servicesSource.length === 0 &&
    timersSource.length === 0
  ) {
    throw invalidPackage(
      'Event package must declare at least one Event, Listener, Service, or Timer',
    );
  }
  const eventNames = new Set<string>();
  const events = record.events.map((value, index): EventPackageManifestEvent => {
    const event = optionalExactRecord(value, [
      'name',
      'description',
      'mode',
      'payloadSchema',
      'resultSchema',
    ]);
    const name = boundedString(event.name, `Event events[${index}].name`, 192);
    const description = optionalDescription(
      event.description,
      `Event events[${index}].description`,
    );
    const payloadSchema = requireJsonSchema(event.payloadSchema, name);
    const mode = (event.mode ?? 'emit') as ExtensionEventDispatchMode;
    const resultSchema =
      event.resultSchema === undefined ? undefined : requireJsonSchema(event.resultSchema, name);
    if (eventNames.has(name)) throw invalidPackage(`Event definition repeats: ${name}`);
    eventNames.add(name);
    const definition = Object.freeze({
      name,
      description,
      mode,
      payloadSchema,
      ...(resultSchema ? { resultSchema } : {}),
    });
    try {
      validateExtensionEventDefinition(id, definition);
    } catch (error) {
      throw invalidPackage(
        error instanceof Error ? error.message : `Event definition is invalid: ${name}`,
        error,
      );
    }
    return definition;
  });
  const listenerIds = new Set<string>();
  const listeners = record.listeners.map((value, index): EventPackageManifestListener => {
    const listener = optionalExactRecord(value, [
      'id',
      'event',
      'handler',
      'priority',
      'timeoutMs',
    ]);
    const listenerId = boundedString(listener.id, `Event listeners[${index}].id`, 128);
    const event = boundedString(listener.event, `Event listeners[${index}].event`, 192);
    const handler = boundedString(listener.handler, `Event listeners[${index}].handler`, 128);
    const priority = listener.priority === undefined ? 0 : listener.priority;
    const timeoutMs = listener.timeoutMs === undefined ? 3_000 : listener.timeoutMs;
    if (listenerIds.has(`${event}\0${listenerId}`))
      throw invalidPackage(`Event Listener repeats: ${event}:${listenerId}`);
    listenerIds.add(`${event}\0${listenerId}`);
    if (!ID_PATTERN.test(listenerId) || !ID_PATTERN.test(handler))
      throw invalidPackage(`Event Listener identity is invalid: ${listenerId}`);
    const contribution = {
      id: listenerId,
      event,
      handler,
      priority: priority as number,
      timeoutMs: timeoutMs as number,
      invoke: async () => undefined,
    };
    try {
      validateExtensionEventListener(contribution);
    } catch (error) {
      throw invalidPackage(
        error instanceof Error ? error.message : `Event Listener is invalid: ${listenerId}`,
        error,
      );
    }
    return Object.freeze({
      id: listenerId,
      event,
      handler,
      priority: priority as number,
      timeoutMs: timeoutMs as number,
    });
  });
  const permissions = exactRecord(record.permissions, ['workspace', 'network']);
  if (
    permissions.workspace !== 'none' &&
    permissions.workspace !== 'read' &&
    permissions.workspace !== 'write'
  ) {
    throw invalidPackage('Extension Runtime workspace permission is invalid');
  }
  if (typeof permissions.network !== 'boolean')
    throw invalidPackage('Event package network permission is invalid');
  const serviceNames = new Set<string>();
  const services = servicesSource.map((value, index): EventPackageManifestService => {
    const service = optionalExactRecord(value, ['name', 'version', 'description', 'methods']);
    const name = boundedString(service.name, `Event services[${index}].name`, 192);
    const version = boundedString(service.version, `Event services[${index}].version`, 128);
    const description = optionalDescription(
      service.description,
      `Event services[${index}].description`,
    );
    if (
      !Array.isArray(service.methods) ||
      service.methods.length === 0 ||
      service.methods.length > 64
    )
      throw invalidPackage(`Service methods are invalid: ${name}`);
    if (serviceNames.has(name)) throw invalidPackage(`Service definition repeats: ${name}`);
    serviceNames.add(name);
    const methodNames = new Set<string>();
    const methods = service.methods.map(
      (methodValue, methodIndex): ExtensionServiceMethodDefinition => {
        const method = optionalExactRecord(methodValue, [
          'name',
          'description',
          'handler',
          'inputSchema',
          'outputSchema',
          'timeoutMs',
        ]);
        const methodName = boundedString(
          method.name,
          `Event services[${index}].methods[${methodIndex}].name`,
          128,
        );
        if (methodNames.has(methodName))
          throw invalidPackage(`Service method repeats: ${name}.${methodName}`);
        methodNames.add(methodName);
        return Object.freeze({
          name: methodName,
          description: optionalDescription(method.description, `Service method description`),
          handler: boundedString(method.handler, `Service method handler`, 128),
          inputSchema: requireJsonSchema(method.inputSchema, `${name}.${methodName}.input`),
          outputSchema: requireJsonSchema(method.outputSchema, `${name}.${methodName}.output`),
          timeoutMs: (method.timeoutMs ?? 3_000) as number,
        });
      },
    );
    const contribution = {
      name,
      version,
      description,
      methods,
      invoke: async () => undefined,
    };
    try {
      validateExtensionServiceContribution(id, contribution);
    } catch (error) {
      throw invalidPackage(
        error instanceof Error ? error.message : `Service definition is invalid: ${name}`,
        error,
      );
    }
    return Object.freeze({ name, version, description, methods: Object.freeze(methods) });
  });
  const timerIds = new Set<string>();
  const timers = timersSource.map((value, index): EventPackageManifestTimer => {
    const timer = optionalExactRecord(value, [
      'id',
      'handler',
      'intervalMs',
      'initialDelayMs',
      'timeoutMs',
      'payload',
    ]);
    const id = boundedString(timer.id, `Event timers[${index}].id`, 128);
    if (timerIds.has(id)) throw invalidPackage(`Timer definition repeats: ${id}`);
    timerIds.add(id);
    const definition = Object.freeze({
      id,
      handler: boundedString(timer.handler, `Event timers[${index}].handler`, 128),
      intervalMs: (timer.intervalMs ?? 60_000) as number,
      initialDelayMs: (timer.initialDelayMs ?? timer.intervalMs ?? 60_000) as number,
      timeoutMs: (timer.timeoutMs ?? 3_000) as number,
      ...(timer.payload === undefined ? {} : { payload: structuredClone(timer.payload) }),
    });
    try {
      validateExtensionTimerContribution({
        ...definition,
        configuration: Object.freeze({}),
        invoke: async () => undefined,
      });
    } catch (error) {
      throw invalidPackage(
        error instanceof Error ? error.message : `Timer definition is invalid: ${id}`,
        error,
      );
    }
    return definition;
  });
  return Object.freeze({
    schemaVersion: 1,
    id,
    entry,
    events: Object.freeze(events.sort((left, right) => compareString(left.name, right.name))),
    listeners: Object.freeze(
      listeners.sort(
        (left, right) =>
          left.event.localeCompare(right.event) ||
          right.priority - left.priority ||
          compareString(left.id, right.id),
      ),
    ),
    services: Object.freeze(services.sort((left, right) => compareString(left.name, right.name))),
    timers: Object.freeze(timers.sort((left, right) => compareString(left.id, right.id))),
    permissions: Object.freeze({ workspace: permissions.workspace, network: permissions.network }),
  });
}

function requireJsonSchema(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidPackage(`Event payloadSchema must be an object: ${name}`);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw invalidPackage(`Event payloadSchema is not JSON: ${name}`, error);
  }
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024)
    throw invalidPackage(`Event payloadSchema is too large: ${name}`);
  return Object.freeze(structuredClone(value as Record<string, unknown>));
}

function optionalDescription(value: unknown, label: string): string {
  if (value === undefined || value === '') return '';
  return boundedString(value, label, 4096);
}

function invalidPackage(message: string, cause?: unknown): PluginHookManifestError {
  return new PluginHookManifestError('invalid_package', message, { cause });
}
