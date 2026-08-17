import { isCanonicalExtensionId } from '@maka/runtime/extension-lifecycle-kernel';
import type {
  ExtensionConfigurationScalar,
  ExtensionPackageContractProjection,
  TrustedExtensionRevisionProjection,
} from '../protocol/index.js';
import type {
  HostExtensionRevisionInput,
  HostPreparedToolExtensionRevisionInput,
  HostToolExtensionRevisionInput,
  HostTrustedToolExtensionRevisionInput,
  HostUiExtensionRevisionInput,
} from './extension-runtime.js';
import type { ExtensionEventInvocationContext } from '@maka/runtime/extension-event-contributions';
import type { ExtensionServiceInvocationContext } from '@maka/runtime/extension-service-contributions';
import type {
  PackageWorkerInvocationContext,
  PackageWorkerServiceCaller,
} from './tool-package-worker.js';
import { ToolPackageActivation } from './tool-package-worker.js';
import { HookPackageActivation } from './hook-package-activation.js';
import {
  type InstalledHookPackage,
  HookPackageStore,
  HookPackageStoreError,
} from './hook-package-store.js';
import { EventPackageActivation } from './event-package-activation.js';
import {
  type InstalledEventPackage,
  EventPackageStore,
  EventPackageStoreError,
} from './event-package-store.js';
import {
  type InstalledToolPackage,
  ToolPackageStore,
  ToolPackageStoreError,
} from './tool-package-store.js';
import {
  type InstalledUiPackage,
  UiPackageStore,
  UiPackageStoreError,
} from './ui-package-store.js';
import { UiPackageService } from './ui-package-service.js';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exportExtensionBundle, materializeExtensionPackage } from './extension-bundle.js';
import {
  type ExtensionPackageManifest,
  ExtensionPackageManifestError,
  loadExtensionPackageManifest,
} from './extension-package-manifest.js';

export type StaticTrustedToolExtensionRevision = HostTrustedToolExtensionRevisionInput;

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
  list(): Promise<readonly TrustedExtensionRevisionProjection[]>;
  load(extensionId: string, revision: string): Promise<HostExtensionRevisionInput>;
  installPackage?(sourcePath: string): Promise<TrustedExtensionRevisionProjection>;
  uninstallPackage?(extensionId: string, revision: string): Promise<void>;
  contracts?(): Promise<readonly ExtensionPackageContractProjection[]>;
  exportPackage?(extensionId: string, revision: string, targetPath: string): Promise<void>;
  setConfigurationResolver?(
    resolver: (bindingId: string) => Readonly<Record<string, ExtensionConfigurationScalar>>,
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
}

/**
 * Loader for Tool revisions explicitly registered by the trusted Host composition.
 *
 * It never resolves a path or executes workspace code. Installed packages use
 * a separate loader and isolated worker without weakening this static boundary.
 */
export class StaticTrustedToolExtensionLoader implements HostTrustedToolExtensionLoader {
  readonly #definitions = new Map<string, HostTrustedToolExtensionRevisionInput>();
  readonly #catalog: readonly TrustedExtensionRevisionProjection[];

  constructor(definitions: readonly StaticTrustedToolExtensionRevision[] = []) {
    for (const definition of definitions) {
      assertDefinition(definition);
      const key = revisionKey(definition.extensionId, definition.revision);
      if (this.#definitions.has(key)) {
        throw new HostExtensionLoaderError(
          'invalid_definition',
          `Trusted Extension revision is registered more than once: ${key}`,
        );
      }
      this.#definitions.set(key, freezeDefinition(definition));
    }
    this.#catalog = Object.freeze(
      [...this.#definitions.values()]
        .map((definition) =>
          Object.freeze({
            extensionId: definition.extensionId,
            revision: definition.revision,
            toolNames: Object.freeze(definition.tools.map(({ name }) => name).sort(compareString)),
            uiContributionIds: Object.freeze([]),
            hookContributionIds: Object.freeze([]),
            eventContributionIds: Object.freeze([]),
          }),
        )
        .sort(
          (left, right) =>
            compareString(left.extensionId, right.extensionId) ||
            compareString(left.revision, right.revision),
        ),
    );
  }

  async list(): Promise<readonly TrustedExtensionRevisionProjection[]> {
    return this.#catalog;
  }

  async load(
    extensionId: string,
    revision: string,
  ): Promise<HostTrustedToolExtensionRevisionInput> {
    const definition = this.#definitions.get(revisionKey(extensionId, revision));
    if (!definition) {
      throw new HostExtensionLoaderError(
        'not_found',
        `Trusted Extension revision is not available: ${extensionId}@${revision}`,
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
            revision: definition.revision,
            version: definition.revision,
            displayName: definition.extensionId,
            description: '',
            dependencies: Object.freeze(
              (definition.dependencies ?? []).map(({ extensionId: id }) =>
                Object.freeze({ id, version: '*' }),
              ),
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
        .sort(
          (left, right) =>
            compareString(left.extensionId, right.extensionId) ||
            compareString(left.revision, right.revision),
        ),
    );
  }
}

/** Combines Host-composed static Tools with real packages installed in the root-private Store. */
export class InstalledToolPackageExtensionLoader implements HostTrustedToolExtensionLoader {
  #configurationFor: (bindingId: string) => Readonly<Record<string, ExtensionConfigurationScalar>> =
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

  constructor(
    private readonly statics: StaticTrustedToolExtensionLoader,
    private readonly packages: ToolPackageStore,
    private readonly uiPackages?: UiPackageStore,
    private readonly hookPackages?: HookPackageStore,
    private readonly eventPackages?: EventPackageStore,
  ) {}

  setConfigurationResolver(
    resolver: (bindingId: string) => Readonly<Record<string, ExtensionConfigurationScalar>>,
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

  async list(): Promise<readonly TrustedExtensionRevisionProjection[]> {
    const combined = [...(await this.statics.list())];
    const installedByRevision = new Map<string, TrustedExtensionRevisionProjection>();
    for (const installed of await this.packages.list()) {
      const projection = projectPackage(installed);
      installedByRevision.set(revisionKey(projection.extensionId, projection.revision), projection);
    }
    if (this.uiPackages) {
      for (const installed of await this.uiPackages.list()) {
        const projection = projectUiPackage(installed);
        const key = revisionKey(projection.extensionId, projection.revision);
        const current = installedByRevision.get(key);
        installedByRevision.set(key, current ? mergeProjection(current, projection) : projection);
      }
    }
    if (this.hookPackages) {
      for (const installed of await this.hookPackages.list()) {
        const projection = projectHookPackage(installed);
        const key = revisionKey(projection.extensionId, projection.revision);
        const current = installedByRevision.get(key);
        installedByRevision.set(key, current ? mergeProjection(current, projection) : projection);
      }
    }
    if (this.eventPackages) {
      for (const installed of await this.eventPackages.list()) {
        const projection = projectEventPackage(installed);
        const key = revisionKey(projection.extensionId, projection.revision);
        const current = installedByRevision.get(key);
        installedByRevision.set(key, current ? mergeProjection(current, projection) : projection);
      }
    }
    combined.push(...installedByRevision.values());
    const keys = new Set<string>();
    for (const item of combined) {
      const key = revisionKey(item.extensionId, item.revision);
      if (keys.has(key)) {
        throw new HostExtensionLoaderError(
          'invalid_definition',
          `Tool Extension revision exists in both static and package catalogs: ${item.extensionId}@${item.revision}`,
        );
      }
      keys.add(key);
    }
    return Object.freeze(combined.sort(compareRevision));
  }

  async load(extensionId: string, revision: string): Promise<HostExtensionRevisionInput> {
    try {
      return await this.statics.load(extensionId, revision);
    } catch (error) {
      if (!(error instanceof HostExtensionLoaderError) || error.code !== 'not_found') throw error;
    }
    const tool = await this.#loadTool(extensionId, revision);
    const ui = await this.#loadUi(extensionId, revision);
    const hook = await this.#loadHook(extensionId, revision);
    const event = await this.#loadEvent(extensionId, revision);
    const root = tool?.root ?? ui?.root ?? hook?.root ?? event?.root;
    const metadata = root ? await loadAndValidateMetadata(root, tool, ui, hook, event) : undefined;
    if (root) {
      return combinedPackageRevisionInput({
        tool,
        ui: ui && this.uiPackages ? { installed: ui, store: this.uiPackages } : undefined,
        hook,
        event,
        metadata,
        configurationFor: this.#configurationFor,
        emitEvent: (...args) => this.#emitEvent(...args),
        callService: (...args) => this.#callService(...args),
      });
    }
    throw new HostExtensionLoaderError(
      'not_found',
      `Extension revision is not available: ${extensionId}@${revision}`,
    );
  }

  async installPackage(sourcePath: string): Promise<TrustedExtensionRevisionProjection> {
    const materialized = await materializeExtensionPackage(
      sourcePath,
      dirname(this.packages.root),
    ).catch((error) => {
      throw translatePackageError(error);
    });
    let installedTool: InstalledToolPackage | undefined;
    let installedUi: InstalledUiPackage | undefined;
    let installedHook: InstalledHookPackage | undefined;
    let installedEvent: InstalledEventPackage | undefined;
    let toolsBefore = new Set<string>();
    let uiBefore = new Set<string>();
    let hooksBefore = new Set<string>();
    let eventsBefore = new Set<string>();
    try {
      toolsBefore = new Set(
        (await this.packages.list()).map((item) => revisionKey(item.extensionId, item.revision)),
      );
      uiBefore = new Set(
        this.uiPackages
          ? (await this.uiPackages.list()).map((item) =>
              revisionKey(item.extensionId, item.revision),
            )
          : [],
      );
      hooksBefore = new Set(
        this.hookPackages
          ? (await this.hookPackages.list()).map((item) =>
              revisionKey(item.extensionId, item.revision),
            )
          : [],
      );
      eventsBefore = new Set(
        this.eventPackages
          ? (await this.eventPackages.list()).map((item) =>
              revisionKey(item.extensionId, item.revision),
            )
          : [],
      );
      const packageRoot = materialized.root;
      const hasUi = Boolean(this.uiPackages && (await exists(join(packageRoot, 'maka.ui.json'))));
      const hasTool = await exists(join(packageRoot, 'maka.tool.json'));
      const hasHook = Boolean(
        this.hookPackages && (await exists(join(packageRoot, 'maka.hook.json'))),
      );
      const hasEvent = Boolean(
        this.eventPackages && (await exists(join(packageRoot, 'maka.event.json'))),
      );
      if (!hasUi && !hasTool && !hasHook && !hasEvent) {
        throw new HostExtensionLoaderError(
          'invalid_definition',
          'Extension package must contain maka.ui.json, maka.tool.json, maka.hook.json, maka.event.json, or a combination',
        );
      }
      installedTool = hasTool ? await this.packages.install(packageRoot) : undefined;
      installedUi = hasUi ? await this.uiPackages!.install(packageRoot) : undefined;
      installedHook = hasHook ? await this.hookPackages!.install(packageRoot) : undefined;
      installedEvent = hasEvent ? await this.eventPackages!.install(packageRoot) : undefined;
      const installed = installedTool ?? installedUi ?? installedHook ?? installedEvent!;
      try {
        await loadAndValidateMetadata(
          installed.root,
          installedTool,
          installedUi,
          installedHook,
          installedEvent,
        );
      } catch (error) {
        if (installedTool) {
          await this.packages
            .uninstall(installedTool.extensionId, installedTool.revision)
            .catch(() => undefined);
        }
        if (installedUi) {
          await this.uiPackages!.uninstall(installedUi.extensionId, installedUi.revision).catch(
            () => undefined,
          );
        }
        if (installedHook) {
          await this.hookPackages!.uninstall(
            installedHook.extensionId,
            installedHook.revision,
          ).catch(() => undefined);
        }
        if (installedEvent) {
          await this.eventPackages!.uninstall(
            installedEvent.extensionId,
            installedEvent.revision,
          ).catch(() => undefined);
        }
        throw error;
      }
      if (
        [installedTool, installedUi, installedHook, installedEvent]
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
          .some(
            (item) =>
              item.extensionId !== installed.extensionId || item.revision !== installed.revision,
          )
      ) {
        if (installedTool)
          await this.packages
            .uninstall(installedTool.extensionId, installedTool.revision)
            .catch(() => undefined);
        if (installedUi)
          await this.uiPackages!.uninstall(installedUi.extensionId, installedUi.revision).catch(
            () => undefined,
          );
        if (installedHook)
          await this.hookPackages!.uninstall(
            installedHook.extensionId,
            installedHook.revision,
          ).catch(() => undefined);
        if (installedEvent)
          await this.eventPackages!.uninstall(
            installedEvent.extensionId,
            installedEvent.revision,
          ).catch(() => undefined);
        throw new HostExtensionLoaderError(
          'invalid_definition',
          'Tool, UI, Hook, and Event manifests in one package must declare the same id and content Revision',
        );
      }
      const staticConflict = (await this.statics.list()).some(
        (item) =>
          item.extensionId === installed.extensionId && item.revision === installed.revision,
      );
      if (staticConflict) {
        if (installedTool)
          await this.packages
            .uninstall(installed.extensionId, installed.revision)
            .catch(() => undefined);
        if (installedUi)
          await this.uiPackages!.uninstall(installed.extensionId, installed.revision).catch(
            () => undefined,
          );
        if (installedHook)
          await this.hookPackages!.uninstall(installed.extensionId, installed.revision).catch(
            () => undefined,
          );
        if (installedEvent)
          await this.eventPackages!.uninstall(installed.extensionId, installed.revision).catch(
            () => undefined,
          );
        throw new HostExtensionLoaderError(
          'invalid_definition',
          `Installed package conflicts with a static revision: ${installed.extensionId}@${installed.revision}`,
        );
      }
      const toolProjection = installedTool ? projectPackage(installedTool) : undefined;
      const uiProjection = installedUi ? projectUiPackage(installedUi) : undefined;
      const hookProjection = installedHook ? projectHookPackage(installedHook) : undefined;
      const eventProjection = installedEvent ? projectEventPackage(installedEvent) : undefined;
      const projections = [toolProjection, uiProjection, hookProjection, eventProjection].filter(
        (item): item is TrustedExtensionRevisionProjection => Boolean(item),
      );
      return projections.reduce(mergeProjection);
    } catch (error) {
      if (
        installedTool &&
        !toolsBefore.has(revisionKey(installedTool.extensionId, installedTool.revision))
      ) {
        await this.packages
          .uninstall(installedTool.extensionId, installedTool.revision)
          .catch(() => undefined);
      }
      if (
        installedHook &&
        this.hookPackages &&
        !hooksBefore.has(revisionKey(installedHook.extensionId, installedHook.revision))
      ) {
        await this.hookPackages
          .uninstall(installedHook.extensionId, installedHook.revision)
          .catch(() => undefined);
      }
      if (
        installedEvent &&
        this.eventPackages &&
        !eventsBefore.has(revisionKey(installedEvent.extensionId, installedEvent.revision))
      ) {
        await this.eventPackages
          .uninstall(installedEvent.extensionId, installedEvent.revision)
          .catch(() => undefined);
      }
      if (
        installedUi &&
        this.uiPackages &&
        !uiBefore.has(revisionKey(installedUi.extensionId, installedUi.revision))
      ) {
        await this.uiPackages
          .uninstall(installedUi.extensionId, installedUi.revision)
          .catch(() => undefined);
      }
      throw translatePackageError(error);
    } finally {
      await materialized.dispose();
    }
  }

  async contracts(): Promise<readonly ExtensionPackageContractProjection[]> {
    const contracts = [...(await this.statics.contracts())];
    const installed = new Map<
      string,
      {
        tool?: InstalledToolPackage;
        ui?: InstalledUiPackage;
        hook?: InstalledHookPackage;
        event?: InstalledEventPackage;
      }
    >();
    for (const tool of await this.packages.list()) {
      installed.set(revisionKey(tool.extensionId, tool.revision), { tool });
    }
    if (this.uiPackages) {
      for (const ui of await this.uiPackages.list()) {
        const key = revisionKey(ui.extensionId, ui.revision);
        installed.set(key, { ...installed.get(key), ui });
      }
    }
    if (this.hookPackages) {
      for (const hook of await this.hookPackages.list()) {
        const key = revisionKey(hook.extensionId, hook.revision);
        installed.set(key, { ...installed.get(key), hook });
      }
    }
    if (this.eventPackages) {
      for (const event of await this.eventPackages.list()) {
        const key = revisionKey(event.extensionId, event.revision);
        installed.set(key, { ...installed.get(key), event });
      }
    }
    for (const { tool, ui, hook, event } of installed.values()) {
      const root = tool?.root ?? ui?.root ?? hook?.root ?? event?.root;
      if (!root) continue;
      const metadata = await loadAndValidateMetadata(root, tool, ui, hook, event);
      contracts.push(projectContract(tool, ui, hook, event, metadata));
    }
    return Object.freeze(
      contracts.sort(
        (left, right) =>
          compareString(left.extensionId, right.extensionId) ||
          compareString(left.revision, right.revision),
      ),
    );
  }

  async exportPackage(extensionId: string, revision: string, targetPath: string): Promise<void> {
    const tool = await this.#loadTool(extensionId, revision);
    const ui = await this.#loadUi(extensionId, revision);
    const hook = await this.#loadHook(extensionId, revision);
    const event = await this.#loadEvent(extensionId, revision);
    const installed = tool ?? ui ?? hook ?? event;
    if (!installed) {
      throw new HostExtensionLoaderError(
        'not_found',
        `Extension revision is not installed: ${extensionId}@${revision}`,
      );
    }
    await exportExtensionBundle(installed.root, targetPath).catch((error) => {
      throw translatePackageError(error);
    });
  }

  async uninstallPackage(extensionId: string, revision: string): Promise<void> {
    const staticRevision = (await this.statics.list()).some(
      (item) => item.extensionId === extensionId && item.revision === revision,
    );
    if (staticRevision) {
      throw new HostExtensionLoaderError(
        'invalid_definition',
        `Static Tool Extension revisions cannot be uninstalled: ${extensionId}@${revision}`,
      );
    }
    try {
      const tool = await this.#loadTool(extensionId, revision);
      const ui = await this.#loadUi(extensionId, revision);
      const hook = await this.#loadHook(extensionId, revision);
      const event = await this.#loadEvent(extensionId, revision);
      if (!tool && !ui && !hook && !event)
        throw new HostExtensionLoaderError(
          'not_found',
          `Extension revision is not installed: ${extensionId}@${revision}`,
        );
      const restoreSource = tool?.root ?? ui?.root ?? hook?.root ?? event!.root;
      const removed: Array<() => Promise<void>> = [];
      if (event && this.eventPackages) {
        await this.eventPackages.uninstall(extensionId, revision);
        removed.push(() => this.eventPackages!.install(restoreSource).then(() => undefined));
      }
      if (hook && this.hookPackages) {
        await this.hookPackages.uninstall(extensionId, revision);
        removed.push(() => this.hookPackages!.install(restoreSource).then(() => undefined));
      }
      if (ui && this.uiPackages) {
        try {
          await this.uiPackages.uninstall(extensionId, revision);
          removed.push(() => this.uiPackages!.install(restoreSource).then(() => undefined));
        } catch (error) {
          await Promise.allSettled(removed.map((restore) => restore()));
          throw error;
        }
      }
      if (tool) {
        try {
          await this.packages.uninstall(extensionId, revision);
        } catch (error) {
          await Promise.allSettled(removed.map((restore) => restore()));
          throw error;
        }
      }
    } catch (error) {
      throw translatePackageError(error);
    }
  }

  async #loadTool(
    extensionId: string,
    revision: string,
  ): Promise<InstalledToolPackage | undefined> {
    try {
      return await this.packages.load(extensionId, revision);
    } catch (error) {
      if (error instanceof ToolPackageStoreError && error.code === 'not_found') return undefined;
      throw translatePackageError(error);
    }
  }

  async #loadUi(extensionId: string, revision: string): Promise<InstalledUiPackage | undefined> {
    if (!this.uiPackages) return undefined;
    try {
      return await this.uiPackages.load(extensionId, revision);
    } catch (error) {
      if (error instanceof UiPackageStoreError && error.code === 'not_found') return undefined;
      throw translatePackageError(error);
    }
  }

  async #loadHook(
    extensionId: string,
    revision: string,
  ): Promise<InstalledHookPackage | undefined> {
    if (!this.hookPackages) return undefined;
    try {
      return await this.hookPackages.load(extensionId, revision);
    } catch (error) {
      if (error instanceof HookPackageStoreError && error.code === 'not_found') return undefined;
      throw translatePackageError(error);
    }
  }

  async #loadEvent(
    extensionId: string,
    revision: string,
  ): Promise<InstalledEventPackage | undefined> {
    if (!this.eventPackages) return undefined;
    try {
      return await this.eventPackages.load(extensionId, revision);
    } catch (error) {
      if (error instanceof EventPackageStoreError && error.code === 'not_found') return undefined;
      throw translatePackageError(error);
    }
  }
}

function projectPackage(installed: InstalledToolPackage): TrustedExtensionRevisionProjection {
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
    toolNames: Object.freeze(installed.manifest.tools.map(({ name }) => name).sort(compareString)),
    uiContributionIds: Object.freeze([]),
    hookContributionIds: Object.freeze([]),
    eventContributionIds: Object.freeze([]),
  });
}

async function uiPackageRevisionInput(
  store: UiPackageStore,
  installed: InstalledUiPackage,
  metadata?: ExtensionPackageManifest,
): Promise<HostUiExtensionRevisionInput> {
  const service = new UiPackageService();
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
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

function projectUiPackage(installed: InstalledUiPackage): TrustedExtensionRevisionProjection {
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
    toolNames: Object.freeze([]),
    uiContributionIds: Object.freeze(installed.manifest.ui.map(({ id }) => id).sort(compareString)),
    hookContributionIds: Object.freeze([]),
    eventContributionIds: Object.freeze([]),
  });
}

function projectHookPackage(installed: InstalledHookPackage): TrustedExtensionRevisionProjection {
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
    toolNames: Object.freeze([]),
    uiContributionIds: Object.freeze([]),
    hookContributionIds: Object.freeze(
      installed.manifest.hooks.map(({ event, id }) => `${event}:${id}`).sort(compareString),
    ),
    eventContributionIds: Object.freeze([]),
  });
}

function projectEventPackage(installed: InstalledEventPackage): TrustedExtensionRevisionProjection {
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
    toolNames: Object.freeze([]),
    uiContributionIds: Object.freeze([]),
    hookContributionIds: Object.freeze([]),
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

async function combinedPackageRevisionInput(input: {
  readonly tool?: InstalledToolPackage;
  readonly ui?: { readonly installed: InstalledUiPackage; readonly store: UiPackageStore };
  readonly hook?: InstalledHookPackage;
  readonly event?: InstalledEventPackage;
  readonly metadata?: ExtensionPackageManifest;
  readonly configurationFor: (
    bindingId: string,
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
}): Promise<HostPreparedToolExtensionRevisionInput> {
  const installed = input.tool ?? input.ui?.installed ?? input.hook ?? input.event;
  if (!installed) throw new HostExtensionLoaderError('not_found', 'Extension package is missing');
  const uiInput = input.ui
    ? await uiPackageRevisionInput(input.ui.store, input.ui.installed, input.metadata)
    : undefined;
  const configurationFor = input.configurationFor;
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
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
    ...(input.hook
      ? {
          hookContributionIds: Object.freeze(
            input.hook.manifest.hooks.map(({ event, id }) => `${event}:${id}`),
          ),
        }
      : {}),
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
    prepare: async (context: Parameters<HostPreparedToolExtensionRevisionInput['prepare']>[0]) => {
      const configuration = configurationFor(context.bindingId);
      const emitEvent = (
        event: string,
        payload: unknown,
        workerContext: PackageWorkerInvocationContext,
      ) =>
        input.emitEvent(workerContext.sessionId, event, payload, {
          sessionId: workerContext.sessionId,
          ...(workerContext.runId ? { runId: workerContext.runId } : {}),
          turnId: workerContext.turnId,
          cwd: workerContext.cwd,
          permissionMode: workerContext.permissionMode ?? 'default',
          origin: workerContext.origin ?? 'provider',
          configuration,
          signal: workerContext.abortSignal,
          eventDepth: (workerContext.eventDepth ?? 0) + 1,
        });
      const declaredDependencies = new Set(input.metadata?.dependencies.map(({ id }) => id) ?? []);
      const callService: PackageWorkerServiceCaller = (service, method, payload, workerContext) => {
        const ownsService = service.startsWith(`${workerContext.callerExtensionId}.`);
        const declaredProvider = [...declaredDependencies].find((id) =>
          service.startsWith(`${id}.`),
        );
        if (!ownsService && !declaredProvider) {
          throw new Error(
            `Extension Service provider must be declared as a dependency: ${service}`,
          );
        }
        return input.callService(workerContext.sessionId, service, method, payload, {
          sessionId: workerContext.sessionId,
          ...(workerContext.runId ? { runId: workerContext.runId } : {}),
          turnId: workerContext.turnId,
          cwd: workerContext.cwd,
          permissionMode: workerContext.permissionMode ?? 'default',
          origin: workerContext.origin ?? 'provider',
          configuration,
          signal: workerContext.abortSignal,
          callerExtensionId: workerContext.callerExtensionId,
          serviceDepth: (workerContext.serviceDepth ?? 0) + 1,
        });
      };
      const toolActivation = input.tool
        ? new ToolPackageActivation(
            input.tool,
            configuration,
            Object.freeze({}),
            emitEvent,
            callService,
          )
        : undefined;
      const hookActivation = input.hook
        ? new HookPackageActivation(input.hook, configuration, emitEvent, callService)
        : undefined;
      const eventActivation = input.event
        ? new EventPackageActivation(input.event, configuration, emitEvent, callService)
        : undefined;
      return {
        tools: toolActivation?.tools() ?? Object.freeze([]),
        ...(hookActivation ? { hooks: hookActivation.contributions() } : {}),
        ...(eventActivation
          ? {
              events: eventActivation.events(),
              listeners: eventActivation.listeners(),
              services: eventActivation.services(),
              timers: eventActivation.timers(),
            }
          : {}),
        healthCheck: async () => {
          await toolActivation?.healthCheck();
          await uiInput?.healthCheck?.();
          await hookActivation?.healthCheck();
          await eventActivation?.healthCheck();
        },
        dispose: async () => {
          await Promise.allSettled([
            ...(toolActivation ? [toolActivation.dispose()] : []),
            ...(hookActivation ? [hookActivation.dispose()] : []),
            ...(eventActivation ? [eventActivation.dispose()] : []),
          ]);
        },
      };
    },
  });
}

function mergeProjection(
  left: TrustedExtensionRevisionProjection,
  right: TrustedExtensionRevisionProjection,
): TrustedExtensionRevisionProjection {
  return Object.freeze({
    extensionId: left.extensionId,
    revision: left.revision,
    toolNames: Object.freeze(
      [...new Set([...left.toolNames, ...right.toolNames])].sort(compareString),
    ),
    uiContributionIds: Object.freeze(
      [...new Set([...left.uiContributionIds, ...right.uiContributionIds])].sort(compareString),
    ),
    hookContributionIds: Object.freeze(
      [...new Set([...left.hookContributionIds, ...right.hookContributionIds])].sort(compareString),
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

async function loadAndValidateMetadata(
  root: string,
  tool: InstalledToolPackage | undefined,
  ui: InstalledUiPackage | undefined,
  hook: InstalledHookPackage | undefined,
  event: InstalledEventPackage | undefined,
): Promise<ExtensionPackageManifest | undefined> {
  const metadata = await loadExtensionPackageManifest(root);
  if (!metadata) return undefined;
  const manifests = [tool?.manifest, ui?.manifest, hook?.manifest, event?.manifest].filter(
    (manifest): manifest is NonNullable<typeof manifest> => Boolean(manifest),
  );
  if (
    manifests.some(
      (manifest) => manifest.id !== metadata.id || manifest.version !== metadata.version,
    )
  ) {
    throw new HostExtensionLoaderError(
      'invalid_definition',
      'maka.extension.json identity and version must match every contribution manifest',
    );
  }
  return metadata;
}

function projectContract(
  tool: InstalledToolPackage | undefined,
  ui: InstalledUiPackage | undefined,
  hook: InstalledHookPackage | undefined,
  event: InstalledEventPackage | undefined,
  metadata: ExtensionPackageManifest | undefined,
): ExtensionPackageContractProjection {
  const installed = tool ?? ui ?? hook ?? event;
  if (!installed) throw new HostExtensionLoaderError('not_found', 'Extension package is missing');
  const version =
    metadata?.version ??
    tool?.manifest.version ??
    ui?.manifest.version ??
    hook?.manifest.version ??
    event!.manifest.version;
  return Object.freeze({
    extensionId: installed.extensionId,
    revision: installed.revision,
    version,
    displayName: metadata?.displayName ?? installed.extensionId,
    description: metadata?.description ?? '',
    dependencies: Object.freeze(metadata?.dependencies ?? []),
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
      ...(hook?.manifest.hooks.map((item) =>
        Object.freeze({
          kind: 'hook' as const,
          id: item.id,
          event: item.event,
          mode: item.mode,
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
  if (error instanceof ToolPackageStoreError) {
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
  if (error instanceof UiPackageStoreError) {
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
  if (error instanceof HookPackageStoreError) {
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
  if (error instanceof EventPackageStoreError) {
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
  if (error instanceof ExtensionPackageManifestError) {
    return new HostExtensionLoaderError('invalid_definition', error.message, { cause: error });
  }
  return new HostExtensionLoaderError('load_failed', 'Extension package operation failed', {
    cause: error,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertDefinition(definition: HostTrustedToolExtensionRevisionInput): void {
  if (!definition || typeof definition !== 'object') {
    throw new HostExtensionLoaderError('invalid_definition', 'Trusted Extension is required');
  }
  if (!isCanonicalExtensionId(definition.extensionId)) {
    throw new HostExtensionLoaderError(
      'invalid_definition',
      'Trusted Extension extensionId is invalid',
    );
  }
  if (
    typeof definition.revision !== 'string' ||
    definition.revision.length === 0 ||
    Buffer.byteLength(definition.revision, 'utf8') > 128 ||
    /[\r\n]/u.test(definition.revision)
  ) {
    throw new HostExtensionLoaderError(
      'invalid_definition',
      'Trusted Extension revision is invalid',
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
  definition: HostTrustedToolExtensionRevisionInput,
): HostTrustedToolExtensionRevisionInput {
  return Object.freeze({
    extensionId: definition.extensionId,
    revision: definition.revision,
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

function revisionKey(extensionId: string, revision: string): string {
  return `${extensionId}\u0000${revision}`;
}

function compareRevision(
  left: TrustedExtensionRevisionProjection,
  right: TrustedExtensionRevisionProjection,
): number {
  return (
    compareString(left.extensionId, right.extensionId) ||
    compareString(left.revision, right.revision)
  );
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
