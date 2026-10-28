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

import { batch, cleanup, computed, importModule, signal, type JSX, type Signal } from 'nsh';
import { host as nativeHost } from 'maka/host';
import type {
  UiCatalog,
  UiContribution,
  UiInstance as CatalogInstance,
  UiTarget,
} from '../../../../../packages/plugin-sdk/src/generated/runtime.js';
import type {
  UiContext,
  UiContributionRef,
  UiContributionProps,
  UiExports,
  UiModule,
  UiRuntime,
  UiService,
  UiOperation,
  UiMutation,
  UiOperations,
  UiSubscription,
  UiCommandContext,
  UiActivation,
  UiHost,
  UiViewContract,
} from '../../../../../packages/plugin-sdk/src/workbench.js';
import { UiError } from '../text';
import { uiHost } from '../host';
import { currentLocale } from '../locale';
import { sameValue } from '../../../../../plugins/shared/value';
import { renderContribution, renderEmbeddedView } from './RuntimeView';

// The Host validates JSON maps; their present values cannot be undefined.
type UiInstance = Omit<CatalogInstance, 'contributions'> & {
  contributions: Record<string, UiContribution>;
};
type Catalog = Omit<UiCatalog, 'instances'> & { instances: UiInstance[] };
type Loaded = UiModule<JSX.Element>;
type Exports = UiExports<JSX.Element>;
type Context = UiContext<UiHost, JSX.Element>;
type Bindings = Awaited<ReturnType<typeof nativeHost.bindUi>>;
type Pending = {
  promise: Promise<Exports>;
  resolve(value: Exports): void;
  reject(reason: unknown): void;
};
type State =
  | { kind: 'idle' }
  | ({ kind: 'loading' } & Pending)
  | ({ kind: 'loaded'; module: Loaded; bindings: Bindings } & Pending)
  | { kind: 'active'; module: Loaded; activation: UiActivation<JSX.Element>; context: Context }
  | { kind: 'failed'; reason: unknown };

export type Contribution = UiContributionRef & { entry: PluginEntry };
export type PluginEntry = {
  key: string;
  identity: string;
  source: Catalog['source'];
  instance: UiInstance;
  state: Signal<State>;
  live: boolean;
};
type InstanceIdentity = { instance: UiInstance['instance']; packageId: string };
type RestoredInstance = InstanceIdentity & { state: unknown };
type RestoredUi = { instances: RestoredInstance[] };
const targetKey = (target: UiTarget) => JSON.stringify([target.path, target.id]);
const instanceKey = (identity: InstanceIdentity) =>
  JSON.stringify([identity.instance, identity.packageId]);

export function createPlugins() {
  const entries = signal<PluginEntry[]>([]);
  const catalog = signal<Catalog | null>(null);
  const ready = signal(false);
  const reloading = signal(false);
  const updateError = signal<unknown | null>(null);
  const importedPackages = new Set<string>();
  const restored = nativeHost.restored as RestoredUi | null;
  const restoredInstances = new Map(
    restored?.instances.map((instance) => [instanceKey(instance), instance.state]),
  );
  let alive = true;
  let nextInstance = 0;
  let watchGeneration = 0;
  let subscription: UiSubscription | undefined;
  let desired: Catalog | null = null;
  let processing = false;
  let acceptedReload = false;
  let panelHandler: ((contribution: UiContributionRef, input?: unknown) => void) | undefined;
  const contributions = computed<Contribution[]>(() =>
    entries().flatMap((entry) =>
      Object.entries(entry.instance.contributions).map(([id, declaration]) => ({
        key: `${entry.key}/${id}`,
        id,
        entry,
        instance: entry.instance,
        declaration,
      })),
    ),
  );
  const byKey = computed(() => new Map(contributions().map((item) => [item.key, item])));
  const byTarget = computed(
    () =>
      new Map(
        contributions().map((item) => [targetKey({ path: item.instance.path, id: item.id }), item]),
      ),
  );
  const byInstance = computed(
    () =>
      new Map(
        contributions().map((item) => [JSON.stringify([item.instance.instance, item.id]), item]),
      ),
  );
  const panels = computed(() =>
    contributions().filter((item) => item.declaration.kind === 'panel'),
  );
  const settings = computed(() =>
    contributions().filter((item) => item.declaration.kind === 'settings'),
  );
  const renderers = computed(
    () =>
      new Map(
        contributions().flatMap((item) =>
          item.declaration.kind === 'tool_renderer'
            ? [[item.declaration.presentation, item] as const]
            : [],
        ),
      ),
  );
  const rootContribution = computed(() => {
    const selected = catalog()?.ui;
    return selected
      ? (byInstance().get(JSON.stringify([selected.instance, selected.id])) ?? null)
      : null;
  });
  const current = (item: Contribution) => alive && item.entry.live;
  const fail = (entry: PluginEntry, reason: unknown) => {
    if (!entry.live) return;
    const previous = entry.state();
    entry.state.set({ kind: 'failed', reason });
    if (previous.kind === 'loading' || previous.kind === 'loaded') previous.reject(reason);
  };
  const closeBindings = (bindings: Bindings) => {
    void bindings.close().catch((reason) => {
      if (alive) updateError.set(reason);
      else console.error(reason);
    });
  };
  const retire = (entry: PluginEntry) => {
    entry.live = false;
    const state = entry.state();
    if (state.kind === 'loading' || state.kind === 'loaded')
      state.reject(new UiError('Plugin was disabled or replaced.'));
    if (state.kind === 'loaded') closeBindings(state.bindings);
  };
  const validate = (value: Catalog) => {
    const presentation = new Set<string>();
    for (const instance of value.instances) {
      for (const declaration of Object.values(instance.contributions)) {
        if (declaration.kind !== 'tool_renderer') continue;
        if (presentation.has(declaration.presentation))
          throw new UiError('Multiple plugins render the same tool presentation: {presentation}', {
            presentation: declaration.presentation,
          });
        presentation.add(declaration.presentation);
      }
    }
  };
  const adopt = (value: Catalog) => {
    const old = new Map(entries().map((entry) => [entry.identity, entry]));
    const next = value.instances.map((instance) => {
      const identity = JSON.stringify(instance.instance);
      const existing = old.get(identity);
      old.delete(identity);
      if (existing && existing.instance.definitionBasis === instance.definitionBasis) {
        existing.source = value.source;
        existing.instance = instance;
        return existing;
      }
      if (existing) retire(existing);
      return {
        key: `ui-${++nextInstance}`,
        identity,
        source: value.source,
        instance,
        state: signal<State>({ kind: 'idle' }),
        live: true,
      };
    });
    batch(() => {
      old.forEach(retire);
      entries.set(next);
      catalog.set(value);
      ready.set(true);
      updateError.set(null);
    });
  };
  const needsReload = (value: Catalog) => {
    const previous = catalog();
    if (!previous) return false;
    if (!sameValue(previous.ui ?? null, value.ui ?? null)) return true;
    const nextInstances = new Map(
      value.instances.map((instance) => [JSON.stringify(instance.instance), instance]),
    );
    for (const entry of entries()) {
      if (entry.state().kind !== 'active') continue;
      const next = nextInstances.get(entry.identity);
      if (!next || next.definitionBasis !== entry.instance.definitionBasis) return true;
    }
    const packages = new Set(value.instances.map((instance) => instance.package.revision));
    return [...importedPackages].some((revision) => !packages.has(revision));
  };
  const identityFor = (entry: PluginEntry): InstanceIdentity => ({
    instance: entry.instance.instance,
    packageId: entry.instance.package.id,
  });
  const reconcile = async () => {
    if (processing || acceptedReload || !alive || !desired) return;
    processing = true;
    let paused = false;
    try {
      validate(desired);
      if (needsReload(desired)) {
        reloading.set(true);
        paused = true;
        await nativeHost.beginUiReload();
        if (!alive) return;
        const instances: RestoredInstance[] = [];
        for (const entry of entries()) {
          const state = entry.state();
          if (state.kind !== 'active') continue;
          const snapshot = (await state.activation.prepareReload?.()) ?? null;
          if (!alive) return;
          instances.push({ ...identityFor(entry), state: snapshot });
        }
        if (!alive) return;
        validate(desired!);
        if (needsReload(desired!)) {
          nativeHost.reloadUi({ instances });
          acceptedReload = true;
          return;
        }
        nativeHost.cancelUiReload();
        paused = false;
      }
      const next = desired!;
      desired = null;
      adopt(next);
    } catch (reason) {
      if (alive) updateError.set(reason);
    } finally {
      processing = false;
      if (!acceptedReload && alive) {
        if (paused) {
          try {
            nativeHost.cancelUiReload();
          } catch (reason) {
            updateError.set(reason);
          }
        }
        reloading.set(false);
      }
    }
  };
  const publish = (value: Catalog) => {
    desired = value;
    void reconcile();
  };
  const refresh = async () => {
    const generation = ++watchGeneration;
    await subscription?.close();
    subscription = undefined;
    const first = (await uiHost.readUi({})) as Catalog;
    if (!alive || generation !== watchGeneration) return;
    const stream = (await nativeHost.subscribe('management', 'watch', {
      source: first.source,
    })) as UiSubscription<Catalog['source']>;
    if (!alive || generation !== watchGeneration) {
      await stream.close();
      return;
    }
    subscription = stream;
    publish(first);
    for (;;) {
      const source = await stream.next();
      if (!alive || generation !== watchGeneration || source === null) return;
      try {
        const next = (await uiHost.readUi({ source })) as Catalog;
        if (!alive || generation !== watchGeneration) return;
        publish(next);
      } catch (reason) {
        if (alive && generation === watchGeneration) updateError.set(reason);
      }
    }
  };
  const load = (entry: PluginEntry): Promise<Exports> => {
    if (!entry.live) return Promise.reject(new UiError('Plugin was disabled or replaced.'));
    const state = entry.state();
    if (state.kind === 'active') return Promise.resolve(state.activation.exports);
    if (state.kind === 'loading' || state.kind === 'loaded') return state.promise;
    if (state.kind === 'failed') return Promise.reject(state.reason);
    let resolve!: Pending['resolve'], reject!: Pending['reject'];
    const promise = new Promise<Exports>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const pending = { promise, resolve, reject };
    entry.state.set({ kind: 'loading', ...pending });
    const id = `maka-ui-${entry.instance.package.revision.replace(/^sha256-/, '')}.js`;
    // A pending import may finish after its instance leaves the catalog.
    importedPackages.add(entry.instance.package.revision);
    void importModule<Loaded>(id)
      .then(async (module) => {
        if (!entry.live) return;
        const bindings = await nativeHost.bindUi(
          entry.source,
          entry.instance.instance,
          entry.instance.definitionBasis,
        );
        if (!entry.live) {
          closeBindings(bindings);
          return;
        }
        entry.state.set({ kind: 'loaded', module, bindings, ...pending });
      })
      .catch((reason) => fail(entry, reason));
    return promise;
  };
  const openPanel = (contribution: Contribution, input?: unknown) => {
    if (reloading() || !current(contribution) || contribution.declaration.kind !== 'panel') return;
    if (!panelHandler) throw new UiError('The selected root UI does not handle panels.');
    panelHandler(contribution, input);
  };
  const contextFor = (entry: PluginEntry): Context => {
    const state = entry.state();
    if (state.kind === 'active') return state.context;
    if (state.kind !== 'loaded') throw new UiError('Plugin services are not ready.');
    const bindings = state.bindings;
    const source = entry.source;
    const instance = entry.instance;
    const services: Record<string, UiService[]> = Object.fromEntries(
      Object.entries(bindings.imports as Record<string, string[]>).map(([name, locators]) => [
        name,
        locators.map((locator) => ({
          query: (method: string, input: unknown) => bindings.query(locator, method, input),
          subscribe: (method: string, input: unknown) =>
            bindings.subscribe(locator, method, input) as Promise<UiSubscription>,
          mutation: (method: string, input: unknown) =>
            bindings.mutation(locator, method, input) as Promise<UiOperation>,
          beginMutation: (method: string, input: unknown) =>
            bindings.beginMutation(locator, method, input) as Promise<UiMutation>,
        })),
      ]),
    );
    return {
      source,
      instance: instance.instance,
      package: instance.package,
      configuration: instance.configuration as Readonly<Record<string, unknown>>,
      locale: currentLocale,
      host: uiHost,
      application: bindings.application() as unknown as UiHost,
      services,
      operations: {
        pending: () => bindings.pending(),
        recover: (id) => bindings.recover(id),
        abandon: (id) => bindings.abandon(id),
      } as UiOperations,
      runtime,
      restored: restoredInstances.get(instanceKey(identityFor(entry))) ?? null,
      asset: (path) => {
        const directory = instance.module.slice(0, instance.module.lastIndexOf('/') + 1);
        const target = path.startsWith('asset:/') ? path.slice('asset:/'.length) : path;
        const parts: string[] = [];
        for (const part of `${target.startsWith('/') ? '' : directory}${target}`.split('/')) {
          if (!part || part === '.') continue;
          if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
          else parts.push(part);
        }
        return `asset:/plugin/${encodeURIComponent(JSON.stringify({ source, package: instance.package }))}/${parts.map(encodeURIComponent).join('/')}`;
      },
      openPanel(id, input) {
        const contribution = byInstance().get(JSON.stringify([instance.instance, id]));
        if (!contribution || contribution.declaration.kind !== 'panel')
          throw new UiError('Unknown plugin panel: {panel}', { panel: id });
        openPanel(contribution, input);
      },
    };
  };
  const activate = (entry: PluginEntry, module: Loaded) => {
    const pending = entry.state();
    if (reloading() || !entry.live || pending.kind !== 'loaded' || pending.module !== module)
      return;
    cleanup(() => {
      closeBindings(pending.bindings);
      const state = entry.state();
      if (entry.live && state.kind === 'active' && state.module === module)
        entry.state.set({ kind: 'idle' });
    });
    try {
      if (typeof module.activate !== 'function')
        throw new UiError('UI module must export activate(context).');
      const context = contextFor(entry);
      const activation = module.activate(context);
      if (
        !activation ||
        typeof activation !== 'object' ||
        (activation.prepareReload !== undefined && typeof activation.prepareReload !== 'function')
      )
        throw new UiError('UI activate(context) must return an activation.');
      const exports = activation.exports;
      const declarations = entry.instance.contributions;
      if (!exports || typeof exports !== 'object' || Array.isArray(exports))
        throw new UiError('UI activate(context) must return its declared contributions.');
      for (const [id, declaration] of Object.entries(declarations)) {
        const implementation = exports[id];
        if (
          !implementation ||
          implementation.kind !== declaration.kind ||
          (implementation.kind === 'command'
            ? typeof implementation.run !== 'function' ||
              (implementation.enabled !== undefined && typeof implementation.enabled !== 'function')
            : typeof implementation.render !== 'function') ||
          (declaration.kind === 'view' &&
            (implementation.kind !== 'view' || implementation.contract !== declaration.contract))
        )
          throw new UiError('Plugin contribution does not match its declaration: {contribution}', {
            contribution: id,
          });
      }
      for (const id of Object.keys(exports))
        if (!(id in declarations))
          throw new UiError('Plugin returned an undeclared contribution: {contribution}', {
            contribution: id,
          });
      entry.state.set({ kind: 'active', module, activation, context });
      pending.resolve(exports);
    } catch (reason) {
      fail(entry, reason);
    }
  };
  const invoke = async (
    reference: UiContributionRef,
    context: UiCommandContext,
    isCurrent: () => boolean = () => true,
  ) => {
    const contribution = byKey().get(reference.key);
    if (!contribution || reloading() || !isCurrent()) return false;
    const exports = await load(contribution.entry);
    if (!current(contribution) || reloading() || !isCurrent()) return false;
    const implementation = exports[contribution.id];
    if (implementation.kind !== 'command' || implementation.enabled?.(context) === false)
      return false;
    return (await implementation.run(context)) !== false;
  };
  const retry = (entry: PluginEntry) => {
    if (entry.live) entry.state.set({ kind: 'idle' });
  };
  const view = <Input>(target: UiTarget, contract: UiViewContract<Input>): Contribution => {
    const contribution = byTarget().get(targetKey(target));
    if (!contribution)
      throw new UiError('Unknown UI view: {view}', {
        view: `${target.path.join(' / ')} / ${target.id}`,
      });
    if (contribution.declaration.kind !== 'view')
      throw new UiError('UI contribution is not an embedded view: {view}', { view: target.id });
    if (contribution.declaration.contract !== contract.id)
      throw new UiError('UI view {view} does not implement contract {contract}.', {
        view: target.id,
        contract: contract.id,
      });
    return contribution;
  };
  const runtime: UiRuntime<JSX.Element> = {
    source: () => catalog()?.source ?? null,
    root: () => catalog()?.ui ?? null,
    ready,
    contributions,
    panels,
    settings,
    renderer: (presentation) => (presentation == null ? undefined : renderers().get(presentation)),
    view,
    renderView(target, contract, input) {
      return renderEmbeddedView(manager, target, contract.id, input);
    },
    render(reference: UiContributionRef, props: UiContributionProps) {
      return renderContribution(manager, reference, props);
    },
    invoke,
    commandEnabled(reference, context) {
      const contribution = byKey().get(reference.key);
      if (!contribution || reloading()) return false;
      const state = contribution.entry.state();
      if (state.kind === 'idle')
        void Promise.resolve()
          .then(() => load(contribution.entry))
          .catch((reason) => fail(contribution.entry, reason));
      if (state.kind !== 'active') return false;
      const implementation = state.activation.exports[contribution.id];
      return implementation.kind === 'command' && (implementation.enabled?.(context) ?? true);
    },
    openPanel(target, input) {
      const contribution = byTarget().get(targetKey(target));
      if (!contribution || contribution.declaration.kind !== 'panel')
        throw new UiError('Unknown plugin panel: {panel}', { panel: target.id });
      openPanel(contribution, input);
    },
    handlePanels(handler) {
      panelHandler = handler;
      return () => {
        if (panelHandler === handler) panelHandler = undefined;
      };
    },
    locale: currentLocale,
    setLocale: (locale) => currentLocale.set(locale),
    reloading,
    updateError,
    retryUpdates() {
      void refresh().catch((reason) => {
        if (alive) updateError.set(reason);
      });
    },
  };
  const manager = {
    runtime,
    entries,
    rootContribution,
    byKey,
    resolveView: view,
    load,
    activate,
    fail,
    retry,
    contextFor,
  };
  cleanup(() => {
    alive = false;
    ++watchGeneration;
    entries().forEach(retire);
    if (subscription) void subscription.close().catch((reason) => console.error(reason));
  });
  void refresh().catch((reason) => {
    if (alive) updateError.set(reason);
  });
  return manager;
}
export type Plugins = ReturnType<typeof createPlugins>;
