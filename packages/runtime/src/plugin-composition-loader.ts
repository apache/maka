import { Context, type Fiber, type Inject, type Plugin } from '@deepseek-ai/cordis';
import {
  fiberStateName,
  type MakaCompositionEntry,
  type MakaCompositionEntryInspection,
  type MakaCompositionSnapshot,
  type MakaPluginMetadata,
  type MakaPluginPackage,
  type MakaPluginRootId,
  MakaPluginRuntimeError,
  MakaPluginTransactionBuffer,
  type MakaPluginTransaction,
  pluginPackageKey,
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

export class MakaCompositionLoader {
  readonly root: Context;
  readonly #packages = new Map<string, MakaPluginPackage>();
  readonly #roots = new Map<MakaPluginRootId, LiveRoot>();
  readonly #entries = new Map<string, LiveEntry>();
  readonly #isolationLabels = new Map<string, symbol>();
  readonly #transaction?: (context: Context) => MakaPluginTransaction | undefined;
  #generation = 0;
  #mutation: Promise<void> = Promise.resolve();

  constructor(options: MakaCompositionLoaderOptions = {}) {
    this.root = options.root ?? new Context();
    this.#transaction = options.transaction;
  }

  install(pkg: MakaPluginPackage): Promise<void> {
    return this.#mutate(async () => {
      validatePluginPackage(pkg);
      const key = pluginPackageKey(pkg.packageId, pkg.revision);
      if (this.#packages.has(key)) {
        throw new MakaPluginRuntimeError(
          'package_exists',
          `Plugin package already exists: ${pkg.packageId}@${pkg.revision}`,
        );
      }
      this.#packages.set(key, freezePackage(pkg));
    });
  }

  uninstall(packageId: string, revision: string): Promise<void> {
    return this.#mutate(async () => {
      const key = pluginPackageKey(packageId, revision);
      if (!this.#packages.has(key)) {
        throw new MakaPluginRuntimeError(
          'package_not_found',
          `Plugin package is not installed: ${packageId}@${revision}`,
        );
      }
      const user = [...this.#entries.values()].find(
        (entry) => entry.spec.packageId === packageId && entry.spec.revision === revision,
      );
      if (user) {
        throw new MakaPluginRuntimeError(
          'package_in_use',
          `Plugin package is used by entry ${user.spec.id}`,
        );
      }
      this.#packages.delete(key);
    });
  }

  create(
    rootId: MakaPluginRootId,
    entry: MakaCompositionEntry,
    parentId?: string,
    position = Infinity,
  ): Promise<MakaCompositionEntryInspection> {
    return this.#mutate(async () => {
      validatePluginRootId(rootId);
      validateCompositionEntry(entry);
      this.#assertUniqueSubtree(entry);
      const root = this.#root(rootId);
      const parent = parentId ? this.#requireEntry(parentId) : undefined;
      if (parent && parent.rootId !== rootId) {
        throw new MakaPluginRuntimeError(
          'invalid_entry',
          'Composition entries cannot move between roots',
        );
      }
      const live = await this.#stage(entry, rootId, parent, parent?.context ?? root.context, false);
      await this.#commitSubtree(live);
      const siblings = parent?.children ?? root.entries;
      siblings.splice(Math.min(position, siblings.length), 0, live);
      this.#index(live);
      return this.#inspect(live);
    });
  }

  update(
    entryId: string,
    patch: Partial<Omit<MakaCompositionEntry, 'id' | 'children'>>,
  ): Promise<MakaCompositionEntryInspection> {
    return this.#mutate(async () => {
      const current = this.#requireEntry(entryId);
      const next = freezeEntry({
        ...current.spec,
        ...patch,
        id: current.spec.id,
        children: current.spec.children,
      });
      validateCompositionEntry(next);
      const structural =
        next.packageId !== current.spec.packageId ||
        next.revision !== current.spec.revision ||
        JSON.stringify(next.inject ?? null) !== JSON.stringify(current.spec.inject ?? null) ||
        JSON.stringify(next.isolate ?? null) !== JSON.stringify(current.spec.isolate ?? null) ||
        JSON.stringify(next.intercept ?? null) !== JSON.stringify(current.spec.intercept ?? null);
      if (
        !structural &&
        current.fiber &&
        next.disabled !== true &&
        current.spec.disabled !== true
      ) {
        const previous = current.spec;
        try {
          await current.fiber.update(next.config);
          current.spec = next;
          current.generation = ++this.#generation;
          current.diagnostic = undefined;
        } catch (error) {
          await Promise.resolve(current.fiber.update(previous.config)).catch(() => undefined);
          current.diagnostic = diagnostic(error);
          throw new MakaPluginRuntimeError(
            'activation_failed',
            `Unable to update entry ${entryId}`,
            { cause: error },
          );
        }
        return this.#inspect(current);
      }
      return this.#replace(current, next);
    });
  }

  move(
    entryId: string,
    newParentId?: string,
    position = Infinity,
  ): Promise<MakaCompositionEntryInspection> {
    return this.#mutate(async () => {
      const entry = this.#requireEntry(entryId);
      const parent = newParentId ? this.#requireEntry(newParentId) : undefined;
      if (parent && parent.rootId !== entry.rootId) {
        throw new MakaPluginRuntimeError(
          'invalid_entry',
          'Composition entries cannot move between roots',
        );
      }
      for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
        if (ancestor === entry)
          throw new MakaPluginRuntimeError(
            'dependency_cycle',
            `Entry ${entryId} cannot contain itself`,
          );
      }
      const source = entry.parent?.children ?? this.#root(entry.rootId).entries;
      source.splice(source.indexOf(entry), 1);
      entry.parent = parent;
      const target = parent?.children ?? this.#root(entry.rootId).entries;
      target.splice(Math.min(position, target.length), 0, entry);
      await this.#rebind(entry);
      return this.#inspect(entry);
    });
  }

  enable(entryId: string): Promise<MakaCompositionEntryInspection> {
    return this.update(entryId, { disabled: false });
  }

  disable(entryId: string): Promise<MakaCompositionEntryInspection> {
    return this.update(entryId, { disabled: true });
  }

  replaceRevision(entryId: string, revision: string): Promise<MakaCompositionEntryInspection> {
    return this.update(entryId, { revision });
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
      const descendantIds = new Set([...walk(entry)].map((item) => item.id));
      for (const id of descendantIds) {
        const existing = this.#entries.get(id);
        if (existing && !isWithin(existing, current)) {
          throw new MakaPluginRuntimeError(
            'entry_exists',
            `Composition entry already exists: ${id}`,
          );
        }
      }
      return this.#replace(current, freezeEntry(entry));
    });
  }

  remove(entryId: string): Promise<void> {
    return this.#mutate(async () => {
      const entry = this.#requireEntry(entryId);
      const siblings = entry.parent?.children ?? this.#root(entry.rootId).entries;
      siblings.splice(siblings.indexOf(entry), 1);
      this.#unindex(entry);
      await this.#dispose(entry);
    });
  }

  inspectTree(rootId?: MakaPluginRootId): readonly MakaCompositionEntryInspection[] {
    const roots = rootId ? [this.#root(rootId)] : [...this.#roots.values()];
    return Object.freeze(
      roots.flatMap((root) => root.entries.map((entry) => this.#inspect(entry))),
    );
  }

  inspect(entryId: string): MakaCompositionEntryInspection {
    return this.#inspect(this.#requireEntry(entryId));
  }

  installedPackages(): readonly { readonly packageId: string; readonly revision: string }[] {
    return Object.freeze(
      [...this.#packages.values()]
        .map(({ packageId, revision }) => Object.freeze({ packageId, revision }))
        .sort(
          (left, right) =>
            left.packageId.localeCompare(right.packageId) ||
            left.revision.localeCompare(right.revision),
        ),
    );
  }

  package(packageId: string, revision: string): MakaPluginPackage {
    const pkg = this.#packages.get(pluginPackageKey(packageId, revision));
    if (!pkg) {
      throw new MakaPluginRuntimeError(
        'package_not_found',
        `Plugin package is not installed: ${packageId}@${revision}`,
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

  snapshot(): MakaCompositionSnapshot {
    const encode = (rootId: MakaPluginRootId): readonly MakaCompositionEntry[] =>
      Object.freeze((this.#roots.get(rootId)?.entries ?? []).map((entry) => serialize(entry)));
    const sessions: Record<string, readonly MakaCompositionEntry[]> = {};
    for (const root of this.#roots.values()) {
      if (root.id.startsWith('session:'))
        sessions[root.id.slice('session:'.length)] = encode(root.id);
    }
    return Object.freeze({
      schemaVersion: 1,
      generation: this.#generation,
      roots: Object.freeze({
        profile: encode('profile'),
        desktopUi: encode('desktop-ui'),
        sessions: Object.freeze(sessions),
      }),
    });
  }

  replaceSnapshot(snapshot: MakaCompositionSnapshot): Promise<void> {
    return this.#mutate(async () => {
      if (snapshot.schemaVersion !== 1)
        throw new MakaPluginRuntimeError('invalid_entry', 'Unsupported composition snapshot');
      const specs = new Map<MakaPluginRootId, readonly MakaCompositionEntry[]>([
        ['profile', snapshot.roots.profile],
        ['desktop-ui', snapshot.roots.desktopUi],
        ...Object.entries(snapshot.roots.sessions).map(
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
        await Promise.allSettled(
          [...stagedRoots.values()].map((root) => root.context.fiber.dispose()),
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
      this.#generation = Math.max(this.#generation, snapshot.generation);
      await Promise.allSettled(previous.map((root) => root.context.fiber.dispose()));
    });
  }

  async close(): Promise<void> {
    await this.#mutate(async () => {
      const roots = [...this.#roots.values()];
      this.#roots.clear();
      this.#entries.clear();
      await Promise.allSettled(roots.map((root) => root.context.fiber.dispose()));
      await this.root.fiber.dispose();
    });
  }

  async #replace(
    current: LiveEntry,
    spec: MakaCompositionEntry,
  ): Promise<MakaCompositionEntryInspection> {
    const parentContext = current.parent?.context ?? this.#root(current.rootId).context;
    const candidate = await this.#stage(spec, current.rootId, current.parent, parentContext, false);
    try {
      await this.#commitSubtree(candidate);
    } catch (error) {
      await this.#dispose(candidate);
      current.diagnostic = diagnostic(error);
      throw error;
    }
    const siblings = current.parent?.children ?? this.#root(current.rootId).entries;
    const index = siblings.indexOf(current);
    this.#unindex(current);
    siblings[index] = candidate;
    this.#index(candidate);
    await this.#dispose(current);
    return this.#inspect(candidate);
  }

  async #rebind(entry: LiveEntry): Promise<void> {
    const replacement = await this.#stage(
      serialize(entry),
      entry.rootId,
      entry.parent,
      entry.parent?.context ?? this.#root(entry.rootId).context,
      false,
    );
    await this.#commitSubtree(replacement);
    const siblings = entry.parent?.children ?? this.#root(entry.rootId).entries;
    const index = siblings.indexOf(entry);
    this.#unindex(entry);
    siblings[index] = replacement;
    this.#index(replacement);
    await this.#dispose(entry);
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
    if (!disabled && spec.packageId && spec.revision) {
      const pkg = this.#packages.get(pluginPackageKey(spec.packageId, spec.revision));
      if (!pkg)
        throw new MakaPluginRuntimeError(
          'package_not_found',
          `Plugin package is not installed: ${spec.packageId}@${spec.revision}`,
        );
      if (!pkg.host)
        throw new MakaPluginRuntimeError(
          'invalid_package',
          `Plugin package has no Host plugin: ${spec.packageId}@${spec.revision}`,
        );
      const generation = ++this.#generation;
      const metadata: MakaPluginMetadata = Object.freeze({
        rootId,
        entryId: spec.id,
        packageId: spec.packageId,
        revision: spec.revision,
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
        await live.fiber.dispose().catch(() => undefined);
        await transaction?.rollback();
        throw new MakaPluginRuntimeError(
          'activation_failed',
          `Unable to activate entry ${spec.id}: ${diagnostic(error)}`,
          { cause: error },
        );
      }
    }
    for (const child of spec.children ?? [])
      live.children.push(await this.#stage(child, rootId, live, live.context, disabled));
    return live;
  }

  async #commitSubtree(entry: LiveEntry): Promise<void> {
    await entry.context.makaTransaction?.commit();
    for (const child of entry.children) await this.#commitSubtree(child);
  }

  async #dispose(entry: LiveEntry): Promise<void> {
    await Promise.allSettled([...entry.children].reverse().map((child) => this.#dispose(child)));
    await entry.context.makaTransaction?.rollback();
    if (entry.fiber) await entry.fiber.dispose();
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
    const inject = Array.isArray(entry.spec.inject)
      ? entry.spec.inject
      : Object.keys(entry.spec.inject ?? {});
    const waitingFor =
      entry.fiber?.state === FIBER_PENDING
        ? inject.filter((name) => entry.context.get(name) === undefined)
        : [];
    return Object.freeze({
      id: entry.spec.id,
      rootId: entry.rootId,
      ...(entry.parent ? { parentId: entry.parent.spec.id } : {}),
      ...(entry.spec.packageId ? { packageId: entry.spec.packageId } : {}),
      ...(entry.spec.revision ? { revision: entry.spec.revision } : {}),
      ...(entry.spec.config === undefined ? {} : { config: structuredClone(entry.spec.config) }),
      disabled: isDisabled(entry),
      status:
        entry.spec.disabled === true
          ? 'disabled'
          : entry.fiber
            ? fiberStateName(entry.fiber.state)
            : 'active',
      ...(entry.generation === undefined ? {} : { generation: entry.generation }),
      waitingFor: Object.freeze(waitingFor),
      effects: Object.freeze(entry.fiber?.getEffects().map(({ label }) => label) ?? []),
      children: Object.freeze(entry.children.map((child) => this.#inspect(child))),
      ...(entry.diagnostic ? { diagnostic: entry.diagnostic } : {}),
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
    async apply(ctx: Context, config: unknown) {
      const child = ctx.plugin(plugin, config as never);
      await child.await();
      return () => child.dispose();
    },
  };
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

function* walk(entry: MakaCompositionEntry): Generator<MakaCompositionEntry> {
  yield entry;
  for (const child of entry.children ?? []) yield* walk(child);
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
