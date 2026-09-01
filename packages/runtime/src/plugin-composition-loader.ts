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

import { Context, type Fiber, FiberState, type Inject, type Plugin } from './plugin-kernel.js';
import {
  fiberStateName,
  type MakaCompositionEntry,
  type MakaCompositionEntryInspection,
  type MakaCompositionApplyInput,
  type MakaCompositionState,
  type MakaPluginMetadata,
  type MakaPluginPackage,
  type MakaPluginRootId,
  MakaPluginRuntimeError,
  MakaPluginTransactionBuffer,
  type MakaPluginTransaction,
  validateCompositionEntry,
  validatePluginPackage,
  validatePluginRootId,
} from './plugin-runtime.js';

interface LiveEntry {
  spec: MakaCompositionEntry;
  readonly rootId: MakaPluginRootId;
  parent?: LiveEntry;
  context: Context;
  fiber?: Fiber;
  generation?: number;
  readonly children: LiveEntry[];
  diagnostic?: string;
}

const FIBER_PENDING = 0;
const FIBER_FAILED = 3;

interface LiveRoot {
  readonly id: MakaPluginRootId;
  readonly context: Context;
  readonly entries: LiveEntry[];
}

export interface MakaCompositionLoaderOptions {
  readonly root?: Context;
  readonly transaction?: (context: Context) => MakaPluginTransaction | undefined;
}

export interface MakaCompositionRecoveryFailure {
  readonly entryId: string;
  readonly diagnostic: string;
}

export class MakaCompositionLoader {
  readonly root: Context;
  readonly #packages = new Map<string, MakaPluginPackage>();
  readonly #roots = new Map<MakaPluginRootId, LiveRoot>();
  readonly #entries = new Map<string, LiveEntry>();
  readonly #isolationLabels = new Map<string, symbol>();
  readonly #transaction?: (context: Context) => MakaPluginTransaction | undefined;
  #compositionGeneration = 0;
  #fiberGeneration = 0;
  #mutation: Promise<void> = Promise.resolve();

  constructor(options: MakaCompositionLoaderOptions = {}) {
    this.root = options.root ?? new Context();
    this.#transaction = options.transaction;
  }

  install(pkg: MakaPluginPackage): Promise<void> {
    return this.#mutate(async () => {
      validatePluginPackage(pkg);
      if (this.#packages.has(pkg.packageId)) {
        throw new MakaPluginRuntimeError(
          'package_exists',
          `Plugin package is already installed: ${pkg.packageId}`,
        );
      }
      this.#packages.set(pkg.packageId, freezePackage(pkg));
    });
  }

  reload(pkg: MakaPluginPackage): Promise<void> {
    return this.#mutate(async () => {
      validatePluginPackage(pkg);
      const previous = this.#packages.get(pkg.packageId);
      if (!previous) {
        throw new MakaPluginRuntimeError(
          'package_not_found',
          `Plugin package is not installed: ${pkg.packageId}`,
        );
      }
      this.#packages.set(pkg.packageId, freezePackage(pkg));
      try {
        await this.#reloadPackage(pkg.packageId);
      } catch (error) {
        this.#packages.set(pkg.packageId, previous);
        throw error;
      }
    });
  }

  uninstall(packageId: string): Promise<void> {
    return this.#mutate(async () => {
      if (!this.#packages.has(packageId)) {
        throw new MakaPluginRuntimeError(
          'package_not_found',
          `Plugin package is not installed: ${packageId}`,
        );
      }
      const user = [...this.#entries.values()].find((entry) => entry.spec.packageId === packageId);
      if (user) {
        throw new MakaPluginRuntimeError(
          'package_in_use',
          `Plugin package is used by entry ${user.spec.id}`,
        );
      }
      this.#packages.delete(packageId);
    });
  }

  create(
    rootId: MakaPluginRootId,
    entry: MakaCompositionEntry,
    parentId?: string,
    position = Infinity,
  ): Promise<MakaCompositionEntryInspection> {
    return this.apply({
      operations: [{ type: 'insert', rootId, entry, parentId, position }],
    }).then(([inspection]) => inspection!);
  }

  update(
    entryId: string,
    patch: Partial<Omit<MakaCompositionEntry, 'id' | 'children'>>,
  ): Promise<MakaCompositionEntryInspection> {
    return this.apply({ operations: [{ type: 'update', entryId, patch }] }).then(
      ([inspection]) => inspection!,
    );
  }

  move(
    entryId: string,
    newParentId?: string,
    position = Infinity,
  ): Promise<MakaCompositionEntryInspection> {
    return this.apply({
      operations: [{ type: 'move', entryId, parentId: newParentId, position }],
    }).then(([inspection]) => inspection!);
  }

  enable(entryId: string): Promise<MakaCompositionEntryInspection> {
    return this.update(entryId, { disabled: false });
  }

  disable(entryId: string): Promise<MakaCompositionEntryInspection> {
    return this.update(entryId, { disabled: true });
  }

  apply(input: MakaCompositionApplyInput): Promise<readonly MakaCompositionEntryInspection[]> {
    return this.#mutate(async () => {
      if (
        input.baseGeneration !== undefined &&
        input.baseGeneration !== this.#compositionGeneration
      )
        throw new MakaPluginRuntimeError(
          'invalid_entry',
          `Composition generation changed from ${input.baseGeneration} to ${this.#compositionGeneration}`,
        );
      const before = this.compositionState();
      const inspections: MakaCompositionEntryInspection[] = [];
      let appliedOperations = 0;
      try {
        for (const operation of input.operations) {
          switch (operation.type) {
            case 'insert': {
              const entry = await this.#insert(
                operation.rootId ?? this.#inferRoot(operation.parentId),
                operation.entry,
                operation.parentId,
                operation.position,
              );
              inspections.push(this.#inspect(entry));
              appliedOperations += 1;
              break;
            }
            case 'update': {
              const entry = await this.#update(operation.entryId, operation.patch);
              inspections.push(this.#inspect(entry));
              appliedOperations += 1;
              break;
            }
            case 'move': {
              const entry = await this.#move(
                operation.entryId,
                operation.parentId,
                operation.position,
              );
              inspections.push(this.#inspect(entry));
              appliedOperations += 1;
              break;
            }
            case 'remove':
              await this.#remove(operation.entryId);
              appliedOperations += 1;
              break;
          }
        }
      } catch (error) {
        // A candidate can fail before changing the live tree. Rebuilding in
        // that case would unnecessarily dispose the current Fiber and lose
        // its registered contributions.
        if (appliedOperations > 0) {
          try {
            await this.#replaceComposition(before, 'rollback');
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Plugin composition batch and rollback both failed',
            );
          }
        }
        throw error;
      }
      if (input.operations.length > 0) this.#compositionGeneration += 1;
      return Object.freeze(inspections);
    });
  }

  replaceSubtree(
    entryId: string,
    entry: MakaCompositionEntry,
  ): Promise<MakaCompositionEntryInspection> {
    return this.#mutate(async () => {
      const current = this.#requireEntry(entryId);
      if (entry.id !== entryId) {
        throw new MakaPluginRuntimeError(
          'invalid_entry',
          'Replacement subtree must preserve entry id',
        );
      }
      validateCompositionEntry(entry);
      const descendantIds = new Set<string>();
      for (const item of walk(entry)) {
        if (descendantIds.has(item.id)) {
          throw new MakaPluginRuntimeError(
            'entry_exists',
            `Replacement subtree repeats entry ${item.id}`,
          );
        }
        descendantIds.add(item.id);
        const existing = this.#entries.get(item.id);
        if (existing && !isWithin(existing, current)) {
          throw new MakaPluginRuntimeError(
            'entry_exists',
            `Composition entry already exists: ${item.id}`,
          );
        }
      }
      const inspection = await this.#replace(current, freezeEntry(entry));
      this.#compositionGeneration += 1;
      return inspection;
    });
  }

  remove(entryId: string): Promise<void> {
    return this.apply({ operations: [{ type: 'remove', entryId }] }).then(() => undefined);
  }

  inspectTree(rootId?: MakaPluginRootId): readonly MakaCompositionEntryInspection[] {
    if (rootId) validatePluginRootId(rootId);
    const selected = rootId ? this.#roots.get(rootId) : undefined;
    const roots = rootId ? (selected ? [selected] : []) : [...this.#roots.values()];
    return Object.freeze(
      roots.flatMap((root) => root.entries.map((entry) => this.#inspect(entry))),
    );
  }

  inspect(entryId: string): MakaCompositionEntryInspection {
    return this.#inspect(this.#requireEntry(entryId));
  }

  installedPackages(): readonly { readonly packageId: string }[] {
    return Object.freeze(
      [...this.#packages.values()]
        .map(({ packageId }) => Object.freeze({ packageId }))
        .sort((left, right) => left.packageId.localeCompare(right.packageId)),
    );
  }

  package(packageId: string): MakaPluginPackage {
    const pkg = this.#packages.get(packageId);
    if (!pkg) {
      throw new MakaPluginRuntimeError(
        'package_not_found',
        `Plugin package is not installed: ${packageId}`,
      );
    }
    return pkg;
  }

  async awaitSettled(): Promise<void> {
    while (true) {
      const tasks = [...this.#entries.values()].flatMap((entry) =>
        entry.fiber?.inertia ? [entry.fiber.inertia] : [],
      );
      if (!tasks.length) return;
      await Promise.allSettled(tasks);
    }
  }

  compositionState(): MakaCompositionState {
    const encode = (rootId: MakaPluginRootId): readonly MakaCompositionEntry[] =>
      Object.freeze((this.#roots.get(rootId)?.entries ?? []).map((entry) => serialize(entry)));
    const sessions = Object.fromEntries(
      [...this.#roots.values()].flatMap((root) =>
        root.id.startsWith('session:')
          ? [[root.id.slice('session:'.length), encode(root.id)] as const]
          : [],
      ),
    );
    return Object.freeze({
      schemaVersion: 1,
      generation: this.#compositionGeneration,
      roots: Object.freeze({
        profile: encode('profile'),
        desktopUi: encode('desktop-ui'),
        sessions: Object.freeze(sessions),
      }),
    });
  }

  replaceComposition(state: MakaCompositionState): Promise<void> {
    return this.#mutate(() => this.#replaceComposition(state, 'publish'));
  }

  /** Restores an externally uncommitted mutation without advancing its generation. */
  restoreComposition(state: MakaCompositionState): Promise<void> {
    return this.#mutate(() => this.#replaceComposition(state, 'rollback'));
  }

  /**
   * Recovers as much of a durable desired tree as possible. A failed Entry
   * does not prevent unrelated roots or siblings from becoming active.
   */
  recoverComposition(
    state: MakaCompositionState,
  ): Promise<readonly MakaCompositionRecoveryFailure[]> {
    return this.#mutate(async () => {
      if (state.schemaVersion !== 1) {
        throw new MakaPluginRuntimeError('invalid_entry', 'Unsupported composition state');
      }
      const failures: MakaCompositionRecoveryFailure[] = [];
      const stagedRoots = new Map<MakaPluginRootId, LiveRoot>();
      const stagedIds = new Set<string>();
      const specs = new Map<MakaPluginRootId, readonly MakaCompositionEntry[]>([
        ['profile', state.roots.profile],
        ['desktop-ui', state.roots.desktopUi],
        ...Object.entries(state.roots.sessions).map(
          ([id, entries]) => [`session:${id}` as MakaPluginRootId, entries] as const,
        ),
      ]);
      const recoverEntry = async (
        spec: MakaCompositionEntry,
        rootId: MakaPluginRootId,
        parent: LiveEntry | undefined,
        parentContext: Context,
        ancestorDisabled: boolean,
      ): Promise<LiveEntry | undefined> => {
        for (const item of walk(spec)) {
          if (stagedIds.has(item.id)) {
            failures.push(
              Object.freeze({
                entryId: spec.id,
                diagnostic: `Composition entry already exists: ${item.id}`,
              }),
            );
            return undefined;
          }
        }
        const shallow = freezeEntry({ ...spec, children: [] });
        let live: LiveEntry | undefined;
        try {
          validateCompositionEntry(shallow);
          live = await this.#stage(shallow, rootId, parent, parentContext, ancestorDisabled);
          await this.#commitSubtree(live);
        } catch (error) {
          if (live) await this.#dispose(live).catch(() => undefined);
          failures.push(
            Object.freeze({ entryId: spec.id, diagnostic: diagnostic(error).slice(0, 4096) }),
          );
          return undefined;
        }
        stagedIds.add(spec.id);
        const disabled = ancestorDisabled || spec.disabled === true;
        for (const child of spec.children ?? []) {
          const recovered = await recoverEntry(
            child,
            rootId,
            live,
            childMountContext(live),
            disabled,
          );
          if (recovered) live.children.push(recovered);
        }
        live.spec = freezeEntry({ ...live.spec, children: live.children.map(serialize) });
        return live;
      };

      try {
        for (const [rootId, entries] of specs) {
          validatePluginRootId(rootId);
          const context = this.root.extend({ makaRootId: rootId });
          const root: LiveRoot = { id: rootId, context, entries: [] };
          stagedRoots.set(rootId, root);
          for (const spec of entries) {
            const recovered = await recoverEntry(spec, rootId, undefined, context, false);
            if (recovered) root.entries.push(recovered);
          }
        }
      } catch (error) {
        await settleAll(
          [...stagedRoots.values()].flatMap((root) =>
            [...root.entries].reverse().map((entry) => this.#dispose(entry)),
          ),
          'Recovered composition cleanup failed',
        );
        throw error;
      }

      const previous = [...this.#roots.values()];
      this.#roots.clear();
      this.#entries.clear();
      for (const [rootId, root] of stagedRoots) {
        this.#roots.set(rootId, root);
        for (const entry of root.entries) this.#index(entry);
      }
      this.#compositionGeneration = state.generation;
      await this.#retire(
        settleAll(
          previous.flatMap((root) =>
            [...root.entries].reverse().map((entry) => this.#dispose(entry)),
          ),
          'Previous composition cleanup failed',
        ),
        'Previous composition cleanup failed after recovering desired state',
      );
      return Object.freeze(failures);
    });
  }

  async #replaceComposition(
    state: MakaCompositionState,
    generationMode: 'publish' | 'rollback',
  ): Promise<void> {
    if (state.schemaVersion !== 1)
      throw new MakaPluginRuntimeError('invalid_entry', 'Unsupported composition state');
    const previousGeneration = this.#compositionGeneration;
    const pristine = previousGeneration === 0 && this.#entries.size === 0 && this.#roots.size === 0;
    const specs = new Map<MakaPluginRootId, readonly MakaCompositionEntry[]>([
      ['profile', state.roots.profile],
      ['desktop-ui', state.roots.desktopUi],
      ...Object.entries(state.roots.sessions).map(
        ([id, entries]) => [`session:${id}` as MakaPluginRootId, entries] as const,
      ),
    ]);
    const stagedRoots = new Map<MakaPluginRootId, LiveRoot>();
    const stagedIds = new Set<string>();
    try {
      for (const [rootId, entries] of specs) {
        validatePluginRootId(rootId);
        const context = this.root.extend({ makaRootId: rootId });
        const root: LiveRoot = { id: rootId, context, entries: [] };
        stagedRoots.set(rootId, root);
        for (const spec of entries) {
          validateCompositionEntry(spec);
          for (const item of walk(spec)) {
            if (stagedIds.has(item.id))
              throw new MakaPluginRuntimeError(
                'entry_exists',
                `Composition entry already exists: ${item.id}`,
              );
            stagedIds.add(item.id);
          }
          root.entries.push(await this.#stage(spec, rootId, undefined, context, false));
        }
      }
      for (const root of stagedRoots.values())
        for (const entry of root.entries) await this.#commitSubtree(entry);
    } catch (error) {
      return rethrowAfterCleanup(
        error,
        () =>
          settleAll(
            [...stagedRoots.values()].flatMap((root) =>
              [...root.entries].reverse().map((entry) => this.#dispose(entry)),
            ),
            'Staged composition cleanup failed',
          ),
        'Composition replacement and cleanup failed',
      );
    }
    const previous = [...this.#roots.values()];
    this.#roots.clear();
    this.#entries.clear();
    for (const [rootId, root] of stagedRoots) {
      this.#roots.set(rootId, root);
      for (const entry of root.entries) this.#index(entry);
    }
    this.#compositionGeneration =
      generationMode === 'rollback'
        ? state.generation
        : pristine
          ? state.generation
          : Math.max(previousGeneration, state.generation) + 1;
    await this.#retire(
      settleAll(
        previous.flatMap((root) =>
          [...root.entries].reverse().map((entry) => this.#dispose(entry)),
        ),
        'Previous composition cleanup failed',
      ),
      'Previous composition cleanup failed after publishing the replacement',
    );
  }

  async close(): Promise<void> {
    await this.#mutate(async () => {
      const roots = [...this.#roots.values()];
      this.#roots.clear();
      this.#entries.clear();
      const errors: unknown[] = [];
      try {
        await settleAll(
          roots.flatMap((root) => [...root.entries].reverse().map((entry) => this.#dispose(entry))),
          'Composition entry cleanup failed',
        );
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.root.fiber.dispose();
      } catch (error) {
        errors.push(error);
      }
      throwIfErrors(errors, 'Composition loader close failed');
    });
  }

  async #replace(
    current: LiveEntry,
    spec: MakaCompositionEntry,
  ): Promise<MakaCompositionEntryInspection> {
    const parentContext = current.parent
      ? childMountContext(current.parent)
      : this.#root(current.rootId).context;
    const candidate = await this.#stage(
      spec,
      current.rootId,
      current.parent,
      parentContext,
      current.parent ? isDisabled(current.parent) : false,
    );
    try {
      await this.#commitSubtree(candidate);
    } catch (error) {
      current.diagnostic = diagnostic(error);
      return rethrowAfterCleanup(
        error,
        () => this.#dispose(candidate),
        `Entry ${current.spec.id} replacement and cleanup failed`,
      );
    }
    const siblings = current.parent?.children ?? this.#root(current.rootId).entries;
    const index = siblings.indexOf(current);
    this.#unindex(current);
    siblings[index] = candidate;
    this.#index(candidate);
    await this.#retire(
      this.#dispose(current),
      `Entry ${current.spec.id} cleanup failed after publishing its replacement`,
    );
    return this.#inspect(candidate);
  }

  async #reloadPackage(packageId: string): Promise<void> {
    const affected = [...this.#entries.values()].filter(
      (entry) =>
        entry.spec.packageId === packageId &&
        ![...ancestors(entry)].some((ancestor) => ancestor.spec.packageId === packageId),
    );
    if (!affected.length) return;
    const candidates: { readonly current: LiveEntry; readonly replacement: LiveEntry }[] = [];
    try {
      for (const current of affected) {
        const replacement = await this.#stage(
          serialize(current),
          current.rootId,
          current.parent,
          current.parent ? childMountContext(current.parent) : this.#root(current.rootId).context,
          current.parent ? isDisabled(current.parent) : false,
        );
        candidates.push({ current, replacement });
      }
      for (const { replacement } of candidates) await this.#commitSubtree(replacement);
    } catch (error) {
      return rethrowAfterCleanup(
        error,
        () =>
          settleAll(
            candidates.map(({ replacement }) => this.#dispose(replacement)),
            `Plugin package ${packageId} candidate cleanup failed`,
          ),
        `Plugin package ${packageId} reload and cleanup failed`,
      );
    }
    for (const { current, replacement } of candidates) {
      const siblings = current.parent?.children ?? this.#root(current.rootId).entries;
      const index = siblings.indexOf(current);
      this.#unindex(current);
      siblings[index] = replacement;
      this.#index(replacement);
    }
    await this.#retire(
      settleAll(
        candidates.map(({ current }) => this.#dispose(current)),
        `Plugin package ${packageId} previous generation cleanup failed`,
      ),
      `Plugin package ${packageId} cleanup failed after publishing its replacement`,
    );
  }

  async #rebind(entry: LiveEntry, parent: LiveEntry | undefined, position: number): Promise<void> {
    const replacement = await this.#stage(
      serialize(entry),
      entry.rootId,
      parent,
      parent ? childMountContext(parent) : this.#root(entry.rootId).context,
      parent ? isDisabled(parent) : false,
    );
    try {
      await this.#commitSubtree(replacement);
    } catch (error) {
      return rethrowAfterCleanup(
        error,
        () => this.#dispose(replacement),
        `Entry ${entry.spec.id} move activation and cleanup failed`,
      );
    }
    const source = entry.parent?.children ?? this.#root(entry.rootId).entries;
    const target = parent?.children ?? this.#root(entry.rootId).entries;
    this.#unindex(entry);
    source.splice(source.indexOf(entry), 1);
    target.splice(Math.min(position, target.length), 0, replacement);
    this.#index(replacement);
    await this.#retire(
      this.#dispose(entry),
      `Entry ${entry.spec.id} cleanup failed after publishing its rebound Fiber`,
    );
  }

  async #stage(
    spec: MakaCompositionEntry,
    rootId: MakaPluginRootId,
    parent: LiveEntry | undefined,
    parentContext: Context,
    ancestorDisabled: boolean,
  ): Promise<LiveEntry> {
    let context = parentContext.extend({ makaEntryId: spec.id });
    for (const [service, label] of Object.entries(spec.isolate ?? {})) {
      const symbol = label === true ? Symbol(`${spec.id}:${service}`) : this.#isolationLabel(label);
      context = context.isolate(service, symbol);
    }
    for (const [service, config] of Object.entries(spec.intercept ?? {}))
      context = context.intercept(service, config);
    const live: LiveEntry = { spec: freezeEntry(spec), rootId, parent, context, children: [] };
    const disabled = ancestorDisabled || spec.disabled === true;
    if (!disabled && spec.packageId) {
      const pkg = this.#packages.get(spec.packageId);
      if (!pkg)
        throw new MakaPluginRuntimeError(
          'package_not_found',
          `Plugin package is not installed: ${spec.packageId}`,
        );
      if (!pkg.host)
        throw new MakaPluginRuntimeError(
          'invalid_package',
          `Plugin package has no Host plugin: ${spec.packageId}`,
        );
      const generation = ++this.#fiberGeneration;
      const metadata: MakaPluginMetadata = Object.freeze({
        rootId,
        entryId: spec.id,
        packageId: spec.packageId,
        generation,
      });
      context = context.extend({ maka: metadata });
      const transaction = this.#transaction?.(context) ?? new MakaPluginTransactionBuffer(context);
      if (transaction) context = context.extend({ makaTransaction: transaction });
      live.context = context;
      live.generation = generation;
      const plugin = entryPlugin(pkg.host, spec.inject);
      live.fiber = context.plugin(plugin, spec.config);
      try {
        await live.fiber.await();
        if (live.fiber.state === FIBER_FAILED) throw new Error(`Plugin Fiber failed: ${spec.id}`);
      } catch (error) {
        live.diagnostic = diagnostic(error);
        const cleanupErrors: unknown[] = [];
        try {
          await live.fiber.dispose();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          await transaction?.rollback();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        const cause = cleanupErrors.length
          ? new AggregateError(
              [error, ...cleanupErrors],
              `Entry ${spec.id} activation and cleanup failed`,
            )
          : error;
        throw new MakaPluginRuntimeError(
          'activation_failed',
          `Unable to activate entry ${spec.id}: ${diagnostic(error)}`,
          { cause },
        );
      }
    }
    try {
      for (const child of spec.children ?? []) {
        live.children.push(
          await this.#stage(child, rootId, live, childMountContext(live), disabled),
        );
      }
    } catch (error) {
      return rethrowAfterCleanup(
        error,
        () => this.#dispose(live),
        `Entry ${spec.id} staging and cleanup failed`,
      );
    }
    return live;
  }

  async #commitSubtree(entry: LiveEntry): Promise<void> {
    await entry.context.makaTransaction?.commit();
    for (const child of entry.children) await this.#commitSubtree(child);
  }

  async #dispose(entry: LiveEntry): Promise<void> {
    const errors: unknown[] = [];
    try {
      await settleAll(
        [...entry.children].reverse().map((child) => this.#dispose(child)),
        `Entry ${entry.spec.id} child cleanup failed`,
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      await entry.context.makaTransaction?.rollback();
    } catch (error) {
      errors.push(error);
    }
    try {
      await entry.fiber?.dispose();
    } catch (error) {
      errors.push(error);
    }
    throwIfErrors(errors, `Entry ${entry.spec.id} cleanup failed`);
  }

  async #retire(task: Promise<void>, message: string): Promise<void> {
    try {
      await task;
    } catch (error) {
      this.root.logger.warn(message, error);
    }
  }

  #root(rootId: MakaPluginRootId): LiveRoot {
    validatePluginRootId(rootId);
    let root = this.#roots.get(rootId);
    if (!root) {
      root = { id: rootId, context: this.root.extend({ makaRootId: rootId }), entries: [] };
      this.#roots.set(rootId, root);
    }
    return root;
  }

  #inferRoot(parentId: string | undefined): MakaPluginRootId {
    if (!parentId) return 'profile';
    return this.#requireEntry(parentId).rootId;
  }

  async #insert(
    rootId: MakaPluginRootId,
    entry: MakaCompositionEntry,
    parentId?: string,
    position = Infinity,
  ): Promise<LiveEntry> {
    validatePluginRootId(rootId);
    validateCompositionEntry(entry);
    this.#assertUniqueSubtree(entry);
    const parent = parentId ? this.#requireEntry(parentId) : undefined;
    if (parent && parent.rootId !== rootId)
      throw new MakaPluginRuntimeError(
        'invalid_entry',
        'Composition entries cannot move between roots',
      );
    const createdRoot = !this.#roots.has(rootId);
    const root = this.#root(rootId);
    try {
      const live = await this.#stage(
        entry,
        rootId,
        parent,
        parent ? childMountContext(parent) : root.context,
        parent ? isDisabled(parent) : false,
      );
      try {
        await this.#commitSubtree(live);
      } catch (error) {
        await rethrowAfterCleanup(
          error,
          () => this.#dispose(live),
          `Entry ${entry.id} commit and cleanup failed`,
        );
      }
      const siblings = parent?.children ?? root.entries;
      siblings.splice(Math.min(position, siblings.length), 0, live);
      this.#index(live);
      return live;
    } catch (error) {
      if (createdRoot && root.entries.length === 0) this.#roots.delete(rootId);
      throw error;
    }
  }

  async #update(
    entryId: string,
    patch: Partial<Omit<MakaCompositionEntry, 'id' | 'children'>>,
  ): Promise<LiveEntry> {
    const current = this.#requireEntry(entryId);
    const next = freezeEntry({
      ...current.spec,
      ...patch,
      id: current.spec.id,
      children: current.children.map(serialize),
    });
    validateCompositionEntry(next);
    const structural =
      next.packageId !== current.spec.packageId ||
      !shallowCompositionEqual(next.inject, current.spec.inject) ||
      !shallowCompositionEqual(next.isolate, current.spec.isolate) ||
      !shallowCompositionEqual(next.intercept, current.spec.intercept);
    if (!structural && current.fiber && next.disabled !== true && current.spec.disabled !== true) {
      await current.fiber.update(next.config);
      current.spec = next;
      current.diagnostic = undefined;
      return current;
    }
    return this.#replace(current, next).then((inspection) => this.#requireEntry(inspection.id));
  }

  async #move(entryId: string, newParentId?: string, position = Infinity): Promise<LiveEntry> {
    const entry = this.#requireEntry(entryId);
    const parent = newParentId ? this.#requireEntry(newParentId) : undefined;
    if (parent && parent.rootId !== entry.rootId)
      throw new MakaPluginRuntimeError(
        'invalid_entry',
        'Composition entries cannot move between roots',
      );
    for (let ancestor = parent; ancestor; ancestor = ancestor.parent)
      if (ancestor === entry)
        throw new MakaPluginRuntimeError(
          'dependency_cycle',
          `Entry ${entryId} cannot contain itself`,
        );
    await this.#rebind(entry, parent, position);
    return this.#requireEntry(entryId);
  }

  async #remove(entryId: string): Promise<void> {
    const entry = this.#requireEntry(entryId);
    const siblings = entry.parent?.children ?? this.#root(entry.rootId).entries;
    siblings.splice(siblings.indexOf(entry), 1);
    this.#unindex(entry);
    await this.#retire(
      this.#dispose(entry),
      `Entry ${entry.spec.id} cleanup failed after removing it from the composition`,
    );
  }

  #requireEntry(entryId: string): LiveEntry {
    const entry = this.#entries.get(entryId);
    if (!entry)
      throw new MakaPluginRuntimeError(
        'entry_not_found',
        `Composition entry not found: ${entryId}`,
      );
    return entry;
  }

  #assertUniqueSubtree(entry: MakaCompositionEntry): void {
    const local = new Set<string>();
    for (const item of walk(entry)) {
      if (local.has(item.id) || this.#entries.has(item.id))
        throw new MakaPluginRuntimeError(
          'entry_exists',
          `Composition entry already exists: ${item.id}`,
        );
      local.add(item.id);
    }
  }

  #index(entry: LiveEntry): void {
    this.#entries.set(entry.spec.id, entry);
    for (const child of entry.children) this.#index(child);
  }

  #unindex(entry: LiveEntry): void {
    this.#entries.delete(entry.spec.id);
    for (const child of entry.children) this.#unindex(child);
  }

  #inspect(entry: LiveEntry): MakaCompositionEntryInspection {
    const sourceInject = entry.fiber?.inject ?? entry.spec.inject;
    const inject = Array.isArray(sourceInject)
      ? sourceInject
      : Object.keys((sourceInject as Readonly<Record<string, unknown>> | undefined) ?? {});
    const waitingFor =
      entry.fiber?.state === FIBER_PENDING
        ? inject.filter((name) => entry.context.get(name) === undefined)
        : [];
    return Object.freeze({
      id: entry.spec.id,
      rootId: entry.rootId,
      ...(entry.parent ? { parentId: entry.parent.spec.id } : {}),
      ...(entry.spec.packageId ? { packageId: entry.spec.packageId } : {}),
      ...(entry.spec.config === undefined ? {} : { config: entry.spec.config }),
      disabled: isDisabled(entry),
      status: isDisabled(entry)
        ? 'disabled'
        : entry.fiber
          ? fiberStateName(entry.fiber.state)
          : 'active',
      ...(entry.generation === undefined ? {} : { generation: entry.generation }),
      waitingFor: Object.freeze(waitingFor),
      effects: Object.freeze(entry.fiber?.getEffects().map(({ label }) => label) ?? []),
      children: Object.freeze(entry.children.map((child) => this.#inspect(child))),
      ...((entry.diagnostic ?? entry.fiber?.error)
        ? { diagnostic: entry.diagnostic ?? diagnostic(entry.fiber?.error) }
        : {}),
    });
  }

  #isolationLabel(label: string): symbol {
    let symbol = this.#isolationLabels.get(label);
    if (!symbol) {
      symbol = Symbol(label);
      this.#isolationLabels.set(label, symbol);
    }
    return symbol;
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function entryPlugin(plugin: Plugin, inject: MakaCompositionEntry['inject']): Plugin {
  const combined = mergeInject((plugin as Plugin.Base).inject, inject);
  return {
    name: (plugin as Plugin.Base).name ?? 'maka-entry',
    ...(combined ? { inject: combined } : {}),
    ...((plugin as Plugin.Base).Config ? { Config: (plugin as Plugin.Base).Config } : {}),
    apply(ctx: Context, config: unknown) {
      if (typeof plugin !== 'function') return plugin.apply(ctx, config as never);
      if (isConstructor(plugin)) return Reflect.construct(plugin, [ctx, config]);
      return (plugin as Plugin.Function)(ctx, config as never);
    },
  };
}

function isConstructor(value: Function): boolean {
  return /^class\s/u.test(Function.prototype.toString.call(value));
}

function mergeInject(
  left: Inject | undefined,
  right: MakaCompositionEntry['inject'],
): Inject | undefined {
  if (!left && !right) return undefined;
  const output: Record<string, unknown> = {};
  for (const source of [left, right]) {
    if (Array.isArray(source)) for (const name of source) output[name] = null;
    else Object.assign(output, source ?? {});
  }
  return output;
}

function freezePackage(pkg: MakaPluginPackage): MakaPluginPackage {
  return Object.freeze({ ...pkg, contributions: Object.freeze([...(pkg.contributions ?? [])]) });
}

function freezeEntry(entry: MakaCompositionEntry): MakaCompositionEntry {
  return Object.freeze({
    ...entry,
    ...(entry.inject && !Array.isArray(entry.inject)
      ? { inject: Object.freeze({ ...entry.inject }) }
      : entry.inject
        ? { inject: Object.freeze([...entry.inject]) }
        : {}),
    ...(entry.isolate ? { isolate: Object.freeze({ ...entry.isolate }) } : {}),
    ...(entry.intercept ? { intercept: Object.freeze({ ...entry.intercept }) } : {}),
    children: Object.freeze((entry.children ?? []).map(freezeEntry)),
  });
}

function serialize(entry: LiveEntry): MakaCompositionEntry {
  return freezeEntry({ ...entry.spec, children: entry.children.map(serialize) });
}

function shallowCompositionEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value]) =>
        Object.hasOwn(right, key) &&
        Object.is(value, (right as Readonly<Record<string, unknown>>)[key]),
    )
  );
}

function* walk(entry: MakaCompositionEntry): Generator<MakaCompositionEntry> {
  yield entry;
  for (const child of entry.children ?? []) yield* walk(child);
}

function* walkLive(entry: LiveEntry): Generator<LiveEntry> {
  yield entry;
  for (const child of entry.children) yield* walkLive(child);
}

function* ancestors(entry: LiveEntry): Generator<LiveEntry> {
  for (let current = entry.parent; current; current = current.parent) yield current;
}

/**
 * Package Entries introduce a Fiber ownership boundary. Their descendants
 * must mount through that Fiber's Context; scope-only Entries keep using the
 * Context view owned by their nearest package ancestor (or the root Fiber).
 */
function childMountContext(entry: LiveEntry): Context {
  return entry.fiber?.context ?? entry.context;
}

function isWithin(entry: LiveEntry, root: LiveEntry): boolean {
  for (let current: LiveEntry | undefined = entry; current; current = current.parent)
    if (current === root) return true;
  return false;
}

function isDisabled(entry: LiveEntry): boolean {
  for (let current: LiveEntry | undefined = entry; current; current = current.parent) {
    if (current.spec.disabled === true) return true;
  }
  return false;
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settleAll(tasks: Iterable<PromiseLike<unknown>>, message: string): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  throwIfErrors(errors, message);
}

async function rethrowAfterCleanup(
  error: unknown,
  cleanup: () => Promise<void>,
  message: string,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], message);
  }
  throw error;
}

function throwIfErrors(errors: readonly unknown[], message: string): void {
  if (errors.length) throw new AggregateError(errors, message);
}
