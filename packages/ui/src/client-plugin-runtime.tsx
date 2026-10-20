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

import type { ReactNode } from 'react';
import { Component, useSyncExternalStore } from 'react';
import type {
  MakaClientProductEventMap,
  MakaClientProductEventName,
  MakaClientProductEventOptions,
  MakaClientRemoteInput,
  MakaClientRemoteMethodName,
  MakaClientRemoteOutput,
  MakaClientRemoteOptions,
  MakaClientRemoteStreamInput,
  MakaClientRemoteStreamItem,
  MakaClientRemoteStreamName,
  MakaClientRemoteStreamOptions,
} from '@maka/core/client-plugin-bridge';
import {
  MakaClientSlotCore,
  MakaClientSlotProvider,
  type MakaClientLiveSlotNode,
  type MakaClientSlotRegistrar,
} from './client-plugin-slots.js';
import { remoteStream } from './client-plugin-remote-stream.js';

export interface MakaClientPluginDescriptor {
  readonly entryId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly contentDigest: string;
  readonly clientDigest: string;
  readonly totalBytes: number;
  readonly dependencies: readonly string[];
  readonly url: string;
  readonly config?: Readonly<Record<string, string | number | boolean>>;
}

export interface MakaClientPluginDiagnostic {
  readonly entryId?: string;
  readonly extensionId?: string;
  readonly diagnostic: string;
}

export interface MakaClientPluginSnapshot {
  readonly authorityEpoch: number;
  readonly revision: string;
  readonly plugins: readonly MakaClientPluginDescriptor[];
  readonly failures: readonly MakaClientPluginDiagnostic[];
}

export interface MakaClientBundleRegistration {
  readonly id: string;
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>;
}

export interface MakaClientModuleLoaderTarget {
  load(registration: MakaClientBundleRegistration): void;
  inspect(): MakaClientPluginRuntimeInspection;
}

declare global {
  interface Window {
    /** Stable factory-registration facade used by trusted Client bundles. */
    __MakaModuleLoader__?: MakaClientModuleLoaderTarget;
  }
}

export interface MakaClientRootProps {
  readonly children: ReactNode;
}

export type MakaClientRootComponent = (props: MakaClientRootProps) => ReactNode;

export type MakaClientPluginSlots = MakaClientSlotRegistrar & {
  register(options: { readonly name: 'root' }, component: MakaClientRootComponent): () => void;
};

export interface MakaClientPluginContext {
  readonly id: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly slots: MakaClientPluginSlots;
  readonly remote: {
    call<const Name extends MakaClientRemoteMethodName>(
      name: Name,
      input: MakaClientRemoteInput<Name>,
      options?: MakaClientRemoteOptions,
    ): Promise<MakaClientRemoteOutput<Name>>;
    stream<const Name extends MakaClientRemoteStreamName>(
      name: Name,
      input: MakaClientRemoteStreamInput<Name>,
      options?: MakaClientRemoteStreamOptions,
    ): AsyncIterable<MakaClientRemoteStreamItem<Name>>;
  };
  readonly events: {
    on<const Name extends MakaClientProductEventName>(
      name: Name,
      options: MakaClientProductEventOptions<Name>,
      listener: (event: MakaClientProductEventMap[Name]) => void,
    ): () => void;
  };
  /** Stage an owned side effect. Setup runs only if the whole snapshot commits. */
  effect(setup: () => void | (() => void | Promise<void>), label?: string): () => void;
  /** Stage Client CSS with lifecycle-owned removal. */
  style(css: string, label?: string): () => void;
}

export type MakaClientPluginApply = (
  context: MakaClientPluginContext,
  config: Readonly<Record<string, string | number | boolean>>,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;

export interface MakaClientPluginRuntimeInspection {
  readonly revision: string | null;
  readonly active: readonly {
    readonly entryId: string;
    readonly extensionId: string;
    readonly generation: number;
  }[];
  readonly slots: readonly MakaClientLiveSlotNode[];
  readonly failure: { readonly revision: string; readonly diagnostic: string } | null;
}

interface StagedRootRegistration {
  readonly render: MakaClientRootComponent;
  readonly component: MakaClientRootComponent;
  cancelled: boolean;
}

class ClientRootBoundary extends Component<{
  readonly registration: StagedRootRegistration;
  readonly children?: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.registration.cancelled = true;
    console.error('Client Plugin root failed', error);
  }

  render(): ReactNode {
    if (this.state.failed || this.props.registration.cancelled) return this.props.children;
    const Root = this.props.registration.render;
    return <Root>{this.props.children}</Root>;
  }
}

interface StagedEffect {
  readonly setup: () => void | (() => void | Promise<void>);
  cancelled: boolean;
  cleanup?: () => void | Promise<void>;
}

interface PluginInstance {
  phase: 'staged' | 'active' | 'disposed';
  readonly descriptor: MakaClientPluginDescriptor;
  readonly roots: StagedRootRegistration[];
  readonly slotDisposers: Array<() => void>;
  readonly effects: StagedEffect[];
  readonly lifetime: AbortController;
}

interface MakaClientRootSnapshot {
  readonly components: readonly MakaClientRootComponent[];
  readonly slots: MakaClientSlotCore;
}

export class MakaClientRoot {
  readonly #listeners = new Set<() => void>();
  #snapshot: MakaClientRootSnapshot = Object.freeze({
    components: Object.freeze([]),
    slots: new MakaClientSlotCore(),
  });

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  snapshot = (): MakaClientRootSnapshot => this.#snapshot;

  replace(
    components: readonly MakaClientRootComponent[],
    slots: MakaClientSlotCore = new MakaClientSlotCore(),
  ): void {
    this.#snapshot = Object.freeze({
      components: Object.freeze([...components]),
      slots,
    });
    for (const listener of this.#listeners) listener();
  }
}

export function MakaClientRootOutlet(props: {
  readonly root: MakaClientRoot;
  readonly children: ReactNode;
}): ReactNode {
  const snapshot = useSyncExternalStore(
    props.root.subscribe,
    props.root.snapshot,
    props.root.snapshot,
  );
  return (
    <MakaClientSlotProvider core={snapshot.slots}>
      {snapshot.components.reduceRight<ReactNode>(
        (children, Component) => <Component>{children}</Component>,
        props.children,
      )}
    </MakaClientSlotProvider>
  );
}

export interface ClientPluginRuntimeOptions {
  readonly root: MakaClientRoot;
  readonly staticModules: Readonly<Record<string, unknown>>;
  readonly loadBundle?: (descriptor: MakaClientPluginDescriptor) => Promise<void>;
  readonly document?: Pick<Document, 'createElement' | 'head'>;
  readonly remote?: MakaClientRemoteTransport;
  readonly productEvents?: MakaClientProductEventTransport;
}

export interface MakaClientRemoteRequest {
  readonly authorityEpoch: number;
  readonly revision: string;
  readonly entryId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly contentDigest: string;
  readonly clientDigest: string;
  readonly method: string;
  readonly input: unknown;
  readonly sessionId?: string;
}

export interface MakaClientRemoteTransport {
  call(input: MakaClientRemoteRequest): Promise<{ readonly value: unknown }>;
  open(input: MakaClientRemoteRequest): Promise<{ readonly streamId: string }>;
  next(input: { readonly streamId: string }): Promise<
    { readonly done: false; readonly value: unknown } | { readonly done: true }
  >;
  close(input: { readonly streamId: string }): Promise<unknown>;
}

export interface MakaClientProductEventTransport {
  subscribe<const Name extends MakaClientProductEventName>(
    name: Name,
    options: MakaClientProductEventOptions<Name>,
    listener: (event: MakaClientProductEventMap[Name]) => void,
  ): () => void;
}

/** Trusted Renderer module runtime with whole-snapshot stage/swap rollback. */
export class ClientPluginRuntime {
  readonly #root: MakaClientRoot;
  readonly #staticModules: Readonly<Record<string, unknown>>;
  readonly #loadBundle: (descriptor: MakaClientPluginDescriptor) => Promise<void>;
  readonly #document: Pick<Document, 'createElement' | 'head'> | undefined;
  readonly #remote: MakaClientRemoteTransport | undefined;
  readonly #productEvents: MakaClientProductEventTransport | undefined;
  readonly #factories = new Map<string, MakaClientBundleRegistration['factory']>();
  readonly #modules = new Map<string, Record<string, unknown>>();
  #pending: MakaClientPluginDescriptor | undefined;
  #active: readonly PluginInstance[] = Object.freeze([]);
  #slots = new MakaClientSlotCore();
  #revision: string | null = null;
  #failure: { readonly revision: string; readonly diagnostic: string } | null = null;
  #closed = false;

  constructor(options: ClientPluginRuntimeOptions) {
    this.#root = options.root;
    this.#staticModules = options.staticModules;
    this.#document = options.document ?? globalThis.document;
    this.#loadBundle = options.loadBundle ?? ((descriptor) => this.#loadScript(descriptor));
    this.#remote = options.remote;
    this.#productEvents = options.productEvents;
  }

  readonly loader: MakaClientModuleLoaderTarget = {
    load: (registration) => this.registerBundle(registration),
    inspect: () => this.inspect(),
  };

  attachLoader(target: Window = globalThis.window): () => void {
    const previous = target.__MakaModuleLoader__;
    target.__MakaModuleLoader__ = this.loader;
    return () => {
      if (target.__MakaModuleLoader__ === this.loader) {
        target.__MakaModuleLoader__ = previous;
      }
    };
  }

  inspect(): MakaClientPluginRuntimeInspection {
    return Object.freeze({
      revision: this.#revision,
      active: Object.freeze(
        this.#active.map(({ descriptor }) =>
          Object.freeze({
            entryId: descriptor.entryId,
            extensionId: descriptor.extensionId,
            generation: descriptor.generation,
          }),
        ),
      ),
      slots: this.#slots.inspect(),
      failure: this.#failure,
    });
  }

  registerBundle(registration: MakaClientBundleRegistration): void {
    const pending = this.#pending;
    if (!pending) throw new Error('Client Plugin bundle registered outside a load request');
    if (registration.id !== pending.extensionId || typeof registration.factory !== 'function') {
      throw new Error(
        `Client Plugin bundle registered as ${registration.id}, expected ${pending.extensionId}`,
      );
    }
    const key = moduleKey(pending);
    if (this.#factories.has(key)) {
      throw new Error(`Client Plugin bundle registered twice: ${pending.extensionId}`);
    }
    this.#factories.set(key, registration.factory);
  }

  async reconcile(snapshot: MakaClientPluginSnapshot): Promise<void> {
    if (this.#closed) throw new Error('Client Plugin Runtime is closed');
    if (snapshot.revision === this.#revision) return;
    const staged: PluginInstance[] = [];
    const slots = new MakaClientSlotCore();
    try {
      const byExtension = indexDescriptors(snapshot.plugins);
      const ordered = orderDescriptors(snapshot.plugins, byExtension);
      // A package's exports may retain imports from a dependency generation.
      // Re-materialize the module graph for every candidate snapshot while
      // keeping immutable bundle factories cached by digest.
      this.#modules.clear();
      for (const descriptor of uniqueBundles(ordered)) await this.#ensureFactory(descriptor);
      if (this.#closed) throw new Error('Client Plugin Runtime is closed');
      for (const descriptor of ordered) {
        staged.push(await this.#stage(descriptor, byExtension, slots, snapshot));
      }
      if (this.#closed) throw new Error('Client Plugin Runtime is closed');
      for (const instance of staged) await commitEffects(instance);
      if (this.#closed) throw new Error('Client Plugin Runtime is closed');
    } catch (error) {
      await disposeInstances(staged);
      this.#retainFactories(this.#active.map(({ descriptor }) => descriptor));
      if (!this.#closed) {
        this.#failure = Object.freeze({
          revision: snapshot.revision,
          diagnostic: diagnostic(error),
        });
      }
      return;
    }

    const previous = this.#active;
    this.#root.replace(
      snapshot.plugins.flatMap((descriptor) =>
        staged
          .find((instance) => instance.descriptor.entryId === descriptor.entryId)!
          .roots.filter(({ cancelled }) => !cancelled)
          .map(({ component }) => component),
      ),
      slots,
    );
    this.#active = Object.freeze(staged);
    this.#slots = slots;
    this.#revision = snapshot.revision;
    this.#failure = null;
    this.#retainFactories(snapshot.plugins);
    await disposeInstances(previous);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#slots = new MakaClientSlotCore();
    this.#root.replace([], this.#slots);
    const active = this.#active;
    this.#active = Object.freeze([]);
    this.#revision = null;
    await disposeInstances(active);
    this.#factories.clear();
    this.#modules.clear();
  }

  async #ensureFactory(descriptor: MakaClientPluginDescriptor): Promise<void> {
    const key = moduleKey(descriptor);
    if (this.#factories.has(key)) return;
    if (this.#pending) throw new Error('Client Plugin bundle loads must be serialized');
    this.#pending = descriptor;
    try {
      await this.#loadBundle(descriptor);
      if (!this.#factories.has(key)) {
        throw new Error(`Client Plugin bundle did not register: ${descriptor.extensionId}`);
      }
    } finally {
      this.#pending = undefined;
    }
  }

  async #loadScript(descriptor: MakaClientPluginDescriptor): Promise<void> {
    const document = this.#document;
    if (!document) throw new Error('Client Plugin script loading requires a document');
    const script = document.createElement('script');
    script.async = true;
    script.src = descriptor.url;
    script.dataset.makaClientPlugin = descriptor.extensionId;
    try {
      await new Promise<void>((resolve, reject) => {
        script.addEventListener('load', () => resolve(), { once: true });
        script.addEventListener(
          'error',
          () => reject(new Error(`Unable to load Client Plugin ${descriptor.extensionId}`)),
          { once: true },
        );
        document.head.append(script);
      });
    } finally {
      script.remove();
    }
  }

  async #stage(
    descriptor: MakaClientPluginDescriptor,
    byExtension: ReadonlyMap<string, MakaClientPluginDescriptor>,
    slots: MakaClientSlotCore,
    snapshot: MakaClientPluginSnapshot,
  ): Promise<PluginInstance> {
    const exports = this.#materialize(descriptor, byExtension, new Set());
    const apply = exports.apply ?? exports.default;
    if (typeof apply !== 'function') {
      throw new Error(`Client Plugin ${descriptor.extensionId} must export apply(ctx)`);
    }
    const instance: PluginInstance = {
      descriptor,
      phase: 'staged',
      roots: [],
      slotDisposers: [],
      effects: [],
      lifetime: new AbortController(),
    };
    const context = this.#context(instance, slots, snapshot);
    try {
      const cleanup = await (apply as MakaClientPluginApply)(context, descriptor.config ?? {});
      if (typeof cleanup === 'function') {
        instance.effects.push({ setup: () => cleanup, cancelled: false });
      }
      return instance;
    } catch (error) {
      await disposeInstances([instance]);
      throw error;
    }
  }

  #context(
    instance: PluginInstance,
    slots: MakaClientSlotCore,
    snapshot: MakaClientPluginSnapshot,
  ): MakaClientPluginContext {
    const register = (options: { readonly name?: string }, component: unknown): (() => void) => {
      if (options?.name === 'root') {
        if (typeof component !== 'function') {
          throw new Error('Client Plugin root Slot component must be a function');
        }
        const registration: StagedRootRegistration = {
          component: ({ children }) => (
            <ClientRootBoundary registration={registration}>
              {children}
            </ClientRootBoundary>
          ),
          render: component as MakaClientRootComponent,
          cancelled: false,
        };
        instance.roots.push(registration);
        return () => {
          registration.cancelled = true;
        };
      }
      const dispose = slots.register(
        {
          ...options,
          registrant: `${instance.descriptor.extensionId}:${instance.descriptor.entryId}`,
        } as never,
        component as never,
      );
      instance.slotDisposers.push(dispose);
      return dispose;
    };
    return Object.freeze({
      id: instance.descriptor.entryId,
      extensionId: instance.descriptor.extensionId,
      generation: instance.descriptor.generation,
      slots: Object.freeze({
        register,
      }) as MakaClientPluginSlots,
      remote: Object.freeze({
        call: async <Name extends MakaClientRemoteMethodName>(
          name: Name,
          input: MakaClientRemoteInput<Name>,
          options?: MakaClientRemoteOptions,
        ): Promise<MakaClientRemoteOutput<Name>> => {
          const remote = this.#remote;
          if (!remote) throw new Error('Client Plugin Remote transport is unavailable');
          const result = await remote.call(
            remoteRequest(snapshot, instance.descriptor, name, input, options),
          );
          return result.value as MakaClientRemoteOutput<Name>;
        },
        stream: <Name extends MakaClientRemoteStreamName>(
          name: Name,
          input: MakaClientRemoteStreamInput<Name>,
          options?: MakaClientRemoteStreamOptions,
        ): AsyncIterable<MakaClientRemoteStreamItem<Name>> => {
          const remote = this.#remote;
          if (!remote) throw new Error('Client Plugin Remote transport is unavailable');
          const request = remoteRequest(snapshot, instance.descriptor, name, input, options);
          return remoteStream(remote, request, [instance.lifetime.signal, ...(options?.signal ? [options.signal] : [])]) as AsyncIterable<MakaClientRemoteStreamItem<Name>>;
        },
      }),
      events: Object.freeze({
        on: <Name extends MakaClientProductEventName>(
          name: Name,
          options: MakaClientProductEventOptions<Name>,
          listener: (event: MakaClientProductEventMap[Name]) => void,
        ) => {
          validateProductEventOptions(name, options);
          if (typeof listener !== 'function') {
            throw new Error('Client Plugin product event listener must be a function');
          }
          const productEvents = this.#productEvents;
          if (!productEvents) throw new Error('Client Plugin product events are unavailable');
          return stageEffect(instance, () => productEvents.subscribe(name, options, listener));
        },
      }),
      effect: (setup: () => void | (() => void | Promise<void>)) => {
        return stageEffect(instance, setup);
      },
      style: (css: string, label?: string) => {
        if (typeof css !== 'string') throw new Error('Client Plugin CSS must be a string');
        const document = this.#document;
        if (!document) throw new Error('Client Plugin CSS requires a document');
        return stageEffect(instance, () => {
          const element = document.createElement('style');
          element.dataset.makaClientPlugin = instance.descriptor.extensionId;
          if (label) element.dataset.makaClientPluginStyle = label;
          element.textContent = css;
          document.head.append(element);
          return () => element.remove();
        });
      },
    });
  }

  #materialize(
    descriptor: MakaClientPluginDescriptor,
    byExtension: ReadonlyMap<string, MakaClientPluginDescriptor>,
    visiting: Set<string>,
  ): Record<string, unknown> {
    const key = moduleKey(descriptor);
    const cached = this.#modules.get(key);
    if (cached) return cached;
    if (visiting.has(descriptor.extensionId)) {
      throw new Error(`Client Plugin module dependency cycle at ${descriptor.extensionId}`);
    }
    const factory = this.#factories.get(key);
    if (!factory) throw new Error(`Client Plugin factory is unavailable: ${descriptor.extensionId}`);
    const nextVisiting = new Set(visiting).add(descriptor.extensionId);
    const exports = factory((specifier) => {
      if (Object.hasOwn(this.#staticModules, specifier)) return this.#staticModules[specifier];
      const normalized = normalizeModuleId(specifier);
      if (Object.hasOwn(this.#staticModules, normalized)) return this.#staticModules[normalized];
      if (!descriptor.dependencies.includes(normalized)) {
        throw new Error(
          `Client Plugin ${descriptor.extensionId} requested undeclared module ${specifier}`,
        );
      }
      const dependency = byExtension.get(normalized);
      if (!dependency) {
        throw new Error(`Client Plugin dependency is not composed: ${normalized}`);
      }
      return this.#materialize(dependency, byExtension, nextVisiting);
    });
    if (!exports || typeof exports !== 'object') {
      throw new Error(`Client Plugin factory must return exports: ${descriptor.extensionId}`);
    }
    this.#modules.set(key, exports);
    return exports;
  }

  #retainFactories(descriptors: readonly MakaClientPluginDescriptor[]): void {
    const retained = new Set(descriptors.map(moduleKey));
    for (const key of this.#factories.keys()) {
      if (!retained.has(key)) this.#factories.delete(key);
    }
  }
}

function indexDescriptors(
  descriptors: readonly MakaClientPluginDescriptor[],
): ReadonlyMap<string, MakaClientPluginDescriptor> {
  const entries = new Set<string>();
  const byExtension = new Map<string, MakaClientPluginDescriptor>();
  for (const descriptor of descriptors) {
    if (entries.has(descriptor.entryId)) {
      throw new Error(`Client Plugin Entry repeats: ${descriptor.entryId}`);
    }
    entries.add(descriptor.entryId);
    const current = byExtension.get(descriptor.extensionId);
    if (
      current &&
      (current.contentDigest !== descriptor.contentDigest ||
        current.clientDigest !== descriptor.clientDigest)
    ) {
      throw new Error(`Client Plugin package has mixed generations: ${descriptor.extensionId}`);
    }
    byExtension.set(descriptor.extensionId, current ?? descriptor);
  }
  return byExtension;
}

function orderDescriptors(
  descriptors: readonly MakaClientPluginDescriptor[],
  byExtension: ReadonlyMap<string, MakaClientPluginDescriptor>,
): readonly MakaClientPluginDescriptor[] {
  const extensions: MakaClientPluginDescriptor[] = [];
  const state = new Map<string, 'visiting' | 'visited'>();
  const visit = (descriptor: MakaClientPluginDescriptor): void => {
    const current = state.get(descriptor.extensionId);
    if (current === 'visited') return;
    if (current === 'visiting') {
      throw new Error(`Client Plugin dependency cycle at ${descriptor.extensionId}`);
    }
    state.set(descriptor.extensionId, 'visiting');
    for (const dependencyId of descriptor.dependencies) {
      const dependency = byExtension.get(dependencyId);
      if (dependency) visit(dependency);
    }
    state.set(descriptor.extensionId, 'visited');
    extensions.push(descriptor);
  };
  for (const descriptor of descriptors) visit(descriptor);
  const rank = new Map(extensions.map((descriptor, index) => [descriptor.extensionId, index]));
  return [...descriptors].sort(
    (left, right) =>
      rank.get(left.extensionId)! - rank.get(right.extensionId)! ||
      descriptors.indexOf(left) - descriptors.indexOf(right),
  );
}

function uniqueBundles(
  descriptors: readonly MakaClientPluginDescriptor[],
): readonly MakaClientPluginDescriptor[] {
  const seen = new Set<string>();
  return descriptors.filter((descriptor) => {
    const key = moduleKey(descriptor);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeModuleId(value: string): string {
  return value.endsWith('/client') ? value.slice(0, -'/client'.length) : value;
}

function moduleKey(descriptor: MakaClientPluginDescriptor): string {
  return `${descriptor.extensionId}\u0000${descriptor.clientDigest}`;
}

function remoteRequest(
  snapshot: MakaClientPluginSnapshot,
  descriptor: MakaClientPluginDescriptor,
  method: string,
  input: unknown,
  options?: MakaClientRemoteOptions,
): MakaClientRemoteRequest {
  return Object.freeze({
    authorityEpoch: snapshot.authorityEpoch,
    revision: snapshot.revision,
    entryId: descriptor.entryId,
    extensionId: descriptor.extensionId,
    generation: descriptor.generation,
    contentDigest: descriptor.contentDigest,
    clientDigest: descriptor.clientDigest,
    method,
    input,
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
  });
}

function validateProductEventOptions<Name extends MakaClientProductEventName>(
  name: Name,
  options: MakaClientProductEventOptions<Name>,
): void {
  if (name === 'session.changed') {
    if (options.sessionId !== undefined) {
      throw new Error('session.changed does not accept a Session id');
    }
    return;
  }
  if (!options.sessionId) throw new Error(`${name} requires a Session id`);
}

function stageEffect(
  instance: PluginInstance,
  setup: () => void | (() => void | Promise<void>),
): () => void {
  if (typeof setup !== 'function') throw new Error('Client Plugin effect must be a function');
  if (instance.phase === 'disposed') throw new Error('Client Plugin instance is disposed');
  const effect: StagedEffect = { setup, cancelled: false };
  instance.effects.push(effect);
  if (instance.phase === 'active') startEffect(effect);
  return () => {
    effect.cancelled = true;
    const cleanup = effect.cleanup;
    effect.cleanup = undefined;
    void Promise.resolve().then(cleanup).catch(() => undefined);
  };
}

function startEffect(effect: StagedEffect): void {
  if (effect.cancelled) return;
  const cleanup = effect.setup();
  if (typeof cleanup === 'function') effect.cleanup = cleanup;
}

async function commitEffects(instance: PluginInstance): Promise<void> {
  for (const effect of instance.effects) startEffect(effect);
  instance.phase = 'active';
}

async function disposeInstances(instances: readonly PluginInstance[]): Promise<void> {
  for (const instance of [...instances].reverse()) {
    instance.phase = 'disposed';
    instance.lifetime.abort();
    for (const effect of [...instance.effects].reverse()) {
      const cleanup = effect.cleanup;
      effect.cleanup = undefined;
      if (!cleanup) continue;
      await Promise.resolve().then(cleanup).catch(() => undefined);
    }
    for (const dispose of [...instance.slotDisposers].reverse()) dispose();
  }
}

function diagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4096);
}
