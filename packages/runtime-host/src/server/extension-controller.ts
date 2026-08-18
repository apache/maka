import type {
  MakaCompositionEntry,
  MakaCompositionSnapshot,
  MakaPluginMountInspection,
  MakaPluginRootId,
} from '@maka/runtime/plugin-runtime';
import { createHash } from 'node:crypto';
import {
  type ExtensionBindingProjection,
  type ExtensionCatalogMutateInput,
  type ExtensionCatalogMutateResult,
  type ExtensionCatalogQueryResult,
  type ExtensionConfigurationMutateInput,
  type ExtensionConfigurationMutateResult,
  type ExtensionConfigurationQueryInput,
  type ExtensionConfigurationQueryResult,
  type ExtensionContractQueryResult,
  type ExtensionPackageExportInput,
  type ExtensionPackageExportResult,
  type ExtensionPackageContractProjection,
  type ExtensionUiSnapshotInput,
  type ExtensionUiSnapshotResult,
  type ExtensionUiRpcInvokeInput,
  type ExtensionUiRpcInvokeResult,
  type ExtensionUiStateMutateInput,
  type ExtensionUiStateMutateResult,
  type ExtensionUiStateQueryInput,
  type ExtensionUiStateQueryResult,
  type OperationOutcome,
  type ToolPackageInstallInput,
  type ToolPackageInstallResult,
  type ToolPackageUninstallInput,
} from '../protocol/index.js';
import type { ExtensionOperationHandlerMap } from './operation-dispatcher.js';
import {
  HostExtensionLoaderError,
  type HostTrustedToolExtensionLoader,
} from './extension-loader.js';
import { HostExtensionRuntime } from './extension-runtime.js';
import {
  HostPluginCompositionStore,
  HostPluginCompositionStoreError,
  type PersistedPluginComposition,
  type PersistedPluginEntry,
} from './plugin-composition-store.js';
import { HostExtensionUiStateStore } from './extension-ui-state-store.js';
import { UiPackageService } from './ui-package-service.js';
import type { PluginPackageStore } from './plugin-package-store.js';
import {
  compareExtensionVersions,
  extensionVersionSatisfies,
  validateExtensionConfiguration,
} from './extension-package-manifest.js';

type MutationFailureCode =
  | 'host_draining'
  | 'not_found'
  | 'operation_conflict'
  | 'persistence_failed'
  | 'commit_outcome_unknown';

interface PersistedExtensionBinding {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly desiredRevision: string;
  readonly enabled: boolean;
  readonly error: string | null;
}

/** Durable control plane that converges persisted desired bindings into the Host runtime. */
export class HostExtensionController {
  readonly handlers: ExtensionOperationHandlerMap = {
    'extension.catalog.query': () => this.#query(),
    'extension.catalog.mutate': (input) => this.#mutate(input),
    'extension.contract.query': () => this.#contractQuery(),
    'extension.configuration.query': (input) => this.#configurationQuery(input),
    'extension.configuration.mutate': (input) => this.#configurationMutate(input),
    'extension.ui.snapshot': (input) => this.#uiSnapshot(input),
    'extension.ui.state.query': (input) => this.#uiStateQuery(input),
    'extension.ui.state.mutate': (input) => this.#uiStateMutate(input),
    'extension.ui.rpc.invoke': (input) => this.#uiRpcInvoke(input),
    'extension.package.install': (input) => this.#installPackage(input),
    'extension.package.uninstall': (input) => this.#uninstallPackage(input),
    'extension.package.export': (input) => this.#exportPackage(input),
  };

  readonly #bindings = new Map<string, PersistedExtensionBinding>();
  readonly #configuration = new Map<string, Readonly<Record<string, string | number | boolean>>>();
  #mutationTail: Promise<void> = Promise.resolve();
  #recovered = false;
  #draining = false;
  #persistenceFailure: HostPluginCompositionStoreError | undefined;
  #compositionGeneration = 0;
  #persistedComposition: PersistedPluginComposition | undefined;

  constructor(
    private readonly runtime: HostExtensionRuntime,
    private readonly loader: HostTrustedToolExtensionLoader,
    private readonly store: HostPluginCompositionStore,
    private readonly requestDrain: () => void,
    private readonly uiState = new HostExtensionUiStateStore(),
    private readonly uiPackages?: PluginPackageStore,
  ) {
    this.loader.setConfigurationResolver?.(
      (bindingId) => this.#configuration.get(bindingId) ?? Object.freeze({}),
    );
    this.loader.setEventEmitter?.((scopeId, event, payload, context) =>
      this.runtime.emitEvent(scopeId, event, payload, context),
    );
    this.loader.setServiceCaller?.((scopeId, service, method, input, context) =>
      this.runtime.callService(scopeId, service, method, input, context),
    );
  }

  /** Recovery is fail-open for the Host and fail-closed for Extension mutations. */
  async recover(): Promise<void> {
    if (this.#recovered) return;
    try {
      const composition = await this.store.read();
      if (composition) {
        this.#persistedComposition = composition;
        this.#compositionGeneration = composition.generation;
        for (const [scopeId, entry] of persistedEntries(composition)) {
          if (!entry.packageId || !entry.revision) continue;
          this.#bindings.set(
            entry.id,
            bindingState({
              bindingId: entry.id,
              scopeId,
              extensionId: entry.packageId,
              desiredRevision: entry.revision,
              enabled: !entry.disabled,
              error: entry.error ?? null,
            }),
          );
          this.#configuration.set(entry.id, entry.config);
        }
        for (const [, entry] of persistedEntries(composition)) {
          if (!entry.packageId || !entry.revision || entry.disabled) continue;
          await this.#ensureInstalled(entry.packageId, entry.revision);
        }
        await this.runtime.replaceCompositionSnapshot(runtimeSnapshot(composition));
      }
      await this.#recoverEnabledBindings();
      await this.#refreshRuntimeState();
      await this.#pruneOrphanDependencyBindings();
      await this.#garbageCollectRevisions();
      await this.#persist();
    } catch (error) {
      this.#persistenceFailure = asPersistenceFailure(error);
    } finally {
      this.#recovered = true;
    }
  }

  beginDrain(): void {
    this.#draining = true;
  }

  async #query(): Promise<OperationOutcome<'extension.catalog.query'>> {
    if (this.#persistenceFailure) {
      return queryFailure('persistence_failed', 'Extension state is unavailable');
    }
    const result: ExtensionCatalogQueryResult = {
      revisions: await this.loader.list(),
      bindings: this.#bindingProjections(),
    };
    return { ok: true, result };
  }

  async #contractQuery(): Promise<OperationOutcome<'extension.contract.query'>> {
    if (this.#persistenceFailure) {
      return {
        ok: false,
        error: { code: 'persistence_failed', message: 'Extension state is unavailable' },
      };
    }
    try {
      const packages = this.loader.contracts ? await this.loader.contracts() : [];
      const result: ExtensionContractQueryResult = { packages };
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: { code: 'internal_failure', message: boundedErrorMessage(error) },
      };
    }
  }

  async #configurationQuery(
    input: ExtensionConfigurationQueryInput,
  ): Promise<OperationOutcome<'extension.configuration.query'>> {
    const binding = this.#bindings.get(input.bindingId);
    if (!binding) {
      return { ok: false, error: { code: 'not_found', message: 'Extension binding not found' } };
    }
    try {
      const contract = await this.#requireContract(binding.extensionId, binding.desiredRevision);
      const configuration = validateExtensionConfiguration(
        contract.configuration,
        this.#configuration.get(input.bindingId),
      );
      const result: ExtensionConfigurationQueryResult = {
        configuration: redactSecretConfiguration(contract, configuration),
      };
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: { code: 'invalid_request', message: boundedErrorMessage(error) },
      };
    }
  }

  #configurationMutate(
    input: ExtensionConfigurationMutateInput,
  ): Promise<OperationOutcome<'extension.configuration.mutate'>> {
    if (this.#draining) {
      return Promise.resolve({
        ok: false,
        error: { code: 'host_draining', message: 'Runtime Host is draining' },
      });
    }
    return this.#serializeMutation(async () => {
      const binding = this.#bindings.get(input.bindingId);
      if (!binding) {
        return { ok: false, error: { code: 'not_found', message: 'Extension binding not found' } };
      }
      let configuration: Readonly<Record<string, string | number | boolean>>;
      try {
        const contract = await this.#requireContract(binding.extensionId, binding.desiredRevision);
        configuration = validateExtensionConfiguration(contract.configuration, input.configuration);
      } catch (error) {
        return {
          ok: false,
          error: { code: 'invalid_request', message: boundedErrorMessage(error) },
        };
      }
      const previous = this.#configuration.get(input.bindingId);
      this.#configuration.set(input.bindingId, configuration);
      try {
        await this.#persist();
        if (binding.enabled && this.#tryInspect(binding.bindingId)) {
          await this.runtime.stop(binding.bindingId);
          await this.runtime.start(binding.bindingId);
          await this.#refreshRuntimeState();
          await this.#persist();
        }
        const contract = await this.#requireContract(binding.extensionId, binding.desiredRevision);
        const result: ExtensionConfigurationMutateResult = {
          configuration: redactSecretConfiguration(contract, configuration),
        };
        return { ok: true, result };
      } catch (error) {
        if (previous) this.#configuration.set(input.bindingId, previous);
        else this.#configuration.delete(input.bindingId);
        await this.#persist().catch(() => undefined);
        if (binding.enabled) await this.#convergeBinding(binding.bindingId).catch(() => undefined);
        return {
          ok: false,
          error: { code: 'persistence_failed', message: boundedErrorMessage(error) },
        };
      }
    });
  }

  async #uiSnapshot(
    input: ExtensionUiSnapshotInput,
  ): Promise<OperationOutcome<'extension.ui.snapshot'>> {
    if (this.#persistenceFailure) {
      return uiSnapshotFailure('persistence_failed', 'Extension state is unavailable');
    }
    const contributions: ExtensionUiSnapshotResult['contributions'] = this.runtime
      .inspectUi(input.scopeId)
      .map((item) =>
        Object.freeze({
          bindingId: item.bindingId,
          extensionId: item.extensionId,
          revision: item.revision,
          id: item.id,
          surface: item.surface,
          ...(item.slot ? { slot: item.slot } : {}),
          slots: item.slots,
          priority: item.priority,
          document: item.document,
          documentSha256: item.documentSha256,
          network: item.network,
          hostState: item.hostState,
          hostMethods: item.hostMethods,
          sessionAccess: item.sessionAccess,
        }),
      );
    const digest = createHash('sha256').update(JSON.stringify(contributions)).digest('hex');
    const result: ExtensionUiSnapshotResult = {
      scopeId: input.scopeId,
      digest: `sha256-${digest}`,
      contributions,
    };
    return { ok: true, result };
  }

  async #uiStateQuery(
    input: ExtensionUiStateQueryInput,
  ): Promise<OperationOutcome<'extension.ui.state.query'>> {
    const denied = this.#authorizeUiState(input);
    if (denied) return uiStateFailure(denied.code, denied.message);
    try {
      const result: ExtensionUiStateQueryResult = await this.uiState.get(
        input.scopeId,
        input.extensionId,
        input.key,
      );
      return { ok: true, result };
    } catch (error) {
      return uiStateFailure('persistence_failed', boundedErrorMessage(error));
    }
  }

  #uiStateMutate(
    input: ExtensionUiStateMutateInput,
  ): Promise<OperationOutcome<'extension.ui.state.mutate'>> {
    if (this.#draining)
      return Promise.resolve(uiStateMutationFailure('host_draining', 'Runtime Host is draining'));
    return this.#serializeMutation(async () => {
      const denied = this.#authorizeUiState(input);
      if (denied) return uiStateMutationFailure(denied.code, denied.message);
      try {
        const changed =
          input.kind === 'set'
            ? await this.uiState
                .set(input.scopeId, input.extensionId, input.key, input.value)
                .then(() => true)
            : await this.uiState.delete(input.scopeId, input.extensionId, input.key);
        const result: ExtensionUiStateMutateResult = { changed };
        return { ok: true, result };
      } catch (error) {
        return uiStateMutationFailure('persistence_failed', boundedErrorMessage(error));
      }
    });
  }

  async #uiRpcInvoke(
    input: ExtensionUiRpcInvokeInput,
  ): Promise<OperationOutcome<'extension.ui.rpc.invoke'>> {
    if (this.#draining) return uiRpcFailure('host_draining', 'Runtime Host is draining');
    if (!this.uiPackages)
      return uiRpcFailure('operation_unavailable', 'UI Host services are unavailable');
    const denied = this.#authorizeUiRpc(input);
    if (denied) return uiRpcFailure(denied.code, denied.message);
    try {
      const installed = await this.uiPackages.loadUi(input.extensionId, input.revision);
      const result: ExtensionUiRpcInvokeResult = {
        value: (await new UiPackageService().invoke(
          installed,
          input.method,
          input.args,
          new AbortController().signal,
        )) as ExtensionUiRpcInvokeResult['value'],
      };
      return { ok: true, result };
    } catch (error) {
      return uiRpcFailure('internal_failure', boundedErrorMessage(error));
    }
  }

  #authorizeUiState(
    input: ExtensionUiStateQueryInput,
  ): { code: 'not_found' | 'invalid_request'; message: string } | undefined {
    const binding = this.#bindings.get(input.bindingId);
    if (!binding) return { code: 'not_found', message: 'UI Extension binding is not installed' };
    const current = this.runtime.inspect(input.bindingId).current;
    if (
      !binding.enabled ||
      binding.scopeId !== input.scopeId ||
      binding.extensionId !== input.extensionId ||
      current?.revision !== input.revision
    ) {
      return {
        code: 'invalid_request',
        message: 'UI Extension bridge identity is stale or inactive',
      };
    }
    const admitted = this.runtime
      .inspectUi(input.scopeId)
      .some(
        (item) =>
          item.bindingId === input.bindingId &&
          item.extensionId === input.extensionId &&
          item.revision === input.revision &&
          item.hostState,
      );
    return admitted
      ? undefined
      : { code: 'invalid_request', message: 'UI Extension did not declare Host state permission' };
  }

  #authorizeUiRpc(
    input: ExtensionUiRpcInvokeInput,
  ): { code: 'not_found' | 'invalid_request'; message: string } | undefined {
    const binding = this.#bindings.get(input.bindingId);
    if (!binding) return { code: 'not_found', message: 'UI Extension binding is not installed' };
    const current = this.runtime.inspect(input.bindingId).current;
    if (
      !binding.enabled ||
      binding.scopeId !== input.scopeId ||
      binding.extensionId !== input.extensionId ||
      current?.revision !== input.revision
    ) {
      return {
        code: 'invalid_request',
        message: 'UI Extension bridge identity is stale or inactive',
      };
    }
    const admitted = this.runtime
      .inspectUi(input.scopeId)
      .some(
        (item) =>
          item.bindingId === input.bindingId &&
          item.extensionId === input.extensionId &&
          item.revision === input.revision &&
          item.hostMethods.includes(input.method),
      );
    return admitted
      ? undefined
      : {
          code: 'invalid_request',
          message: 'UI Host method is not declared by the active revision',
        };
  }

  #installPackage(
    input: ToolPackageInstallInput,
  ): Promise<OperationOutcome<'extension.package.install'>> {
    if (this.#draining) {
      return Promise.resolve(packageFailure('host_draining', 'Runtime Host is draining'));
    }
    return this.#serializeMutation(async () => {
      if (this.#persistenceFailure) {
        return packageFailure('persistence_failed', 'Extension state is unavailable');
      }
      if (!this.loader.installPackage) {
        return packageFailure('operation_unavailable', 'Tool package installation is unavailable');
      }
      try {
        const result: ToolPackageInstallResult = await this.loader.installPackage(input.sourcePath);
        return { ok: true, result };
      } catch (error) {
        return packageLoaderFailure(error, 'install');
      }
    });
  }

  #uninstallPackage(
    input: ToolPackageUninstallInput,
  ): Promise<OperationOutcome<'extension.package.uninstall'>> {
    if (this.#draining) {
      return Promise.resolve(packageFailure('host_draining', 'Runtime Host is draining'));
    }
    return this.#serializeMutation(async () => {
      if (this.#persistenceFailure) {
        return packageFailure('persistence_failed', 'Extension state is unavailable');
      }
      if (!this.loader.uninstallPackage) {
        return packageFailure(
          'operation_unavailable',
          'Tool package uninstallation is unavailable',
        );
      }
      const referenced = [...this.#bindings.values()].find(
        (binding) =>
          binding.extensionId === input.extensionId &&
          uniqueRevisions(binding).includes(input.revision),
      );
      if (referenced) {
        return packageFailure(
          'operation_conflict',
          `Tool package revision is retained by binding ${referenced.bindingId}`,
        );
      }
      try {
        if (
          this.runtime
            .installedRevisions()
            .some(
              (item) => item.extensionId === input.extensionId && item.revision === input.revision,
            )
        ) {
          await this.runtime.uninstall(input.extensionId, input.revision);
        }
        await this.loader.uninstallPackage(input.extensionId, input.revision);
        return { ok: true, result: {} };
      } catch (error) {
        return packageLoaderFailure(error, 'uninstall');
      }
    });
  }

  #exportPackage(
    input: ExtensionPackageExportInput,
  ): Promise<OperationOutcome<'extension.package.export'>> {
    if (this.#draining) {
      return Promise.resolve({
        ok: false,
        error: { code: 'host_draining', message: 'Runtime Host is draining' },
      });
    }
    return this.#serializeMutation(async () => {
      if (!this.loader.exportPackage) {
        return {
          ok: false,
          error: {
            code: 'operation_unavailable',
            message: 'Extension package export is unavailable',
          },
        };
      }
      try {
        await this.loader.exportPackage(input.extensionId, input.revision, input.targetPath);
        const result: ExtensionPackageExportResult = { targetPath: input.targetPath };
        return { ok: true, result };
      } catch (error) {
        const failure = packageLoaderFailure(error, 'export');
        return failure;
      }
    });
  }

  #mutate(
    input: ExtensionCatalogMutateInput,
  ): Promise<OperationOutcome<'extension.catalog.mutate'>> {
    if (this.#draining) {
      return Promise.resolve(mutationFailure('host_draining', 'Runtime Host is draining'));
    }
    return this.#serializeMutation(async () => {
      if (this.#persistenceFailure) {
        return mutationFailure('persistence_failed', 'Extension state is unavailable');
      }
      switch (input.kind) {
        case 'enable':
          return this.#enable(input);
        case 'disable':
          return this.#disable(input.bindingId);
        case 'update':
          return this.#update(input.bindingId, input.revision);
        case 'remove':
          return this.#remove(input.bindingId);
      }
    });
  }

  async #enable(
    input: Extract<ExtensionCatalogMutateInput, { kind: 'enable' }>,
  ): Promise<OperationOutcome<'extension.catalog.mutate'>> {
    const available = await this.#requireAvailable(input.extensionId, input.revision);
    if (available) return available;
    const current = this.#bindings.get(input.bindingId);
    if (
      current &&
      (current.scopeId !== input.scopeId || current.extensionId !== input.extensionId)
    ) {
      return mutationFailure(
        'operation_conflict',
        `Binding ${input.bindingId} cannot change scope or Extension identity`,
      );
    }
    const scopeOwner = [...this.#bindings.values()].find(
      (binding) =>
        binding.bindingId !== input.bindingId &&
        binding.scopeId === input.scopeId &&
        binding.extensionId === input.extensionId,
    );
    if (scopeOwner) {
      return mutationFailure(
        'operation_conflict',
        `Scope ${input.scopeId} already binds ${input.extensionId} as ${scopeOwner.bindingId}`,
      );
    }
    const bindingSnapshot = new Map(this.#bindings);
    const configurationSnapshot = new Map(this.#configuration);
    let dependencyBindings: readonly string[];
    try {
      const contract = await this.#requireContract(input.extensionId, input.revision);
      dependencyBindings = await this.#stageDependencies(input.scopeId, contract, new Set());
      this.#configuration.set(
        input.bindingId,
        validateExtensionConfiguration(
          contract.configuration,
          this.#configuration.get(input.bindingId),
        ),
      );
    } catch (error) {
      this.#replaceMap(this.#bindings, bindingSnapshot);
      this.#replaceMap(this.#configuration, configurationSnapshot);
      return mutationFailure('operation_conflict', boundedErrorMessage(error));
    }
    this.#bindings.set(
      input.bindingId,
      bindingState({
        bindingId: input.bindingId,
        scopeId: input.scopeId,
        extensionId: input.extensionId,
        desiredRevision: input.revision,
        enabled: true,
        error: null,
      }),
    );
    const committed = await this.#commitDesiredState();
    if (committed) return committed;
    for (const dependencyBindingId of dependencyBindings) {
      const dependency = await this.#convergeMutation(dependencyBindingId);
      if (!dependency.ok) return dependency;
    }
    return this.#convergeMutation(input.bindingId);
  }

  async #update(
    bindingId: string,
    revision: string,
  ): Promise<OperationOutcome<'extension.catalog.mutate'>> {
    const binding = this.#bindings.get(bindingId);
    if (!binding) return mutationFailure('not_found', `Extension binding not found: ${bindingId}`);
    const available = await this.#requireAvailable(binding.extensionId, revision);
    if (available) return available;
    const bindingSnapshot = new Map(this.#bindings);
    const configurationSnapshot = new Map(this.#configuration);
    let dependencyBindings: readonly string[];
    try {
      const contract = await this.#requireContract(binding.extensionId, revision);
      dependencyBindings = await this.#stageDependencies(binding.scopeId, contract, new Set());
      this.#configuration.set(
        bindingId,
        validateExtensionConfiguration(contract.configuration, this.#configuration.get(bindingId)),
      );
    } catch (error) {
      this.#replaceMap(this.#bindings, bindingSnapshot);
      this.#replaceMap(this.#configuration, configurationSnapshot);
      return mutationFailure('operation_conflict', boundedErrorMessage(error));
    }
    this.#bindings.set(
      bindingId,
      bindingState({ ...binding, desiredRevision: revision, enabled: true, error: null }),
    );
    const committed = await this.#commitDesiredState();
    if (committed) return committed;
    for (const dependencyBindingId of dependencyBindings) {
      const dependency = await this.#convergeMutation(dependencyBindingId);
      if (!dependency.ok) return dependency;
    }
    return this.#convergeMutation(bindingId);
  }

  async #disable(bindingId: string): Promise<OperationOutcome<'extension.catalog.mutate'>> {
    const binding = this.#bindings.get(bindingId);
    if (!binding) return mutationFailure('not_found', `Extension binding not found: ${bindingId}`);
    let dependent: PersistedExtensionBinding | undefined;
    try {
      dependent = await this.#requiredBy(binding);
    } catch (error) {
      return mutationFailure('operation_conflict', boundedErrorMessage(error));
    }
    if (dependent) {
      return mutationFailure(
        'operation_conflict',
        `Extension binding ${bindingId} is required by ${dependent.bindingId}`,
      );
    }
    this.#bindings.set(bindingId, bindingState({ ...binding, enabled: false, error: null }));
    const committed = await this.#commitDesiredState();
    if (committed) return committed;
    try {
      if (this.#tryInspect(bindingId)) await this.runtime.stop(bindingId);
      await this.#pruneOrphanDependencyBindings();
      await this.#refreshRuntimeState();
      const persisted = await this.#commitDesiredState();
      return persisted ?? mutationSuccess(this.#projection(bindingId));
    } catch (error) {
      return this.#recordRuntimeFailure(bindingId, error);
    }
  }

  async #remove(bindingId: string): Promise<OperationOutcome<'extension.catalog.mutate'>> {
    const binding = this.#bindings.get(bindingId);
    if (!binding) return mutationFailure('not_found', `Extension binding not found: ${bindingId}`);
    let dependent: PersistedExtensionBinding | undefined;
    try {
      dependent = await this.#requiredBy(binding);
    } catch (error) {
      return mutationFailure('operation_conflict', boundedErrorMessage(error));
    }
    if (dependent) {
      return mutationFailure(
        'operation_conflict',
        `Extension binding ${bindingId} is required by ${dependent.bindingId}`,
      );
    }
    try {
      if (this.#tryInspect(bindingId)) await this.runtime.removeBinding(bindingId);
      await this.uiState.clear(binding.scopeId, binding.extensionId);
      this.#bindings.delete(bindingId);
      this.#configuration.delete(bindingId);
      await this.#pruneOrphanDependencyBindings();
      await this.#garbageCollectRevisions();
      const persisted = await this.#commitDesiredState();
      return persisted ?? mutationSuccess(null);
    } catch (error) {
      return this.#recordRuntimeFailure(bindingId, error);
    }
  }

  async #convergeMutation(
    bindingId: string,
  ): Promise<OperationOutcome<'extension.catalog.mutate'>> {
    try {
      await this.#convergeBinding(bindingId);
      await this.#refreshRuntimeState();
      await this.#pruneOrphanDependencyBindings();
      await this.#garbageCollectRevisions();
      const persisted = await this.#commitDesiredState();
      return persisted ?? mutationSuccess(this.#projection(bindingId));
    } catch (error) {
      return this.#recordRuntimeFailure(bindingId, error);
    }
  }

  async #recordRuntimeFailure(
    bindingId: string,
    error: unknown,
  ): Promise<OperationOutcome<'extension.catalog.mutate'>> {
    const binding = this.#bindings.get(bindingId);
    if (binding) {
      this.#bindings.set(
        bindingId,
        bindingState({ ...binding, error: boundedErrorMessage(error) }),
      );
    }
    const persisted = await this.#commitDesiredState();
    return persisted ?? mutationFailure('operation_conflict', boundedErrorMessage(error));
  }

  async #recoverEnabledBindings(): Promise<void> {
    const enabled = [...this.#bindings.values()]
      .filter((binding) => binding.enabled)
      .sort(compareBinding);
    for (const binding of enabled) {
      for (const revision of uniqueRevisions(binding)) {
        try {
          await this.#ensureInstalled(binding.extensionId, revision);
        } catch (error) {
          this.#bindings.set(
            binding.bindingId,
            bindingState({ ...binding, error: boundedErrorMessage(error) }),
          );
        }
      }
    }
    for (const original of enabled) {
      const binding = this.#bindings.get(original.bindingId)!;
      try {
        await this.#convergeBinding(binding.bindingId);
      } catch (error) {
        const latest = this.#bindings.get(binding.bindingId)!;
        this.#bindings.set(
          binding.bindingId,
          bindingState({ ...latest, error: boundedErrorMessage(error) }),
        );
      }
    }
  }

  async #convergeBinding(bindingId: string): Promise<void> {
    const binding = this.#bindings.get(bindingId);
    if (!binding || !binding.enabled) return;
    await this.#ensureInstalled(binding.extensionId, binding.desiredRevision);
    const inspection = this.#tryInspect(bindingId);
    const rootId: MakaPluginRootId =
      binding.scopeId === 'profile'
        ? 'profile'
        : binding.scopeId === 'desktop-ui'
          ? 'desktop-ui'
          : `session:${binding.scopeId}`;
    await this.runtime.applyComposition({
      operations: inspection
        ? [
            {
              type: 'update',
              entryId: binding.bindingId,
              patch: {
                packageId: binding.extensionId,
                revision: binding.desiredRevision,
                disabled: false,
                config: this.#configuration.get(binding.bindingId) ?? Object.freeze({}),
              },
            },
          ]
        : [
            {
              type: 'insert',
              rootId,
              entry: {
                id: binding.bindingId,
                packageId: binding.extensionId,
                revision: binding.desiredRevision,
                config: this.#configuration.get(binding.bindingId) ?? Object.freeze({}),
              },
            },
          ],
    });
  }

  async #ensureInstalled(extensionId: string, revision: string): Promise<void> {
    if (
      this.runtime
        .installedRevisions()
        .some((item) => item.extensionId === extensionId && item.revision === revision)
    ) {
      return;
    }
    await this.runtime.installRevision(await this.loader.load(extensionId, revision));
  }

  async #garbageCollectRevisions(): Promise<void> {
    const retained = new Set(
      [...this.#bindings.values()].flatMap((binding) =>
        [binding.desiredRevision, this.#tryInspect(binding.bindingId)?.current?.revision]
          .filter((revision): revision is string => typeof revision === 'string')
          .map((revision) => revisionKey(binding.extensionId, revision)),
      ),
    );
    for (const installed of [...this.runtime.installedRevisions()].reverse()) {
      if (retained.has(revisionKey(installed.extensionId, installed.revision))) continue;
      try {
        await this.runtime.uninstall(installed.extensionId, installed.revision);
      } catch {
        // A stale in-memory revision is inert. Keep control-plane convergence
        // successful and let the Host close boundary retry complete cleanup.
      }
    }
  }

  async #refreshRuntimeState(): Promise<void> {
    for (const binding of [...this.#bindings.values()]) {
      const inspection = this.#tryInspect(binding.bindingId);
      if (!inspection) continue;
      const error = inspection.diagnostic?.message ?? binding.error;
      this.#bindings.set(
        binding.bindingId,
        bindingState({
          ...binding,
          error: !inspection.diagnostic && inspection.status === 'active' ? null : error,
        }),
      );
    }
  }

  #tryInspect(bindingId: string): MakaPluginMountInspection | undefined {
    try {
      return this.runtime.inspect(bindingId);
    } catch {
      return undefined;
    }
  }

  async #requireAvailable(
    extensionId: string,
    revision: string,
  ): Promise<OperationOutcome<'extension.catalog.mutate'> | undefined> {
    try {
      await this.loader.load(extensionId, revision);
      return undefined;
    } catch (error) {
      if (error instanceof HostExtensionLoaderError && error.code === 'not_found') {
        return mutationFailure('not_found', error.message);
      }
      return mutationFailure('operation_conflict', boundedErrorMessage(error));
    }
  }

  async #requireContract(
    extensionId: string,
    revision: string,
  ): Promise<ExtensionPackageContractProjection> {
    const contracts = this.loader.contracts ? await this.loader.contracts() : [];
    const contract = contracts.find(
      (candidate) => candidate.extensionId === extensionId && candidate.revision === revision,
    );
    if (!contract) {
      throw new Error(`Extension contract is unavailable: ${extensionId}@${revision}`);
    }
    return contract;
  }

  async #stageDependencies(
    scopeId: string,
    contract: ExtensionPackageContractProjection,
    visiting: Set<string>,
  ): Promise<readonly string[]> {
    if (visiting.has(contract.extensionId)) {
      throw new Error(`Extension dependency cycle includes ${contract.extensionId}`);
    }
    visiting.add(contract.extensionId);
    const staged: string[] = [];
    try {
      const contracts = this.loader.contracts ? await this.loader.contracts() : [];
      for (const dependency of contract.dependencies) {
        const candidates = contracts
          .filter(
            (candidate) =>
              candidate.extensionId === dependency.id &&
              extensionVersionSatisfies(candidate.version, dependency.version),
          )
          .sort((left, right) => compareExtensionVersions(left.version, right.version));
        const selected = candidates.at(-1);
        if (!selected) {
          throw new Error(
            `Required dependency is not installed: ${dependency.id}@${dependency.version}`,
          );
        }
        const existing = [...this.#bindings.values()].find(
          (binding) => binding.scopeId === scopeId && binding.extensionId === dependency.id,
        );
        const bindingId = existing?.bindingId ?? dependencyBindingId(scopeId, dependency.id);
        if (existing) {
          const existingContract = contracts.find(
            (candidate) =>
              candidate.extensionId === existing.extensionId &&
              candidate.revision === existing.desiredRevision,
          );
          if (
            !existingContract ||
            !extensionVersionSatisfies(existingContract.version, dependency.version)
          ) {
            this.#bindings.set(
              bindingId,
              bindingState({
                ...existing,
                desiredRevision: selected.revision,
                enabled: true,
                error: null,
              }),
            );
          } else if (!existing.enabled) {
            this.#bindings.set(
              bindingId,
              bindingState({ ...existing, enabled: true, error: null }),
            );
          }
        } else {
          this.#bindings.set(
            bindingId,
            bindingState({
              bindingId,
              scopeId,
              extensionId: selected.extensionId,
              desiredRevision: selected.revision,
              enabled: true,
              error: null,
            }),
          );
        }
        this.#configuration.set(
          bindingId,
          validateExtensionConfiguration(
            selected.configuration,
            this.#configuration.get(bindingId),
          ),
        );
        staged.push(...(await this.#stageDependencies(scopeId, selected, visiting)), bindingId);
      }
      return Object.freeze([...new Set(staged)]);
    } finally {
      visiting.delete(contract.extensionId);
    }
  }

  async #requiredBy(
    target: PersistedExtensionBinding,
  ): Promise<PersistedExtensionBinding | undefined> {
    const contracts = this.loader.contracts ? await this.loader.contracts() : [];
    return [...this.#bindings.values()].find((binding) => {
      if (!binding.enabled || binding.bindingId === target.bindingId) return false;
      if (binding.scopeId !== target.scopeId) return false;
      const contract = contracts.find(
        (candidate) =>
          candidate.extensionId === binding.extensionId &&
          candidate.revision === binding.desiredRevision,
      );
      return contract?.dependencies.some((dependency) => dependency.id === target.extensionId);
    });
  }

  async #pruneOrphanDependencyBindings(): Promise<void> {
    const contracts = this.loader.contracts ? await this.loader.contracts() : [];
    const required = new Set<string>();
    const visit = (binding: PersistedExtensionBinding, visiting: Set<string>): void => {
      if (visiting.has(binding.bindingId)) return;
      visiting.add(binding.bindingId);
      const contract = contracts.find(
        (candidate) =>
          candidate.extensionId === binding.extensionId &&
          candidate.revision === binding.desiredRevision,
      );
      for (const dependency of contract?.dependencies ?? []) {
        const dependencyBinding = [...this.#bindings.values()].find(
          (candidate) =>
            candidate.enabled &&
            candidate.scopeId === binding.scopeId &&
            candidate.extensionId === dependency.id,
        );
        if (!dependencyBinding) continue;
        required.add(dependencyBinding.bindingId);
        visit(dependencyBinding, visiting);
      }
      visiting.delete(binding.bindingId);
    };
    for (const binding of this.#bindings.values()) {
      if (binding.enabled && !binding.bindingId.startsWith('dependency_')) {
        visit(binding, new Set());
      }
    }
    for (const binding of [...this.#bindings.values()]) {
      if (!binding.bindingId.startsWith('dependency_') || required.has(binding.bindingId)) continue;
      if (this.#tryInspect(binding.bindingId)) await this.runtime.removeBinding(binding.bindingId);
      this.#bindings.delete(binding.bindingId);
      this.#configuration.delete(binding.bindingId);
    }
  }

  #replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
    target.clear();
    for (const [key, value] of source) target.set(key, value);
  }

  async #commitDesiredState(): Promise<OperationOutcome<'extension.catalog.mutate'> | undefined> {
    try {
      await this.#persist();
      return undefined;
    } catch (error) {
      const failure = asPersistenceFailure(error);
      if (failure.code === 'commit_outcome_unknown') this.requestDrain();
      return mutationFailure(
        failure.code === 'invalid_state' ? 'persistence_failed' : failure.code,
        failure.message,
      );
    }
  }

  async #persist(): Promise<void> {
    const profile: PersistedPluginEntry[] = [];
    const desktopUi: PersistedPluginEntry[] = [];
    const sessions: Record<string, PersistedPluginEntry[]> = {};
    for (const binding of [...this.#bindings.values()].sort(compareBinding)) {
      const entry: PersistedPluginEntry = Object.freeze({
        id: binding.bindingId,
        packageId: binding.extensionId,
        revision: binding.desiredRevision,
        disabled: !binding.enabled,
        config: this.#configuration.get(binding.bindingId) ?? Object.freeze({}),
        error: binding.error,
      });
      if (binding.scopeId === 'profile') profile.push(entry);
      else if (binding.scopeId === 'desktop-ui') desktopUi.push(entry);
      else (sessions[binding.scopeId] ??= []).push(entry);
    }
    const previous = this.#persistedComposition;
    const sessionIds = new Set([
      ...Object.keys(previous?.roots.sessions ?? {}),
      ...Object.keys(sessions),
    ]);
    const snapshot: PersistedPluginComposition = {
      schemaVersion: 1,
      generation: ++this.#compositionGeneration,
      roots: Object.freeze({
        profile: reconcileEntries(previous?.roots.profile, profile),
        desktopUi: reconcileEntries(previous?.roots.desktopUi, desktopUi),
        sessions: Object.freeze(
          Object.fromEntries(
            [...sessionIds]
              .sort(compareString)
              .map((scopeId) => [
                scopeId,
                reconcileEntries(previous?.roots.sessions[scopeId], sessions[scopeId] ?? []),
              ]),
          ),
        ),
      }),
    };
    await this.store.replace(snapshot);
    this.#persistedComposition = snapshot;
  }

  #bindingProjections(): readonly ExtensionBindingProjection[] {
    return [...this.#bindings.keys()]
      .sort(compareString)
      .map((bindingId) => this.#projection(bindingId));
  }

  #projection(bindingId: string): ExtensionBindingProjection {
    const binding = this.#bindings.get(bindingId);
    if (!binding) throw new Error(`Extension binding not found: ${bindingId}`);
    const inspection = this.#tryInspect(bindingId);
    return {
      bindingId: binding.bindingId,
      scopeId: binding.scopeId,
      extensionId: binding.extensionId,
      desiredRevision: binding.desiredRevision,
      lastGoodRevision: null,
      enabled: binding.enabled,
      status: projectStatus(binding, inspection),
      error: binding.error,
    };
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function projectStatus(
  binding: PersistedExtensionBinding,
  inspection: MakaPluginMountInspection | undefined,
): ExtensionBindingProjection['status'] {
  if (!binding.enabled) return 'disabled';
  if (binding.error || inspection?.status === 'failed') return 'failed';
  if (inspection?.current?.revision === binding.desiredRevision) return 'active';
  return 'waiting';
}

function bindingState(binding: PersistedExtensionBinding): PersistedExtensionBinding {
  return Object.freeze({ ...binding });
}

function uniqueRevisions(binding: PersistedExtensionBinding): readonly string[] {
  return [binding.desiredRevision];
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const encoded = Buffer.from(message || 'Extension operation failed', 'utf8');
  return encoded.byteLength <= 4096
    ? encoded.toString('utf8')
    : encoded
        .subarray(0, 4093)
        .toString('utf8')
        .replace(/\uFFFD$/u, '') + '...';
}

function asPersistenceFailure(error: unknown): HostPluginCompositionStoreError {
  return error instanceof HostPluginCompositionStoreError
    ? error
    : new HostPluginCompositionStoreError('persistence_failed', 'Extension state is unavailable', {
        cause: error,
      });
}

function mutationSuccess(
  binding: ExtensionBindingProjection | null,
): OperationOutcome<'extension.catalog.mutate'> {
  const result: ExtensionCatalogMutateResult = { binding };
  return { ok: true, result };
}

function queryFailure(
  code: 'persistence_failed',
  message: string,
): OperationOutcome<'extension.catalog.query'> {
  return { ok: false, error: { code, message } };
}

function uiSnapshotFailure(
  code: 'persistence_failed',
  message: string,
): OperationOutcome<'extension.ui.snapshot'> {
  return { ok: false, error: { code, message } };
}

function uiStateFailure(
  code: 'not_found' | 'invalid_request' | 'persistence_failed',
  message: string,
): OperationOutcome<'extension.ui.state.query'> {
  return { ok: false, error: { code, message } };
}

function uiStateMutationFailure(
  code: 'host_draining' | 'not_found' | 'invalid_request' | 'persistence_failed',
  message: string,
): OperationOutcome<'extension.ui.state.mutate'> {
  return { ok: false, error: { code, message } };
}

function uiRpcFailure(
  code:
    | 'host_draining'
    | 'operation_unavailable'
    | 'not_found'
    | 'invalid_request'
    | 'internal_failure',
  message: string,
): OperationOutcome<'extension.ui.rpc.invoke'> {
  return { ok: false, error: { code, message } };
}

function mutationFailure(
  code: MutationFailureCode,
  message: string,
): OperationOutcome<'extension.catalog.mutate'> {
  return { ok: false, error: { code, message } };
}

function packageFailure(
  code:
    | 'host_draining'
    | 'operation_unavailable'
    | 'not_found'
    | 'operation_conflict'
    | 'invalid_request'
    | 'persistence_failed',
  message: string,
): OperationOutcome<'extension.package.install'> &
  OperationOutcome<'extension.package.uninstall'> &
  OperationOutcome<'extension.package.export'> {
  return { ok: false, error: { code, message } };
}

function packageLoaderFailure(
  error: unknown,
  operation: 'install' | 'uninstall' | 'export',
): OperationOutcome<'extension.package.install'> &
  OperationOutcome<'extension.package.uninstall'> &
  OperationOutcome<'extension.package.export'> {
  if (error instanceof HostExtensionLoaderError) {
    const code =
      error.code === 'not_found'
        ? 'not_found'
        : error.code === 'invalid_definition'
          ? operation === 'install'
            ? 'invalid_request'
            : 'operation_conflict'
          : 'persistence_failed';
    return packageFailure(code, error.message);
  }
  return packageFailure('operation_conflict', boundedErrorMessage(error));
}

function compareBinding(
  left: Pick<PersistedExtensionBinding, 'bindingId'>,
  right: Pick<PersistedExtensionBinding, 'bindingId'>,
): number {
  return compareString(left.bindingId, right.bindingId);
}

function persistedEntries(
  composition: PersistedPluginComposition,
): readonly (readonly [scopeId: string, entry: PersistedPluginEntry])[] {
  return [
    ...flattenPersistedEntries('profile', composition.roots.profile),
    ...flattenPersistedEntries('desktop-ui', composition.roots.desktopUi),
    ...Object.entries(composition.roots.sessions).flatMap(([scopeId, entries]) =>
      flattenPersistedEntries(scopeId, entries),
    ),
  ];
}

function flattenPersistedEntries(
  scopeId: string,
  entries: readonly PersistedPluginEntry[],
): readonly (readonly [scopeId: string, entry: PersistedPluginEntry])[] {
  return entries.flatMap((entry) => [
    [scopeId, entry] as const,
    ...flattenPersistedEntries(scopeId, entry.children ?? []),
  ]);
}

function reconcileEntries(
  previous: readonly PersistedPluginEntry[] | undefined,
  current: readonly PersistedPluginEntry[],
): readonly PersistedPluginEntry[] {
  const remaining = new Map(current.map((entry) => [entry.id, entry]));
  const preserve = (entry: PersistedPluginEntry): PersistedPluginEntry | undefined => {
    if (entry.packageId) {
      const replacement = remaining.get(entry.id);
      if (!replacement) return undefined;
      remaining.delete(entry.id);
      return replacement;
    }
    const children = (entry.children ?? []).flatMap((child) => {
      const next = preserve(child);
      return next ? [next] : [];
    });
    return Object.freeze({ ...entry, children: Object.freeze(children) });
  };
  const retained = (previous ?? []).flatMap((entry) => {
    if (entry.packageId) {
      const replacement = remaining.get(entry.id);
      if (!replacement) return [];
      remaining.delete(entry.id);
      return [replacement];
    }
    return [preserve(entry)!];
  });
  return Object.freeze([...retained, ...remaining.values()]);
}

function runtimeSnapshot(composition: PersistedPluginComposition): MakaCompositionSnapshot {
  const convert = (entry: PersistedPluginEntry): MakaCompositionEntry =>
    Object.freeze({
      id: entry.id,
      ...(entry.packageId && entry.revision
        ? { packageId: entry.packageId, revision: entry.revision }
        : {}),
      config: entry.config,
      disabled: entry.disabled,
      ...(entry.inject === undefined ? {} : { inject: entry.inject }),
      ...(entry.isolate === undefined ? {} : { isolate: entry.isolate }),
      ...(entry.intercept === undefined ? {} : { intercept: entry.intercept }),
      ...(entry.children === undefined
        ? {}
        : { children: Object.freeze(entry.children.map(convert)) }),
    });
  return Object.freeze({
    schemaVersion: 1,
    generation: composition.generation,
    roots: Object.freeze({
      profile: Object.freeze(composition.roots.profile.map(convert)),
      desktopUi: Object.freeze(composition.roots.desktopUi.map(convert)),
      sessions: Object.freeze(
        Object.fromEntries(
          Object.entries(composition.roots.sessions).map(([scopeId, entries]) => [
            scopeId,
            Object.freeze(entries.map(convert)),
          ]),
        ),
      ),
    }),
  });
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function revisionKey(extensionId: string, revision: string): string {
  return `${extensionId}\u0000${revision}`;
}

function dependencyBindingId(scopeId: string, extensionId: string): string {
  return `dependency_${createHash('sha256')
    .update(`${scopeId}\u0000${extensionId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function redactSecretConfiguration(
  contract: ExtensionPackageContractProjection,
  configuration: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(configuration).filter(
        ([key]) => contract.configuration.properties[key]?.secret !== true,
      ),
    ),
  );
}
