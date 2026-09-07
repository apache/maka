/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import {
  MakaCompositionLoader,
  type MakaCompositionRecoveryFailure,
} from '@maka/runtime/plugin-composition-loader';
import {
  applyCompositionState,
  MakaPluginRuntimeError,
  type MakaCompositionApplyInput,
  type MakaCompositionEntry,
  type MakaCompositionEntryInspection,
  type MakaCompositionOperation,
  type MakaCompositionState,
  type MakaPluginPackage,
  type MakaPluginRootId,
} from '@maka/runtime/plugin-runtime';
import type { ExtensionPackageManifest } from './extension-package-manifest.js';
import { validateExtensionConfiguration } from './extension-package-manifest.js';
import { recoverExtensionBundleImports } from './extension-bundle.js';
import { loadPluginCompositionPatch } from './plugin-composition-patch.js';
import {
  HostPluginCompositionStore,
  HostPluginCompositionStoreError,
  type PersistedPluginComposition,
} from './plugin-composition-store.js';
import { TrustedPluginPackageLoader } from './plugin-package-loader.js';
import { PluginPackageStore, PluginPackageStoreError } from './plugin-package-store.js';
import type {
  PluginMutationReceipt,
  PluginPackageProjection,
  PluginPlatformConvergence,
  PluginPlatformPhase,
} from '../protocol/plugin-platform.js';

export class HostPluginPlatformError extends Error {
  readonly name = 'HostPluginPlatformError';

  constructor(
    readonly code:
      | 'closed'
      | 'persistence_failed'
      | 'commit_outcome_unknown'
      | 'recovery_failed'
      | 'mutation_failed'
      | 'not_ready'
      | 'stale_cursor',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface HostPluginPlatformOptions {
  readonly composition?: MakaCompositionLoader;
  readonly packages?: PluginPackageStore;
  readonly packageLoader?: TrustedPluginPackageLoader;
  readonly store?: HostPluginCompositionStore;
}

export interface HostPluginPlatformFailure {
  readonly entryId?: string;
  readonly extensionId?: string;
  readonly diagnostic: string;
}

interface CompositionEntryRecord {
  readonly entry: MakaCompositionEntry;
  readonly rootId: MakaPluginRootId;
  readonly disabled: boolean;
}

interface DesiredProjection {
  readonly desired: MakaCompositionState;
  readonly failures: readonly HostPluginPlatformFailure[];
  readonly structuralDependencies: ReadonlyMap<string, ReadonlySet<string>>;
}

interface PackageOverride {
  readonly extensionId: string;
  readonly patch: MakaCompositionApplyInput | undefined;
  readonly manifest: ExtensionPackageManifest;
}

/**
 * Runtime Host's sole authority for trusted Plugin packages and Entry composition.
 * Package layers and user overlays are durable; the desired Entry Tree is derived from them.
 */
export class HostPluginPlatform {
  readonly #composition: MakaCompositionLoader;
  readonly #packages: PluginPackageStore;
  readonly #packageLoader: TrustedPluginPackageLoader;
  readonly #store: HostPluginCompositionStore;

  #authority: PersistedPluginComposition = emptyCompositionAuthority();
  #desired: MakaCompositionState = emptyCompositionState();
  #mutation: Promise<void> = Promise.resolve();
  #phase: PluginPlatformPhase = 'new';
  #recoveryStarted = false;
  #recoveryComplete = false;
  #drainRequested = false;
  #convergence: PluginPlatformConvergence = 'unknown';
  #fence?: Error;
  #reconcileTimer?: ReturnType<typeof setTimeout>;
  #reconcileDelayMs = 250;
  #failures: readonly HostPluginPlatformFailure[] = Object.freeze([]);
  #structuralDependencies: ReadonlyMap<string, ReadonlySet<string>> = new Map();

  constructor(
    readonly controlDirectory: string,
    options: HostPluginPlatformOptions = {},
  ) {
    this.#composition = options.composition ?? new MakaCompositionLoader();
    this.#packages = options.packages ?? new PluginPackageStore(controlDirectory);
    this.#packageLoader =
      options.packageLoader ?? new TrustedPluginPackageLoader(controlDirectory, this.#packages);
    this.#store = options.store ?? new HostPluginCompositionStore(controlDirectory);
  }

  async recover(): Promise<void> {
    if (
      this.#recoveryStarted ||
      (this.#phase !== 'new' && !(this.#phase === 'draining' && this.#drainRequested))
    ) {
      throw new HostPluginPlatformError(
        'recovery_failed',
        `Plugin Platform cannot recover from phase ${this.#phase}`,
      );
    }
    this.#recoveryStarted = true;
    if (!this.#drainRequested) this.#phase = 'recovering';
    await this.#serialize(async () => {
      try {
        const storedAuthority = (await this.#store.read()) ?? emptyCompositionAuthority();
        await recoverExtensionBundleImports(this.controlDirectory);
        await this.#packages.recover(storedAuthority.generation);
        await this.#packageLoader.collectGarbage();
        const packageFailures: HostPluginPlatformFailure[] = [];
        for (const extensionId of await this.#packages.identities()) {
          let loaded: MakaPluginPackage | undefined;
          try {
            loaded = await this.#packageLoader.load(extensionId);
            await this.#composition.install(loaded);
          } catch (error) {
            if (loaded) await this.#packageLoader.release(loaded).catch(() => undefined);
            packageFailures.push(
              Object.freeze({
                extensionId,
                diagnostic: boundedDiagnostic(error),
              }),
            );
          }
        }
        const projection = await this.#deriveDesired(storedAuthority, 'recovery');
        const entryFailures = await this.#recoverDesiredRuntime(projection.desired);
        this.#failures = Object.freeze([
          ...packageFailures,
          ...projection.failures,
          ...entryFailures.map((failure) =>
            Object.freeze({ entryId: failure.entryId, diagnostic: failure.diagnostic }),
          ),
        ]);
        this.#authority = storedAuthority;
        this.#desired = projection.desired;
        this.#structuralDependencies = projection.structuralDependencies;
        this.#convergence = this.#failures.length > 0 ? 'diverged' : 'converged';
        this.#recoveryComplete = true;
        this.#phase = this.#drainRequested
          ? 'draining'
          : this.#failures.length > 0
            ? 'degraded'
            : 'ready';
        if (this.#failures.length > 0) this.#scheduleReconcile();
      } catch (error) {
        this.#fence = asError(error);
        this.#recoveryComplete = true;
        this.#phase = 'fenced';
        this.#convergence = 'unknown';
      }
    });
  }

  async installPackage(
    sourcePath: string,
  ): Promise<PluginMutationReceipt & { readonly extensionId: string }> {
    this.#assertMutable();
    return await this.#serializeMutable(async () => {
      let prepared;
      try {
        prepared = await this.#packages.prepareInstall(sourcePath);
      } catch (error) {
        if (error instanceof PluginPackageStoreError && error.code === 'commit_outcome_unknown') {
          throw this.#fenceUnknownPackageOutcome(error, 'preparation');
        }
        throw error;
      }
      let loaded: MakaPluginPackage | undefined;
      let authorityCommitted = false;
      let packageCommitted = false;
      let runtimeAdoptionStarted = false;
      try {
        const compositionPatch = await loadPluginCompositionPatch(prepared.installed);
        loaded = await this.#packageLoader.loadInstalled(prepared.installed);
        const alreadyInstalled = this.#composition
          .installedPackages()
          .some(({ packageId }) => packageId === prepared.installed.extensionId);
        const layerPlan = await this.#planPackageLayer(
          prepared.installed.extensionId,
          compositionPatch,
          prepared.installed.manifest,
        );
        await prepared.publish(this.#authority.generation, layerPlan.planned.generation);
        await this.#commitDesiredAuthority(
          layerPlan.planned,
          layerPlan.packageLayers,
          this.#authority.overlays,
        );
        authorityCommitted = true;
        this.#structuralDependencies = layerPlan.structuralDependencies;
        await prepared.commit();
        packageCommitted = true;
        this.#clearPackageFailure(prepared.installed.extensionId);
        runtimeAdoptionStarted = true;
        const failures = await this.#adoptRuntimePackage(
          prepared.installed.extensionId,
          loaded,
          layerPlan.planned,
          alreadyInstalled,
        );
        await this.#publishEntryFailures(failures);
        this.#settleConvergence(failures.length === 0);
        return Object.freeze({
          extensionId: prepared.installed.extensionId,
          ...this.#receipt('complete'),
        });
      } catch (error) {
        if (authorityCommitted) {
          if (loaded && !runtimeAdoptionStarted) {
            await this.#packageLoader.release(loaded).catch(() => undefined);
          }
          this.#recordPackageFailure(prepared.installed.extensionId, error);
          this.#settleConvergence(false);
          return Object.freeze({
            extensionId: prepared.installed.extensionId,
            ...this.#receipt(packageCommitted ? 'complete' : 'pending'),
          });
        }
        if (error instanceof PluginPackageStoreError && error.code === 'commit_outcome_unknown') {
          if (loaded) await this.#packageLoader.release(loaded).catch(() => undefined);
          throw this.#fenceUnknownPackageOutcome(error, 'publication');
        }
        if (error instanceof HostPluginPlatformError && error.code === 'commit_outcome_unknown') {
          if (loaded) await this.#packageLoader.release(loaded).catch(() => undefined);
          throw error;
        }
        try {
          await prepared.rollback();
        } catch (rollbackError) {
          if (loaded) await this.#packageLoader.release(loaded).catch(() => undefined);
          if (
            rollbackError instanceof PluginPackageStoreError &&
            rollbackError.code === 'commit_outcome_unknown'
          ) {
            throw this.#fenceUnknownPackageOutcome(rollbackError, 'rollback');
          }
          this.#fence = asError(rollbackError);
          this.#phase = 'fenced';
          throw new HostPluginPlatformError(
            'persistence_failed',
            'Plugin package installation and stored-package rollback both failed',
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
        if (loaded) await this.#packageLoader.release(loaded).catch(() => undefined);
        throw error;
      }
    });
  }

  async reloadPackage(extensionId: string): Promise<PluginMutationReceipt> {
    this.#assertMutable();
    return await this.#serializeMutable(async () => {
      const loaded = await this.#packageLoader.load(extensionId);
      let adoptionStarted = false;
      try {
        await this.#validateDesired(this.desiredComposition());
        adoptionStarted = true;
        const failures = await this.#adoptRuntimePackage(extensionId, loaded, this.#desired, true);
        await this.#publishEntryFailures(failures);
        this.#clearPackageFailure(extensionId);
        this.#settleConvergence(failures.length === 0);
      } catch (error) {
        if (!adoptionStarted) await this.#packageLoader.release(loaded).catch(() => undefined);
        this.#recordPackageFailure(extensionId, error);
        this.#settleConvergence(false);
      }
      return this.#receipt('complete');
    });
  }

  async uninstallPackage(extensionId: string): Promise<PluginMutationReceipt> {
    this.#assertMutable();
    return await this.#serializeMutable(async () => {
      const structuralDependent = this.#structuralDependent(extensionId);
      if (structuralDependent) {
        throw new MakaPluginRuntimeError(
          'package_in_use',
          `Plugin package is structurally required by ${structuralDependent}`,
        );
      }
      const manifestDependent = await this.#manifestDependentPackage(extensionId);
      if (manifestDependent) {
        throw new MakaPluginRuntimeError(
          'package_in_use',
          `Plugin package is required by package ${manifestDependent}`,
        );
      }
      const packageLayers = this.#authority.packageLayers.filter((item) => item !== extensionId);
      const candidateAuthority = compositionAuthority(
        this.#authority.generation +
          (packageLayers.length === this.#authority.packageLayers.length ? 0 : 1),
        packageLayers,
        this.#authority.overlays,
      );
      const projection = await this.#deriveDesired(candidateAuthority, 'strict');
      const desiredUser = compositionEntries(projection.desired).find(
        (entry) => entry.packageId === extensionId,
      );
      if (desiredUser) {
        throw new MakaPluginRuntimeError(
          'package_in_use',
          `Plugin package is used by desired entry ${desiredUser.id}`,
        );
      }
      const dependent = await this.#desiredPackageDependent(extensionId, projection.desired);
      if (dependent) {
        throw new MakaPluginRuntimeError(
          'package_in_use',
          `Plugin package is required by desired entry ${dependent.id}`,
        );
      }
      if (packageLayers.length !== this.#authority.packageLayers.length) {
        await this.#commitDesiredAuthority(
          projection.desired,
          packageLayers,
          this.#authority.overlays,
        );
        this.#structuralDependencies = projection.structuralDependencies;
      }
      const installedInRuntime = this.#composition
        .installedPackages()
        .some(({ packageId }) => packageId === extensionId);
      const pkg = installedInRuntime ? this.#composition.package(extensionId) : undefined;
      const postCommitErrors: unknown[] = [];
      const failures = await this.#recoverDesiredRuntime(projection.desired).catch((error) => {
        postCommitErrors.push(error);
        return Object.freeze([]) as readonly MakaCompositionRecoveryFailure[];
      });
      await this.#publishEntryFailures(failures);
      if (failures.length > 0) postCommitErrors.push(new Error('Runtime convergence failed'));
      if (pkg) {
        await this.#composition
          .uninstall(extensionId)
          .catch((error) => postCommitErrors.push(error));
      }
      await this.#packages.uninstall(extensionId).catch((error) => postCommitErrors.push(error));
      if (pkg) await this.#releaseGeneration(pkg);
      if (postCommitErrors.length > 0) {
        this.#recordPackageFailure(extensionId, new AggregateError(postCommitErrors));
        this.#settleConvergence(false);
        return this.#receipt('pending');
      }
      this.#clearPackageFailure(extensionId);
      this.#settleConvergence(true);
      return this.#receipt('complete');
    });
  }

  async apply(input: MakaCompositionApplyInput): Promise<PluginMutationReceipt> {
    this.#assertMutable();
    return await this.#serializeMutable(async () => {
      let normalizedInput: MakaCompositionApplyInput;
      let projection: DesiredProjection;
      try {
        normalizedInput = await this.#normalizeApplyInput(this.#desired, input);
        const nextAuthority = compositionAuthority(
          this.#authority.generation + (normalizedInput.operations.length > 0 ? 1 : 0),
          this.#authority.packageLayers,
          Object.freeze([...this.#authority.overlays, ...normalizedInput.operations]),
        );
        projection = await this.#deriveDesired(nextAuthority, 'strict');
      } catch (error) {
        throw new HostPluginPlatformError('mutation_failed', 'Plugin composition mutation failed', {
          cause: error,
        });
      }
      const next = compositionAuthority(
        projection.desired.generation,
        this.#authority.packageLayers,
        Object.freeze([...this.#authority.overlays, ...normalizedInput.operations]),
      );
      try {
        await this.#store.replace(next);
        this.#authority = next;
        this.#desired = projection.desired;
        this.#structuralDependencies = projection.structuralDependencies;
      } catch (error) {
        if (
          error instanceof HostPluginCompositionStoreError &&
          error.code === 'commit_outcome_unknown'
        ) {
          this.#fence = error;
          this.#phase = 'fenced';
          throw new HostPluginPlatformError(
            'commit_outcome_unknown',
            'Plugin composition commit outcome is unknown; Plugin Platform was fenced',
            { cause: error },
          );
        }
        throw new HostPluginPlatformError(
          'persistence_failed',
          'Plugin composition persistence failed; Runtime state was not changed',
          { cause: error },
        );
      }

      try {
        const failures = await this.#recoverDesiredRuntime(projection.desired);
        await this.#publishEntryFailures(failures);
        this.#settleConvergence(failures.length === 0);
        return this.#receipt('complete');
      } catch (error) {
        await this.#publishEntryFailures(operationFailures(normalizedInput, error));
        this.#settleConvergence(false);
        return this.#receipt('complete');
      }
    });
  }

  desiredComposition(): MakaCompositionState {
    this.#assertReadable();
    return this.#desired;
  }

  failures(): readonly HostPluginPlatformFailure[] {
    this.#assertReadable();
    return this.#failures;
  }

  inspect(rootId?: MakaPluginRootId): readonly MakaCompositionEntryInspection[] {
    this.#assertReadable();
    return this.#composition.inspectTree(rootId);
  }

  async status(): Promise<{
    readonly phase: PluginPlatformPhase;
    readonly authorityEpoch: number;
    readonly convergence: PluginPlatformConvergence;
    readonly installedPackageCount: number;
    readonly layeredPackageCount: number;
    readonly desiredEntryCount: number;
    readonly liveEntryCount: number;
    readonly failureCount: number;
    readonly fenceDiagnostic: string | null;
  }> {
    this.#assertReadable();
    return Object.freeze({
      phase: this.#phase,
      authorityEpoch: this.#authority.generation,
      convergence: this.#convergence,
      installedPackageCount: (await this.#packages.identities()).length,
      layeredPackageCount: this.#authority.packageLayers.length,
      desiredEntryCount: compositionEntries(this.#desired).length,
      liveEntryCount: countInspections(this.#composition.inspectTree()),
      failureCount: this.#failures.length,
      fenceDiagnostic: this.#fence ? boundedDiagnostic(this.#fence) : null,
    });
  }

  async packageProjections(): Promise<readonly PluginPackageProjection[]> {
    this.#assertReadable();
    const requiredBy = new Map<string, Set<string>>();
    for (const [actor, dependencies] of this.#structuralDependencies) {
      if (actor.startsWith('@')) continue;
      for (const dependency of dependencies) {
        const users = requiredBy.get(dependency) ?? new Set<string>();
        users.add(actor);
        requiredBy.set(dependency, users);
      }
    }
    const installedPackages = await Promise.all(
      (await this.#packages.identities()).map((extensionId) => this.#packages.load(extensionId)),
    );
    for (const installed of installedPackages) {
      for (const dependency of installed.manifest.dependencies) {
        const users = requiredBy.get(dependency.id) ?? new Set<string>();
        users.add(installed.extensionId);
        requiredBy.set(dependency.id, users);
      }
    }
    const projections: PluginPackageProjection[] = [];
    for (const installed of installedPackages) {
      const extensionId = installed.extensionId;
      projections.push(
        Object.freeze({
          extensionId,
          contentDigest: installed.contentDigest,
          displayName: installed.manifest.displayName,
          ...(installed.manifest.description
            ? { description: installed.manifest.description }
            : {}),
          dependencies: Object.freeze(installed.manifest.dependencies.map(({ id }) => id)),
          structuralDependencies: Object.freeze(
            [...(this.#structuralDependencies.get(extensionId) ?? [])].sort(),
          ),
          requiredBy: Object.freeze([...(requiredBy.get(extensionId) ?? [])].sort()),
        }),
      );
    }
    return Object.freeze(projections);
  }

  async exportPackage(extensionId: string, targetPath: string): Promise<void> {
    await this.read(() => this.#packages.export(extensionId, targetPath));
  }

  async reconcile(): Promise<PluginMutationReceipt> {
    this.#assertMutable();
    return await this.#serializeMutable(() => this.#reconcileNow());
  }

  read<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#assertReadable();
    return this.#serialize(async () => {
      this.#assertReadable();
      return await operation();
    });
  }

  beginDrain(): void {
    if (this.#phase === 'closed') return;
    this.#drainRequested = true;
    this.#phase = 'draining';
  }

  async close(): Promise<void> {
    if (this.#phase === 'closed') return;
    this.#drainRequested = true;
    this.#phase = 'draining';
    if (this.#reconcileTimer) clearTimeout(this.#reconcileTimer);
    this.#reconcileTimer = undefined;
    const errors: unknown[] = [];
    try {
      await this.#mutation;
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#composition.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#packageLoader.close();
    } catch (error) {
      errors.push(error);
    }
    this.#phase = 'closed';
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Unable to close every Plugin Platform resource');
    }
  }

  async #planPackageLayer(
    extensionId: string,
    patch: MakaCompositionApplyInput | undefined,
    manifest: ExtensionPackageManifest,
  ): Promise<{
    readonly planned: MakaCompositionState;
    readonly packageLayers: readonly string[];
    readonly structuralDependencies: ReadonlyMap<string, ReadonlySet<string>>;
  }> {
    const previousIndex = this.#authority.packageLayers.indexOf(extensionId);
    const packageLayers = this.#authority.packageLayers.filter((item) => item !== extensionId);
    const nextIndex = previousIndex < 0 ? packageLayers.length : previousIndex;
    packageLayers.splice(nextIndex, 0, extensionId);
    const candidate = compositionAuthority(
      this.#authority.generation + 1,
      packageLayers,
      this.#authority.overlays,
    );
    const projection = await this.#deriveDesired(candidate, 'strict', {
      extensionId,
      patch,
      manifest,
    });
    return {
      planned: projection.desired,
      packageLayers,
      structuralDependencies: projection.structuralDependencies,
    };
  }

  async #deriveDesired(
    authority: PersistedPluginComposition,
    policy: 'strict' | 'recovery',
    override?: PackageOverride,
  ): Promise<DesiredProjection> {
    let working = emptyCompositionState();
    let owners = new Map<string, string>();
    let dependencies = new Map<string, Set<string>>();
    const failures: HostPluginPlatformFailure[] = [];

    const applyLayer = async (
      actor: string,
      input: MakaCompositionApplyInput,
      manifestOverride?: ExtensionPackageManifest,
    ): Promise<void> => {
      let candidate = working;
      const candidateOwners = new Map(owners);
      const candidateDependencies = cloneDependencyGraph(dependencies);
      const applyOperation = async (operation: MakaCompositionOperation): Promise<void> => {
        recordStructuralDependencies(
          candidate,
          candidateOwners,
          candidateDependencies,
          actor,
          operation,
        );
        const previous = candidate;
        candidate = applyCompositionState(candidate, { operations: [operation] });
        updateEntryOwners(previous, candidateOwners, actor, operation);
      };
      if (policy === 'strict') {
        const normalized = await this.#normalizeApplyInput(candidate, input, manifestOverride);
        for (const operation of normalized.operations) await applyOperation(operation);
      } else {
        for (const operation of input.operations) {
          try {
            const normalized = await this.#normalizeApplyInput(
              candidate,
              { operations: [operation] },
              manifestOverride,
            );
            await applyOperation(normalized.operations[0]!);
          } catch (error) {
            try {
              await applyOperation(operation);
            } catch {
              // A structurally invalid operation cannot contribute to the
              // recoverable desired tree, but its diagnostic is retained.
            }
            const identity = overlayFailureIdentity([operation]);
            failures.push(
              Object.freeze({
                ...(actor.startsWith('@') ? { entryId: identity } : { extensionId: actor }),
                diagnostic: boundedDiagnostic(error),
              }),
            );
          }
        }
      }
      if (!actor.startsWith('@') && manifestOverride) {
        const inferred = [...(candidateDependencies.get(actor) ?? [])].sort();
        const declared = [...(manifestOverride.composition?.structuralDependencies ?? [])].sort();
        if (
          inferred.length !== declared.length ||
          inferred.some((dependency, index) => dependency !== declared[index])
        ) {
          throw new MakaPluginRuntimeError(
            'invalid_package',
            `Plugin package ${actor} structural dependencies do not match its composition patch`,
          );
        }
      }
      working = candidate;
      owners = candidateOwners;
      dependencies = candidateDependencies;
    };

    for (const extensionId of authority.packageLayers) {
      try {
        const installed =
          override?.extensionId === extensionId
            ? undefined
            : await this.#packages.load(extensionId);
        const patch =
          override?.extensionId === extensionId
            ? override.patch
            : await loadPluginCompositionPatch(installed!);
        const manifest =
          override?.extensionId === extensionId ? override.manifest : installed!.manifest;
        if (patch) {
          await applyLayer(extensionId, patch, manifest);
        }
      } catch (error) {
        if (policy === 'strict') throw error;
        failures.push(Object.freeze({ extensionId, diagnostic: boundedDiagnostic(error) }));
      }
    }
    if (authority.overlays.length > 0) {
      try {
        await applyLayer('@user-overlay', { operations: authority.overlays });
      } catch (error) {
        if (policy === 'strict') throw error;
        failures.push(
          Object.freeze({
            entryId: overlayFailureIdentity(authority.overlays),
            diagnostic: boundedDiagnostic(error),
          }),
        );
      }
    }

    let desired = compositionWithGeneration(working, authority.generation);
    if (policy === 'strict') await this.#validateDesired(desired, override?.manifest);
    else desired = await this.#normalizeCompositionConfigurations(desired);
    return Object.freeze({
      desired,
      failures: Object.freeze(failures),
      structuralDependencies: freezeDependencyGraph(dependencies),
    });
  }

  async #commitDesiredAuthority(
    planned: MakaCompositionState,
    packageLayers: readonly string[],
    overlays: readonly MakaCompositionOperation[],
  ): Promise<void> {
    const next = compositionAuthority(planned.generation, packageLayers, overlays);
    try {
      await this.#store.replace(next);
      this.#authority = next;
      this.#desired = planned;
    } catch (error) {
      if (
        error instanceof HostPluginCompositionStoreError &&
        error.code === 'commit_outcome_unknown'
      ) {
        this.#fence = error;
        this.#phase = 'fenced';
        throw new HostPluginPlatformError(
          'commit_outcome_unknown',
          'Plugin composition commit outcome is unknown; Plugin Platform was fenced',
          { cause: error },
        );
      }
      throw new HostPluginPlatformError(
        'persistence_failed',
        'Plugin composition persistence failed; Runtime state was not changed',
        { cause: error },
      );
    }
  }

  async #validateDesired(
    state: MakaCompositionState,
    manifestOverride?: ExtensionPackageManifest,
  ): Promise<void> {
    const records = compositionEntryRecords(state);
    for (const record of records) {
      await this.#validateEntry(record.entry, !record.disabled, manifestOverride);
      await this.#validateActiveDependencies(record, records, manifestOverride);
    }
  }

  async #normalizeApplyInput(
    desired: MakaCompositionState,
    input: MakaCompositionApplyInput,
    manifestOverride?: ExtensionPackageManifest,
  ): Promise<MakaCompositionApplyInput> {
    if (input.baseGeneration !== undefined && input.baseGeneration !== desired.generation) {
      throw new MakaPluginRuntimeError(
        'invalid_entry',
        `Composition generation changed from ${input.baseGeneration} to ${desired.generation}`,
      );
    }
    let working = desired;
    const operations: MakaCompositionOperation[] = [];
    for (const operation of input.operations) {
      let normalized: MakaCompositionOperation;
      if (operation.type === 'insert') {
        normalized = Object.freeze({
          ...operation,
          entry: await this.#normalizeEntryConfiguration(operation.entry, true, manifestOverride),
        });
      } else if (operation.type === 'update') {
        const current = findCompositionEntry(working, operation.entryId);
        if (!current) {
          throw new MakaPluginRuntimeError(
            'entry_not_found',
            `Composition entry not found: ${operation.entryId}`,
          );
        }
        const effective = Object.freeze({ ...current, ...operation.patch });
        const configured = await this.#normalizeEntryConfiguration(
          effective,
          false,
          manifestOverride,
        );
        normalized = Object.freeze({
          ...operation,
          patch: Object.freeze({ ...operation.patch, config: configured.config }),
        });
      } else {
        normalized = operation;
      }
      operations.push(normalized);
      const advanced = applyCompositionState(working, { operations: [normalized] });
      working = compositionWithGeneration(advanced, desired.generation);
    }
    return Object.freeze({
      ...(input.baseGeneration === undefined ? {} : { baseGeneration: input.baseGeneration }),
      operations: Object.freeze(operations),
    });
  }

  async #normalizeCompositionConfigurations(
    state: MakaCompositionState,
  ): Promise<MakaCompositionState> {
    const normalize = async (entry: MakaCompositionEntry): Promise<MakaCompositionEntry> => {
      let configured = entry;
      try {
        configured = await this.#normalizeEntryConfiguration(entry, false);
      } catch {
        // Recovery records malformed or unavailable package configuration as
        // an Entry failure below instead of failing the Runtime Host.
      }
      return Object.freeze({
        ...configured,
        children: Object.freeze(await Promise.all((entry.children ?? []).map(normalize))),
      });
    };
    const sessions = await Promise.all(
      Object.entries(state.roots.sessions).map(
        async ([scopeId, entries]) =>
          [scopeId, Object.freeze(await Promise.all(entries.map(normalize)))] as const,
      ),
    );
    return Object.freeze({
      schemaVersion: 1,
      generation: state.generation,
      roots: Object.freeze({
        profile: Object.freeze(await Promise.all(state.roots.profile.map(normalize))),
        desktopUi: Object.freeze(await Promise.all(state.roots.desktopUi.map(normalize))),
        sessions: Object.freeze(Object.fromEntries(sessions)),
      }),
    });
  }

  async #normalizeEntryConfiguration(
    entry: MakaCompositionEntry,
    recursive = true,
    manifestOverride?: ExtensionPackageManifest,
  ): Promise<MakaCompositionEntry> {
    const config = entry.packageId
      ? validateExtensionConfiguration(
          (await this.#packageManifest(entry.packageId, manifestOverride)).configuration,
          entry.config,
        )
      : scalarConfiguration(entry.config);
    return Object.freeze({
      ...entry,
      config,
      ...(recursive
        ? {
            children: Object.freeze(
              await Promise.all(
                (entry.children ?? []).map((child) =>
                  this.#normalizeEntryConfiguration(child, true, manifestOverride),
                ),
              ),
            ),
          }
        : {}),
    });
  }

  async #desiredValidationFailures(
    state: MakaCompositionState,
  ): Promise<readonly MakaCompositionRecoveryFailure[]> {
    const failures: MakaCompositionRecoveryFailure[] = [];
    const records = compositionEntryRecords(state);
    for (const record of records) {
      try {
        await this.#validateEntry(record.entry, !record.disabled);
        await this.#validateActiveDependencies(record, records);
      } catch (error) {
        failures.push(
          Object.freeze({ entryId: record.entry.id, diagnostic: boundedDiagnostic(error) }),
        );
      }
    }
    return Object.freeze(failures);
  }

  async #validateEntry(
    entry: MakaCompositionEntry,
    active = entry.disabled !== true,
    manifestOverride?: ExtensionPackageManifest,
  ): Promise<void> {
    if (!entry.packageId) return;
    const manifests = new Map<string, ExtensionPackageManifest>();
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = async (extensionId: string): Promise<void> => {
      if (visited.has(extensionId)) return;
      if (visiting.has(extensionId)) {
        throw new MakaPluginRuntimeError(
          'dependency_cycle',
          `Plugin package dependency cycle includes ${extensionId}`,
        );
      }
      visiting.add(extensionId);
      let manifest = manifests.get(extensionId);
      if (!manifest) {
        manifest = await this.#packageManifest(extensionId, manifestOverride);
        manifests.set(extensionId, manifest);
      }
      for (const dependency of manifest.dependencies) await visit(dependency.id);
      visiting.delete(extensionId);
      visited.add(extensionId);
    };
    const manifest = await this.#packageManifest(entry.packageId, manifestOverride);
    validateExtensionConfiguration(manifest.configuration, entry.config);
    if (active) await visit(entry.packageId);
  }

  async #validateActiveDependencies(
    record: CompositionEntryRecord,
    records: readonly CompositionEntryRecord[],
    manifestOverride?: ExtensionPackageManifest,
  ): Promise<void> {
    if (record.disabled || !record.entry.packageId) return;
    const manifest = await this.#packageManifest(record.entry.packageId, manifestOverride);
    for (const dependency of manifest.dependencies) {
      if (
        !records.some(
          (candidate) =>
            candidate.rootId === record.rootId &&
            !candidate.disabled &&
            candidate.entry.packageId === dependency.id,
        )
      ) {
        throw new MakaPluginRuntimeError(
          'package_not_found',
          `Required dependency ${dependency.id} is not active in ${record.rootId}`,
        );
      }
    }
  }

  async #packageManifest(
    extensionId: string,
    manifestOverride?: ExtensionPackageManifest,
  ): Promise<ExtensionPackageManifest> {
    return manifestOverride?.id === extensionId
      ? manifestOverride
      : (await this.#packages.load(extensionId)).manifest;
  }

  async #recoverDesiredRuntime(
    desired: MakaCompositionState,
  ): Promise<readonly MakaCompositionRecoveryFailure[]> {
    let failures = new Map(
      (await this.#desiredValidationFailures(desired)).map((failure) => [failure.entryId, failure]),
    );
    for (;;) {
      const recovered = await this.#composition.recoverComposition(
        withoutEntries(desired, new Set(failures.keys())),
      );
      for (const failure of recovered) failures.set(failure.entryId, failure);
      const expanded = await this.#expandDependencyFailures(desired, [...failures.values()]);
      if (expanded.length === failures.size) return Object.freeze([...failures.values()]);
      failures = new Map(expanded.map((failure) => [failure.entryId, failure]));
    }
  }

  async #expandDependencyFailures(
    state: MakaCompositionState,
    initial: readonly MakaCompositionRecoveryFailure[],
  ): Promise<readonly MakaCompositionRecoveryFailure[]> {
    const failures = new Map(initial.map((failure) => [failure.entryId, failure]));
    const records = compositionEntryRecords(state);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records) {
        if (record.disabled || !record.entry.packageId || failures.has(record.entry.id)) continue;
        const manifest = (await this.#packages.load(record.entry.packageId)).manifest;
        for (const dependency of manifest.dependencies) {
          const candidates = records.filter(
            (candidate) =>
              candidate.rootId === record.rootId &&
              !candidate.disabled &&
              candidate.entry.packageId === dependency.id,
          );
          if (candidates.length > 0 && candidates.every(({ entry }) => failures.has(entry.id))) {
            failures.set(
              record.entry.id,
              Object.freeze({
                entryId: record.entry.id,
                diagnostic: `Required dependency ${dependency.id} failed in ${record.rootId}`,
              }),
            );
            changed = true;
            break;
          }
        }
      }
    }
    return Object.freeze([...failures.values()]);
  }

  async #desiredPackageDependent(
    extensionId: string,
    desired: MakaCompositionState = this.desiredComposition(),
  ): Promise<MakaCompositionEntry | undefined> {
    const dependsOn = async (packageId: string, visited: Set<string>): Promise<boolean> => {
      if (packageId === extensionId) return true;
      if (visited.has(packageId)) return false;
      visited.add(packageId);
      const manifest = (await this.#packages.load(packageId)).manifest;
      for (const dependency of manifest.dependencies) {
        if (await dependsOn(dependency.id, visited)) return true;
      }
      return false;
    };
    for (const entry of compositionEntries(desired)) {
      if (
        entry.packageId &&
        entry.packageId !== extensionId &&
        entry.disabled !== true &&
        (await dependsOn(entry.packageId, new Set()))
      ) {
        return entry;
      }
    }
    return undefined;
  }

  async #manifestDependentPackage(extensionId: string): Promise<string | undefined> {
    for (const candidateId of this.#authority.packageLayers) {
      if (candidateId === extensionId) continue;
      const manifest = (await this.#packages.load(candidateId)).manifest;
      if (manifest.dependencies.some(({ id }) => id === extensionId)) return candidateId;
    }
    return undefined;
  }

  async #publishEntryFailures(failures: readonly MakaCompositionRecoveryFailure[]): Promise<void> {
    const packageFailures = this.#failures.filter((failure) => failure.entryId === undefined);
    this.#failures = Object.freeze([
      ...packageFailures,
      ...failures.map((failure) =>
        Object.freeze({ entryId: failure.entryId, diagnostic: failure.diagnostic }),
      ),
    ]);
  }

  async #adoptRuntimePackage(
    extensionId: string,
    loaded: MakaPluginPackage,
    desired: MakaCompositionState,
    replacing: boolean,
  ): Promise<readonly MakaCompositionRecoveryFailure[]> {
    let installed = false;
    try {
      if (replacing) {
        const previous = this.#composition.package(extensionId);
        const detached = withoutPackageEntries(desired, extensionId);
        await this.#recoverDesiredRuntime(detached);
        await this.#composition.uninstall(extensionId);
        await this.#releaseGeneration(previous);
      }
      await this.#composition.install(loaded);
      installed = true;
      return await this.#recoverDesiredRuntime(desired);
    } catch (error) {
      if (!installed) await this.#packageLoader.release(loaded).catch(() => undefined);
      throw error;
    }
  }

  async #releaseGeneration(pkg: MakaPluginPackage): Promise<void> {
    try {
      await this.#packageLoader.release(pkg);
    } catch (error) {
      this.#composition.root.logger.warn('Unable to remove retired Plugin generation', error);
    }
  }

  #clearPackageFailure(extensionId: string): void {
    this.#failures = Object.freeze(
      this.#failures.filter((failure) => failure.extensionId !== extensionId),
    );
  }

  #assertReadable(): void {
    if (!this.#recoveryComplete) {
      throw new HostPluginPlatformError('not_ready', 'Plugin Platform is not recovered');
    }
    if (this.#phase === 'closed') {
      throw new HostPluginPlatformError('closed', 'Plugin Platform is closed');
    }
  }

  #assertMutable(): void {
    this.#assertReadable();
    if (this.#phase === 'fenced') {
      throw new HostPluginPlatformError('recovery_failed', 'Plugin Platform is fenced', {
        cause: this.#fence,
      });
    }
    if (this.#phase === 'draining') {
      throw new HostPluginPlatformError('closed', 'Plugin Platform is draining');
    }
  }

  #fenceUnknownPackageOutcome(
    error: PluginPackageStoreError,
    operation: string,
  ): HostPluginPlatformError {
    this.#fence = error;
    this.#phase = 'fenced';
    return new HostPluginPlatformError(
      'commit_outcome_unknown',
      `Plugin package ${operation} outcome is unknown; Plugin Platform was fenced`,
      { cause: error },
    );
  }

  #serializeMutable<T>(operation: () => Promise<T>): Promise<T> {
    return this.#serialize(async () => {
      this.#assertMutable();
      return await operation();
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #recordPackageFailure(extensionId: string, error: unknown): void {
    this.#clearPackageFailure(extensionId);
    this.#failures = Object.freeze([
      ...this.#failures,
      Object.freeze({ extensionId, diagnostic: boundedDiagnostic(error) }),
    ]);
  }

  #settleConvergence(converged: boolean): void {
    this.#convergence = converged ? 'converged' : 'diverged';
    if (!this.#drainRequested && this.#phase !== 'fenced' && this.#phase !== 'closed') {
      this.#phase = converged ? 'ready' : 'degraded';
    }
    if (converged) {
      this.#reconcileDelayMs = 250;
      if (this.#reconcileTimer) clearTimeout(this.#reconcileTimer);
      this.#reconcileTimer = undefined;
    } else {
      this.#scheduleReconcile();
    }
  }

  async #reconcileNow(): Promise<PluginMutationReceipt> {
    await this.#packages.recover(this.#authority.generation);
    await this.#packageLoader.collectGarbage();
    const projection = await this.#deriveDesired(this.#authority, 'recovery');
    const packageFailures: HostPluginPlatformFailure[] = [];
    const retryPackages = new Set(
      this.#failures.flatMap(({ extensionId }) => (extensionId ? [extensionId] : [])),
    );
    const storedPackages = new Set(await this.#packages.identities());
    for (const extensionId of storedPackages) {
      const installed = this.#composition
        .installedPackages()
        .some(({ packageId }) => packageId === extensionId);
      if (installed && !retryPackages.has(extensionId)) continue;
      try {
        const loaded = await this.#packageLoader.load(extensionId);
        await this.#adoptRuntimePackage(extensionId, loaded, projection.desired, installed);
      } catch (error) {
        packageFailures.push(Object.freeze({ extensionId, diagnostic: boundedDiagnostic(error) }));
      }
    }
    const runtimeFailures = await this.#recoverDesiredRuntime(projection.desired);
    this.#desired = projection.desired;
    this.#structuralDependencies = projection.structuralDependencies;
    this.#failures = Object.freeze([
      ...projection.failures,
      ...packageFailures,
      ...runtimeFailures.map(({ entryId, diagnostic }) => Object.freeze({ entryId, diagnostic })),
    ]);
    this.#settleConvergence(this.#failures.length === 0);
    return this.#receipt('complete');
  }

  #scheduleReconcile(): void {
    if (this.#reconcileTimer || this.#drainRequested || this.#phase !== 'degraded') return;
    const delay = this.#reconcileDelayMs;
    this.#reconcileDelayMs = Math.min(this.#reconcileDelayMs * 2, 30_000);
    this.#reconcileTimer = setTimeout(() => {
      this.#reconcileTimer = undefined;
      void this.#serialize(async () => {
        if (this.#phase !== 'degraded') return;
        await this.#reconcileNow();
      }).catch((error) => {
        this.#composition.root.logger.warn('Unable to reconcile Plugin Platform', error);
        this.#scheduleReconcile();
      });
    }, delay);
    this.#reconcileTimer.unref?.();
  }

  #receipt(cleanup: 'complete' | 'pending'): PluginMutationReceipt {
    return Object.freeze({
      authorityEpoch: this.#authority.generation,
      durability: 'committed',
      convergence: this.#convergence === 'converged' ? 'converged' : 'diverged',
      cleanup,
      failures: Object.freeze(this.#failures.map((failure) => Object.freeze({ ...failure }))),
    });
  }

  #structuralDependent(extensionId: string): string | undefined {
    for (const [actor, dependencies] of this.#structuralDependencies) {
      if (dependencies.has(extensionId)) return actor;
    }
    return undefined;
  }
}

function emptyCompositionAuthority(): PersistedPluginComposition {
  return Object.freeze({
    schemaVersion: 1,
    generation: 0,
    packageLayers: Object.freeze([]),
    overlays: Object.freeze([]),
  });
}

function emptyCompositionState(): MakaCompositionState {
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

function compositionAuthority(
  generation: number,
  packageLayers: readonly string[],
  overlays: readonly MakaCompositionOperation[],
): PersistedPluginComposition {
  return Object.freeze({
    schemaVersion: 1,
    generation,
    packageLayers: Object.freeze([...packageLayers]),
    overlays: Object.freeze(structuredClone(overlays)),
  });
}

function compositionEntries(state: MakaCompositionState): readonly MakaCompositionEntry[] {
  const walk = (entries: readonly MakaCompositionEntry[]): MakaCompositionEntry[] =>
    entries.flatMap((entry) => [entry, ...walk(entry.children ?? [])]);
  return [
    ...walk(state.roots.profile),
    ...walk(state.roots.desktopUi),
    ...Object.values(state.roots.sessions).flatMap(walk),
  ];
}

function findCompositionEntry(
  state: MakaCompositionState,
  entryId: string,
): MakaCompositionEntry | undefined {
  return compositionEntries(state).find((entry) => entry.id === entryId);
}

function compositionWithGeneration(
  state: MakaCompositionState,
  generation: number,
): MakaCompositionState {
  return Object.freeze({ ...state, generation });
}

function compositionEntryRecords(state: MakaCompositionState): readonly CompositionEntryRecord[] {
  const records: CompositionEntryRecord[] = [];
  const visit = (
    entries: readonly MakaCompositionEntry[],
    rootId: MakaPluginRootId,
    ancestorDisabled: boolean,
  ): void => {
    for (const entry of entries) {
      const disabled = ancestorDisabled || entry.disabled === true;
      records.push(Object.freeze({ entry, rootId, disabled }));
      visit(entry.children ?? [], rootId, disabled);
    }
  };
  visit(state.roots.profile, 'profile', false);
  visit(state.roots.desktopUi, 'desktop-ui', false);
  for (const [scopeId, entries] of Object.entries(state.roots.sessions)) {
    visit(entries, `session:${scopeId}`, false);
  }
  return Object.freeze(records);
}

function withoutEntries(
  state: MakaCompositionState,
  excluded: ReadonlySet<string>,
): MakaCompositionState {
  const filter = (entries: readonly MakaCompositionEntry[]): readonly MakaCompositionEntry[] =>
    Object.freeze(
      entries.flatMap((entry) =>
        excluded.has(entry.id)
          ? []
          : [Object.freeze({ ...entry, children: filter(entry.children ?? []) })],
      ),
    );
  return Object.freeze({
    schemaVersion: 1,
    generation: state.generation,
    roots: Object.freeze({
      profile: filter(state.roots.profile),
      desktopUi: filter(state.roots.desktopUi),
      sessions: Object.freeze(
        Object.fromEntries(
          Object.entries(state.roots.sessions).map(([scopeId, entries]) => [
            scopeId,
            filter(entries),
          ]),
        ),
      ),
    }),
  });
}

function withoutPackageEntries(
  state: MakaCompositionState,
  extensionId: string,
): MakaCompositionState {
  return withoutEntries(
    state,
    new Set(
      compositionEntries(state)
        .filter(({ packageId }) => packageId === extensionId)
        .map(({ id }) => id),
    ),
  );
}

function countInspections(inspections: readonly MakaCompositionEntryInspection[]): number {
  return inspections.reduce(
    (total, inspection) => total + 1 + countInspections(inspection.children),
    0,
  );
}

function cloneDependencyGraph(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  return new Map([...graph].map(([actor, dependencies]) => [actor, new Set(dependencies)]));
}

function freezeDependencyGraph(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    [...graph].map(([actor, dependencies]) => [
      actor,
      Object.freeze(new Set([...dependencies].sort())) as ReadonlySet<string>,
    ]),
  );
}

function recordStructuralDependencies(
  state: MakaCompositionState,
  owners: ReadonlyMap<string, string>,
  dependencies: Map<string, Set<string>>,
  actor: string,
  operation: MakaCompositionOperation,
): void {
  const referencedIds: string[] = [];
  if (operation.type === 'insert') {
    if (operation.parentId) referencedIds.push(operation.parentId);
  } else {
    referencedIds.push(operation.entryId);
    if (operation.type === 'move' && operation.parentId) referencedIds.push(operation.parentId);
  }
  for (const entryId of referencedIds) {
    if (!findCompositionEntry(state, entryId)) continue;
    const owner = owners.get(entryId);
    if (!owner || owner === actor) continue;
    const actorDependencies = dependencies.get(actor) ?? new Set<string>();
    actorDependencies.add(owner);
    dependencies.set(actor, actorDependencies);
  }
}

function updateEntryOwners(
  previous: MakaCompositionState,
  owners: Map<string, string>,
  actor: string,
  operation: MakaCompositionOperation,
): void {
  if (operation.type === 'insert') {
    for (const entry of walkCompositionEntries(operation.entry)) owners.set(entry.id, actor);
    return;
  }
  if (operation.type === 'remove') {
    const removed = findCompositionEntry(previous, operation.entryId);
    if (removed) {
      for (const entry of walkCompositionEntries(removed)) owners.delete(entry.id);
    }
  }
}

function walkCompositionEntries(entry: MakaCompositionEntry): readonly MakaCompositionEntry[] {
  return [entry, ...(entry.children ?? []).flatMap(walkCompositionEntries)];
}

function overlayFailureIdentity(operations: readonly MakaCompositionOperation[]): string {
  const operation = operations[0];
  if (!operation) return 'user-overlay';
  if (operation.type === 'insert') return operation.entry.id;
  return operation.entryId;
}

function operationFailures(
  input: MakaCompositionApplyInput,
  error: unknown,
): readonly MakaCompositionRecoveryFailure[] {
  const diagnostic = boundedDiagnostic(error);
  const ids = new Set<string>();
  for (const operation of input.operations) {
    if (operation.type === 'insert') ids.add(operation.entry.id);
    else ids.add(operation.entryId);
  }
  return Object.freeze([...ids].map((entryId) => Object.freeze({ entryId, diagnostic })));
}

function scalarConfiguration(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostPluginCompositionStoreError(
      'invalid_state',
      'Plugin Entry config must be a scalar record',
    );
  }
  const output: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item !== 'string' &&
      typeof item !== 'boolean' &&
      !(typeof item === 'number' && Number.isFinite(item))
    ) {
      throw new HostPluginCompositionStoreError(
        'invalid_state',
        `Plugin Entry config value is invalid: ${key}`,
      );
    }
    output[key] = item;
  }
  return Object.freeze(output);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function boundedDiagnostic(error: unknown): string {
  const message =
    error instanceof AggregateError
      ? error.errors.map((item) => boundedDiagnostic(item)).join('; ')
      : error instanceof Error
        ? error.message
        : String(error);
  return message.slice(0, 4096) || 'Plugin Platform operation failed';
}
