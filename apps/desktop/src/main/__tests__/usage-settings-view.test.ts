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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { EMPTY_USAGE_PROVENANCE } from '@maka/core/usage-ledger-merge';
import {
  createDefaultSettings,
  mergeSettings,
  type AppSettings,
  type UsageRange,
  type UsageStats,
} from '@maka/core/settings';
import {
  UsageFeatureScope,
  UsageSettingsView,
  type UsageScopeHandle,
  type UsageServices,
} from '../../renderer/features/usage/index.js';


function statsWithRequests(totalRequests: number): UsageStats {
  return {
    summary: {
      totalRequests,
      totalCostUsd: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      cacheMiss: 0,
      cacheRead: 0,
      cacheCreation: 0,
      reasoning: 0,
    },
    logs: [],
    byProvider: [],
    byModel: [],
    byTool: [],
    pricing: [],
    provenance: EMPTY_USAGE_PROVENANCE,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  matchMedia: globalThis.matchMedia,
  HTMLElement: globalThis.HTMLElement,
  getComputedStyle: globalThis.getComputedStyle,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  CSS: (globalThis as { CSS?: unknown }).CSS,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};
afterEach(() => Object.assign(globalThis, originalGlobals));

/** Install a linkedom DOM + the browser globals React DOM needs, return the root. */
function setupDom(): { container: HTMLElement; root: Root } {
  const { document, window } = parseHTML('<div id="root"></div>');
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  Object.assign(window, { matchMedia, scrollTo: () => {} });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    HTMLElement: window.HTMLElement,
    getComputedStyle: () => ({ color: 'currentColor' }) as CSSStyleDeclaration,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    CSS: { supports: () => false, escape: (v: string) => v },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector<HTMLElement>('#root');
  assert.ok(container);
  return { container, root: createRoot(container) };
}

/**
 * Mounts the persistent `UsageFeatureScope` (given `targetKey`, as the settings
 * surface derives it from `host:epoch`) with the view gated by `active` — the
 * shape the real surface produces once the scope sits above the loading/error
 * gate. So a section change or a Skeleton/Banner state is `active` toggling
 * (the view unmounts, the scope does not), and a Host change is `targetKey`
 * changing as a prop (no React `key`, so the scope resets in place rather than
 * remounting the surface).
 */
function tree(opts: {
  active: boolean;
  settings: AppSettings;
  targetKey: string;
  services: UsageServices;
}): ReactNode {
  return createElement(LocaleProvider, {
    locale: 'en' as const,
    children: createElement(AstryxLocaleProvider, {
      children: createElement(ToastProvider, {
        children: createElement(UsageFeatureScope, {
          targetKey: opts.targetKey,
          services: opts.services,
          loadErrorTitle: 'load failed',
          describeError: (error: unknown) => String(error),
          children: opts.active
            ? createElement(UsageSettingsView, {
                settings: opts.settings.usage,
                describeError: (error: unknown) => String(error),
              })
            : null,
        }),
      }),
    }),
  });
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('Usage feature scope', () => {
  it('re-displays the last snapshot immediately when returning to the section, then refreshes', async () => {
    const { container, root } = setupDom();
    const base: AppSettings = mergeSettings(createDefaultSettings(), {
      usage: { range: '24h', activeTab: 'providers' },
    });
    const loads = new Map<UsageRange, Deferred<UsageStats | null>>();
    const services: UsageServices = {
      loadUsageStats: (range) => {
        const d = deferred<UsageStats | null>();
        loads.set(range, d);
        return d.promise;
      },
      updateUsageSettings: async (patch) => mergeSettings(base, { usage: patch }).usage,
    };

    // Load 24h → 111 while on the Usage section.
    await act(async () => {
      root.render(tree({ active: true, settings: base, targetKey: 'hostA:1', services }));
      await Promise.resolve();
    });
    await act(async () => {
      loads.get('24h')!.resolve(statsWithRequests(111));
      await flush();
    });
    assert.match(container.textContent ?? '', /111/, '24h totals should render');

    // Leave the Usage section: the view unmounts, the scope stays mounted.
    await act(async () => {
      root.render(tree({ active: false, settings: base, targetKey: 'hostA:1', services }));
      await Promise.resolve();
    });
    assert.doesNotMatch(container.textContent ?? '', /111/, 'the view should be gone while away');

    // Return: the held snapshot must show immediately (before any new load
    // resolves), i.e. stale-while-revalidate rather than a blank re-fetch.
    await act(async () => {
      root.render(tree({ active: true, settings: base, targetKey: 'hostA:1', services }));
      await flush();
    });
    assert.match(
      container.textContent ?? '',
      /111/,
      'returning must re-display the retained snapshot immediately',
    );

    // The background refresh (triggered on remount) lands and updates the view.
    await act(async () => {
      loads.get('24h')!.resolve(statsWithRequests(222));
      await flush();
    });
    assert.match(container.textContent ?? '', /222/, 'the background refresh should update totals');

    await act(async () => root.unmount());
  });

  it('never shows the previous range while a new range loads, and drops a failed range', async () => {
    const { container, root } = setupDom();
    const base: AppSettings = mergeSettings(createDefaultSettings(), {
      usage: { range: '24h', activeTab: 'providers' },
    });
    const loads = new Map<UsageRange, Deferred<UsageStats | null>>();
    const services: UsageServices = {
      loadUsageStats: (range) => {
        const d = deferred<UsageStats | null>();
        loads.set(range, d);
        return d.promise;
      },
      updateUsageSettings: async (patch) => mergeSettings(base, { usage: patch }).usage,
    };

    await act(async () => {
      root.render(tree({ active: true, settings: base, targetKey: 'hostA:1', services }));
      await Promise.resolve();
    });
    await act(async () => {
      loads.get('24h')!.resolve(statsWithRequests(111));
      await flush();
    });
    assert.match(container.textContent ?? '', /111/, '24h totals should render');

    // Switch persisted range to 7d; its load is pending — the 24h number must
    // disappear immediately (a single tagged snapshot, not a per-range cache).
    const sevenDay = mergeSettings(base, { usage: { range: '7d' } });
    await act(async () => {
      root.render(tree({ active: true, settings: sevenDay, targetKey: 'hostA:1', services }));
      await Promise.resolve();
    });
    assert.doesNotMatch(
      container.textContent ?? '',
      /111/,
      'the previous range total must not persist while 7d is loading',
    );

    // The 7d load fails — the stale 24h total must not reappear.
    await act(async () => {
      loads.get('7d')!.reject(new Error('boom'));
      await flush();
    });
    assert.doesNotMatch(
      container.textContent ?? '',
      /111/,
      'a failed range load must not fall back to the previous range',
    );

    await act(async () => root.unmount());
  });

  it('discards the previous Host generation snapshot when targetKey changes', async () => {
    const { container, root } = setupDom();
    const base: AppSettings = mergeSettings(createDefaultSettings(), {
      usage: { range: '24h', activeTab: 'providers' },
    });
    const loads = new Map<string, Deferred<UsageStats | null>>();
    let generation = 1;
    const services: UsageServices = {
      loadUsageStats: (range) => {
        const d = deferred<UsageStats | null>();
        loads.set(`${generation}:${range}`, d);
        return d.promise;
      },
      updateUsageSettings: async (patch) => mergeSettings(base, { usage: patch }).usage,
    };

    await act(async () => {
      root.render(tree({ active: true, settings: base, targetKey: 'hostA:1', services }));
      await Promise.resolve();
    });
    await act(async () => {
      loads.get('1:24h')!.resolve(statsWithRequests(111));
      await flush();
    });
    assert.match(container.textContent ?? '', /111/, 'generation 1 totals should render');

    // Host generation bumps (same host, new epoch) → `targetKey` changes as a
    // prop and the scope resets in place (no remount), so the previous
    // generation's snapshot is gone at once.
    generation = 2;
    await act(async () => {
      root.render(tree({ active: true, settings: base, targetKey: 'hostA:2', services }));
      await flush();
    });
    assert.doesNotMatch(
      container.textContent ?? '',
      /111/,
      'a Host generation change must discard the previous snapshot immediately',
    );

    await act(async () => root.unmount());
  });

  it('accepts a load that resolves while the view is unmounted, visible on return', async () => {
    const { container, root } = setupDom();
    const base: AppSettings = mergeSettings(createDefaultSettings(), {
      usage: { range: '24h', activeTab: 'providers' },
    });
    const loads = new Map<UsageRange, Deferred<UsageStats | null>>();
    const services: UsageServices = {
      loadUsageStats: (range) => {
        const d = deferred<UsageStats | null>();
        loads.set(range, d);
        return d.promise;
      },
      updateUsageSettings: async (patch) => mergeSettings(base, { usage: patch }).usage,
    };

    // Mount on Usage → a 24h load is in flight (not resolved yet).
    await act(async () => {
      root.render(tree({ active: true, settings: base, targetKey: 'hostA:1', services }));
      await Promise.resolve();
    });

    // Leave the section before the load resolves — the view unmounts.
    await act(async () => {
      root.render(tree({ active: false, settings: base, targetKey: 'hostA:1', services }));
      await Promise.resolve();
    });

    // The in-flight load resolves while the view is unmounted; the persistent
    // scope must still accept it (no unmounted-view drop).
    await act(async () => {
      loads.get('24h')!.resolve(statsWithRequests(333));
      await flush();
    });

    // Returning shows the result the scope received while unmounted.
    await act(async () => {
      root.render(tree({ active: true, settings: base, targetKey: 'hostA:1', services }));
      await flush();
    });
    assert.match(
      container.textContent ?? '',
      /333/,
      'a load completing while unmounted must be visible on return',
    );

    await act(async () => root.unmount());
  });

  it('fences a late load from a superseded Host generation', async () => {
    const { container, root } = setupDom();
    const base: AppSettings = mergeSettings(createDefaultSettings(), {
      usage: { range: '24h', activeTab: 'providers' },
    });
    const loads = new Map<string, Deferred<UsageStats | null>>();
    let generation = 1;
    const services: UsageServices = {
      loadUsageStats: (range) => {
        const d = deferred<UsageStats | null>();
        loads.set(`${generation}:${range}`, d);
        return d.promise;
      },
      updateUsageSettings: async (patch) => mergeSettings(base, { usage: patch }).usage,
    };

    // Generation 1's load is in flight (not resolved yet).
    await act(async () => {
      root.render(tree({ active: true, settings: base, targetKey: 'hostA:1', services }));
      await Promise.resolve();
    });

    // Host generation bumps to 2 before generation 1's load resolves; the scope
    // resets and fences the in-flight generation-1 load in place.
    generation = 2;
    await act(async () => {
      root.render(tree({ active: true, settings: base, targetKey: 'hostA:2', services }));
      await flush();
    });

    // The superseded generation-1 load resolves late — it must not land.
    await act(async () => {
      loads.get('1:24h')!.resolve(statsWithRequests(111));
      await flush();
    });
    assert.doesNotMatch(
      container.textContent ?? '',
      /111/,
      'a superseded Host generation load must be fenced, not shown',
    );

    // Generation 2's load resolves and is shown.
    await act(async () => {
      loads.get('2:24h')!.resolve(statsWithRequests(222));
      await flush();
    });
    assert.match(container.textContent ?? '', /222/, 'the current generation load lands');

    await act(async () => root.unmount());
  });

  it('keeps the snapshot while the loading gate shows a skeleton', async () => {
    const { container, root } = setupDom();
    const base: AppSettings = mergeSettings(createDefaultSettings(), {
      usage: { range: '24h', activeTab: 'providers' },
    });
    const loads = new Map<UsageRange, Deferred<UsageStats | null>>();
    const services: UsageServices = {
      loadUsageStats: (range) => {
        const d = deferred<UsageStats | null>();
        loads.set(range, d);
        return d.promise;
      },
      updateUsageSettings: async (patch) => mergeSettings(base, { usage: patch }).usage,
    };

    // Mirrors the real surface: the scope sits ABOVE the loading/error gate, and
    // `gated` swaps the view for a skeleton the way the gate does. The scope (and
    // its snapshot) must not unmount when the gate closes. If the scope were moved
    // back inside the gate, this topology — and the assertion below — would break.
    const gateTree = (gated: boolean): ReactNode =>
      createElement(LocaleProvider, {
        locale: 'en' as const,
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children: createElement(UsageFeatureScope, {
              targetKey: 'hostA:1',
              services,
              loadErrorTitle: 'load failed',
              describeError: (error: unknown) => String(error),
              children: gated
                ? createElement('div', null, 'Loading…')
                : createElement(UsageSettingsView, {
                    settings: base.usage,
                    describeError: (error: unknown) => String(error),
                  }),
            }),
          }),
        }),
      });

    await act(async () => {
      root.render(gateTree(false));
      await Promise.resolve();
    });
    await act(async () => {
      loads.get('24h')!.resolve(statsWithRequests(111));
      await flush();
    });
    assert.match(container.textContent ?? '', /111/, 'totals render before the gate closes');

    // Gate shows a skeleton (e.g. switching to a not-yet-loaded section): the view
    // unmounts, but the scope above the gate keeps the snapshot.
    await act(async () => {
      root.render(gateTree(true));
      await flush();
    });
    assert.doesNotMatch(container.textContent ?? '', /111/, 'the skeleton replaces the view');

    // Gate reopens: the retained snapshot shows immediately, not a blank re-fetch.
    await act(async () => {
      root.render(gateTree(false));
      await flush();
    });
    assert.match(
      container.textContent ?? '',
      /111/,
      'the snapshot survives the loading gate and re-displays',
    );

    await act(async () => root.unmount());
  });

  it('fences an in-flight load synchronously when the host changes before the re-render', async () => {
    const { container, root } = setupDom();
    const base: AppSettings = mergeSettings(createDefaultSettings(), {
      usage: { range: '24h', activeTab: 'providers' },
    });
    const loads = new Map<UsageRange, Deferred<UsageStats | null>>();
    const services: UsageServices = {
      loadUsageStats: (range) => {
        const d = deferred<UsageStats | null>();
        loads.set(range, d);
        return d.promise;
      },
      updateUsageSettings: async (patch) => mergeSettings(base, { usage: patch }).usage,
    };
    const scopeRef = createRef<UsageScopeHandle>();
    const treeWithRef = (): ReactNode =>
      createElement(LocaleProvider, {
        locale: 'en' as const,
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children: createElement(UsageFeatureScope, {
              ref: scopeRef,
              targetKey: 'hostA:1',
              services,
              loadErrorTitle: 'load failed',
              describeError: (error: unknown) => String(error),
              children: createElement(UsageSettingsView, {
                settings: base.usage,
                describeError: (error: unknown) => String(error),
              }),
            }),
          }),
        }),
      });

    // Mount → a 24h load is in flight (not resolved).
    await act(async () => {
      root.render(treeWithRef());
      await Promise.resolve();
    });

    // Host changes: the settings surface fences synchronously at the Host event,
    // before React re-renders a new targetKey. Drive that imperative call here.
    act(() => {
      scopeRef.current!.fenceTarget();
    });

    // The in-flight load resolves *after* the synchronous fence — it must not
    // land. This covers the event→commit window, not just a post-render
    // targetKey change (which the other tests exercise).
    await act(async () => {
      loads.get('24h')!.resolve(statsWithRequests(111));
      await flush();
    });
    assert.doesNotMatch(
      container.textContent ?? '',
      /111/,
      'a load fenced at the host event must not land, even before the re-render',
    );

    await act(async () => root.unmount());
  });
});
