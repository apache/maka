import type { ExtensionBindingInspection } from '@maka/runtime/extension-lifecycle-kernel';
import {
  type ExtensionBindingProjection,
  type ExtensionCatalogMutateInput,
  type ExtensionCatalogMutateResult,
  type ExtensionCatalogQueryResult,
  type OperationOutcome,
} from '../protocol/index.js';
import type { ExtensionOperationHandlerMap } from './operation-dispatcher.js';
import {
  HostExtensionLoaderError,
  type HostTrustedToolExtensionLoader,
} from './extension-loader.js';
import { HostExtensionRuntime } from './extension-runtime.js';
import {
  HostExtensionStateStore,
  HostExtensionStateStoreError,
  type PersistedExtensionBinding,
} from './extension-state-store.js';

type MutationFailureCode =
  | 'host_draining'
  | 'not_found'
  | 'operation_conflict'
  | 'persistence_failed'
  | 'commit_outcome_unknown';

/** Durable control plane that converges persisted desired bindings into the Host runtime. */
export class HostExtensionController {
  readonly handlers: ExtensionOperationHandlerMap = {
    'extension.catalog.query': () => this.#query(),
    'extension.catalog.mutate': (input) => this.#mutate(input),
  };

  readonly #bindings = new Map<string, PersistedExtensionBinding>();
  #mutationTail: Promise<void> = Promise.resolve();
  #recovered = false;
  #draining = false;
  #persistenceFailure: HostExtensionStateStoreError | undefined;

  constructor(
    private readonly runtime: HostExtensionRuntime,
    private readonly loader: HostTrustedToolExtensionLoader,
    private readonly store: HostExtensionStateStore,
    private readonly requestDrain: () => void,
  ) {}

  /** Recovery is fail-open for the Host and fail-closed for Extension mutations. */
  async recover(): Promise<void> {
    if (this.#recovered) return;
    try {
      for (const binding of await this.store.read()) this.#bindings.set(binding.bindingId, binding);
      await this.#recoverEnabledBindings();
      await this.#refreshRuntimeState();
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
      revisions: this.loader.list(),
      bindings: this.#bindingProjections(),
    };
    return { ok: true, result };
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
    this.#bindings.set(
      input.bindingId,
      bindingState({
        bindingId: input.bindingId,
        scopeId: input.scopeId,
        extensionId: input.extensionId,
        desiredRevision: input.revision,
        lastGoodRevision: current?.lastGoodRevision ?? null,
        enabled: true,
        error: null,
      }),
    );
    const committed = await this.#commitDesiredState();
    if (committed) return committed;
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
    this.#bindings.set(
      bindingId,
      bindingState({ ...binding, desiredRevision: revision, enabled: true, error: null }),
    );
    const committed = await this.#commitDesiredState();
    if (committed) return committed;
    return this.#convergeMutation(bindingId);
  }

  async #disable(bindingId: string): Promise<OperationOutcome<'extension.catalog.mutate'>> {
    const binding = this.#bindings.get(bindingId);
    if (!binding) return mutationFailure('not_found', `Extension binding not found: ${bindingId}`);
    this.#bindings.set(bindingId, bindingState({ ...binding, enabled: false, error: null }));
    const committed = await this.#commitDesiredState();
    if (committed) return committed;
    try {
      if (this.#tryInspect(bindingId)) await this.runtime.stop(bindingId);
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
    try {
      if (this.#tryInspect(bindingId)) await this.runtime.removeBinding(bindingId);
      this.#bindings.delete(bindingId);
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
      let activeRevision: string | null = null;
      if (binding.lastGoodRevision) {
        try {
          await this.#ensureInstalled(binding.extensionId, binding.lastGoodRevision);
          await this.runtime.activate({
            bindingId: binding.bindingId,
            scopeId: binding.scopeId,
            extensionId: binding.extensionId,
            revision: binding.lastGoodRevision,
          });
          activeRevision = binding.lastGoodRevision;
        } catch (error) {
          this.#bindings.set(
            binding.bindingId,
            bindingState({ ...binding, error: boundedErrorMessage(error) }),
          );
        }
      }
      if (activeRevision === binding.desiredRevision) continue;
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
    if (!inspection) {
      await this.runtime.activate({
        bindingId: binding.bindingId,
        scopeId: binding.scopeId,
        extensionId: binding.extensionId,
        revision: binding.desiredRevision,
      });
      return;
    }
    if (inspection.desiredRevision !== binding.desiredRevision) {
      await this.runtime.update(bindingId, binding.desiredRevision);
      return;
    }
    if (!inspection.enabled) await this.runtime.start(bindingId);
    else if (inspection.current?.revision !== binding.desiredRevision) {
      await this.runtime.update(bindingId, binding.desiredRevision);
    }
  }

  async #ensureInstalled(extensionId: string, revision: string): Promise<void> {
    if (
      this.runtime
        .installedRevisions()
        .some((item) => item.extensionId === extensionId && item.revision === revision)
    ) {
      return;
    }
    await this.runtime.installTrustedToolRevision(await this.loader.load(extensionId, revision));
  }

  async #garbageCollectRevisions(): Promise<void> {
    const retained = new Set(
      [...this.#bindings.values()].flatMap((binding) =>
        uniqueRevisions(binding).map((revision) => revisionKey(binding.extensionId, revision)),
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
      const currentRevision = inspection.current?.revision;
      const error = inspection.diagnostic?.message ?? binding.error;
      this.#bindings.set(
        binding.bindingId,
        bindingState({
          ...binding,
          ...(currentRevision ? { lastGoodRevision: currentRevision } : {}),
          error:
            currentRevision === binding.desiredRevision && !inspection.diagnostic ? null : error,
        }),
      );
    }
  }

  #tryInspect(bindingId: string): ExtensionBindingInspection | undefined {
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

  async #commitDesiredState(): Promise<OperationOutcome<'extension.catalog.mutate'> | undefined> {
    try {
      await this.#persist();
      return undefined;
    } catch (error) {
      const failure = asPersistenceFailure(error);
      if (failure.code === 'commit_outcome_unknown') this.requestDrain();
      return mutationFailure(failure.code, failure.message);
    }
  }

  async #persist(): Promise<void> {
    await this.store.replace([...this.#bindings.values()].sort(compareBinding));
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
      lastGoodRevision: binding.lastGoodRevision,
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
  inspection: ExtensionBindingInspection | undefined,
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
  return [...new Set([binding.lastGoodRevision, binding.desiredRevision].filter(isString))];
}

function isString(value: string | null): value is string {
  return value !== null;
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

function asPersistenceFailure(error: unknown): HostExtensionStateStoreError {
  return error instanceof HostExtensionStateStoreError
    ? error
    : new HostExtensionStateStoreError('persistence_failed', 'Extension state is unavailable', {
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

function mutationFailure(
  code: MutationFailureCode,
  message: string,
): OperationOutcome<'extension.catalog.mutate'> {
  return { ok: false, error: { code, message } };
}

function compareBinding(
  left: Pick<PersistedExtensionBinding, 'bindingId'>,
  right: Pick<PersistedExtensionBinding, 'bindingId'>,
): number {
  return compareString(left.bindingId, right.bindingId);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function revisionKey(extensionId: string, revision: string): string {
  return `${extensionId}\u0000${revision}`;
}
