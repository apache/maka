import type { StorageRootKind } from '@maka/storage/root-authority';
import type { RuntimeHostCompositionFactory } from './host-kernel.js';
import { INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID } from '../protocol/index.js';
import {
  createUnavailableDomainOperationHandlers,
  type DomainOperationHandlerMap,
} from './operation-dispatcher.js';

const COMPOSITION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const moduleDrainFailures = new WeakMap<RuntimeHostDomainModule, unknown[]>();

export interface HostCompositionDescriptor {
  readonly id: string;
  readonly revision: string;
}

export const HOST_RECOVERY_PHASES = [
  'state',
  'resources',
  'executions',
  'domains',
  'schedulers',
] as const;

export type HostRecoveryPhase = (typeof HOST_RECOVERY_PHASES)[number];

export interface RuntimeHostDomainModule {
  readonly id: string;
  readonly handlers: Partial<DomainOperationHandlerMap>;
  recover(phase: HostRecoveryPhase): Promise<void>;
  beginDrain(): void;
  close(): Promise<void>;
  releaseConnection?(connectionId: string): void;
}

export interface RuntimeHostDomainModuleDefinition {
  readonly id: string;
  readonly handlers?: readonly Partial<DomainOperationHandlerMap>[];
  readonly recovery?: Partial<Record<HostRecoveryPhase, () => void | Promise<void>>>;
  readonly drain?: readonly (() => void)[];
  readonly close?: readonly (() => void | Promise<void> | undefined)[];
  readonly releaseConnection?: readonly ((connectionId: string) => void)[];
}

export function createRuntimeHostDomainModule(
  definition: RuntimeHostDomainModuleDefinition,
): RuntimeHostDomainModule {
  assertModuleId(definition.id);
  const handlers = mergeModuleHandlers(definition.id, definition.handlers ?? []);
  const recovery = { ...definition.recovery };
  const drain = [...(definition.drain ?? [])];
  const close = [...(definition.close ?? [])];
  const releaseConnection = [...(definition.releaseConnection ?? [])];
  const drainFailures: unknown[] = [];
  let draining = false;
  let closeTask: Promise<void> | undefined;
  return Object.freeze({
    id: definition.id,
    handlers: Object.freeze(handlers),
    recover: async (phase: HostRecoveryPhase) => {
      await recovery[phase]?.();
    },
    beginDrain: () => {
      if (draining) return;
      draining = true;
      for (const begin of drain) {
        try {
          begin();
        } catch (error) {
          drainFailures.push(error);
        }
      }
    },
    close: () => {
      closeTask ??= closeModuleResources(definition.id, close, drainFailures);
      return closeTask;
    },
    ...(releaseConnection.length > 0
      ? {
          releaseConnection: (connectionId: string) => {
            for (const release of releaseConnection) release(connectionId);
          },
        }
      : {}),
  });
}

export function composeRuntimeHostDomainHandlers(
  modules: readonly RuntimeHostDomainModule[],
): DomainOperationHandlerMap {
  assertUniqueModules(modules);
  const handlers = createUnavailableDomainOperationHandlers();
  const claimed = new Set<string>();
  for (const module of modules) {
    for (const [operation, handler] of Object.entries(module.handlers)) {
      if (claimed.has(operation)) {
        throw new Error(`Duplicate Runtime Host operation handler: ${operation}`);
      }
      if (typeof handler !== 'function' || !Object.hasOwn(handlers, operation)) {
        throw new Error(`Invalid Runtime Host operation handler: ${operation}`);
      }
      claimed.add(operation);
      Object.assign(handlers, { [operation]: handler });
    }
  }
  return handlers;
}

export async function recoverRuntimeHostDomainModules(
  modules: readonly RuntimeHostDomainModule[],
): Promise<void> {
  assertUniqueModules(modules);
  for (const phase of HOST_RECOVERY_PHASES) {
    for (const module of modules) await module.recover(phase);
  }
}

export function beginRuntimeHostDomainModuleDrain(
  modules: readonly RuntimeHostDomainModule[],
): void {
  assertUniqueModules(modules);
  for (const module of [...modules].reverse()) {
    try {
      module.beginDrain();
    } catch (error) {
      const failures = moduleDrainFailures.get(module) ?? [];
      failures.push(error);
      moduleDrainFailures.set(module, failures);
    }
  }
}

export async function closeRuntimeHostDomainModules(
  modules: readonly RuntimeHostDomainModule[],
): Promise<void> {
  assertUniqueModules(modules);
  const errors: unknown[] = [];
  for (const module of [...modules].reverse()) {
    errors.push(...(moduleDrainFailures.get(module) ?? []));
    moduleDrainFailures.delete(module);
    try {
      await module.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Unable to close every Runtime Host Domain Module');
  }
}

function assertUniqueModules(modules: readonly RuntimeHostDomainModule[]): void {
  const ids = new Set<string>();
  for (const module of modules) {
    assertModuleId(module.id);
    if (ids.has(module.id)) throw new Error(`Duplicate Runtime Host Domain Module: ${module.id}`);
    ids.add(module.id);
  }
}

function assertModuleId(id: string): void {
  if (!MODULE_ID_PATTERN.test(id) || id.length > 64) {
    throw new TypeError('Runtime Host Domain Module id is invalid');
  }
}

function mergeModuleHandlers(
  moduleId: string,
  groups: readonly Partial<DomainOperationHandlerMap>[],
): Partial<DomainOperationHandlerMap> {
  const handlers: Partial<DomainOperationHandlerMap> = {};
  for (const group of groups) {
    for (const [operation, handler] of Object.entries(group)) {
      if (Object.hasOwn(handlers, operation)) {
        throw new Error(`Duplicate Runtime Host operation handler in ${moduleId}: ${operation}`);
      }
      Object.assign(handlers, { [operation]: handler });
    }
  }
  return handlers;
}

async function closeModuleResources(
  moduleId: string,
  resources: readonly (() => void | Promise<void> | undefined)[],
  priorFailures: readonly unknown[],
): Promise<void> {
  const errors: unknown[] = [...priorFailures];
  for (const close of resources) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Unable to close Runtime Host ${moduleId} module`);
  }
}

export interface RuntimeHostCompositionSource<K extends StorageRootKind = 'interactive'> {
  readonly descriptor: HostCompositionDescriptor;
  readonly create: RuntimeHostCompositionFactory<K>;
}

export function defineRuntimeHostComposition<K extends StorageRootKind>(
  descriptor: HostCompositionDescriptor,
  create: RuntimeHostCompositionFactory<K>,
): RuntimeHostCompositionSource<K> {
  return Object.freeze({
    descriptor: normalizeHostCompositionDescriptor(descriptor),
    create,
  });
}

export function defineInteractiveRuntimeHostComposition(
  create: RuntimeHostCompositionFactory<'interactive'>,
): RuntimeHostCompositionSource<'interactive'> {
  return defineRuntimeHostComposition(INTERACTIVE_HOST_COMPOSITION_DESCRIPTOR, create);
}

export function normalizeHostCompositionDescriptor(
  descriptor: HostCompositionDescriptor,
): HostCompositionDescriptor {
  if (!COMPOSITION_ID_PATTERN.test(descriptor.id) || descriptor.id.length > 128) {
    throw new TypeError('Runtime Host composition id is invalid');
  }
  if (
    descriptor.revision.length === 0 ||
    descriptor.revision.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(descriptor.revision)
  ) {
    throw new TypeError('Runtime Host composition revision is invalid');
  }
  return Object.freeze({
    id: descriptor.id,
    revision: descriptor.revision,
  });
}

export const INTERACTIVE_HOST_COMPOSITION_DESCRIPTOR = normalizeHostCompositionDescriptor({
  id: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  revision: '3',
});
