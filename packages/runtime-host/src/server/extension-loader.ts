import { isCanonicalExtensionId } from '@maka/runtime/plugin-runtime';
import type {
  ExtensionConfigurationScalar,
  ExtensionPackageContractProjection,
  TrustedExtensionProjection,
} from '../protocol/index.js';
import type {
  HostExtensionInput,
  HostPreparedPluginPackageInput,
  HostToolExtensionInput,
  HostTrustedToolExtensionInput,
  HostUiExtensionInput,
} from './extension-runtime.js';
import type { ExtensionEventInvocationContext } from '@maka/runtime/extension-event-contributions';
import type { ExtensionServiceInvocationContext } from '@maka/runtime/extension-service-contributions';
import type {
  PackageInvocationContext,
  PackageServiceCaller,
} from './in-process-package-runtime.js';
import { InProcessPackageActivation } from './in-process-package-runtime.js';
import { PluginHookActivation } from './plugin-hook-activation.js';
import { type InstalledEventPackage } from './plugin-hook-manifest.js';
import { type InstalledToolPackage } from './plugin-runtime-manifest.js';
import { type InstalledUiPackage } from './plugin-ui-manifest.js';
import { UiPackageService } from './ui-package-service.js';
import { dirname, join } from 'node:path';
import { exportExtensionBundle, materializeExtensionPackage } from './extension-bundle.js';
import { type ExtensionPackageManifest } from './extension-package-manifest.js';
import {
  type InstalledPluginPackage,
  PluginPackageStore,
  PluginPackageStoreError,
} from './plugin-package-store.js';

export type StaticTrustedToolExtension = HostTrustedToolExtensionInput;

export class HostExtensionLoaderError extends Error {
  readonly name = 'HostExtensionLoaderError';

  constructor(
    readonly code: 'not_found' | 'invalid_definition' | 'load_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface HostTrustedToolExtensionLoader {
  list(): Promise<readonly TrustedExtensionProjection[]>;
  load(extensionId: string): Promise<HostExtensionInput>;
  installPackage?(sourcePath: string): Promise<TrustedExtensionProjection>;
  uninstallPackage?(extensionId: string): Promise<void>;
  contracts?(): Promise<readonly ExtensionPackageContractProjection[]>;
  exportPackage?(extensionId: string, targetPath: string): Promise<void>;
  setConfigurationResolver?(
    resolver: (entryId: string) => Readonly<Record<string, ExtensionConfigurationScalar>>,
  ): void;
  setEventEmitter?(
    emitter: (
      scopeId: string,
      event: string,
      payload: unknown,
      context: ExtensionEventInvocationContext,
    ) => Promise<unknown>,
  ): void;
  setServiceCaller?(
    caller: (
      scopeId: string,
      service: string,
      method: string,
      input: unknown,
      context: ExtensionServiceInvocationContext,
    ) => Promise<unknown>,
  ): void;
  setUiStatePublisher?(
    publisher: (extensionId: string, key: string, value: unknown) => Promise<void>,
  ): void;
}

/**
 * Loader for Tools explicitly registered by the trusted Host composition.
 *
 * It never resolves a path or executes workspace code. Installed trusted
 * packages use the same lifecycle registry but a dynamic in-process loader.
 */
export class StaticTrustedToolExtensionLoader implements HostTrustedToolExtensionLoader {
  readonly #definitions = new Map<string, HostTrustedToolExtensionInput>();
  readonly #catalog: readonly TrustedExtensionProjection[];

  constructor(definitions: readonly StaticTrustedToolExtension[] = []) {
    for (const definition of definitions) {
      assertDefinition(definition);
      const key = definition.extensionId;
      if (this.#definitions.has(key)) {
        throw new HostExtensionLoaderError(
          'invalid_definition',
          `Trusted Extension is registered more than once: ${key}`,
        );
      }
      this.#definitions.set(key, freezeDefinition(definition));
    }
    this.#catalog = Object.freeze(
      [...this.#definitions.values()]
        .map((definition) =>
          Object.freeze({
            extensionId: definition.extensionId,
            toolNames: Object.freeze(definition.tools.map(({ name }) => name).sort(compareString)),
            uiContributionIds: Object.freeze([]),
            eventContributionIds: Object.freeze([]),
          }),
        )
        .sort((left, right) => compareString(left.extensionId, right.extensionId)),
    );
  }

  async list(): Promise<readonly TrustedExtensionProjection[]> {
    return this.#catalog;
  }

  async load(extensionId: string): Promise<HostTrustedToolExtensionInput> {
    const definition = this.#definitions.get(extensionId);
    if (!definition) {
      throw new HostExtensionLoaderError(
        'not_found',
        `Trusted Extension is not available: ${extensionId}`,
      );
    }
    return definition;
  }

  async contracts(): Promise<readonly ExtensionPackageContractProjection[]> {
    return Object.freeze(
      [...this.#definitions.values()]
        .map((definition) =>
          Object.freeze({
            extensionId: definition.extensionId,
            displayName: definition.extensionId,
            description: '',
            dependencies: Object.freeze(
              (definition.dependencies ?? []).map(({ extensionId: id }) => Object.freeze({ id })),
            ),
            configuration: Object.freeze({
              properties: Object.freeze({}),
              required: Object.freeze([]),
            }),
            contributions: Object.freeze(
              definition.tools.map((tool) =>
                Object.freeze({
                  kind: 'tool' as const,
                  id: tool.name,
                  name: tool.name,
                  description: tool.description,
                }),
              ),
            ),
          }),
        )
        .sort((left, right) => compareString(left.extensionId, right.extensionId)),
    );
  }
}

/** Combines Host-composed static Tools with real packages installed in the root-private Store. */
export class InstalledPluginPackageLoader implements HostTrustedToolExtensionLoader {
  #configurationFor: (entryId: string) => Readonly<Record<string, ExtensionConfigurationScalar>> =
    () => Object.freeze({});
  #emitEvent: (
    scopeId: string,
    event: string,
    payload: unknown,
    context: ExtensionEventInvocationContext,
  ) => Promise<unknown> = async () => {
    throw new Error('Extension Event emission is unavailable');
  };
  #callService: (
    scopeId: string,
    service: string,
    method: string,
    input: unknown,
    context: ExtensionServiceInvocationContext,
  ) => Promise<unknown> = async () => {
    throw new Error('Extension Service calls are unavailable');
  };
  #publishUiState: (extensionId: string, key: string, value: unknown) => Promise<void> = async () =>
    undefined;

  constructor(
    private readonly statics: StaticTrustedToolExtensionLoader,
    private readonly packages: PluginPackageStore,
  ) {}

  setConfigurationResolver(
    resolver: (entryId: string) => Readonly<Record<string, ExtensionConfigurationScalar>>,
  ): void {
    this.#configurationFor = resolver;
  }

  setEventEmitter(
    emitter: (
      scopeId: string,
      event: string,
      payload: unknown,
      context: ExtensionEventInvocationContext,
    ) => Promise<unknown>,
  ): void {
    this.#emitEvent = emitter;
  }

  setServiceCaller(
    caller: (
      scopeId: string,
      service: string,
      method: string,
      input: unknown,
      context: ExtensionServiceInvocationContext,
    ) => Promise<unknown>,
  ): void {
    this.#callService = caller;
  }

  setUiStatePublisher(
    publisher: (extensionId: string, key: string, value: unknown) => Promise<void>,
  ): void {
    this.#publishUiState = publisher;
  }

  async list(): Promise<readonly TrustedExtensionProjection[]> {
    const combined = [...(await this.statics.list())];
    for (const installed of await this.packages.list()) {
      combined.push(projectPluginPackage(installed));
    }
    const keys = new Set<string>();
    for (const item of combined) {
      const key = item.extensionId;
      if (keys.has(key)) {
        throw new HostExtensionLoaderError(
          'invalid_definition',
          `Plugin exists in both static and installed catalogs: ${item.extensionId}`,
        );
      }
      keys.add(key);
    }
    return Object.freeze(combined.sort(compareExtension));
  }

  async load(extensionId: string): Promise<HostExtensionInput> {
    try {
      return await this.statics.load(extensionId);
    } catch (error) {
      if (!(error instanceof HostExtensionLoaderError) || error.code !== 'not_found') throw error;
    }
    const installed = await this.#load(extensionId);
    const { tool, ui, event } = packageViews(installed);
    return combinedPackageInput({
      tool,
      ui: ui
        ? {
            installed: ui,
            store: {
              readDocument: (_package, path) => this.packages.readText(installed, path),
            },
          }
        : undefined,
      event,
      metadata: installed.manifest,
      configurationFor: this.#configurationFor,
      emitEvent: (...args) => this.#emitEvent(...args),
      callService: (...args) => this.#callService(...args),
      publishUiState: (...args) => this.#publishUiState(...args),
    });
  }

  async installPackage(sourcePath: string): Promise<TrustedExtensionProjection> {
    const materialized = await materializeExtensionPackage(
      sourcePath,
      dirname(this.packages.root),
    ).catch((error) => {
      throw translatePackageError(error);
    });
    try {
      const installed = await this.packages.install(materialized.root);
      const staticConflict = (await this.statics.list()).some(
        (item) => item.extensionId === installed.extensionId,
      );
      if (staticConflict) {
        await this.packages.uninstall(installed.extensionId).catch(() => undefined);
        throw new HostExtensionLoaderError(
          'invalid_definition',
          `Installed package conflicts with a static Extension: ${installed.extensionId}`,
        );
      }
      return projectPluginPackage(installed);
    } catch (error) {
      throw translatePackageError(error);
    } finally {
      await materialized.dispose();
    }
  }

  async contracts(): Promise<readonly ExtensionPackageContractProjection[]> {
    const contracts = [...(await this.statics.contracts())];
    for (const installed of await this.packages.list()) {
      const { tool, ui, event } = packageViews(installed);
      contracts.push(projectContract(tool, ui, event, installed.manifest));
    }
    return Object.freeze(
      contracts.sort((left, right) => compareString(left.extensionId, right.extensionId)),
    );
  }

  async exportPackage(extensionId: string, targetPath: string): Promise<void> {
    const installed = await this.#load(extensionId);
    await exportExtensionBundle(installed.root, targetPath).catch((error) => {
      throw translatePackageError(error);
    });
  }

  async uninstallPackage(extensionId: string): Promise<void> {
    const staticExtension = (await this.statics.list()).some(
      (item) => item.extensionId === extensionId,
    );
    if (staticExtension) {
      throw new HostExtensionLoaderError(
        'invalid_definition',
        `Static Tool Extensions cannot be uninstalled: ${extensionId}`,
      );
    }
    try {
      await this.packages.uninstall(extensionId);
    } catch (error) {
      throw translatePackageError(error);
    }
  }

  async #load(extensionId: string): Promise<InstalledPluginPackage> {
    try {
      return await this.packages.load(extensionId);
    } catch (error) {
      throw translatePackageError(error);
    }
  }
}

function packageViews(installed: InstalledPluginPackage): {
  readonly tool?: InstalledToolPackage;
  readonly ui?: InstalledUiPackage;
  readonly event?: InstalledEventPackage;
} {
  return Object.freeze({
    ...(installed.toolManifest
      ? {
          tool: Object.freeze({
            extensionId: installed.extensionId,
            root: installed.root,
            entry: join(installed.root, ...installed.toolManifest.entry.split('/')),
            manifest: installed.toolManifest,
          }),
        }
      : {}),
    ...(installed.uiManifest
      ? {
          ui: Object.freeze({
            extensionId: installed.extensionId,
            root: installed.root,
            manifest: installed.uiManifest,
          }),
        }
      : {}),
    ...(installed.eventManifest
      ? {
          event: Object.freeze({
            extensionId: installed.extensionId,
            root: installed.root,
            entry: join(installed.root, ...installed.eventManifest.entry.split('/')),
            manifest: installed.eventManifest,
          }),
        }
      : {}),
  });
}

function projectPluginPackage(installed: InstalledPluginPackage): TrustedExtensionProjection {
  const { tool, ui, event } = packageViews(installed);
  const projections = [
    tool ? projectPackage(tool) : undefined,
    ui ? projectUiPackage(ui) : undefined,
    event ? projectEventPackage(event) : undefined,
  ].filter((item): item is TrustedExtensionProjection => Boolean(item));
  return projections.reduce(mergeProjection);
}

function projectPackage(installed: InstalledToolPackage): TrustedExtensionProjection {
  return Object.freeze({
    extensionId: installed.extensionId,
    toolNames: Object.freeze(installed.manifest.tools.map(({ name }) => name).sort(compareString)),
    uiContributionIds: Object.freeze([]),
    eventContributionIds: Object.freeze([]),
  });
}

async function uiPackageInput(
  store: {
    readDocument(installed: InstalledUiPackage, path: string): Promise<string>;
  },
  installed: InstalledUiPackage,
  metadata?: ExtensionPackageManifest,
): Promise<HostUiExtensionInput> {
  const service = new UiPackageService();
  return Object.freeze({
    extensionId: installed.extensionId,
    ...(metadata?.dependencies.length
      ? {
          dependencies: Object.freeze(
            metadata.dependencies.map(({ id: extensionId }) => Object.freeze({ extensionId })),
          ),
        }
      : {}),
    ui: Object.freeze(
      await Promise.all(
        installed.manifest.ui.map(async (item) =>
          Object.freeze({
            id: item.id,
            surface: item.surface,
            ...(item.slot ? { slot: item.slot } : {}),
            slots: item.slots,
            priority: item.priority,
            document: await store.readDocument(installed, item.document),
            network: installed.manifest.permissions.network,
            hostState: installed.manifest.permissions.hostState,
            hostMethods: Object.freeze(
              installed.manifest.host?.methods.map(({ name }) => name) ?? [],
            ),
            sessionAccess:
              installed.manifest.permissions.sessionAccess && item.surface === 'app.root',
          }),
        ),
      ),
    ),
    healthCheck: () => service.healthCheck(installed),
  });
}

function projectUiPackage(installed: InstalledUiPackage): TrustedExtensionProjection {
  return Object.freeze({
    extensionId: installed.extensionId,
    toolNames: Object.freeze([]),
    uiContributionIds: Object.freeze(installed.manifest.ui.map(({ id }) => id).sort(compareString)),
    eventContributionIds: Object.freeze([]),
  });
}

function projectEventPackage(installed: InstalledEventPackage): TrustedExtensionProjection {
  return Object.freeze({
    extensionId: installed.extensionId,
    toolNames: Object.freeze([]),
    uiContributionIds: Object.freeze([]),
    eventContributionIds: Object.freeze(
      [
        ...installed.manifest.events.map(({ name }) => `event:${name}`),
        ...installed.manifest.listeners.map(({ event, id }) => `listener:${event}:${id}`),
      ].sort(compareString),
    ),
    ...(installed.manifest.services.length
      ? {
          serviceContributionIds: Object.freeze(
            installed.manifest.services.map(({ name }) => name).sort(compareString),
          ),
        }
      : {}),
    ...(installed.manifest.timers.length
      ? {
          timerContributionIds: Object.freeze(
            installed.manifest.timers.map(({ id }) => id).sort(compareString),
          ),
        }
      : {}),
  });
}

async function combinedPackageInput(input: {
  readonly tool?: InstalledToolPackage;
  readonly ui?: {
    readonly installed: InstalledUiPackage;
    readonly store: {
      readDocument(installed: InstalledUiPackage, path: string): Promise<string>;
    };
  };
  readonly event?: InstalledEventPackage;
  readonly metadata?: ExtensionPackageManifest;
  readonly configurationFor: (
    entryId: string,
  ) => Readonly<Record<string, ExtensionConfigurationScalar>>;
  readonly emitEvent: (
    scopeId: string,
    event: string,
    payload: unknown,
    context: ExtensionEventInvocationContext,
  ) => Promise<unknown>;
  readonly callService: (
    scopeId: string,
    service: string,
    method: string,
    payload: unknown,
    context: ExtensionServiceInvocationContext,
  ) => Promise<unknown>;
  readonly publishUiState: (extensionId: string, key: string, value: unknown) => Promise<void>;
}): Promise<HostPreparedPluginPackageInput> {
  const installed = input.tool ?? input.ui?.installed ?? input.event;
  if (!installed) throw new HostExtensionLoaderError('not_found', 'Extension package is missing');
  const uiInput = input.ui
    ? await uiPackageInput(input.ui.store, input.ui.installed, input.metadata)
    : undefined;
  const configurationFor = input.configurationFor;
  return Object.freeze({
    extensionId: installed.extensionId,
    ...(input.metadata?.dependencies.length
      ? {
          dependencies: Object.freeze(
            input.metadata.dependencies.map(({ id: extensionId }) =>
              Object.freeze({ extensionId }),
            ),
          ),
        }
      : {}),
    toolNames: Object.freeze(input.tool?.manifest.tools.map(({ name }) => name) ?? []),
    ...(uiInput ? { ui: uiInput.ui } : {}),
    ...(input.event
      ? {
          eventContributionIds: Object.freeze([
            ...input.event.manifest.events.map(({ name }) => `event:${name}`),
            ...input.event.manifest.listeners.map(({ event, id }) => `listener:${event}:${id}`),
          ]),
          ...(input.event.manifest.services.length
            ? {
                serviceContributionIds: Object.freeze(
                  input.event.manifest.services.map(({ name }) => name),
                ),
              }
            : {}),
          ...(input.event.manifest.timers.length
            ? {
                timerContributionIds: Object.freeze(
                  input.event.manifest.timers.map(({ id }) => id),
                ),
              }
            : {}),
        }
      : {}),
    load: async (context: Parameters<HostPreparedPluginPackageInput['load']>[0]) => {
      const configuration = configurationFor(context.entryId);
      const emitEvent = (
        event: string,
        payload: unknown,
        packageContext: PackageInvocationContext,
      ) =>
        input.emitEvent(packageContext.sessionId, event, payload, {
          sessionId: packageContext.sessionId,
          ...(packageContext.runId ? { runId: packageContext.runId } : {}),
          turnId: packageContext.turnId,
          cwd: packageContext.cwd,
          permissionMode: packageContext.permissionMode ?? 'default',
          origin: packageContext.origin ?? 'provider',
          configuration,
          signal: packageContext.abortSignal,
          eventDepth: (packageContext.eventDepth ?? 0) + 1,
        });
      const declaredDependencies = new Set(input.metadata?.dependencies.map(({ id }) => id) ?? []);
      const callService: PackageServiceCaller = (service, method, payload, packageContext) => {
        const ownsService = service.startsWith(`${packageContext.callerExtensionId}.`);
        const declaredProvider = [...declaredDependencies].find((id) =>
          service.startsWith(`${id}.`),
        );
        if (!ownsService && !declaredProvider) {
          throw new Error(
            `Extension Service provider must be declared as a dependency: ${service}`,
          );
        }
        return input.callService(packageContext.sessionId, service, method, payload, {
          sessionId: packageContext.sessionId,
          ...(packageContext.runId ? { runId: packageContext.runId } : {}),
          turnId: packageContext.turnId,
          cwd: packageContext.cwd,
          permissionMode: packageContext.permissionMode ?? 'default',
          origin: packageContext.origin ?? 'provider',
          configuration,
          signal: packageContext.abortSignal,
          callerExtensionId: packageContext.callerExtensionId,
          serviceDepth: (packageContext.serviceDepth ?? 0) + 1,
        });
      };
      const toolActivation = input.tool
        ? new InProcessPackageActivation(input.tool, configuration, emitEvent, callService)
        : undefined;
      const eventActivation = input.event
        ? new PluginHookActivation(
            input.event,
            configuration,
            emitEvent,
            callService,
            toolActivation,
          )
        : undefined;
      return {
        tools: Object.freeze(
          (toolActivation?.tools() ?? []).map((tool) => {
            const stateKey = input.tool?.manifest.tools.find(({ name }) => name === tool.name)
              ?.visualization?.stateKey;
            if (!stateKey) return tool;
            return Object.freeze({
              ...tool,
              impl: async (...args: Parameters<typeof tool.impl>) => {
                const result = await tool.impl(...args);
                await input.publishUiState(installed.extensionId, stateKey, result);
                return result;
              },
            });
          }),
        ),
        ...(eventActivation
          ? {
              events: eventActivation.events(),
              listeners: eventActivation.listeners(),
              services: eventActivation.services(),
              timers: eventActivation.timers(),
            }
          : {}),
        healthCheck: async () => {
          await toolActivation?.healthCheck(
            input.tool?.manifest.tools.map(({ handler }) => handler) ?? [],
          );
          await uiInput?.healthCheck?.();
          await eventActivation?.healthCheck();
        },
        dispose: async () => {
          await Promise.allSettled([
            ...(toolActivation ? [toolActivation.dispose()] : []),
            ...(eventActivation ? [eventActivation.dispose()] : []),
          ]);
        },
      };
    },
  });
}

function mergeProjection(
  left: TrustedExtensionProjection,
  right: TrustedExtensionProjection,
): TrustedExtensionProjection {
  return Object.freeze({
    extensionId: left.extensionId,
    toolNames: Object.freeze(
      [...new Set([...left.toolNames, ...right.toolNames])].sort(compareString),
    ),
    uiContributionIds: Object.freeze(
      [...new Set([...left.uiContributionIds, ...right.uiContributionIds])].sort(compareString),
    ),
    eventContributionIds: Object.freeze(
      [...new Set([...left.eventContributionIds, ...right.eventContributionIds])].sort(
        compareString,
      ),
    ),
    ...((left.serviceContributionIds?.length ?? 0) + (right.serviceContributionIds?.length ?? 0) > 0
      ? {
          serviceContributionIds: Object.freeze(
            [
              ...new Set([
                ...(left.serviceContributionIds ?? []),
                ...(right.serviceContributionIds ?? []),
              ]),
            ].sort(compareString),
          ),
        }
      : {}),
    ...((left.timerContributionIds?.length ?? 0) + (right.timerContributionIds?.length ?? 0) > 0
      ? {
          timerContributionIds: Object.freeze(
            [
              ...new Set([
                ...(left.timerContributionIds ?? []),
                ...(right.timerContributionIds ?? []),
              ]),
            ].sort(compareString),
          ),
        }
      : {}),
  });
}

function projectContract(
  tool: InstalledToolPackage | undefined,
  ui: InstalledUiPackage | undefined,
  event: InstalledEventPackage | undefined,
  metadata: ExtensionPackageManifest | undefined,
): ExtensionPackageContractProjection {
  const installed = tool ?? ui ?? event;
  if (!installed) throw new HostExtensionLoaderError('not_found', 'Extension package is missing');
  return Object.freeze({
    extensionId: installed.extensionId,
    displayName: metadata?.displayName ?? installed.extensionId,
    description: metadata?.description ?? '',
    dependencies: Object.freeze(metadata?.dependencies.map(({ id }) => ({ id })) ?? []),
    configuration:
      metadata?.configuration ??
      Object.freeze({ properties: Object.freeze({}), required: Object.freeze([]) }),
    contributions: Object.freeze([
      ...(tool?.manifest.tools.map((item) =>
        Object.freeze({
          kind: 'tool' as const,
          id: item.name,
          name: item.name,
          description: item.description,
        }),
      ) ?? []),
      ...(ui?.manifest.ui.map((item) =>
        Object.freeze({
          kind: 'ui' as const,
          id: item.id,
          surface: item.surface,
          ...(item.slot ? { slot: item.slot } : {}),
          ...(item.slots.length ? { slots: item.slots } : {}),
        }),
      ) ?? []),
      ...(event?.manifest.events.map((item) =>
        Object.freeze({
          kind: 'event' as const,
          id: item.name,
          event: item.name,
          description: item.description,
          ...(item.mode === 'emit' ? {} : { mode: item.mode }),
        }),
      ) ?? []),
      ...(event?.manifest.listeners.map((item) =>
        Object.freeze({
          kind: 'listener' as const,
          id: item.id,
          event: item.event,
        }),
      ) ?? []),
      ...(event?.manifest.services.map((item) =>
        Object.freeze({
          kind: 'service' as const,
          id: item.name,
          name: item.name,
          description: item.description,
        }),
      ) ?? []),
      ...(event?.manifest.timers.map((item) =>
        Object.freeze({
          kind: 'timer' as const,
          id: item.id,
          name: item.id,
          description: `Every ${item.intervalMs}ms`,
        }),
      ) ?? []),
    ]),
  });
}

function translatePackageError(error: unknown): HostExtensionLoaderError {
  if (error instanceof HostExtensionLoaderError) return error;
  if (error instanceof PluginPackageStoreError) {
    return new HostExtensionLoaderError(
      error.code === 'not_found'
        ? 'not_found'
        : error.code === 'invalid_package' || error.code === 'already_installed'
          ? 'invalid_definition'
          : 'load_failed',
      error.message,
      { cause: error },
    );
  }
  return new HostExtensionLoaderError('load_failed', 'Extension package operation failed', {
    cause: error,
  });
}

function assertDefinition(definition: HostTrustedToolExtensionInput): void {
  if (!definition || typeof definition !== 'object') {
    throw new HostExtensionLoaderError('invalid_definition', 'Trusted Extension is required');
  }
  if (!isCanonicalExtensionId(definition.extensionId)) {
    throw new HostExtensionLoaderError(
      'invalid_definition',
      'Trusted Extension extensionId is invalid',
    );
  }
  if (!Array.isArray(definition.tools) || definition.tools.length === 0) {
    throw new HostExtensionLoaderError(
      'invalid_definition',
      'Trusted Extension must declare at least one Tool',
    );
  }
  const names = new Set<string>();
  for (const tool of definition.tools) {
    if (
      !tool ||
      typeof tool !== 'object' ||
      typeof tool.name !== 'string' ||
      tool.name.length === 0 ||
      tool.name.length > 128 ||
      /[\r\n\0]/u.test(tool.name) ||
      typeof tool.description !== 'string' ||
      typeof tool.impl !== 'function' ||
      tool.parameters === undefined
    ) {
      throw new HostExtensionLoaderError('invalid_definition', 'Trusted Extension Tool is invalid');
    }
    const key = tool.name.toLowerCase();
    if (names.has(key)) {
      throw new HostExtensionLoaderError(
        'invalid_definition',
        `Trusted Extension repeats Tool name: ${tool.name}`,
      );
    }
    names.add(key);
  }
}

function freezeDefinition(
  definition: HostTrustedToolExtensionInput,
): HostTrustedToolExtensionInput {
  return Object.freeze({
    extensionId: definition.extensionId,
    tools: Object.freeze(definition.tools.map((tool) => Object.freeze({ ...tool }))),
    ...(definition.dependencies
      ? {
          dependencies: Object.freeze(
            definition.dependencies.map((item) => Object.freeze({ ...item })),
          ),
        }
      : {}),
    ...(definition.healthCheck ? { healthCheck: definition.healthCheck } : {}),
  });
}

function compareExtension(
  left: TrustedExtensionProjection,
  right: TrustedExtensionProjection,
): number {
  return compareString(left.extensionId, right.extensionId);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
