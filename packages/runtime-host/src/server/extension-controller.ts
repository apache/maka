import type {
  MakaCompositionEntry,
  MakaCompositionSnapshot,
  MakaPluginMountInspection,
  MakaPluginRootId,
} from '@maka/runtime/plugin-runtime';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { createHash } from 'node:crypto';
import {
  type ExtensionCompositionEntryProjection,
  type ExtensionCompositionMutateInput,
  type ExtensionCompositionMutateResult,
  type ExtensionCompositionQueryResult,
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
import { validateExtensionConfiguration } from './extension-package-manifest.js';

type MutationFailureCode =
  | 'host_draining'
  | 'not_found'
  | 'operation_conflict'
  | 'persistence_failed'
  | 'commit_outcome_unknown';

interface CompositionEntryState {
  readonly entryId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly enabled: boolean;
  readonly error: string | null;
  readonly config: Readonly<Record<string, string | number | boolean>>;
}

/** Durable control plane that converges persisted desired entries into the Host runtime. */
export class HostExtensionController {
  readonly handlers: ExtensionOperationHandlerMap = {
    'extension.composition.query': () => this.#query(),
    'extension.composition.mutate': (input) => this.#mutate(input),
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

  readonly #entries = new CompositionEntryIndex(
    () => this.#persistedComposition,
    (composition) => {
      this.#persistedComposition = composition;
    },
  );
  #mutationTail: Promise<void> = Promise.resolve();
  #recovered = false;
  #draining = false;
  #persistenceFailure: HostPluginCompositionStoreError | undefined;
  #compositionGeneration = 0;
  #persistedComposition: PersistedPluginComposition = emptyComposition();

  constructor(
    private readonly runtime: HostExtensionRuntime,
    private readonly loader: HostTrustedToolExtensionLoader,
    private readonly store: HostPluginCompositionStore,
    private readonly requestDrain: () => void,
    private readonly uiState = new HostExtensionUiStateStore(),
    private readonly uiPackages?: PluginPackageStore,
  ) {
    this.loader.setConfigurationResolver?.((entryId) => this.#configurationForEntry(entryId));
    this.loader.setEventEmitter?.((scopeId, event, payload, context) =>
      this.runtime.emitEvent(scopeId, event, payload, context),
    );
    this.loader.setServiceCaller?.((scopeId, service, method, input, context) =>
      this.runtime.callService(scopeId, service, method, input, context),
    );
    this.loader.setUiStatePublisher?.((extensionId, key, value) =>
      this.#publishToolVisualization(extensionId, key, value),
    );
  }

  resolveTool(scopeId: string, name: string): MakaTool | undefined {
    return this.runtime.resolveTools(scopeId, []).find((tool) => tool.name === name);
  }

  emitEvent(scopeId: string, event: string, payload: unknown, context: MakaToolContext) {
    return this.runtime.emitEvent(scopeId, event, payload, invocationContext(context));
  }

  callService(
    scopeId: string,
    service: string,
    method: string,
    input: unknown,
    context: MakaToolContext,
  ) {
    return this.runtime.callService(scopeId, service, method, input, {
      ...invocationContext(context),
      callerExtensionId: 'maka.host',
    });
  }

  async publishUiState(extensionId: string, key: string, value: unknown): Promise<void> {
    const matches = this.runtime
      .inspectUi('desktop-ui')
      .filter((item) => item.extensionId === extensionId);
    if (matches.length === 0) {
      throw new Error(`Active Desktop UI Extension was not found: ${extensionId}`);
    }
    if (!matches.some((item) => item.hostState)) {
      throw new Error(`Active Desktop UI Extension does not allow Host state: ${extensionId}`);
    }
    await this.#publishToolVisualization(extensionId, key, value);
  }

  async #publishToolVisualization(extensionId: string, key: string, value: unknown): Promise<void> {
    const admitted = this.runtime
      .inspectUi('desktop-ui')
      .filter((item) => item.extensionId === extensionId && item.hostState);
    await Promise.all(
      admitted.map((item) =>
        this.uiState.set(
          'desktop-ui',
          item.entryId,
          key,
          value as Parameters<HostExtensionUiStateStore['set']>[3],
        ),
      ),
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
        for (const [, entry] of persistedEntries(composition)) {
          if (!entry.packageId || entry.disabled) continue;
          await this.#ensureInstalled(entry.packageId);
        }
        const hasPersistedFailures = [...persistedEntries(composition)].some(
          ([, entry]) => entry.error,
        );
        if (hasPersistedFailures) await this.#recoverCompositionEntries(composition);
        else {
          try {
            await this.runtime.replaceCompositionSnapshot(runtimeSnapshot(composition));
          } catch {
            await this.#recoverCompositionEntries(composition);
          }
        }
      }
      await this.#recoverEnabledEntries();
      await this.#refreshRuntimeState();
      await this.#pruneOrphanDependencyEntries();
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

  async #query(): Promise<OperationOutcome<'extension.composition.query'>> {
    if (this.#persistenceFailure) {
      return queryFailure('persistence_failed', 'Extension state is unavailable');
    }
    const result: ExtensionCompositionQueryResult = {
      extensions: await this.loader.list(),
      entries: this.#entryProjections(),
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
    const entry = this.#readEntryState(input.entryId);
    if (!entry) {
      return { ok: false, error: { code: 'not_found', message: 'Extension entry not found' } };
    }
    try {
      const contract = await this.#requireContract(entry.extensionId);
      const configuration = validateExtensionConfiguration(
        contract.configuration,
        this.#configurationForEntry(input.entryId),
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
      const entry = this.#entries.get(input.entryId);
      if (!entry) {
        return { ok: false, error: { code: 'not_found', message: 'Extension entry not found' } };
      }
      let configuration: Readonly<Record<string, string | number | boolean>>;
      try {
        const contract = await this.#requireContract(entry.extensionId);
        configuration = validateExtensionConfiguration(contract.configuration, input.configuration);
      } catch (error) {
        return {
          ok: false,
          error: { code: 'invalid_request', message: boundedErrorMessage(error) },
        };
      }
      const previous = entry;
      this.#entries.set(input.entryId, entryState({ ...entry, config: configuration }));
      try {
        await this.#persist();
        if (entry.enabled && this.#tryInspect(entry.entryId)) {
          await this.#applyComposition({
            operations: [
              {
                type: 'update',
                entryId: entry.entryId,
                patch: { config: configuration },
              },
            ],
          });
          await this.#refreshRuntimeState();
          await this.#persist();
        }
        const contract = await this.#requireContract(entry.extensionId);
        const result: ExtensionConfigurationMutateResult = {
          configuration: redactSecretConfiguration(contract, configuration),
        };
        return { ok: true, result };
      } catch (error) {
        this.#entries.set(input.entryId, previous);
        await this.#persist().catch(() => undefined);
        if (entry.enabled) await this.#convergeEntry(entry.entryId).catch(() => undefined);
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
          entryId: item.entryId,
          extensionId: item.extensionId,
          generation: item.generation,
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
        input.entryId,
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
                .set(input.scopeId, input.entryId, input.key, input.value)
                .then(() => true)
            : await this.uiState.delete(input.scopeId, input.entryId, input.key);
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
      const installed = await this.uiPackages.loadUi(input.extensionId);
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
    const entry = this.#readEntryState(input.entryId);
    if (!entry) return { code: 'not_found', message: 'UI Extension entry is not installed' };
    const current = this.runtime.inspect(input.entryId).current;
    if (
      !entry.enabled ||
      entry.scopeId !== input.scopeId ||
      entry.extensionId !== input.extensionId ||
      current?.generation !== input.generation
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
          item.entryId === input.entryId &&
          item.extensionId === input.extensionId &&
          item.generation === input.generation &&
          item.hostState,
      );
    return admitted
      ? undefined
      : { code: 'invalid_request', message: 'UI Extension did not declare Host state permission' };
  }

  #authorizeUiRpc(
    input: ExtensionUiRpcInvokeInput,
  ): { code: 'not_found' | 'invalid_request'; message: string } | undefined {
    const entry = this.#readEntryState(input.entryId);
    if (!entry) return { code: 'not_found', message: 'UI Extension entry is not installed' };
    const current = this.runtime.inspect(input.entryId).current;
    if (
      !entry.enabled ||
      entry.scopeId !== input.scopeId ||
      entry.extensionId !== input.extensionId ||
      current?.generation !== input.generation
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
          item.entryId === input.entryId &&
          item.extensionId === input.extensionId &&
          item.generation === input.generation &&
          item.hostMethods.includes(input.method),
      );
    return admitted
      ? undefined
      : {
          code: 'invalid_request',
          message: 'UI Host method is not declared by the active Fiber',
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
      const referenced = [...this.#entries.values()].find(
        (entry) => entry.extensionId === input.extensionId,
      );
      if (referenced) {
        return packageFailure(
          'operation_conflict',
          `Tool package is retained by entry ${referenced.entryId}`,
        );
      }
      try {
        if (
          this.runtime.installedExtensions().some((item) => item.extensionId === input.extensionId)
        ) {
          await this.runtime.uninstall(input.extensionId);
        }
        await this.loader.uninstallPackage(input.extensionId);
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
        await this.loader.exportPackage(input.extensionId, input.targetPath);
        const result: ExtensionPackageExportResult = { targetPath: input.targetPath };
        return { ok: true, result };
      } catch (error) {
        const failure = packageLoaderFailure(error, 'export');
        return failure;
      }
    });
  }

  #mutate(
    input: ExtensionCompositionMutateInput,
  ): Promise<OperationOutcome<'extension.composition.mutate'>> {
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
          return this.#disable(input.entryId);
        case 'reload':
          return this.#reload(input.entryId);
        case 'remove':
          return this.#remove(input.entryId);
      }
    });
  }

  async #enable(
    input: Extract<ExtensionCompositionMutateInput, { kind: 'enable' }>,
  ): Promise<OperationOutcome<'extension.composition.mutate'>> {
    const available = await this.#requireAvailable(input.extensionId);
    if (available) return available;
    const current = this.#entries.get(input.entryId);
    if (
      current &&
      (current.scopeId !== input.scopeId || current.extensionId !== input.extensionId)
    ) {
      return mutationFailure(
        'operation_conflict',
        `Entry ${input.entryId} cannot change scope or Extension identity`,
      );
    }
    const compositionSnapshot = this.#persistedComposition;
    let dependencyEntries: readonly string[];
    let configuration: Readonly<Record<string, string | number | boolean>>;
    try {
      const contract = await this.#requireContract(input.extensionId);
      dependencyEntries = await this.#stageDependencies(input.scopeId, contract, new Set());
      configuration = validateExtensionConfiguration(contract.configuration, current?.config);
    } catch (error) {
      this.#persistedComposition = compositionSnapshot;
      return mutationFailure('operation_conflict', boundedErrorMessage(error));
    }
    this.#entries.set(
      input.entryId,
      entryState({
        entryId: input.entryId,
        scopeId: input.scopeId,
        extensionId: input.extensionId,
        enabled: true,
        error: null,
        config: configuration,
      }),
    );
    const committed = await this.#commitDesiredState(compositionSnapshot);
    if (committed) return committed;
    for (const dependencyEntryId of dependencyEntries) {
      const dependency = await this.#convergeMutation(dependencyEntryId);
      if (!dependency.ok) return dependency;
    }
    return this.#convergeMutation(input.entryId);
  }

  async #reload(entryId: string): Promise<OperationOutcome<'extension.composition.mutate'>> {
    const entry = this.#entries.get(entryId);
    if (!entry) return mutationFailure('not_found', `Extension entry not found: ${entryId}`);
    const available = await this.#requireAvailable(entry.extensionId);
    if (available) return available;
    const compositionSnapshot = this.#persistedComposition;
    let dependencyEntries: readonly string[];
    let configuration: Readonly<Record<string, string | number | boolean>>;
    try {
      const contract = await this.#requireContract(entry.extensionId);
      dependencyEntries = await this.#stageDependencies(entry.scopeId, contract, new Set());
      configuration = validateExtensionConfiguration(contract.configuration, entry.config);
      // Like DSH's loader, reload the plugin definition and let the Fiber
      // replacement transaction keep the old Fiber alive on activation failure.
      await this.runtime.installExtension(await this.loader.load(entry.extensionId));
    } catch (error) {
      this.#persistedComposition = compositionSnapshot;
      return mutationFailure('operation_conflict', boundedErrorMessage(error));
    }
    this.#entries.set(
      entryId,
      entryState({
        ...entry,
        enabled: true,
        error: null,
        config: configuration,
      }),
    );
    const committed = await this.#commitDesiredState(compositionSnapshot);
    if (committed) return committed;
    for (const dependencyEntryId of dependencyEntries) {
      const dependency = await this.#convergeMutation(dependencyEntryId);
      if (!dependency.ok) return dependency;
    }
    return this.#convergeMutation(entryId);
  }

  async #disable(entryId: string): Promise<OperationOutcome<'extension.composition.mutate'>> {
    const entry = this.#entries.get(entryId);
    if (!entry) return mutationFailure('not_found', `Extension entry not found: ${entryId}`);
    let dependent: CompositionEntryState | undefined;
    try {
      dependent = await this.#requiredBy(entry);
    } catch (error) {
      return mutationFailure('operation_conflict', boundedErrorMessage(error));
    }
    if (dependent) {
      return mutationFailure(
        'operation_conflict',
        `Extension entry ${entryId} is required by ${dependent.entryId}`,
      );
    }
    const compositionSnapshot = this.#persistedComposition;
    this.#entries.set(entryId, entryState({ ...entry, enabled: false, error: null }));
    const committed = await this.#commitDesiredState(compositionSnapshot);
    if (committed) return committed;
    try {
      if (this.#tryInspect(entryId)) {
        await this.#applyComposition({
          operations: [{ type: 'update', entryId: entryId, patch: { disabled: true } }],
        });
      }
      await this.#pruneOrphanDependencyEntries();
      await this.#refreshRuntimeState();
      const persisted = await this.#commitDesiredState();
      return persisted ?? mutationSuccess(this.#projection(entryId));
    } catch (error) {
      return this.#recordRuntimeFailure(entryId, error);
    }
  }

  async #remove(entryId: string): Promise<OperationOutcome<'extension.composition.mutate'>> {
    const entry = this.#entries.get(entryId);
    if (!entry) return mutationFailure('not_found', `Extension entry not found: ${entryId}`);
    let dependent: CompositionEntryState | undefined;
    try {
      dependent = await this.#requiredBy(entry);
    } catch (error) {
      return mutationFailure('operation_conflict', boundedErrorMessage(error));
    }
    if (dependent) {
      return mutationFailure(
        'operation_conflict',
        `Extension entry ${entryId} is required by ${dependent.entryId}`,
      );
    }
    const compositionSnapshot = this.#persistedComposition;
    this.#entries.delete(entryId);
    const committed = await this.#commitDesiredState(compositionSnapshot);
    if (committed) return committed;
    try {
      if (this.#tryInspect(entryId)) {
        await this.#applyComposition({
          operations: [{ type: 'remove', entryId: entryId }],
        });
      }
      await this.uiState.clear(entry.scopeId, entry.entryId);
      await this.#pruneOrphanDependencyEntries();
      const persisted = await this.#commitDesiredState();
      return persisted ?? mutationSuccess(null);
    } catch (error) {
      return mutationFailure('operation_conflict', boundedErrorMessage(error));
    }
  }

  async #convergeMutation(
    entryId: string,
  ): Promise<OperationOutcome<'extension.composition.mutate'>> {
    try {
      await this.#convergeEntry(entryId);
      await this.#refreshRuntimeState();
      await this.#pruneOrphanDependencyEntries();
      const persisted = await this.#commitDesiredState();
      return persisted ?? mutationSuccess(this.#projection(entryId));
    } catch (error) {
      return this.#recordRuntimeFailure(entryId, error);
    }
  }

  async #recordRuntimeFailure(
    entryId: string,
    error: unknown,
  ): Promise<OperationOutcome<'extension.composition.mutate'>> {
    const entry = this.#entries.get(entryId);
    if (entry) {
      this.#entries.set(entryId, entryState({ ...entry, error: boundedErrorMessage(error) }));
    }
    const persisted = await this.#commitDesiredState();
    return persisted ?? mutationFailure('operation_conflict', boundedErrorMessage(error));
  }

  async #recoverEnabledEntries(): Promise<void> {
    const enabled = [...this.#entries.values()]
      .filter((entry) => entry.enabled && !entry.error)
      .sort(compareEntry);
    for (const entry of enabled) {
      try {
        await this.#ensureInstalled(entry.extensionId);
      } catch (error) {
        this.#entries.set(
          entry.entryId,
          entryState({ ...entry, error: boundedErrorMessage(error) }),
        );
      }
    }
    for (const original of enabled) {
      const entry = this.#entries.get(original.entryId)!;
      try {
        await this.#convergeEntry(entry.entryId);
      } catch (error) {
        const latest = this.#entries.get(entry.entryId)!;
        this.#entries.set(
          entry.entryId,
          entryState({ ...latest, error: boundedErrorMessage(error) }),
        );
      }
    }
  }

  async #convergeEntry(entryId: string): Promise<void> {
    const entry = this.#entries.get(entryId);
    if (!entry || !entry.enabled) return;
    await this.#ensureInstalled(entry.extensionId);
    const inspection = this.#tryInspect(entryId);
    const rootId: MakaPluginRootId =
      entry.scopeId === 'profile'
        ? 'profile'
        : entry.scopeId === 'desktop-ui'
          ? 'desktop-ui'
          : `session:${entry.scopeId}`;
    await this.#applyComposition({
      operations: inspection
        ? [
            {
              type: 'update',
              entryId: entry.entryId,
              patch: {
                packageId: entry.extensionId,
                disabled: false,
                config: this.#configurationForEntry(entry.entryId),
              },
            },
          ]
        : [
            {
              type: 'insert',
              rootId,
              entry: {
                id: entry.entryId,
                packageId: entry.extensionId,
                config: this.#configurationForEntry(entry.entryId),
              },
            },
          ],
    });
  }

  async #ensureInstalled(extensionId: string): Promise<void> {
    if (this.runtime.installedExtensions().some((item) => item.extensionId === extensionId)) {
      return;
    }
    await this.runtime.installExtension(await this.loader.load(extensionId));
  }

  async #recoverCompositionEntries(composition: PersistedPluginComposition): Promise<void> {
    const roots: readonly (readonly [MakaPluginRootId, readonly PersistedPluginEntry[]])[] = [
      ['profile', composition.roots.profile],
      ['desktop-ui', composition.roots.desktopUi],
      ...Object.entries(composition.roots.sessions).map(
        ([scopeId, entries]) => [`session:${scopeId}` as MakaPluginRootId, entries] as const,
      ),
    ];
    for (const [rootId, entries] of roots)
      for (const entry of entries) await this.#recoverCompositionEntry(rootId, entry);
  }

  async #recoverCompositionEntry(
    rootId: MakaPluginRootId,
    entry: PersistedPluginEntry,
    parentId?: string,
  ): Promise<void> {
    try {
      await this.runtime.applyComposition({
        operations: [
          {
            type: 'insert',
            rootId,
            parentId,
            entry: persistedRuntimeEntry(entry),
          },
        ],
      });
    } catch (error) {
      const currentEntry = this.#entries.get(entry.id);
      if (currentEntry)
        this.#entries.set(
          entry.id,
          entryState({ ...currentEntry, error: boundedErrorMessage(error) }),
        );
      return;
    }
    for (const child of entry.children ?? [])
      await this.#recoverCompositionEntry(rootId, child, entry.id);
  }

  async #refreshRuntimeState(): Promise<void> {
    for (const entry of [...this.#entries.values()]) {
      const inspection = this.#tryInspect(entry.entryId);
      if (!inspection) continue;
      const error = inspection.diagnostic?.message ?? entry.error;
      this.#entries.set(
        entry.entryId,
        entryState({
          ...entry,
          error: !inspection.diagnostic && inspection.status === 'active' ? null : error,
        }),
      );
    }
  }

  #tryInspect(entryId: string): MakaPluginMountInspection | undefined {
    try {
      return this.runtime.inspect(entryId);
    } catch {
      return undefined;
    }
  }

  async #applyComposition(
    input: Parameters<HostExtensionRuntime['applyComposition']>[0],
  ): Promise<void> {
    await this.runtime.applyComposition(input);
  }

  #configurationForEntry(entryId: string): Readonly<Record<string, string | number | boolean>> {
    return this.#readEntryState(entryId)?.config ?? Object.freeze({});
  }

  #readEntryState(entryId: string): CompositionEntryState | undefined {
    return this.#entries.get(entryId);
  }

  async #requireAvailable(
    extensionId: string,
  ): Promise<OperationOutcome<'extension.composition.mutate'> | undefined> {
    try {
      await this.loader.load(extensionId);
      return undefined;
    } catch (error) {
      if (error instanceof HostExtensionLoaderError && error.code === 'not_found') {
        return mutationFailure('not_found', error.message);
      }
      return mutationFailure('operation_conflict', boundedErrorMessage(error));
    }
  }

  async #requireContract(extensionId: string): Promise<ExtensionPackageContractProjection> {
    const contracts = this.loader.contracts ? await this.loader.contracts() : [];
    const contract = contracts.find((candidate) => candidate.extensionId === extensionId);
    if (!contract) {
      throw new Error(`Extension contract is unavailable: ${extensionId}`);
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
        const selected = contracts.find((candidate) => candidate.extensionId === dependency.id);
        if (!selected) {
          throw new Error(`Required dependency is not installed: ${dependency.id}`);
        }
        const existing = [...this.#entries.values()].find(
          (entry) => entry.scopeId === scopeId && entry.extensionId === dependency.id,
        );
        const entryId = existing?.entryId ?? dependencyEntryId(scopeId, dependency.id);
        if (existing) {
          if (!existing.enabled) {
            this.#entries.set(entryId, entryState({ ...existing, enabled: true, error: null }));
          }
        } else {
          this.#entries.set(
            entryId,
            entryState({
              entryId,
              scopeId,
              extensionId: selected.extensionId,
              enabled: true,
              error: null,
              config: validateExtensionConfiguration(selected.configuration, undefined),
            }),
          );
        }
        const stagedEntry = this.#entries.get(entryId);
        if (stagedEntry) {
          this.#entries.set(
            entryId,
            entryState({
              ...stagedEntry,
              config: validateExtensionConfiguration(selected.configuration, stagedEntry.config),
            }),
          );
        }
        staged.push(...(await this.#stageDependencies(scopeId, selected, visiting)), entryId);
      }
      return Object.freeze([...new Set(staged)]);
    } finally {
      visiting.delete(contract.extensionId);
    }
  }

  async #requiredBy(target: CompositionEntryState): Promise<CompositionEntryState | undefined> {
    const contracts = this.loader.contracts ? await this.loader.contracts() : [];
    return [...this.#entries.values()].find((entry) => {
      if (!entry.enabled || entry.entryId === target.entryId) return false;
      if (entry.scopeId !== target.scopeId) return false;
      const contract = contracts.find((candidate) => candidate.extensionId === entry.extensionId);
      return contract?.dependencies.some((dependency) => dependency.id === target.extensionId);
    });
  }

  async #pruneOrphanDependencyEntries(): Promise<void> {
    const contracts = this.loader.contracts ? await this.loader.contracts() : [];
    const required = new Set<string>();
    const visit = (entry: CompositionEntryState, visiting: Set<string>): void => {
      if (visiting.has(entry.entryId)) return;
      visiting.add(entry.entryId);
      const contract = contracts.find((candidate) => candidate.extensionId === entry.extensionId);
      for (const dependency of contract?.dependencies ?? []) {
        const dependencyEntry = [...this.#entries.values()].find(
          (candidate) =>
            candidate.enabled &&
            candidate.scopeId === entry.scopeId &&
            candidate.extensionId === dependency.id,
        );
        if (!dependencyEntry) continue;
        required.add(dependencyEntry.entryId);
        visit(dependencyEntry, visiting);
      }
      visiting.delete(entry.entryId);
    };
    for (const entry of this.#entries.values()) {
      if (entry.enabled && !entry.entryId.startsWith('dependency_')) {
        visit(entry, new Set());
      }
    }
    for (const entry of [...this.#entries.values()]) {
      if (!entry.entryId.startsWith('dependency_') || required.has(entry.entryId)) continue;
      if (this.#tryInspect(entry.entryId)) {
        await this.#applyComposition({
          operations: [{ type: 'remove', entryId: entry.entryId }],
        });
      }
      this.#entries.delete(entry.entryId);
    }
  }

  async #commitDesiredState(
    rollback?: PersistedPluginComposition,
  ): Promise<OperationOutcome<'extension.composition.mutate'> | undefined> {
    try {
      await this.#persist();
      return undefined;
    } catch (error) {
      const failure = asPersistenceFailure(error);
      if (failure.code === 'commit_outcome_unknown') this.requestDrain();
      else if (rollback) this.#persistedComposition = rollback;
      return mutationFailure(
        failure.code === 'invalid_state' ? 'persistence_failed' : failure.code,
        failure.message,
      );
    }
  }

  async #persist(): Promise<void> {
    const snapshot: PersistedPluginComposition = {
      schemaVersion: 1,
      generation: ++this.#compositionGeneration,
      roots: this.#persistedComposition.roots,
    };
    await this.store.replace(snapshot);
    this.#persistedComposition = snapshot;
  }

  #entryProjections(): readonly ExtensionCompositionEntryProjection[] {
    const entryIds = persistedEntries(this.#persistedComposition)
      .filter(([, entry]) => entry.packageId)
      .map(([, entry]) => entry.id);
    return entryIds.sort(compareString).map((entryId) => this.#projection(entryId));
  }

  #projection(entryId: string): ExtensionCompositionEntryProjection {
    const entry = this.#readEntryState(entryId);
    if (!entry) throw new Error(`Extension entry not found: ${entryId}`);
    const inspection = this.#tryInspect(entryId);
    return {
      entryId: entry.entryId,
      scopeId: entry.scopeId,
      extensionId: entry.extensionId,
      generation: inspection?.current?.generation ?? 1,
      enabled: entry.enabled,
      status: projectStatus(entry, inspection),
      error: entry.error,
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

function invocationContext(context: MakaToolContext) {
  return {
    sessionId: context.sessionId,
    ...(context.runId ? { runId: context.runId } : {}),
    turnId: context.turnId,
    cwd: context.cwd,
    permissionMode: context.permissionMode ?? 'default',
    origin: 'provider' as const,
    configuration: Object.freeze({}),
    signal: context.abortSignal,
  };
}

class CompositionEntryIndex {
  constructor(
    private readonly read: () => PersistedPluginComposition,
    private readonly write: (composition: PersistedPluginComposition) => void,
  ) {}

  get(entryId: string): CompositionEntryState | undefined {
    const persisted = persistedEntries(this.read()).find(([, entry]) => entry.id === entryId);
    return persisted ? compositionEntryState(...persisted) : undefined;
  }

  values(): IterableIterator<CompositionEntryState> {
    return persistedEntries(this.read())
      .flatMap(([scopeId, entry]) => {
        const state = compositionEntryState(scopeId, entry);
        return state ? [state] : [];
      })
      .values();
  }

  set(entryId: string, state: CompositionEntryState): void {
    if (entryId !== state.entryId) throw new Error('Composition entry identity is immutable');
    const composition = this.read();
    const entry = persistedEntryState(state);
    const updated = replacePersistedEntry(composition, entryId, entry);
    this.write(updated ?? appendPersistedEntry(composition, state.scopeId, entry));
  }

  delete(entryId: string): void {
    this.write(removePersistedEntry(this.read(), entryId));
  }
}

function projectStatus(
  entry: CompositionEntryState,
  inspection: MakaPluginMountInspection | undefined,
): ExtensionCompositionEntryProjection['status'] {
  if (!entry.enabled) return 'disabled';
  if (entry.error || inspection?.status === 'failed') return 'failed';
  if (inspection?.current) return 'active';
  return 'waiting';
}

function entryState(entry: CompositionEntryState): CompositionEntryState {
  return Object.freeze({ ...entry });
}

function compositionEntryState(
  scopeId: string,
  entry: PersistedPluginEntry,
): CompositionEntryState | undefined {
  if (!entry.packageId) return undefined;
  return entryState({
    entryId: entry.id,
    scopeId,
    extensionId: entry.packageId,
    enabled: !entry.disabled,
    error: entry.error ?? null,
    config: entry.config,
  });
}

function persistedEntryState(state: CompositionEntryState): PersistedPluginEntry {
  return Object.freeze({
    id: state.entryId,
    packageId: state.extensionId,
    disabled: !state.enabled,
    config: state.config,
    error: state.error,
  });
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
  entry: ExtensionCompositionEntryProjection | null,
): OperationOutcome<'extension.composition.mutate'> {
  const result: ExtensionCompositionMutateResult = { entry };
  return { ok: true, result };
}

function queryFailure(
  code: 'persistence_failed',
  message: string,
): OperationOutcome<'extension.composition.query'> {
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
): OperationOutcome<'extension.composition.mutate'> {
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

function compareEntry(
  left: Pick<CompositionEntryState, 'entryId'>,
  right: Pick<CompositionEntryState, 'entryId'>,
): number {
  return compareString(left.entryId, right.entryId);
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

function emptyComposition(): PersistedPluginComposition {
  return Object.freeze({
    schemaVersion: 1,
    generation: 0,
    roots: Object.freeze({
      profile: Object.freeze([]),
      desktopUi: Object.freeze([]),
      sessions: Object.freeze({}),
    }),
  });
}

function replacePersistedEntry(
  composition: PersistedPluginComposition,
  entryId: string,
  replacement: PersistedPluginEntry,
): PersistedPluginComposition | undefined {
  const update = (
    entries: readonly PersistedPluginEntry[],
  ): readonly PersistedPluginEntry[] | undefined => {
    let changed = false;
    const next = entries.map((entry) => {
      if (entry.id === entryId) {
        changed = true;
        return Object.freeze({ ...entry, ...replacement });
      }
      const children = update(entry.children ?? []);
      if (!children) return entry;
      changed = true;
      return Object.freeze({ ...entry, children });
    });
    return changed ? Object.freeze(next) : undefined;
  };
  const profile = update(composition.roots.profile);
  if (profile) return replaceCompositionRoots(composition, { profile });
  const desktopUi = update(composition.roots.desktopUi);
  if (desktopUi) return replaceCompositionRoots(composition, { desktopUi });
  for (const [scopeId, entries] of Object.entries(composition.roots.sessions)) {
    const session = update(entries);
    if (session) {
      return replaceCompositionRoots(composition, {
        sessions: Object.freeze({ ...composition.roots.sessions, [scopeId]: session }),
      });
    }
  }
  return undefined;
}

function appendPersistedEntry(
  composition: PersistedPluginComposition,
  scopeId: string,
  entry: PersistedPluginEntry,
): PersistedPluginComposition {
  if (scopeId === 'profile') {
    return replaceCompositionRoots(composition, {
      profile: Object.freeze([...composition.roots.profile, entry]),
    });
  }
  if (scopeId === 'desktop-ui') {
    return replaceCompositionRoots(composition, {
      desktopUi: Object.freeze([...composition.roots.desktopUi, entry]),
    });
  }
  return replaceCompositionRoots(composition, {
    sessions: Object.freeze({
      ...composition.roots.sessions,
      [scopeId]: Object.freeze([...(composition.roots.sessions[scopeId] ?? []), entry]),
    }),
  });
}

function removePersistedEntry(
  composition: PersistedPluginComposition,
  entryId: string,
): PersistedPluginComposition {
  const remove = (
    entries: readonly PersistedPluginEntry[],
  ): readonly PersistedPluginEntry[] | undefined => {
    let changed = false;
    const next = entries.flatMap((entry) => {
      if (entry.id === entryId) {
        changed = true;
        return [];
      }
      const children = remove(entry.children ?? []);
      if (!children) return [entry];
      changed = true;
      return [Object.freeze({ ...entry, children })];
    });
    return changed ? Object.freeze(next) : undefined;
  };
  const profile = remove(composition.roots.profile);
  const desktopUi = remove(composition.roots.desktopUi);
  const sessions = Object.entries(composition.roots.sessions).map(([scopeId, entries]) => {
    const next = remove(entries);
    return [scopeId, next ?? entries] as const;
  });
  if (
    !profile &&
    !desktopUi &&
    sessions.every(([scopeId, entries]) => entries === composition.roots.sessions[scopeId])
  ) {
    return composition;
  }
  return replaceCompositionRoots(composition, {
    profile: profile ?? composition.roots.profile,
    desktopUi: desktopUi ?? composition.roots.desktopUi,
    sessions: Object.freeze(Object.fromEntries(sessions)),
  });
}

function replaceCompositionRoots(
  composition: PersistedPluginComposition,
  patch: Partial<PersistedPluginComposition['roots']>,
): PersistedPluginComposition {
  return Object.freeze({
    ...composition,
    roots: Object.freeze({ ...composition.roots, ...patch }),
  });
}

function runtimeSnapshot(composition: PersistedPluginComposition): MakaCompositionSnapshot {
  const convert = (entry: PersistedPluginEntry): MakaCompositionEntry =>
    persistedRuntimeEntry(entry);
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

function persistedRuntimeEntry(entry: PersistedPluginEntry): MakaCompositionEntry {
  return Object.freeze({
    id: entry.id,
    ...(entry.packageId ? { packageId: entry.packageId } : {}),
    config: entry.config,
    disabled: entry.disabled,
    ...(entry.inject === undefined ? {} : { inject: entry.inject }),
    ...(entry.isolate === undefined ? {} : { isolate: entry.isolate }),
    ...(entry.intercept === undefined ? {} : { intercept: entry.intercept }),
    ...(entry.children === undefined
      ? {}
      : { children: Object.freeze(entry.children.map(persistedRuntimeEntry)) }),
  });
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dependencyEntryId(scopeId: string, extensionId: string): string {
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
