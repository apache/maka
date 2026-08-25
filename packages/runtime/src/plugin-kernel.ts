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

export type Awaitable<T> = T | PromiseLike<T>;

export type Disposable<T = void | Promise<void>> = () => T;

export type Inject = readonly string[] | Readonly<Record<string, unknown>>;

export const enum FiberState {
  PENDING,
  LOADING,
  ACTIVE,
  FAILED,
  DISPOSED,
  UNLOADING,
}

export interface EffectMeta {
  readonly label: string;
  readonly children: readonly EffectMeta[];
}

export interface StandardSchema {
  readonly '~standard': {
    validate(
      value: unknown,
    ):
      | { readonly value: unknown; readonly issues?: undefined }
      | { readonly issues: readonly { readonly message: string }[] }
      | Promise<
          | { readonly value: unknown; readonly issues?: undefined }
          | { readonly issues: readonly { readonly message: string }[] }
        >;
  };
}

export type Plugin<T = unknown> = Plugin.Function<T> | Plugin.Constructor<T> | Plugin.Object<T>;

export namespace Plugin {
  export interface Base {
    readonly name?: string;
    readonly inject?: Inject;
    readonly Config?: StandardSchema;
  }

  export type Function<T = unknown> = Base & ((ctx: Context, config: T) => unknown);

  export type Constructor<T = unknown> = Base & (new (ctx: Context, config: T) => unknown);

  export interface Object<T = unknown> extends Base {
    apply(ctx: Context, config: T): unknown;
  }
}

export interface EventOptions {
  readonly prepend?: boolean;
  readonly global?: boolean;
}

interface ServiceImplementation {
  readonly name: string;
  readonly label: symbol;
  readonly fiber: Fiber;
  value: unknown;
  readonly check?: () => boolean;
}

interface Hook {
  readonly context: Context;
  readonly listener: (...args: unknown[]) => unknown;
  readonly global: boolean;
}

interface Accessor {
  readonly owner: Fiber;
  readonly get: (this: Context, receiver: unknown) => unknown;
  readonly set?: (this: Context, value: unknown, receiver: unknown) => boolean;
}

interface PluginRuntime {
  readonly callback: Function;
  readonly fibers: Set<Fiber>;
  readonly name?: string;
  readonly Config?: StandardSchema;
}

interface KernelState {
  readonly root: Context;
  readonly services: Map<symbol, ServiceImplementation>;
  readonly serviceLabels: Map<string, symbol>;
  readonly runtimes: WeakMap<Plugin, PluginRuntime>;
  readonly listeners: Map<PropertyKey, Hook[]>;
  readonly accessors: Map<PropertyKey, Accessor>;
  readonly fibers: Set<Fiber>;
  nextFiberId: number;
  closed: boolean;
}

const contextBrand = Symbol.for('maka.plugin-kernel.context');
const effectMeta = Symbol('maka.plugin-kernel.effect-meta');
const disposedFibers = new WeakSet<Fiber>();

export interface Logger {
  readonly name: string;
  error(value: unknown, ...values: unknown[]): void;
  warn(value: unknown, ...values: unknown[]): void;
  info(value: unknown, ...values: unknown[]): void;
  debug(value: unknown, ...values: unknown[]): void;
}

export interface LoggerService extends Logger {
  (name?: string): Logger;
}

export interface Context {
  readonly root: Context;
  readonly parent?: Context;
  readonly fiber: Fiber;
  readonly logger: LoggerService;
  [Context.filter]?: (listenerContext: Context) => boolean;
}

/** A non-owning capability view whose lifecycle and resources belong to exactly one Fiber. */
export class Context {
  static readonly effect = effectMeta;
  static readonly filter = Symbol('maka.plugin-kernel.filter');

  readonly [contextBrand] = true;
  readonly #kernel: KernelState;
  readonly #parent?: Context;
  #fiber!: Fiber;
  readonly #isolation: Readonly<Record<string, symbol>>;
  readonly #intercepts: Readonly<Record<string, readonly unknown[]>>;
  readonly #proxy: Context;

  static is(value: unknown): value is Context {
    return Boolean((value as { readonly [contextBrand]?: boolean } | undefined)?.[contextBrand]);
  }

  constructor();
  constructor(
    kernel?: KernelState,
    parent?: Context,
    fiber?: Fiber,
    isolation?: Readonly<Record<string, symbol>>,
    intercepts?: Readonly<Record<string, readonly unknown[]>>,
    meta?: object,
  );
  constructor(
    kernel?: KernelState,
    parent?: Context,
    fiber?: Fiber,
    isolation?: Readonly<Record<string, symbol>>,
    intercepts?: Readonly<Record<string, readonly unknown[]>>,
    meta: object = {},
  ) {
    this.#parent = parent;
    this.#isolation = isolation ?? parent?._isolation() ?? freezeRecord();
    this.#intercepts = intercepts ?? parent?._intercepts() ?? freezeRecord();
    this.#kernel = kernel ?? ({} as KernelState);
    this.#proxy = new Proxy(this, contextProxy);
    if (kernel) {
      this.#fiber = fiber ?? parent?.fiber ?? kernel.root.fiber;
    } else {
      const rootFiber = Fiber.root(this.#proxy);
      this.#fiber = rootFiber;
      Object.assign(this.#kernel, {
        root: this.#proxy,
        services: new Map(),
        serviceLabels: new Map(),
        runtimes: new WeakMap(),
        listeners: new Map(),
        accessors: new Map(),
        fibers: new Set([rootFiber]),
        nextFiberId: 0,
        closed: false,
      } satisfies KernelState);
    }
    assignContextMetadata(this, meta);
    Object.defineProperty(this, 'logger', {
      enumerable: true,
      configurable: false,
      value: createLoggerService(() => this.fiber.name),
    });
    return this.#proxy;
  }

  get root(): Context {
    return this.#kernel.root;
  }

  get parent(): Context | undefined {
    return this.#parent;
  }

  get fiber(): Fiber {
    return this.#fiber;
  }

  extend(meta: object = {}): this {
    this.#assertOpen();
    return this.fiber.deriveContext(this.#proxy, this.#isolation, this.#intercepts, meta) as this;
  }

  isolate(name: string, label = Symbol(name)): this {
    validateServiceName(name);
    return this.fiber.deriveContext(
      this.#proxy,
      freezeRecord({ ...this.#isolation, [name]: label }),
      this.#intercepts,
    ) as this;
  }

  intercept(name: string, config: unknown): this {
    validateServiceName(name);
    const existing = this.#intercepts[name] ?? [];
    return this.fiber.deriveContext(
      this.#proxy,
      this.#isolation,
      freezeRecord({ ...this.#intercepts, [name]: Object.freeze([...existing, config]) }),
    ) as this;
  }

  plugin<P extends Plugin>(plugin: P, config?: unknown): Fiber {
    this.#assertOpen();
    return this.fiber.mount(this.#proxy, plugin, config);
  }

  inject(inject: Inject, callback: Plugin.Function<void>): Fiber {
    return this.plugin(Object.assign(callback, { inject }));
  }

  effect(execute: () => unknown, label = 'anonymous'): Disposable<Promise<void>> {
    return this.fiber.own(execute, label);
  }

  provide(name: string, value?: unknown, check?: () => boolean): Disposable<Promise<void>> {
    this.#assertOpen();
    validateServiceName(name);
    const label = this.#label(name);
    if (this.#kernel.services.has(label)) {
      throw new Error(`Service is already provided in this scope: ${name}`);
    }
    return this.effect(
      () => {
        const implementation: ServiceImplementation = {
          name,
          label,
          value,
          fiber: this.fiber,
          check,
        };
        this.#kernel.services.set(label, implementation);
        this.#notifyService(name, label);
        return async () => {
          if (this.#kernel.services.get(label) !== implementation) return;
          this.#kernel.services.delete(label);
          await Promise.allSettled(this.#notifyService(name, label).map((fiber) => fiber.await()));
        };
      },
      `ctx.provide(${JSON.stringify(name)})`,
    );
  }

  get<T = unknown>(name: string, strict = true): T | undefined {
    const implementation = this.#implementation(name);
    if (!implementation) return undefined;
    if (strict && implementation.fiber.state !== FiberState.ACTIVE) return undefined;
    if (implementation.check && !implementation.check.call(implementation.value)) return undefined;
    return (
      implementation.value instanceof Service
        ? implementation.value._bind(this.#proxy)
        : implementation.value
    ) as T;
  }

  set(name: string, value: unknown): boolean {
    const implementation = this.#implementation(name);
    if (!implementation) throw new Error(`Cannot set missing Service: ${name}`);
    if (implementation.fiber !== this.fiber) {
      throw new Error(`Cannot mutate Service owned by another Fiber: ${name}`);
    }
    implementation.value = value;
    this.#notifyService(name, implementation.label);
    return true;
  }

  accessor(
    name: string,
    options: {
      readonly get: (this: Context, receiver: unknown) => unknown;
      readonly set?: (this: Context, value: unknown, receiver: unknown) => boolean;
    },
  ): Disposable<Promise<void>> {
    this.#assertAccessorAvailable(name);
    return this.effect(
      () => {
        const accessor = { owner: this.fiber, ...options };
        this.#kernel.accessors.set(name, accessor);
        return () => {
          if (this.#kernel.accessors.get(name) === accessor) this.#kernel.accessors.delete(name);
        };
      },
      `ctx.accessor(${JSON.stringify(name)})`,
    );
  }

  mixin(
    source: string | object,
    names: readonly string[] | Readonly<Record<string, string>>,
  ): void {
    const entries = Array.isArray(names)
      ? names.map((name) => [name, name] as const)
      : Object.entries(names);
    const targets = new Set<string>();
    for (const [, targetName] of entries) {
      if (targets.has(targetName))
        throw new Error(`Context property already exists: ${targetName}`);
      targets.add(targetName);
      this.#assertAccessorAvailable(targetName);
    }
    for (const [sourceName, targetName] of entries) {
      this.accessor(targetName, {
        get(receiver) {
          const target = typeof source === 'string' ? this.get(source) : source;
          const value = Reflect.get(target as object, sourceName, receiver ?? target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(value, receiver) {
          const target = typeof source === 'string' ? this.get(source) : source;
          return Reflect.set(target as object, sourceName, value, receiver ?? target);
        },
      });
    }
  }

  on(
    name: PropertyKey,
    listener: (...args: unknown[]) => unknown,
    options: boolean | EventOptions = {},
  ): Disposable<boolean> {
    this.#assertOpen();
    const normalized = typeof options === 'boolean' ? { prepend: options } : options;
    const hook: Hook = { context: this.#proxy, listener, global: normalized.global === true };
    const hooks = this.#kernel.listeners.get(name) ?? [];
    let active = true;
    const unregister = () => {
      if (!active) return false;
      active = false;
      const index = hooks.indexOf(hook);
      if (index >= 0) hooks.splice(index, 1);
      if (!hooks.length) this.#kernel.listeners.delete(name);
      return index >= 0;
    };
    this.effect(
      () => {
        if (normalized.prepend) hooks.unshift(hook);
        else hooks.push(hook);
        this.#kernel.listeners.set(name, hooks);
        return unregister;
      },
      `ctx.on(${String(name)})`,
    );
    return unregister;
  }

  once(
    name: PropertyKey,
    listener: (...args: unknown[]) => unknown,
    options: boolean | EventOptions = {},
  ): Disposable<boolean> {
    let unregister: Disposable<boolean>;
    unregister = this.on(
      name,
      (...args) => {
        unregister();
        return listener(...args);
      },
      options,
    );
    return unregister;
  }

  emit(...input: unknown[]): void {
    const { hooks, args } = this.#dispatch(input);
    for (const hook of hooks) hook.listener(...args);
  }

  async parallel(...input: unknown[]): Promise<void> {
    const { hooks, args } = this.#dispatch(input);
    const settled = await Promise.allSettled(
      hooks.map((hook) => Promise.resolve().then(() => hook.listener(...args))),
    );
    const errors = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(({ reason }) => reason);
    if (errors.length) throw new AggregateError(errors);
  }

  async serial(...input: unknown[]): Promise<unknown> {
    const { hooks, args } = this.#dispatch(input);
    for (const hook of hooks) {
      const result = await hook.listener(...args);
      if (result !== undefined && result !== null && result !== false) return result;
    }
  }

  bail(...input: unknown[]): unknown {
    const { hooks, args } = this.#dispatch(input);
    for (const hook of hooks) {
      const result = hook.listener(...args);
      if (result !== undefined && result !== null && result !== false) return result;
    }
  }

  waterfall(...input: unknown[]): unknown {
    const { hooks, args } = this.#dispatch(input);
    const terminal = args.pop();
    if (typeof terminal !== 'function')
      throw new TypeError('Waterfall requires a terminal callback');
    const callbacks = hooks.map(({ listener }) => listener);
    const next = (): unknown => {
      const callback = callbacks.shift() ?? terminal;
      return callback(...args, next);
    };
    return next();
  }

  interceptConfig(name: string): readonly unknown[] {
    return this.#intercepts[name] ?? [];
  }

  kernelFibers(): readonly Fiber[] {
    return Object.freeze([...this.#kernel.fibers]);
  }

  #dispatch(input: readonly unknown[]): {
    readonly hooks: readonly Hook[];
    readonly args: unknown[];
  } {
    const args = [...input];
    const thisArg = Context.is(args[0]) ? (args.shift() as Context) : undefined;
    const name = args.shift();
    if (typeof name !== 'string' && typeof name !== 'symbol') {
      throw new TypeError('Event name must be a string or symbol');
    }
    const filter = thisArg?.[Context.filter];
    const hooks = (this.#kernel.listeners.get(name) ?? []).filter(
      (hook) => hook.global || !filter || filter(hook.context),
    );
    return { hooks, args };
  }

  #implementation(name: string): ServiceImplementation | undefined {
    const label = this.#lookupLabel(name);
    return label ? this.#kernel.services.get(label) : undefined;
  }

  #lookupLabel(name: string): symbol | undefined {
    return this.#isolation[name] ?? this.#kernel.serviceLabels.get(name);
  }

  #label(name: string): symbol {
    const isolated = this.#isolation[name];
    if (isolated) return isolated;
    let label = this.#kernel.serviceLabels.get(name);
    if (!label) {
      label = Symbol(name);
      this.#kernel.serviceLabels.set(name, label);
    }
    return label;
  }

  #notifyService(name: string, label: symbol): Fiber[] {
    return notifyService(this.#kernel, name, label);
  }

  #assertOpen(): void {
    if (
      this.#kernel.closed ||
      disposedFibers.has(this.fiber) ||
      this.fiber.state === FiberState.DISPOSED ||
      this.fiber.state === FiberState.UNLOADING
    ) {
      throw new Error('Plugin Context is disposed');
    }
  }

  #assertAccessorAvailable(name: string): void {
    this.#assertOpen();
    if (
      Reflect.has(this, name) ||
      hasAncestorProperty(this.parent, name) ||
      this.#kernel.accessors.has(name)
    ) {
      throw new Error(`Context property already exists: ${name}`);
    }
  }

  _kernel(): KernelState {
    return this.#kernel;
  }

  _label(name: string): symbol {
    return this.#label(name);
  }

  _isolation(): Readonly<Record<string, symbol>> {
    return this.#isolation;
  }

  _intercepts(): Readonly<Record<string, readonly unknown[]>> {
    return this.#intercepts;
  }
}

function assignContextMetadata(context: Context, meta: object): void {
  for (const key of Reflect.ownKeys(meta)) {
    const descriptor = Object.getOwnPropertyDescriptor(meta, key);
    if (!descriptor?.enumerable) continue;
    if (key === 'logger' || Reflect.has(context, key)) {
      throw new Error(`Context metadata cannot overwrite owned field: ${String(key)}`);
    }
  }
  Object.assign(context, meta);
}

const contextProxy: ProxyHandler<Context> = {
  get(target, property, receiver) {
    if (Reflect.has(target, property)) {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' && Object.hasOwn(Context.prototype, property)
        ? value.bind(target)
        : value;
    }
    for (let ancestor = target.parent; ancestor; ancestor = ancestor.parent) {
      if (Object.hasOwn(ancestor, property)) return Reflect.get(ancestor, property);
    }
    const accessor = target._kernel().accessors.get(property);
    if (accessor) return accessor.get.call(receiver as Context, receiver);
    if (typeof property === 'string') {
      const service = target.get(property);
      if (service !== undefined) return service;
    }
  },
  set(target, property, value, receiver) {
    if (Reflect.has(target, property)) return Reflect.set(target, property, value, target);
    const accessor = target._kernel().accessors.get(property);
    if (accessor?.set) return accessor.set.call(receiver as Context, value, receiver);
    if (typeof property === 'string' && target.get(property, false) !== undefined) {
      return target.set(property, value);
    }
    return Reflect.set(target, property, value, receiver);
  },
  has(target, property) {
    return (
      Reflect.has(target, property) ||
      target._kernel().accessors.has(property) ||
      (typeof property === 'string' && target.get(property, false) !== undefined) ||
      hasAncestorProperty(target.parent, property)
    );
  },
};

function hasAncestorProperty(context: Context | undefined, property: PropertyKey): boolean {
  for (let ancestor = context; ancestor; ancestor = ancestor.parent) {
    if (Object.hasOwn(ancestor, property)) return true;
  }
  return false;
}

/** The sole lifecycle, child-instance, dependency, error, and resource owner at runtime. */
export class Fiber {
  readonly id: number;
  readonly context: Context;
  readonly parent?: Fiber;
  readonly plugin?: Plugin;
  readonly inject: Readonly<Record<string, unknown>>;
  state: FiberState;
  config: unknown;
  inertia?: Promise<void>;
  error?: unknown;

  readonly #runtime?: PluginRuntime;
  readonly #children = new Set<Fiber>();
  readonly #effects: Array<Disposable<Awaitable<void>> & { [effectMeta]?: EffectMeta }> = [];
  readonly #services = new Map<string, unknown>();
  #disposed = false;
  #cleanupFailed = false;
  #dependencyRefreshQueued = false;
  #disposeTask?: Promise<void>;
  #transition: Promise<void> = Promise.resolve();

  static root(context: Context): Fiber {
    return new Fiber(context, undefined, undefined, {}, undefined, true);
  }

  constructor(
    parentContext: Context,
    plugin: Plugin | undefined,
    config: unknown,
    inject: Readonly<Record<string, unknown>>,
    runtime: PluginRuntime | undefined,
    root = false,
  ) {
    this.parent = root ? undefined : parentContext.fiber;
    this.plugin = plugin;
    this.config = config;
    this.inject = inject;
    this.#runtime = runtime;
    const kernel = parentContext._kernel();
    this.id = root ? 0 : ++kernel.nextFiberId;
    this.state = root ? FiberState.ACTIVE : FiberState.PENDING;
    this.context = root
      ? parentContext
      : new Context(kernel, parentContext, this, undefined, undefined);
    if (!root) {
      kernel.fibers.add(this);
      runtime?.fibers.add(this);
      if (this.parent) this.parent.#children.add(this);
      this.refreshDependencies();
    }
  }

  deriveContext(
    parent: Context = this.context,
    isolation?: Readonly<Record<string, symbol>>,
    intercepts?: Readonly<Record<string, readonly unknown[]>>,
    meta: object = {},
  ): Context {
    if (parent.fiber !== this) {
      throw new Error('Cannot derive a Context view from another Fiber');
    }
    if (
      this.#disposed ||
      this.state === FiberState.DISPOSED ||
      this.state === FiberState.UNLOADING
    ) {
      throw new Error('Cannot derive a Context view from an inactive Fiber');
    }
    return new Context(parent._kernel(), parent, this, isolation, intercepts, meta);
  }

  mount<P extends Plugin>(context: Context, plugin: P, config?: unknown): Fiber {
    if (context.fiber !== this) {
      throw new Error('Cannot mount a child through a Context owned by another Fiber');
    }
    if (
      this.#disposed ||
      this.state === FiberState.DISPOSED ||
      this.state === FiberState.UNLOADING
    ) {
      throw new Error('Cannot mount a child on an inactive Fiber');
    }
    const kernel = context._kernel();
    const callback = resolvePlugin(plugin);
    let runtime = kernel.runtimes.get(plugin);
    if (!runtime) {
      runtime = {
        callback,
        fibers: new Set(),
        name: plugin.name,
        Config: plugin.Config,
      };
      kernel.runtimes.set(plugin, runtime);
    }
    const fiber = new Fiber(context, plugin, config, normalizeInject(plugin.inject), runtime);
    return fiber;
  }

  get name(): string {
    return (
      this.#runtime?.name || this.plugin?.name || (this.id === 0 ? 'root' : `plugin-${this.id}`)
    );
  }

  requires(name: string): boolean {
    return Object.hasOwn(this.inject, name);
  }

  serviceLabel(name: string): symbol {
    return this.context._label(name);
  }

  refreshDependencies(): void {
    if (this.#disposed || !this.plugin) return;
    if (this.#dependencyRefreshQueued) return;
    this.#dependencyRefreshQueued = true;
    this.#enqueue(async () => {
      this.#dependencyRefreshQueued = false;
      await this.#refreshDependencies();
    });
  }

  async #refreshDependencies(): Promise<void> {
    if (this.#disposed || !this.plugin) return;
    const next = new Map<string, unknown>();
    for (const name of Object.keys(this.inject)) {
      let implementation: unknown;
      try {
        implementation = this.context.get(name);
      } catch (error) {
        const errors = [error];
        this.#services.clear();
        if (this.state === FiberState.ACTIVE || this.state === FiberState.FAILED) {
          try {
            await this.#unload(FiberState.PENDING);
          } catch (cleanupError) {
            errors.push(cleanupError);
          }
        }
        this.error =
          errors.length === 1
            ? error
            : new AggregateError(errors, `Fiber ${this.name} dependency check and cleanup failed`);
        this.#setState(FiberState.FAILED);
        return;
      }
      if (implementation === undefined) {
        this.#services.clear();
        if (this.state === FiberState.ACTIVE || this.state === FiberState.FAILED) {
          await this.#unload(FiberState.PENDING);
        } else {
          this.#setState(FiberState.PENDING);
        }
        return;
      }
      next.set(name, implementation);
    }
    const changed =
      next.size !== this.#services.size ||
      [...next].some(([name, value]) => this.#services.get(name) !== value);
    this.#services.clear();
    for (const [name, value] of next) this.#services.set(name, value);
    if (this.state === FiberState.PENDING || this.state === FiberState.FAILED) {
      await this.#load();
    } else if (this.state === FiberState.ACTIVE && changed) {
      await this.#unload(FiberState.PENDING);
      await this.#load();
    }
  }

  own(execute: () => unknown, label = 'anonymous'): Disposable<Promise<void>> {
    if (this.#disposed || this.state === FiberState.UNLOADING) {
      throw new Error('Cannot create an Effect on an inactive Fiber');
    }
    const disposers: Disposable<Awaitable<void>>[] = [];
    let disposeTask: Promise<void> | undefined;
    const collect = (value: unknown): void => {
      if (typeof value === 'function') disposers.push(value as Disposable<Awaitable<void>>);
      else if (value !== undefined && value !== null) {
        throw new TypeError('Plugin Effect must return a disposer');
      }
    };
    const run = async (): Promise<void> => {
      const result = execute();
      if (isAsyncIterable(result)) {
        for await (const value of result) collect(value);
      } else if (isIterable(result)) {
        for (const value of result) collect(value);
      } else {
        collect(await result);
      }
    };
    const setupTask = run();
    const dispose = Object.assign(
      () => {
        disposeTask ??= (async () => {
          await setupTask.catch(() => undefined);
          const errors: unknown[] = [];
          try {
            for (const cleanup of disposers.reverse()) {
              try {
                await cleanup();
              } catch (error) {
                errors.push(error);
              }
            }
          } finally {
            const index = this.#effects.indexOf(dispose);
            if (index >= 0) this.#effects.splice(index, 1);
          }
          if (errors.length) throw new AggregateError(errors, `Effect ${label} cleanup failed`);
        })();
        return disposeTask;
      },
      { [effectMeta]: Object.freeze({ label, children: Object.freeze([]) }) },
    );
    this.#effects.push(dispose);
    void setupTask.catch(async (error) => {
      const errors = [error];
      try {
        await dispose();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
      this.error =
        errors.length === 1
          ? error
          : new AggregateError(errors, `Effect ${label} setup and cleanup failed`);
    });
    return dispose;
  }

  getEffects(): readonly EffectMeta[] {
    return Object.freeze(
      this.#effects.flatMap((dispose) => (dispose[effectMeta] ? [dispose[effectMeta]] : [])),
    );
  }

  async await(): Promise<void> {
    while (this.inertia) await this.inertia.catch(() => undefined);
    if (this.state === FiberState.FAILED) throw this.error;
  }

  async restart(): Promise<void> {
    if (this.#disposed) throw new Error('Cannot restart a disposed Fiber');
    await this.#enqueue(() => this.#restart());
  }

  async update(config: unknown): Promise<void> {
    if (this.#disposed) throw new Error('Cannot update a disposed Fiber');
    await this.#enqueue(async () => {
      const previous = this.config;
      this.config = config;
      try {
        await this.#restart();
      } catch (error) {
        this.config = previous;
        try {
          await this.#restart();
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Fiber ${this.name} update and rollback failed`,
          );
        }
        throw error;
      }
    });
  }

  dispose(): Promise<void> {
    if (this.#disposeTask) return this.#disposeTask;
    this.#disposed = true;
    disposedFibers.add(this);
    this.#disposeTask = this.#enqueue(async () => {
      try {
        await this.#unload(FiberState.DISPOSED);
      } finally {
        const kernel = this.context._kernel();
        kernel.fibers.delete(this);
        this.#runtime?.fibers.delete(this);
        if (this.parent) this.parent.#children.delete(this);
        if (this.id === 0) kernel.closed = true;
      }
    });
    return this.#disposeTask;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.#transition.then(operation, operation);
    this.#transition = task.catch(() => undefined);
    const settled = task.finally(() => {
      if (this.inertia === settled) this.inertia = undefined;
    });
    void settled.catch(() => undefined);
    this.inertia = settled;
    return settled;
  }

  async #restart(): Promise<void> {
    if (this.#cleanupFailed) throw this.error;
    await this.#unload(FiberState.PENDING);
    if (this.#dependenciesAvailable()) await this.#load();
  }

  async #load(): Promise<void> {
    if (this.#disposed || !this.plugin || !this.#dependenciesAvailable()) return;
    if (this.#cleanupFailed) throw this.error;
    this.error = undefined;
    this.#setState(FiberState.LOADING);
    try {
      const config = await validateConfig(this.#runtime?.Config, this.config);
      const output = await invokePlugin(this.plugin, this.context, config);
      if (typeof output === 'function') this.own(() => output, `plugin:${this.name}`);
      else if (
        output !== undefined &&
        output !== null &&
        !(typeof this.plugin === 'function' && isConstructor(this.plugin))
      ) {
        throw new TypeError('Plugin must return a disposer or nothing');
      }
      this.#setState(FiberState.ACTIVE);
    } catch (error) {
      const errors = [error];
      try {
        await this.#disposeEffects();
      } catch (cleanupError) {
        this.#cleanupFailed = true;
        errors.push(cleanupError);
      }
      this.error =
        errors.length === 1
          ? error
          : new AggregateError(errors, `Fiber ${this.name} activation and cleanup failed`);
      this.#setState(FiberState.FAILED);
      throw this.error;
    }
  }

  async #unload(nextState: FiberState): Promise<void> {
    if (this.state === FiberState.DISPOSED) return;
    this.#setState(FiberState.UNLOADING);
    const childResults = await Promise.allSettled(
      [...this.#children].reverse().map((child) => child.dispose()),
    );
    const errors = childResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    try {
      await this.#disposeEffects();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      this.#cleanupFailed = true;
      this.error = new AggregateError(errors, `Fiber ${this.name} cleanup failed`);
      this.#setState(nextState === FiberState.DISPOSED ? FiberState.DISPOSED : FiberState.FAILED);
      throw this.error;
    }
    this.#setState(nextState);
  }

  async #disposeEffects(): Promise<void> {
    const errors: unknown[] = [];
    for (const dispose of [...this.#effects].reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, `Fiber ${this.name} Effect cleanup failed`);
  }

  #dependenciesAvailable(): boolean {
    return Object.keys(this.inject).every((name) => this.context.get(name) !== undefined);
  }

  #setState(state: FiberState): void {
    const previous = this.state;
    this.state = state;
    if (state === FiberState.ACTIVE) {
      notifyProvidedServices(this.context._kernel(), this);
    }
    if (previous !== state) this.context.emit('internal/status', this, previous);
  }
}

function notifyService(kernel: KernelState, name: string, label: symbol): Fiber[] {
  const fibers = serviceConsumers(kernel, name, label);
  for (const fiber of fibers) fiber.refreshDependencies();
  return fibers;
}

function notifyProvidedServices(kernel: KernelState, provider: Fiber): void {
  const fibers = new Set<Fiber>();
  for (const implementation of kernel.services.values()) {
    if (implementation.fiber !== provider) continue;
    for (const fiber of serviceConsumers(kernel, implementation.name, implementation.label)) {
      fibers.add(fiber);
    }
  }
  for (const fiber of fibers) fiber.refreshDependencies();
}

function serviceConsumers(kernel: KernelState, name: string, label: symbol): Fiber[] {
  const fibers: Fiber[] = [];
  for (const fiber of kernel.fibers) {
    if (!fiber.requires(name) || fiber.serviceLabel(name) !== label) continue;
    fibers.push(fiber);
  }
  return fibers;
}

export abstract class Service<T = unknown> {
  readonly name: string;
  readonly #contexts = new WeakMap<Context, this>();

  constructor(
    protected readonly ctx: Context,
    name: string,
  ) {
    this.name = name;
    ctx.provide(name, this);
  }

  _bind(context: Context): this {
    const cached = this.#contexts.get(context);
    if (cached) return cached;
    const bound = new Proxy(this, {
      get: (target, property, receiver) => {
        if (property === 'ctx') return context;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(receiver) : value;
      },
    });
    this.#contexts.set(context, bound);
    return bound;
  }

  protected resolveConfig(base?: T, head?: T): T {
    const values = [base, ...this.ctx.interceptConfig(this.name), head].filter(
      (value): value is T => value !== undefined,
    );
    return Object.assign({}, ...values);
  }
}

function normalizeInject(inject: Inject | undefined): Readonly<Record<string, unknown>> {
  if (!inject) return freezeRecord();
  if (Array.isArray(inject)) {
    return freezeRecord(Object.fromEntries(inject.map((name) => [name, null])));
  }
  return freezeRecord(inject as Readonly<Record<string, unknown>>);
}

function freezeRecord<T>(source?: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, source));
}

function resolvePlugin(plugin: Plugin): Function {
  if (typeof plugin === 'function') return plugin;
  if (plugin && typeof plugin.apply === 'function') return plugin.apply;
  throw new TypeError('Plugin must be a function, class, or object with apply()');
}

async function invokePlugin(plugin: Plugin, context: Context, config: unknown): Promise<unknown> {
  if (typeof plugin === 'function') {
    if (isConstructor(plugin)) return Reflect.construct(plugin, [context, config]);
    return (plugin as Plugin.Function)(context, config);
  }
  return plugin.apply(context, config);
}

function isConstructor(value: Function): boolean {
  return /^class\s/u.test(Function.prototype.toString.call(value));
}

async function validateConfig(
  schema: StandardSchema | undefined,
  value: unknown,
): Promise<unknown> {
  if (!schema) return value;
  const result = await schema['~standard'].validate(value);
  if ('issues' in result && result.issues) {
    throw new TypeError(result.issues.map(({ message }) => message).join('; '));
  }
  return result.value;
}

function validateServiceName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._:-]*$/u.test(name))
    throw new TypeError(`Invalid Service name: ${name}`);
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return Boolean(value && typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function');
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(
    value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function',
  );
}

function createLoggerService(name: () => string): LoggerService {
  const create = (explicit?: string): Logger => {
    const loggerName = explicit || name();
    return {
      name: loggerName,
      error: (value, ...values) => console.error(`[${loggerName}]`, value, ...values),
      warn: (value, ...values) => console.warn(`[${loggerName}]`, value, ...values),
      info: (value, ...values) => console.info(`[${loggerName}]`, value, ...values),
      debug: (value, ...values) => console.debug(`[${loggerName}]`, value, ...values),
    };
  };
  const callable = ((explicit?: string) => create(explicit)) as LoggerService;
  Object.defineProperties(callable, {
    name: { value: 'logger' },
    error: { value: (value: unknown, ...values: unknown[]) => create().error(value, ...values) },
    warn: { value: (value: unknown, ...values: unknown[]) => create().warn(value, ...values) },
    info: { value: (value: unknown, ...values: unknown[]) => create().info(value, ...values) },
    debug: { value: (value: unknown, ...values: unknown[]) => create().debug(value, ...values) },
  });
  return callable;
}
