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

import { batch, cleanup, computed, context, importModule, signal, type JSX } from 'nsh';
import { host as nativeHost } from 'maka/host';
import type { ServiceMethods } from '../../../../../packages/plugin-sdk/src/index.js';
import type {
  UiContext,
  UiExports,
  UiModule,
  UiService,
  UiOperation,
  UiMutation,
  UiOperations,
  UiSubscription,
} from '../../../../../packages/plugin-sdk/src/workbench.js';
import type { CommandEntry } from '../composerCommands';
import { host } from '../host';
import { UiError, errorText, renderText } from '../text';
import { currentLocale, displayText } from '../locale';
import { sameValue } from '../../../../../plugins/shared/value';

type Catalog = ServiceMethods['deploymentManager']['readUi']['output'];
export type UiInstance = Catalog['instances'][number];
type Declaration = UiInstance['contributions'][string];
type Loaded = UiModule<JSX.Element>;
type Exports = UiExports<JSX.Element>;
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
  | { kind: 'active'; module: Loaded; exports: Exports; context: UiContext }
  | { kind: 'failed'; reason: unknown };

export type Contribution = {
  key: string;
  id: string;
  entry: PluginEntry;
  declaration: Declaration;
};
export type Panel = { contribution: Contribution; input?: unknown; instance: number };
export type PanelRoute = { instance: UiInstance['instance']; id: string; input?: unknown };
export type PluginEntry = {
  key: string;
  identity: string;
  source: Catalog['source'];
  instance: UiInstance;
  state: ReturnType<typeof signal<State>>;
  live: boolean;
};

export const contributionTitle = (item: Contribution) =>
  item.declaration.kind === 'tool_renderer' ? '' : displayText(item.declaration.title);

export const pluginContext = context<Plugins | null>(null);

export function createPlugins(options: {
  sessionId(): string | null;
  showPanel(): void;
  report(reason: unknown): void;
  reload(): Promise<boolean>;
  restorePanel?: PanelRoute | null;
}) {
  const entries = signal<PluginEntry[]>([]);
  const panel = signal<Panel | null>(null);
  const ready = signal(false);
  const updatePending = signal(false);
  const updateError = signal<unknown | null>(null);
  const importedPackages = new Set<string>();
  let restorePanel = options.restorePanel;
  let alive = true;
  let nextInstance = 0;
  let watchGeneration = 0;
  let subscription: { close(): Promise<void> } | undefined;
  const contributions = computed(() =>
    entries().flatMap((entry) =>
      Object.entries(entry.instance.contributions).map(([id, declaration]) => ({
        key: `${entry.key}/${id}`,
        id,
        entry,
        declaration,
      })),
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
        contributions()
          .filter((item) => item.declaration.kind === 'tool_renderer')
          .map((item) => [
            item.declaration.kind === 'tool_renderer' ? item.declaration.presentation : '',
            item,
          ]),
      ),
  );
  const current = (item: Contribution) => alive && item.entry.live;
  const fail = (entry: PluginEntry, reason: unknown) => {
    if (!entry.live) return;
    const previous = entry.state();
    entry.state.set({ kind: 'failed', reason });
    if (previous.kind === 'loading' || previous.kind === 'loaded') previous.reject(reason);
  };
  const closeBindings = (bindings: Bindings) => {
    void bindings.close().catch((reason) => {
      if (alive) options.report(reason);
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
  const adopt = (catalog: Catalog) => {
    const old = new Map(entries().map((entry) => [entry.identity, entry]));
    const presentation = new Set<string>();
    for (const instance of catalog.instances) {
      for (const declaration of Object.values(instance.contributions)) {
        if (declaration.kind !== 'tool_renderer') continue;
        if (presentation.has(declaration.presentation))
          throw new UiError('Multiple plugins render the same tool presentation: {presentation}', {
            presentation: declaration.presentation,
          });
        presentation.add(declaration.presentation);
      }
    }
    const next = catalog.instances.map((instance) => {
      const identity = JSON.stringify(instance.instance);
      const existing = old.get(identity);
      old.delete(identity);
      if (existing && existing.instance.bindingBasis === instance.bindingBasis) {
        existing.source = catalog.source;
        existing.instance = instance;
        return existing;
      }
      if (existing) retire(existing);
      return {
        key: `ui-${++nextInstance}`,
        identity,
        source: catalog.source,
        instance,
        state: signal<State>({ kind: 'idle' }),
        live: true,
      };
    });
    batch(() => {
      old.forEach(retire);
      entries.set(next);
      ready.set(true);
      updatePending.set(false);
      updateError.set(null);
      const previousPanel = panel();
      if (previousPanel && !previousPanel.contribution.entry.live) {
        const original = previousPanel.contribution;
        const entry = next.find((item) =>
          sameValue(item.instance.instance, original.entry.instance.instance),
        );
        const declaration = entry?.instance.contributions[original.id];
        panel.set(
          entry && declaration?.kind === 'panel'
            ? {
                contribution: {
                  key: `${entry.key}/${original.id}`,
                  id: original.id,
                  entry,
                  declaration,
                },
                input: previousPanel.input,
                instance: ++nextInstance,
              }
            : null,
        );
      }
      if (restorePanel) {
        const route = restorePanel;
        restorePanel = null;
        const entry = next.find((item) => sameValue(item.instance.instance, route.instance));
        const declaration = entry?.instance.contributions[route.id];
        if (entry && declaration?.kind === 'panel')
          panel.set({
            contribution: { key: `${entry.key}/${route.id}`, id: route.id, entry, declaration },
            input: route.input,
            instance: ++nextInstance,
          });
      }
    });
  };
  const publish = async (catalog: Catalog): Promise<boolean> => {
    const next = new Set(catalog.instances.map((instance) => instance.package.revision));
    if ([...importedPackages].some((revision) => !next.has(revision))) {
      try {
        if (await options.reload()) return false;
      } catch (reason) {
        options.report(reason);
      }
      if (alive) updatePending.set(true);
      return true;
    }
    try {
      adopt(catalog);
    } catch (reason) {
      if (alive) updateError.set(reason);
    }
    return true;
  };
  const refresh = async () => {
    const generation = ++watchGeneration;
    await subscription?.close();
    subscription = undefined;
    if (!(await host.hasService('management'))) {
      if (alive && generation === watchGeneration)
        batch(() => {
          entries().forEach(retire);
          entries.set([]);
          panel.set(null);
          ready.set(true);
          updateError.set(null);
        });
      return;
    }
    const first = await host.query('management', 'readUi', {});
    if (!alive || generation !== watchGeneration) return;
    const stream = await host.subscribe('management', 'watch', { source: first.source });
    if (!alive || generation !== watchGeneration) {
      await stream.close();
      return;
    }
    subscription = stream;
    const project = async (source: Catalog['source']) => {
      try {
        const catalog = await host.query('management', 'readUi', { source });
        if (!alive || generation !== watchGeneration) return false;
        return await publish(catalog);
      } catch (reason) {
        if (alive && generation === watchGeneration) updateError.set(reason);
        return true;
      }
    };
    if (!(await publish(first))) return;
    for (;;) {
      const source = await stream.next();
      if (!alive || generation !== watchGeneration || source === null) return;
      if (!(await project(source))) return;
    }
  };
  const load = (entry: PluginEntry): Promise<Exports> => {
    if (!entry.live) return Promise.reject(new UiError('Plugin was disabled or replaced.'));
    const state = entry.state();
    if (state.kind === 'active') return Promise.resolve(state.exports);
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
          entry.instance.bindingBasis,
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
    if (!current(contribution) || contribution.declaration.kind !== 'panel') return;
    options.showPanel();
    panel.set({ contribution, input, instance: ++nextInstance });
  };
  const contextFor = (entry: PluginEntry): UiContext => {
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
      host: nativeHost,
      services,
      operations: {
        pending: () => bindings.pending(),
        recover: (id) => bindings.recover(id),
        abandon: (id) => bindings.abandon(id),
      } as UiOperations,
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
        const contribution = panels().find((item) => item.entry === entry && item.id === id);
        if (!contribution) throw new UiError('Unknown plugin panel: {panel}', { panel: id });
        openPanel(contribution, input);
      },
    };
  };
  const activate = (entry: PluginEntry, module: Loaded) => {
    const pending = entry.state();
    if (!entry.live || pending.kind !== 'loaded' || pending.module !== module) return;
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
      const exports = module.activate(context);
      const declarations = entry.instance.contributions;
      if (!exports || typeof exports !== 'object' || Array.isArray(exports))
        throw new UiError('UI activate(context) must return its declared contributions.');
      for (const [id, declaration] of Object.entries(declarations)) {
        const implementation = exports[id];
        if (
          !implementation ||
          implementation.kind !== declaration.kind ||
          (implementation.kind === 'command'
            ? typeof implementation.run !== 'function'
            : typeof implementation.render !== 'function')
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
      entry.state.set({ kind: 'active', module, exports, context });
      pending.resolve(exports);
    } catch (reason) {
      fail(entry, reason);
    }
  };
  const invoke = async (contribution: Contribution, sessionId: string | null) => {
    try {
      const exports = await load(contribution.entry);
      if (!current(contribution) || options.sessionId() !== sessionId) return false;
      const implementation = exports[contribution.id];
      if (implementation.kind !== 'command') return false;
      await implementation.run({ sessionId });
      return true;
    } catch (reason) {
      if (alive && contribution.entry.live) options.report(reason);
      return false;
    }
  };
  const commands = (sessionId = options.sessionId()): CommandEntry[] =>
    contributions().flatMap<CommandEntry>((contribution) => {
      const declaration = contribution.declaration;
      if (declaration.kind === 'command')
        return [
          {
            id: contribution.key,
            title: displayText(declaration.title),
            detail: contribution.entry.instance.path.join(' / '),
            trigger: `plugin:${contribution.entry.instance.path.join(':')}:${contribution.id}`,
            run: () => invoke(contribution, sessionId),
          },
        ];
      return [];
    });
  cleanup(() => {
    alive = false;
    ++watchGeneration;
    entries().forEach(retire);
    if (subscription) void subscription.close().catch((reason) => console.error(reason));
  });
  void refresh().catch((reason) => {
    if (alive) updateError.set(reason);
  });
  return {
    entries,
    ready,
    panel,
    updatePending,
    updateError: () => (updateError() === null ? '' : renderText(errorText(updateError()))),
    retryUpdates: () =>
      void refresh().catch((reason) => {
        if (alive) updateError.set(reason);
      }),
    panelRoute(): PanelRoute | null {
      const current = panel();
      return current
        ? {
            instance: current.contribution.entry.instance.instance,
            id: current.contribution.id,
            input: current.input,
          }
        : null;
    },
    panels,
    settings,
    contributions,
    commands,
    current,
    contextFor,
    sessionId: options.sessionId,
    load,
    activate,
    fail,
    renderer: (presentation: string | null | undefined) =>
      presentation == null ? undefined : renderers().get(presentation),
    closePanel(instance: number) {
      if (panel()?.instance === instance) panel.set(null);
    },
    retry(entry: PluginEntry) {
      if (entry.live) entry.state.set({ kind: 'idle' });
    },
  };
}
export type Plugins = ReturnType<typeof createPlugins>;
