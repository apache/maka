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
import { loadPluginCompositionPatch } from './plugin-composition-patch.js';
import {
  HostPluginCompositionStore,
  HostPluginCompositionStoreError,
  type PersistedPluginComposition,
} from './plugin-composition-store.js';
import { TrustedPluginPackageLoader } from './plugin-package-loader.js';
import { PluginPackageStore, PluginPackageStoreError } from './plugin-package-store.js';

export class HostPluginPlatformError extends Error {
  readonly name = 'HostPluginPlatformError';

  constructor(
    readonly code:
      | 'closed'
      | 'persistence_failed'
      | 'commit_outcome_unknown'
      | 'recovery_failed'
      | 'mutation_failed',
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

/**
 * Runtime Host's sole authority for trusted Plugin packages and Entry composition.
 * Package layers and user overlays are durable; the desired Entry Tree is derived from them.
 */
export class HostPluginPlatform {
  readonly composition: MakaCompositionLoader;
  readonly packages: PluginPackageStore;
  readonly packageLoader: TrustedPluginPackageLoader;
  readonly store: HostPluginCompositionStore;

  #authority: PersistedPluginComposition = emptyCompositionAuthority();
  #desired: MakaCompositionState = emptyCompositionState();
  #mutation: Promise<void> = Promise.resolve();
  #closed = false;
  #draining = false;
  #poisoned?: Error;
  #diverged = false;
  #failures: readonly HostPluginPlatformFailure[] = Object.freeze([]);

  constructor(
    readonly controlDirectory: string,
    options: HostPluginPlatformOptions = {},
  ) {
    this.composition = options.composition ?? new MakaCompositionLoader();
    this.packages = options.packages ?? new PluginPackageStore(controlDirectory);
    this.packageLoader =
      options.packageLoader ?? new TrustedPluginPackageLoader(controlDirectory, this.packages);
    this.store = options.store ?? new HostPluginCompositionStore(controlDirectory);
  }

  async recover(): Promise<void> {
    if (this.#closed) throw new HostPluginPlatformError('closed', 'Plugin Platform is closed');
    await this.#serialize(async () => {
      try {
        const storedAuthority = (await this.store.read()) ?? emptyCompositionAuthority();
        await this.packages.recover(storedAuthority.generation);
        await this.packageLoader.collectGarbage();
        const packageFailures: HostPluginPlatformFailure[] = [];
        for (const extensionId of await this.packages.identities()) {
          try {
            await this.composition.install(await this.packageLoader.load(extensionId));
          } catch (error) {
            packageFailures.push(
              Object.freeze({
                extensionId,
                diagnostic: boundedDiagnostic(error),
              }),
            );
          }
        }
        const desired = await this.#normalizeCompositionConfigurations(
          await this.#composePersistedAuthority(storedAuthority),
        );
        const entryFailures = await this.#recoverDesiredRuntime(desired);
        this.#failures = Object.freeze([
          ...packageFailures,
          ...entryFailures.map((failure) =>
            Object.freeze({ entryId: failure.entryId, diagnostic: failure.diagnostic }),
          ),
        ]);
        this.#diverged = entryFailures.length > 0;
        this.#authority = storedAuthority;
        this.#desired = desired;
      } catch (error) {
        this.#poisoned = asError(error);
        // Plugin recovery is fail-open for the Host. Mutations and Plugin
        // queries remain fenced until the persisted authority is repaired.
      }
    });
  }

  async installPackage(sourcePath: string): Promise<{ readonly extensionId: string }> {
    this.#assertMutable();
    return await this.#serializeMutable(async () => {
      let prepared;
      try {
        prepared = await this.packages.prepareInstall(sourcePath);
      } catch (error) {
        if (error instanceof PluginPackageStoreError && error.code === 'commit_outcome_unknown') {
          throw this.#fenceUnknownPackageOutcome(error, 'preparation');
        }
        throw error;
      }
      let loaded: MakaPluginPackage | undefined;
      let previous: MakaPluginPackage | undefined;
      let authorityCommitted = false;
      let runtimeAdopted = false;
      try {
        const compositionPatch = await loadPluginCompositionPatch(prepared.installed);
        loaded = await this.packageLoader.loadInstalled(prepared.installed);
        const alreadyInstalled = this.composition
          .installedPackages()
          .some(({ packageId }) => packageId === prepared.installed.extensionId);
        if (alreadyInstalled) previous = this.composition.package(prepared.installed.extensionId);
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
        await prepared.commit();
        this.#clearPackageFailure(prepared.installed.extensionId);
        if (alreadyInstalled) await this.composition.reload(loaded);
        else await this.composition.install(loaded);
        runtimeAdopted = true;
        const failures = await this.composition.recoverComposition(layerPlan.planned);
        await this.#publishEntryFailures(failures);
        if (failures.length > 0) {
          throw new Error(failures.map(({ diagnostic }) => diagnostic).join('; '));
        }
        if (previous) await this.#releaseGeneration(previous);
        return Object.freeze({ extensionId: prepared.installed.extensionId });
      } catch (error) {
        if (authorityCommitted) {
          this.#diverged = true;
          if (loaded && !runtimeAdopted) {
            await this.packageLoader.release(loaded).catch(() => undefined);
          }
          if (previous && runtimeAdopted) await this.#releaseGeneration(previous);
          throw new HostPluginPlatformError(
            'mutation_failed',
            'Plugin package authority was committed but Runtime convergence failed',
            { cause: error },
          );
        }
        if (error instanceof HostPluginPlatformError && error.code === 'commit_outcome_unknown') {
          if (loaded) await this.packageLoader.release(loaded).catch(() => undefined);
          throw error;
        }
        try {
          await prepared.rollback();
        } catch (rollbackError) {
          if (loaded) await this.packageLoader.release(loaded).catch(() => undefined);
          if (
            rollbackError instanceof PluginPackageStoreError &&
            rollbackError.code === 'commit_outcome_unknown'
          ) {
            throw this.#fenceUnknownPackageOutcome(rollbackError, 'rollback');
          }
          this.#poisoned = asError(rollbackError);
          this.#draining = true;
          throw new HostPluginPlatformError(
            'persistence_failed',
            'Plugin package installation and stored-package rollback both failed',
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
        if (loaded) await this.packageLoader.release(loaded).catch(() => undefined);
        throw error;
      }
    });
  }

  async reloadPackage(extensionId: string): Promise<void> {
    this.#assertMutable();
    await this.#serializeMutable(async () => {
      const previous = this.composition.package(extensionId);
      const loaded = await this.packageLoader.load(extensionId);
      try {
        await this.#validateDesired(this.desiredComposition());
        await this.composition.reload(loaded);
      } catch (error) {
        await this.packageLoader.release(loaded).catch(() => undefined);
        throw error;
      }
      await this.#releaseGeneration(previous);
      this.#clearPackageFailure(extensionId);
      if (this.#diverged) await this.#convergeDesired();
    });
  }

  async uninstallPackage(extensionId: string): Promise<void> {
    this.#assertMutable();
    await this.#serializeMutable(async () => {
      const previousAuthority = this.#authority;
      const previousDesired = this.#desired;
      let planned: MakaCompositionState | undefined;
      let packageLayers = this.#authority.packageLayers;
      if (this.#authority.packageLayers.includes(extensionId)) {
        packageLayers = this.#authority.packageLayers.filter((item) => item !== extensionId);
        planned = await this.#composeLayers(packageLayers, this.#authority.overlays);
      }
      const candidate = planned ?? this.#desired;
      const desiredUser = compositionEntries(candidate).find(
        (entry) => entry.packageId === extensionId,
      );
      if (desiredUser) {
        throw new MakaPluginRuntimeError(
          'package_in_use',
          `Plugin package is used by desired entry ${desiredUser.id}`,
        );
      }
      const dependent = await this.#desiredPackageDependent(extensionId, candidate);
      if (dependent) {
        throw new MakaPluginRuntimeError(
          'package_in_use',
          `Plugin package is required by desired entry ${dependent.id}`,
        );
      }
      if (planned) {
        await this.#replaceDesiredComposition(planned, packageLayers, this.#authority.overlays);
      }
      const installedInRuntime = this.composition
        .installedPackages()
        .some(({ packageId }) => packageId === extensionId);
      const pkg = installedInRuntime ? this.composition.package(extensionId) : undefined;
      if (pkg) await this.composition.uninstall(extensionId);
      try {
        await this.packages.uninstall(extensionId);
        this.#clearPackageFailure(extensionId);
        if (pkg) await this.#releaseGeneration(pkg);
      } catch (error) {
        if (error instanceof PluginPackageStoreError && error.code === 'commit_outcome_unknown') {
          this.#poisoned = error;
          this.#draining = true;
          throw new HostPluginPlatformError(
            'commit_outcome_unknown',
            'Plugin package uninstall outcome is unknown; Plugin Platform was fenced',
            { cause: error },
          );
        }
        const rollbackErrors: unknown[] = [];
        if (pkg) {
          let restored: MakaPluginPackage | undefined;
          try {
            restored = await this.packageLoader.load(extensionId);
            await this.composition.install(restored);
            await this.#releaseGeneration(pkg);
          } catch (rollbackError) {
            if (restored) await this.packageLoader.release(restored).catch(() => undefined);
            rollbackErrors.push(rollbackError);
          }
        }
        if (planned) {
          try {
            await this.#replaceDesiredComposition(
              compositionWithGeneration(previousDesired, this.#desired.generation + 1),
              previousAuthority.packageLayers,
              previousAuthority.overlays,
            );
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          this.#poisoned = asError(rollbackErrors[0]);
          this.#draining = true;
          throw new HostPluginPlatformError(
            'mutation_failed',
            'Plugin package uninstall and rollback both failed; Plugin Platform was fenced',
            { cause: new AggregateError([error, ...rollbackErrors]) },
          );
        }
        throw error;
      }
    });
  }

  async apply(
    input: MakaCompositionApplyInput,
  ): Promise<readonly MakaCompositionEntryInspection[]> {
    this.#assertMutable();
    return await this.#serializeMutable(async () => {
      const desired = this.#desired;
      let normalizedInput: MakaCompositionApplyInput;
      let planned: MakaCompositionState;
      try {
        normalizedInput = await this.#normalizeApplyInput(desired, input);
        planned = applyCompositionState(desired, normalizedInput);
        await this.#validateDesired(planned);
      } catch (error) {
        throw new HostPluginPlatformError('mutation_failed', 'Plugin composition mutation failed', {
          cause: error,
        });
      }
      const next = compositionAuthority(
        planned.generation,
        this.#authority.packageLayers,
        Object.freeze([...this.#authority.overlays, ...normalizedInput.operations]),
      );
      try {
        await this.store.replace(next);
        this.#authority = next;
        this.#desired = planned;
      } catch (error) {
        if (
          error instanceof HostPluginCompositionStoreError &&
          error.code === 'commit_outcome_unknown'
        ) {
          this.#poisoned = error;
          this.#draining = true;
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

      let convergenceFailures: readonly MakaCompositionRecoveryFailure[] | undefined;
      try {
        if (this.#diverged) {
          const failures = await this.composition.recoverComposition(planned);
          await this.#publishEntryFailures(failures);
          if (failures.length > 0) {
            convergenceFailures = failures;
            throw new Error(failures.map(({ diagnostic }) => diagnostic).join('; '));
          }
          return this.composition.inspectTree();
        }
        const inspections = await this.composition.apply(normalizedInput);
        this.#failures = Object.freeze(
          this.#failures.filter((failure) => failure.entryId === undefined),
        );
        return inspections;
      } catch (error) {
        this.#diverged = true;
        if (!convergenceFailures) {
          await this.#publishEntryFailures(operationFailures(normalizedInput, error));
        }
        throw new HostPluginPlatformError(
          'mutation_failed',
          'Desired Plugin composition was committed but Runtime convergence failed',
          { cause: error },
        );
      }
    });
  }

  desiredComposition(): MakaCompositionState {
    return this.#desired;
  }

  failures(): readonly HostPluginPlatformFailure[] {
    return this.#failures;
  }

  inspect(rootId?: MakaPluginRootId): readonly MakaCompositionEntryInspection[] {
    return this.composition.inspectTree(rootId);
  }

  read<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#assertOpen();
    return this.#serialize(async () => await operation());
  }

  beginDrain(): void {
    this.#draining = true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const errors: unknown[] = [];
    try {
      await this.#mutation;
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.composition.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.packageLoader.close();
    } catch (error) {
      errors.push(error);
    }
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
  }> {
    const previousIndex = this.#authority.packageLayers.indexOf(extensionId);
    const packageLayers = this.#authority.packageLayers.filter((item) => item !== extensionId);
    const nextIndex = previousIndex < 0 ? packageLayers.length : previousIndex;
    packageLayers.splice(nextIndex, 0, extensionId);
    const planned = await this.#composeLayers(packageLayers, this.#authority.overlays, {
      extensionId,
      patch,
      manifest,
    });
    return { planned, packageLayers };
  }

  async #composeLayers(
    packageLayers: readonly string[],
    overlays: readonly MakaCompositionOperation[],
    override?: {
      readonly extensionId: string;
      readonly patch: MakaCompositionApplyInput | undefined;
      readonly manifest: ExtensionPackageManifest;
    },
  ): Promise<MakaCompositionState> {
    let working = emptyCompositionState();
    for (const extensionId of packageLayers) {
      const patch =
        override?.extensionId === extensionId
          ? override.patch
          : await loadPluginCompositionPatch(await this.packages.load(extensionId));
      if (!patch) continue;
      const normalized = await this.#normalizeApplyInput(working, patch, override?.manifest);
      working = applyCompositionState(working, normalized);
    }
    if (overlays.length > 0) {
      const normalized = await this.#normalizeApplyInput(
        working,
        { operations: overlays },
        override?.manifest,
      );
      working = applyCompositionState(working, normalized);
    }
    await this.#validateDesired(working, override?.manifest);
    return compositionWithGeneration(working, this.#desired.generation + 1);
  }

  /** Rebuilds the desired Entry Tree without trusting a stored materialized projection. */
  async #composePersistedAuthority(
    authority: PersistedPluginComposition,
  ): Promise<MakaCompositionState> {
    let working = emptyCompositionState();
    for (const extensionId of authority.packageLayers) {
      const patch = await loadPluginCompositionPatch(await this.packages.load(extensionId));
      if (patch) working = applyCompositionState(working, patch);
    }
    if (authority.overlays.length > 0) {
      working = applyCompositionState(working, { operations: authority.overlays });
    }
    return compositionWithGeneration(working, authority.generation);
  }

  async #replaceDesiredComposition(
    planned: MakaCompositionState,
    packageLayers: readonly string[],
    overlays: readonly MakaCompositionOperation[],
  ): Promise<void> {
    await this.#commitDesiredAuthority(planned, packageLayers, overlays);
    const failures = await this.composition.recoverComposition(planned);
    await this.#publishEntryFailures(failures);
    this.#diverged = failures.length > 0;
    if (failures.length > 0) {
      throw new HostPluginPlatformError(
        'mutation_failed',
        'Desired Plugin composition was committed but Runtime convergence failed',
        { cause: new Error(failures.map(({ diagnostic }) => diagnostic).join('; ')) },
      );
    }
  }

  async #commitDesiredAuthority(
    planned: MakaCompositionState,
    packageLayers: readonly string[],
    overlays: readonly MakaCompositionOperation[],
  ): Promise<void> {
    const next = compositionAuthority(planned.generation, packageLayers, overlays);
    try {
      await this.store.replace(next);
      this.#authority = next;
      this.#desired = planned;
    } catch (error) {
      if (
        error instanceof HostPluginCompositionStoreError &&
        error.code === 'commit_outcome_unknown'
      ) {
        this.#poisoned = error;
        this.#draining = true;
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
      : (await this.packages.load(extensionId)).manifest;
  }

  async #convergeDesired(): Promise<void> {
    const desired = this.desiredComposition();
    const failures = await this.#recoverDesiredRuntime(desired);
    await this.#publishEntryFailures(failures);
  }

  async #recoverDesiredRuntime(
    desired: MakaCompositionState,
  ): Promise<readonly MakaCompositionRecoveryFailure[]> {
    let failures = new Map(
      (await this.#desiredValidationFailures(desired)).map((failure) => [failure.entryId, failure]),
    );
    for (;;) {
      const recovered = await this.composition.recoverComposition(
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
        const manifest = (await this.packages.load(record.entry.packageId)).manifest;
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
      const manifest = (await this.packages.load(packageId)).manifest;
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

  async #publishEntryFailures(failures: readonly MakaCompositionRecoveryFailure[]): Promise<void> {
    const packageFailures = this.#failures.filter((failure) => failure.entryId === undefined);
    this.#failures = Object.freeze([
      ...packageFailures,
      ...failures.map((failure) =>
        Object.freeze({ entryId: failure.entryId, diagnostic: failure.diagnostic }),
      ),
    ]);
    this.#diverged = failures.length > 0;
  }

  async #releaseGeneration(pkg: MakaPluginPackage): Promise<void> {
    try {
      await this.packageLoader.release(pkg);
    } catch (error) {
      this.composition.root.logger.warn('Unable to remove retired Plugin generation', error);
    }
  }

  #clearPackageFailure(extensionId: string): void {
    this.#failures = Object.freeze(
      this.#failures.filter((failure) => failure.extensionId !== extensionId),
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new HostPluginPlatformError('closed', 'Plugin Platform is closed');
    if (this.#poisoned) {
      throw new HostPluginPlatformError('recovery_failed', 'Plugin Platform is fenced', {
        cause: this.#poisoned,
      });
    }
  }

  #assertMutable(): void {
    this.#assertOpen();
    if (this.#draining) throw new HostPluginPlatformError('closed', 'Plugin Platform is draining');
  }

  #fenceUnknownPackageOutcome(
    error: PluginPackageStoreError,
    operation: string,
  ): HostPluginPlatformError {
    this.#poisoned = error;
    this.#draining = true;
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
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4096) || 'Plugin Platform operation failed';
}
