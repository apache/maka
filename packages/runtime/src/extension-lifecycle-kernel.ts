import { createHash } from 'node:crypto';
import {
  ExtensionRuntimeContext,
  type ExtensionRuntimeContextDescriptor,
} from './extension-runtime-context.js';

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_ID_LENGTH = 128;

/** Canonical identity shared by Extension manifests, loaders, bindings, and persistence. */
export function isCanonicalExtensionId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

/** Canonical identity for the Session/workspace scope that owns an Extension binding. */
export function isCanonicalExtensionScopeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && SCOPE_ID_PATTERN.test(value);
}

export type ExtensionEffectDisposer = () => void | Promise<void>;

export interface ExtensionDependencyDefinition {
  readonly extensionId: string;
}

export interface ExtensionContributionDefinition {
  readonly id: string;
  readonly kind: string;
}

export interface ExtensionPreparationContext {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly signal: AbortSignal;
  /** Live Context/Fiber that owns this candidate and all of its runtime effects. */
  readonly runtimeContext: ExtensionRuntimeContext;
  ownEffect(label: string, dispose: ExtensionEffectDisposer): void;
}

export interface ExtensionActivationContext extends ExtensionPreparationContext {
  dependency<T = unknown>(extensionId: string): T;
  dependencyRevision(extensionId: string): string;
}

export interface ExtensionActivationResult {
  readonly value?: unknown;
}

export interface PreparedExtension {
  /** Validate candidate-local resources without publishing contributions. */
  healthCheck?(): void | Promise<void>;
  /** Publish activation-owned effects through the candidate Runtime Context. */
  activate(
    context: ExtensionActivationContext,
  ): void | ExtensionActivationResult | Promise<void | ExtensionActivationResult>;
  /** Release candidate-local resources allocated by `prepare`. */
  dispose?(): void | Promise<void>;
}

export interface ExtensionRevisionDefinition {
  readonly extensionId: string;
  readonly revision: string;
  readonly dependencies?: readonly ExtensionDependencyDefinition[];
  readonly contributions?: readonly ExtensionContributionDefinition[];
  /**
   * Definition/install is data-only. The kernel calls `prepare` only when a
   * binding is enabled and all required dependencies are active.
   */
  prepare(context: ExtensionPreparationContext): PreparedExtension | Promise<PreparedExtension>;
}

export interface ExtensionBindingInput {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly revision: string;
}

export type ExtensionBindingStatus =
  | 'stopped'
  | 'waiting'
  | 'preparing'
  | 'health_check'
  | 'activating'
  | 'active'
  | 'failed';

export type ExtensionLifecycleErrorCode =
  | 'invalid_definition'
  | 'revision_already_installed'
  | 'revision_not_installed'
  | 'revision_in_use'
  | 'binding_conflict'
  | 'binding_not_found'
  | 'dependency_cycle'
  | 'prepare_failed'
  | 'health_check_failed'
  | 'activation_failed'
  | 'cleanup_failed';

export interface ExtensionLifecycleDiagnostic {
  readonly code: ExtensionLifecycleErrorCode;
  readonly message: string;
  readonly revision?: string;
  readonly at: number;
}

export interface ExtensionBindingInspection {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly desiredRevision: string;
  readonly enabled: boolean;
  readonly status: ExtensionBindingStatus;
  readonly current?: {
    readonly revision: string;
    readonly generation: number;
  };
  readonly candidate?: {
    readonly revision: string;
    readonly phase: 'preparing' | 'health_check' | 'activating';
  };
  readonly waitingFor: readonly string[];
  readonly pendingCleanupEffects: number;
  readonly diagnostic?: ExtensionLifecycleDiagnostic;
}

export interface ExtensionCompositionEntry {
  readonly bindingId: string;
  readonly extensionId: string;
  readonly revision: string;
  readonly generation: number;
  readonly contributions: readonly ExtensionContributionDefinition[];
}

export interface ExtensionCompositionSnapshot {
  readonly schemaVersion: 1;
  readonly scopeId: string;
  readonly digest: `sha256:${string}`;
  readonly entries: readonly ExtensionCompositionEntry[];
}

export class ExtensionLifecycleOperationError extends Error {
  readonly name = 'ExtensionLifecycleOperationError';

  constructor(
    readonly code: ExtensionLifecycleErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

interface InstalledRevision {
  readonly extensionId: string;
  readonly revision: string;
  readonly dependencies: readonly ExtensionDependencyDefinition[];
  readonly contributions: readonly ExtensionContributionDefinition[];
  readonly prepare: ExtensionRevisionDefinition['prepare'];
}

interface OwnedEffect {
  readonly label: string;
  readonly dispose: ExtensionEffectDisposer;
}

interface EffectCleanupFailure {
  readonly label: string;
  readonly cause: unknown;
}

class EffectCleanupError extends Error {
  readonly name = 'EffectCleanupError';

  constructor(readonly failures: readonly EffectCleanupFailure[]) {
    super(
      `Failed to clean up ${failures.length} extension effect${failures.length === 1 ? '' : 's'}`,
      { cause: failures[0]?.cause },
    );
  }
}

class EffectOwner {
  readonly #effects: OwnedEffect[] = [];
  #accepting = true;

  get size(): number {
    return this.#effects.length;
  }

  own(label: string, dispose: ExtensionEffectDisposer): void {
    if (!this.#accepting) {
      throw new ExtensionLifecycleOperationError(
        'activation_failed',
        `Cannot register effect "${label}" after activation setup completed`,
      );
    }
    if (!label || label.length > 256 || typeof dispose !== 'function') {
      throw new ExtensionLifecycleOperationError(
        'invalid_definition',
        'Extension effects require a non-empty label and disposer',
      );
    }
    this.#effects.push({ label, dispose });
  }

  seal(): void {
    this.#accepting = false;
  }

  async dispose(): Promise<void> {
    this.#accepting = false;
    const failures: EffectCleanupFailure[] = [];
    for (let index = this.#effects.length - 1; index >= 0; index -= 1) {
      const effect = this.#effects[index]!;
      try {
        await effect.dispose();
        this.#effects.splice(index, 1);
      } catch (cause) {
        failures.push({ label: effect.label, cause });
      }
    }
    if (failures.length > 0) throw new EffectCleanupError(Object.freeze(failures));
  }
}

interface CandidateActivation {
  readonly definition: InstalledRevision;
  readonly owner: EffectOwner;
  readonly controller: AbortController;
  readonly runtimeContext: ExtensionRuntimeContext;
  prepared?: PreparedExtension;
  phase: 'preparing' | 'health_check' | 'activating';
}

interface CurrentActivation {
  readonly definition: InstalledRevision;
  readonly owner: EffectOwner;
  readonly generation: number;
  readonly value: unknown;
}

interface BindingRecord {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  desiredRevision: string;
  enabled: boolean;
  status: ExtensionBindingStatus;
  waitingFor: readonly string[];
  current?: CurrentActivation;
  candidate?: CandidateActivation;
  readonly retiredOwners: EffectOwner[];
  diagnostic?: ExtensionLifecycleDiagnostic;
}

interface ReconcileResult {
  readonly errors: Map<string, ExtensionLifecycleOperationError>;
}

/**
 * Product-independent Phase 1 lifecycle authority.
 *
 * Mutations are serialized. Installed revisions are immutable, definition is
 * effect-free, dependencies resolve only inside the same scope, candidates do
 * not replace current until preparation/health/activation succeeds, and every
 * owned effect is disposed in reverse registration order.
 */
export class ExtensionLifecycleKernel {
  readonly #revisions = new Map<string, InstalledRevision>();
  readonly #bindings = new Map<string, BindingRecord>();
  readonly #scopeExtensionBindings = new Map<string, string>();
  readonly #runtimeRoot: ExtensionRuntimeContext;
  readonly #runtimeScopes = new Map<string, ExtensionRuntimeContext>();
  #mutationTail: Promise<void> = Promise.resolve();
  #generation = 0;
  #candidateSequence = 0;

  constructor(
    runtimeRoot = ExtensionRuntimeContext.root(),
    private readonly runtimeScopeParent?: (scopeId: string) => string | undefined,
  ) {
    this.#runtimeRoot = runtimeRoot;
  }

  inspectRuntime(): ExtensionRuntimeContextDescriptor {
    return this.#runtimeRoot.inspect();
  }

  install(definition: ExtensionRevisionDefinition): Promise<void> {
    return this.#mutate(async () => {
      const installed = normalizeDefinition(definition);
      const key = revisionKey(installed.extensionId, installed.revision);
      if (this.#revisions.has(key)) {
        throw new ExtensionLifecycleOperationError(
          'revision_already_installed',
          `Extension revision already installed: ${key}`,
        );
      }
      this.#revisions.set(key, installed);
      await this.#reconcileAllScopes();
    });
  }

  uninstall(extensionId: string, revision: string): Promise<void> {
    return this.#mutate(async () => {
      validateId('extensionId', extensionId);
      validateRevision(revision);
      const key = revisionKey(extensionId, revision);
      if (!this.#revisions.has(key)) {
        throw new ExtensionLifecycleOperationError(
          'revision_not_installed',
          `Extension revision is not installed: ${key}`,
        );
      }
      const user = [...this.#bindings.values()].find(
        (binding) =>
          binding.extensionId === extensionId &&
          (binding.desiredRevision === revision ||
            binding.current?.definition.revision === revision ||
            binding.candidate?.definition.revision === revision),
      );
      if (user) {
        throw new ExtensionLifecycleOperationError(
          'revision_in_use',
          `Extension revision ${key} is still referenced by binding ${user.bindingId}`,
        );
      }
      this.#revisions.delete(key);
    });
  }

  activate(input: ExtensionBindingInput): Promise<ExtensionBindingInspection> {
    return this.#mutate(async () => {
      validateBindingInput(input);
      this.#requireRevision(input.extensionId, input.revision);
      const existing = this.#bindings.get(input.bindingId);
      let record: BindingRecord;
      if (existing) {
        if (existing.scopeId !== input.scopeId || existing.extensionId !== input.extensionId) {
          throw new ExtensionLifecycleOperationError(
            'binding_conflict',
            `Binding ${input.bindingId} cannot change scope or extension identity`,
          );
        }
        record = existing;
        const cleanupFailures = await this.#retryRetiredOwners(record);
        if (cleanupFailures.length > 0) throw cleanupOperationError(cleanupFailures);
        record.desiredRevision = input.revision;
        record.enabled = true;
      } else {
        const scopeKey = scopeExtensionKey(input.scopeId, input.extensionId);
        const owner = this.#scopeExtensionBindings.get(scopeKey);
        if (owner) {
          throw new ExtensionLifecycleOperationError(
            'binding_conflict',
            `Scope ${input.scopeId} already binds extension ${input.extensionId} as ${owner}`,
          );
        }
        record = {
          bindingId: input.bindingId,
          scopeId: input.scopeId,
          extensionId: input.extensionId,
          desiredRevision: input.revision,
          enabled: true,
          status: 'waiting',
          waitingFor: Object.freeze([]),
          retiredOwners: [],
        };
        this.#bindings.set(input.bindingId, record);
        this.#scopeExtensionBindings.set(scopeKey, input.bindingId);
      }
      const result = await this.#reconcileScope(record.scopeId);
      const error = result.errors.get(record.bindingId);
      if (error) throw error;
      return this.#inspectRecord(record);
    });
  }

  update(bindingId: string, revision: string): Promise<ExtensionBindingInspection> {
    return this.#mutate(async () => {
      const record = this.#requireBinding(bindingId);
      const cleanupFailures = await this.#retryRetiredOwners(record);
      if (cleanupFailures.length > 0) throw cleanupOperationError(cleanupFailures);
      validateRevision(revision);
      this.#requireRevision(record.extensionId, revision);
      record.desiredRevision = revision;
      record.enabled = true;
      record.diagnostic = undefined;
      const result = await this.#reconcileScope(record.scopeId);
      const error = result.errors.get(record.bindingId);
      if (error) throw error;
      return this.#inspectRecord(record);
    });
  }

  start(bindingId: string): Promise<ExtensionBindingInspection> {
    return this.#mutate(async () => {
      const record = this.#requireBinding(bindingId);
      const cleanupFailures = await this.#retryRetiredOwners(record);
      if (cleanupFailures.length > 0) throw cleanupOperationError(cleanupFailures);
      record.enabled = true;
      record.diagnostic = undefined;
      const result = await this.#reconcileScope(record.scopeId);
      const error = result.errors.get(record.bindingId);
      if (error) throw error;
      return this.#inspectRecord(record);
    });
  }

  retry(bindingId: string): Promise<ExtensionBindingInspection> {
    return this.start(bindingId);
  }

  stop(bindingId: string): Promise<ExtensionBindingInspection> {
    return this.#mutate(async () => {
      const record = this.#requireBinding(bindingId);
      record.enabled = false;
      record.candidate?.controller.abort();
      const failures = await this.#retryRetiredOwners(record);
      failures.push(...(await this.#deactivateCascade(record, new Set())));
      await this.#reconcileScope(record.scopeId);
      record.waitingFor = Object.freeze([]);
      if (record.retiredOwners.length === 0) {
        record.status = 'stopped';
        record.diagnostic = undefined;
      } else {
        record.status = 'failed';
        record.diagnostic = cleanupDiagnostic(record.desiredRevision, failures);
      }
      if (failures.length > 0) throw cleanupOperationError(failures);
      return this.#inspectRecord(record);
    });
  }

  removeBinding(bindingId: string): Promise<void> {
    return this.#mutate(async () => {
      const record = this.#requireBinding(bindingId);
      record.enabled = false;
      record.candidate?.controller.abort();
      const failures = await this.#retryRetiredOwners(record);
      failures.push(...(await this.#deactivateCascade(record, new Set())));
      if (record.retiredOwners.length > 0 || failures.length > 0) {
        record.status = 'failed';
        record.diagnostic = cleanupDiagnostic(record.desiredRevision, failures);
        throw cleanupOperationError(failures);
      }
      this.#bindings.delete(bindingId);
      this.#scopeExtensionBindings.delete(scopeExtensionKey(record.scopeId, record.extensionId));
      await this.#reconcileScope(record.scopeId);
      if (this.#scopeBindings(record.scopeId).length === 0) {
        const runtimeScope = this.#runtimeScopes.get(record.scopeId);
        if (runtimeScope) await runtimeScope.close();
        this.#runtimeScopes.delete(record.scopeId);
      }
    });
  }

  disposeScope(scopeId: string): Promise<void> {
    return this.#mutate(async () => {
      validateScopeId(scopeId);
      const records = this.#scopeBindings(scopeId);
      for (const record of records) record.enabled = false;
      const failures: EffectCleanupFailure[] = [];
      for (const record of records) {
        failures.push(...(await this.#retryRetiredOwners(record)));
      }
      const visited = new Set<string>();
      for (const record of records) {
        failures.push(...(await this.#deactivateCascade(record, visited)));
      }
      if (records.some((record) => record.retiredOwners.length > 0)) {
        for (const record of records) {
          if (record.retiredOwners.length === 0) continue;
          record.status = 'failed';
          record.diagnostic = cleanupDiagnostic(record.desiredRevision, failures);
        }
        throw cleanupOperationError(failures);
      }
      for (const record of records) {
        this.#bindings.delete(record.bindingId);
        this.#scopeExtensionBindings.delete(scopeExtensionKey(scopeId, record.extensionId));
      }
      const runtimeScope = this.#runtimeScopes.get(scopeId);
      if (runtimeScope) {
        await runtimeScope.close();
        this.#runtimeScopes.delete(scopeId);
      }
    });
  }

  inspect(bindingId: string): ExtensionBindingInspection {
    return this.#inspectRecord(this.#requireBinding(bindingId));
  }

  inspectScope(scopeId: string): readonly ExtensionBindingInspection[] {
    validateScopeId(scopeId);
    return Object.freeze(this.#scopeBindings(scopeId).map((record) => this.#inspectRecord(record)));
  }

  installedRevisions(): readonly {
    readonly extensionId: string;
    readonly revision: string;
  }[] {
    return Object.freeze(
      [...this.#revisions.values()]
        .map(({ extensionId, revision }) => Object.freeze({ extensionId, revision }))
        .sort(compareExtensionRevision),
    );
  }

  composition(scopeId: string): ExtensionCompositionSnapshot {
    validateScopeId(scopeId);
    const entries = this.#scopeBindings(scopeId)
      .flatMap((binding): ExtensionCompositionEntry[] => {
        const current = binding.current;
        if (!current) return [];
        return [
          Object.freeze({
            bindingId: binding.bindingId,
            extensionId: binding.extensionId,
            revision: current.definition.revision,
            generation: current.generation,
            contributions: current.definition.contributions,
          }),
        ];
      })
      .sort((left, right) => compareString(left.extensionId, right.extensionId));
    const digestInput = entries.map((entry) => ({
      bindingId: entry.bindingId,
      extensionId: entry.extensionId,
      revision: entry.revision,
      contributions: entry.contributions,
    }));
    const digest = createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
    return Object.freeze({
      schemaVersion: 1,
      scopeId,
      digest: `sha256:${digest}`,
      entries: Object.freeze(entries),
    });
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #reconcileAllScopes(): Promise<void> {
    const scopes = [...new Set([...this.#bindings.values()].map((binding) => binding.scopeId))];
    for (const scope of scopes.sort(compareString)) await this.#reconcileScope(scope);
  }

  async #reconcileScope(scopeId: string): Promise<ReconcileResult> {
    const errors = new Map<string, ExtensionLifecycleOperationError>();
    const attempted = new Set<string>();
    const cycles = this.#dependencyCycles(scopeId);
    for (const bindingId of cycles) {
      const record = this.#bindings.get(bindingId)!;
      const error = new ExtensionLifecycleOperationError(
        'dependency_cycle',
        `Extension dependency cycle includes binding ${bindingId}`,
      );
      record.status = 'failed';
      record.waitingFor = Object.freeze([]);
      record.diagnostic = diagnostic(error, record.desiredRevision);
      errors.set(bindingId, error);
      attempted.add(bindingId);
    }

    let progress = true;
    while (progress) {
      progress = false;
      for (const record of this.#scopeBindings(scopeId)) {
        if (!record.enabled || attempted.has(record.bindingId)) continue;
        if (record.retiredOwners.length > 0) {
          record.status = 'failed';
          continue;
        }
        const definition = this.#requireRevision(record.extensionId, record.desiredRevision);
        const waitingFor = this.#missingDependencies(record, definition);
        if (waitingFor.length > 0) {
          record.status = 'waiting';
          record.waitingFor = Object.freeze(waitingFor);
          continue;
        }
        record.waitingFor = Object.freeze([]);
        if (record.current?.definition.revision === record.desiredRevision) {
          record.status = 'active';
          continue;
        }
        attempted.add(record.bindingId);
        try {
          if (record.current) await this.#updateCurrent(record, definition);
          else await this.#activateInitial(record, definition);
          record.status = 'active';
          record.diagnostic = undefined;
          progress = true;
        } catch (cause) {
          const error = asLifecycleError(cause);
          record.status = record.current ? 'active' : 'failed';
          record.diagnostic = diagnostic(error, definition.revision);
          errors.set(record.bindingId, error);
          // Candidate activation can temporarily stop dependents; one more pass
          // restores them against the still-current revision.
          if (record.current) progress = true;
        }
      }
    }
    return { errors };
  }

  async #activateInitial(record: BindingRecord, definition: InstalledRevision): Promise<void> {
    const candidate = await this.#prepareCandidate(record, definition);
    try {
      const activation = await this.#activateCandidate(record, candidate);
      record.current = activation;
      record.candidate = undefined;
    } catch (cause) {
      await this.#discardCandidate(record, candidate, cause);
    }
  }

  async #updateCurrent(record: BindingRecord, definition: InstalledRevision): Promise<void> {
    const current = record.current!;
    const candidate = await this.#prepareCandidate(record, definition);
    const dependentCleanupFailures = await this.#deactivateDependents(record, new Set());
    if (dependentCleanupFailures.length > 0) {
      return this.#discardCandidate(
        record,
        candidate,
        new ExtensionLifecycleOperationError(
          'cleanup_failed',
          'Cannot activate candidate because a dependent did not stop cleanly',
          { cause: dependentCleanupFailures[0]?.cause },
        ),
      );
    }
    let activation: CurrentActivation;
    try {
      activation = await this.#activateCandidate(record, candidate);
    } catch (cause) {
      return this.#discardCandidate(record, candidate, cause);
    }
    record.current = activation;
    record.candidate = undefined;
    const cleanupFailures = await this.#disposeOwner(record, current.owner);
    if (cleanupFailures.length > 0) {
      throw cleanupOperationError(
        cleanupFailures,
        'Candidate committed, but old activation cleanup failed',
      );
    }
  }

  async #prepareCandidate(
    record: BindingRecord,
    definition: InstalledRevision,
  ): Promise<CandidateActivation> {
    const owner = new EffectOwner();
    const runtimeScope = this.#runtimeScope(record.scopeId);
    const runtimeContext = runtimeScope.fork({
      id: `${record.bindingId}:${++this.#candidateSequence}`,
      kind: 'plugin',
      label: `${definition.extensionId}@${definition.revision}`,
      replacementKey: record.bindingId,
      status: 'preparing',
    });
    const candidate: CandidateActivation = {
      definition,
      owner,
      controller: new AbortController(),
      runtimeContext,
      phase: 'preparing',
    };
    owner.own('runtime-context', () => runtimeContext.close());
    record.candidate = candidate;
    record.status = 'preparing';
    try {
      const prepared = await definition.prepare(
        this.#preparationContext(record, definition, candidate),
      );
      if (!prepared || typeof prepared !== 'object' || typeof prepared.activate !== 'function') {
        throw new ExtensionLifecycleOperationError(
          'invalid_definition',
          `Extension ${definition.extensionId}@${definition.revision} returned an invalid candidate`,
        );
      }
      candidate.prepared = prepared;
      if (prepared.dispose) runtimeContext.own('prepared.dispose', () => prepared.dispose!());
      candidate.phase = 'health_check';
      record.status = 'health_check';
      await prepared.healthCheck?.();
      return candidate;
    } catch (cause) {
      const phaseCode =
        candidate.phase === 'health_check' ? 'health_check_failed' : 'prepare_failed';
      const error =
        cause instanceof ExtensionLifecycleOperationError
          ? cause
          : new ExtensionLifecycleOperationError(
              phaseCode,
              `Extension candidate ${definition.extensionId}@${definition.revision} ${candidate.phase} failed`,
              { cause },
            );
      return this.#discardCandidate(record, candidate, error);
    }
  }

  async #activateCandidate(
    record: BindingRecord,
    candidate: CandidateActivation,
  ): Promise<CurrentActivation> {
    const prepared = candidate.prepared!;
    candidate.phase = 'activating';
    record.status = 'activating';
    try {
      const result = await prepared.activate(this.#activationContext(record, candidate));
      candidate.runtimeContext.activate();
      candidate.owner.seal();
      return {
        definition: candidate.definition,
        owner: candidate.owner,
        generation: ++this.#generation,
        value: result?.value,
      };
    } catch (cause) {
      throw cause instanceof ExtensionLifecycleOperationError
        ? cause
        : new ExtensionLifecycleOperationError(
            'activation_failed',
            `Extension candidate ${candidate.definition.extensionId}@${candidate.definition.revision} activation failed: ${errorMessage(cause)}`,
            { cause },
          );
    }
  }

  async #discardCandidate(
    record: BindingRecord,
    candidate: CandidateActivation,
    cause: unknown,
  ): Promise<never> {
    candidate.controller.abort();
    candidate.owner.seal();
    record.candidate = undefined;
    const cleanupFailures = await this.#disposeOwner(record, candidate.owner);
    if (cleanupFailures.length > 0) {
      throw cleanupOperationError(
        cleanupFailures,
        'Candidate failed and cleanup was incomplete',
        cause,
      );
    }
    throw cause;
  }

  #preparationContext(
    record: BindingRecord,
    definition: InstalledRevision,
    candidate: CandidateActivation,
  ): ExtensionPreparationContext {
    return Object.freeze({
      bindingId: record.bindingId,
      scopeId: record.scopeId,
      extensionId: record.extensionId,
      revision: definition.revision,
      signal: candidate.controller.signal,
      runtimeContext: candidate.runtimeContext,
      ownEffect: (label: string, dispose: ExtensionEffectDisposer) => {
        if (!label || label.length > 256 || typeof dispose !== 'function') {
          throw new ExtensionLifecycleOperationError(
            'invalid_definition',
            'Extension effects require a non-empty label and disposer',
          );
        }
        try {
          candidate.runtimeContext.own(label, dispose);
        } catch (cause) {
          throw new ExtensionLifecycleOperationError(
            'activation_failed',
            `Cannot register effect "${label}" after its Runtime Context stopped`,
            { cause },
          );
        }
      },
    });
  }

  #runtimeScope(scopeId: string): ExtensionRuntimeContext {
    let context = this.#runtimeScopes.get(scopeId);
    if (!context) {
      const parentScopeId = this.runtimeScopeParent?.(scopeId);
      if (parentScopeId === scopeId) {
        throw new ExtensionLifecycleOperationError(
          'invalid_definition',
          `Extension Runtime Context cannot parent scope ${scopeId} to itself`,
        );
      }
      const parent = parentScopeId ? this.#runtimeScope(parentScopeId) : this.#runtimeRoot;
      context = parent.fork({ id: scopeId, kind: 'scope', label: `scope:${scopeId}` });
      this.#runtimeScopes.set(scopeId, context);
    }
    return context;
  }

  #activationContext(
    record: BindingRecord,
    candidate: CandidateActivation,
  ): ExtensionActivationContext {
    const base = this.#preparationContext(record, candidate.definition, candidate);
    const dependency = <T = unknown>(extensionId: string): T => {
      const activation = this.#dependencyActivation(record.scopeId, extensionId);
      if (!activation) {
        throw new ExtensionLifecycleOperationError(
          'activation_failed',
          `Required dependency ${extensionId} is no longer active`,
        );
      }
      return activation.value as T;
    };
    return Object.freeze({
      ...base,
      dependency,
      dependencyRevision: (extensionId: string) => {
        const activation = this.#dependencyActivation(record.scopeId, extensionId);
        if (!activation) {
          throw new ExtensionLifecycleOperationError(
            'activation_failed',
            `Required dependency ${extensionId} is no longer active`,
          );
        }
        return activation.definition.revision;
      },
    });
  }

  #missingDependencies(record: BindingRecord, definition: InstalledRevision): string[] {
    return definition.dependencies
      .filter((dependency) => !this.#dependencyActivation(record.scopeId, dependency.extensionId))
      .map((dependency) => dependency.extensionId)
      .sort(compareString);
  }

  #dependencyActivation(scopeId: string, extensionId: string): CurrentActivation | undefined {
    const bindingId = this.#scopeExtensionBindings.get(scopeExtensionKey(scopeId, extensionId));
    return bindingId ? this.#bindings.get(bindingId)?.current : undefined;
  }

  #dependencyCycles(scopeId: string): Set<string> {
    const records = this.#scopeBindings(scopeId).filter((record) => record.enabled);
    const byExtension = new Map(records.map((record) => [record.extensionId, record]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];
    const cycles = new Set<string>();
    const visit = (record: BindingRecord): void => {
      if (visited.has(record.bindingId)) return;
      if (visiting.has(record.bindingId)) {
        const start = stack.indexOf(record.bindingId);
        for (const bindingId of stack.slice(start)) cycles.add(bindingId);
        return;
      }
      visiting.add(record.bindingId);
      stack.push(record.bindingId);
      const definition = this.#revisions.get(
        revisionKey(record.extensionId, record.desiredRevision),
      );
      for (const dependency of definition?.dependencies ?? []) {
        const target = byExtension.get(dependency.extensionId);
        if (target) visit(target);
      }
      stack.pop();
      visiting.delete(record.bindingId);
      visited.add(record.bindingId);
    };
    for (const record of records) visit(record);
    return cycles;
  }

  async #deactivateDependents(
    record: BindingRecord,
    visited: Set<string>,
  ): Promise<EffectCleanupFailure[]> {
    const failures: EffectCleanupFailure[] = [];
    for (const dependent of this.#activeDependents(record)) {
      failures.push(...(await this.#deactivateCascade(dependent, visited)));
    }
    return failures;
  }

  async #deactivateCascade(
    record: BindingRecord,
    visited: Set<string>,
  ): Promise<EffectCleanupFailure[]> {
    if (visited.has(record.bindingId)) return [];
    visited.add(record.bindingId);
    const failures = await this.#deactivateDependents(record, visited);
    if (record.current) failures.push(...(await this.#stopCurrent(record)));
    record.waitingFor = record.enabled
      ? Object.freeze(this.#missingDependencies(record, this.#desiredDefinition(record)))
      : Object.freeze([]);
    if (record.retiredOwners.length > 0) {
      record.status = 'failed';
      record.diagnostic = cleanupDiagnostic(record.desiredRevision, failures);
    } else {
      record.status = record.enabled ? 'waiting' : 'stopped';
    }
    return failures;
  }

  #activeDependents(record: BindingRecord): BindingRecord[] {
    return this.#scopeBindings(record.scopeId).filter((candidate) => {
      const definition = candidate.current?.definition;
      return definition?.dependencies.some(
        (dependency) => dependency.extensionId === record.extensionId,
      );
    });
  }

  async #stopCurrent(record: BindingRecord): Promise<EffectCleanupFailure[]> {
    const current = record.current;
    if (!current) return [];
    record.current = undefined;
    return this.#disposeOwner(record, current.owner);
  }

  async #disposeOwner(record: BindingRecord, owner: EffectOwner): Promise<EffectCleanupFailure[]> {
    try {
      await owner.dispose();
      return [];
    } catch (cause) {
      if (owner.size > 0 && !record.retiredOwners.includes(owner)) record.retiredOwners.push(owner);
      return cleanupFailures(cause);
    }
  }

  async #retryRetiredOwners(record: BindingRecord): Promise<EffectCleanupFailure[]> {
    const failures: EffectCleanupFailure[] = [];
    for (let index = record.retiredOwners.length - 1; index >= 0; index -= 1) {
      const owner = record.retiredOwners[index]!;
      try {
        await owner.dispose();
        record.retiredOwners.splice(index, 1);
      } catch (cause) {
        failures.push(...cleanupFailures(cause));
      }
    }
    return failures;
  }

  #desiredDefinition(record: BindingRecord): InstalledRevision {
    return this.#requireRevision(record.extensionId, record.desiredRevision);
  }

  #requireRevision(extensionId: string, revision: string): InstalledRevision {
    const key = revisionKey(extensionId, revision);
    const definition = this.#revisions.get(key);
    if (!definition) {
      throw new ExtensionLifecycleOperationError(
        'revision_not_installed',
        `Extension revision is not installed: ${key}`,
      );
    }
    return definition;
  }

  #requireBinding(bindingId: string): BindingRecord {
    validateId('bindingId', bindingId);
    const record = this.#bindings.get(bindingId);
    if (!record) {
      throw new ExtensionLifecycleOperationError(
        'binding_not_found',
        `Extension binding not found: ${bindingId}`,
      );
    }
    return record;
  }

  #scopeBindings(scopeId: string): BindingRecord[] {
    return [...this.#bindings.values()]
      .filter((binding) => binding.scopeId === scopeId)
      .sort((left, right) => compareString(left.bindingId, right.bindingId));
  }

  #inspectRecord(record: BindingRecord): ExtensionBindingInspection {
    const pendingCleanupEffects = record.retiredOwners.reduce((sum, owner) => sum + owner.size, 0);
    return Object.freeze({
      bindingId: record.bindingId,
      scopeId: record.scopeId,
      extensionId: record.extensionId,
      desiredRevision: record.desiredRevision,
      enabled: record.enabled,
      status: record.status,
      ...(record.current
        ? {
            current: Object.freeze({
              revision: record.current.definition.revision,
              generation: record.current.generation,
            }),
          }
        : {}),
      ...(record.candidate
        ? {
            candidate: Object.freeze({
              revision: record.candidate.definition.revision,
              phase: record.candidate.phase,
            }),
          }
        : {}),
      waitingFor: Object.freeze([...record.waitingFor]),
      pendingCleanupEffects,
      ...(record.diagnostic ? { diagnostic: Object.freeze({ ...record.diagnostic }) } : {}),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function normalizeDefinition(definition: ExtensionRevisionDefinition): InstalledRevision {
  if (!definition || typeof definition !== 'object') invalidDefinition('Definition is required');
  validateId('extensionId', definition.extensionId);
  validateRevision(definition.revision);
  if (typeof definition.prepare !== 'function') invalidDefinition('Definition requires prepare');
  const dependencies = [...(definition.dependencies ?? [])].map((dependency) => {
    validateId('dependency.extensionId', dependency.extensionId);
    if (dependency.extensionId === definition.extensionId) {
      invalidDefinition('An extension cannot depend on itself');
    }
    return Object.freeze({ extensionId: dependency.extensionId });
  });
  dependencies.sort((left, right) => compareString(left.extensionId, right.extensionId));
  if (
    new Set(dependencies.map((dependency) => dependency.extensionId)).size !== dependencies.length
  ) {
    invalidDefinition('Extension dependencies must be unique');
  }
  const contributions = [...(definition.contributions ?? [])].map((contribution) => {
    validateId('contribution.id', contribution.id);
    validateId('contribution.kind', contribution.kind);
    return Object.freeze({ id: contribution.id, kind: contribution.kind });
  });
  contributions.sort((left, right) => compareString(left.id, right.id));
  if (new Set(contributions.map((contribution) => contribution.id)).size !== contributions.length) {
    invalidDefinition('Extension contribution IDs must be unique');
  }
  return Object.freeze({
    extensionId: definition.extensionId,
    revision: definition.revision,
    dependencies: Object.freeze(dependencies),
    contributions: Object.freeze(contributions),
    prepare: definition.prepare,
  });
}

function validateBindingInput(input: ExtensionBindingInput): void {
  if (!input || typeof input !== 'object') invalidDefinition('Binding input is required');
  validateId('bindingId', input.bindingId);
  validateScopeId(input.scopeId);
  validateId('extensionId', input.extensionId);
  validateRevision(input.revision);
}

function validateScopeId(value: string): void {
  if (!isCanonicalExtensionScopeId(value)) {
    invalidDefinition(`Invalid scopeId: ${String(value)}`);
  }
}

function validateId(label: string, value: string): void {
  if (!isCanonicalExtensionId(value)) {
    invalidDefinition(`Invalid ${label}: ${String(value)}`);
  }
}

function validateRevision(revision: string): void {
  if (
    typeof revision !== 'string' ||
    revision.length === 0 ||
    revision.length > MAX_ID_LENGTH ||
    /[\r\n]/.test(revision)
  ) {
    invalidDefinition(`Invalid revision: ${String(revision)}`);
  }
}

function invalidDefinition(message: string): never {
  throw new ExtensionLifecycleOperationError('invalid_definition', message);
}

function revisionKey(extensionId: string, revision: string): string {
  return `${extensionId}@${revision}`;
}

function scopeExtensionKey(scopeId: string, extensionId: string): string {
  return `${scopeId}\u0000${extensionId}`;
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareExtensionRevision(
  left: { extensionId: string; revision: string },
  right: { extensionId: string; revision: string },
): number {
  return (
    compareString(left.extensionId, right.extensionId) ||
    compareString(left.revision, right.revision)
  );
}

function asLifecycleError(cause: unknown): ExtensionLifecycleOperationError {
  return cause instanceof ExtensionLifecycleOperationError
    ? cause
    : new ExtensionLifecycleOperationError('activation_failed', 'Extension activation failed', {
        cause,
      });
}

function diagnostic(
  error: ExtensionLifecycleOperationError,
  revision?: string,
): ExtensionLifecycleDiagnostic {
  return Object.freeze({
    code: error.code,
    message: error.message,
    ...(revision ? { revision } : {}),
    at: Date.now(),
  });
}

function cleanupDiagnostic(
  revision: string,
  failures: readonly EffectCleanupFailure[],
): ExtensionLifecycleDiagnostic {
  return diagnostic(cleanupOperationError(failures), revision);
}

function cleanupFailures(cause: unknown): EffectCleanupFailure[] {
  return cause instanceof EffectCleanupError ? [...cause.failures] : [{ label: 'unknown', cause }];
}

function cleanupOperationError(
  failures: readonly EffectCleanupFailure[],
  message = 'Extension effect cleanup failed',
  cause?: unknown,
): ExtensionLifecycleOperationError {
  return new ExtensionLifecycleOperationError('cleanup_failed', message, {
    cause: cause ?? failures[0]?.cause,
  });
}
