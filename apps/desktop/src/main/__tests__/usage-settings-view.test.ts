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


import { useUsageStats } from '../../renderer/features/usage/testing.js';
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
  type UsageScreenQuery,
  type UsageScreenResult,
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

  it('retains the previous result with a concise notice when a new range fails', async () => {
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
    assert.match(
      container.textContent ?? '',
      /111/,
      'the previous range remains visible while 7d is loading',
    );

    // The 7d load fails — the stale 24h total must not reappear.
    await act(async () => {
      loads.get('7d')!.reject(new Error('boom'));
      await flush();
    });
    assert.match(
      container.textContent ?? '',
      /The last successfully loaded result is still shown/,
      'a failed range explains that the previous result remains visible',
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

function navigable(total: number, query: UsageScreenQuery, identity: string): UsageStats {
  return {...statsWithRequests(total), navigation: {activityTotal: total, query, revision: 'same-revision', queryIdentity: identity, nextCursor: 'next'}};
}
function scopeTree(services: UsageServices, probe: () => ReactNode, targetKey = 'hostA:1'): ReactNode {
  return createElement(ToastProvider, {children: createElement(UsageFeatureScope, {
    targetKey, services, loadErrorTitle: 'load failed', describeError: String, children: createElement(probe),
  })});
}

it('same-revision filters supersede both old screens and continuations and retain fixed time bounds', async () => {
  const {root} = setupDom();
  let scope!: ReturnType<typeof useUsageStats>;
  const Probe = () => {scope = useUsageStats('all'); return null;};
  const loads: {query: UsageScreenQuery; response: Deferred<UsageStats | null>}[] = [];
  const page = deferred<UsageScreenResult>();
  let pageCalls = 0;
  const services: UsageServices = {
    loadUsageStats: async (_range, query) => {assert.ok(query); const response = deferred<UsageStats | null>(); loads.push({query, response}); return response.promise;},
    loadUsageActivity: () => {pageCalls++; return page.promise;},
    updateUsageSettings: async () => createDefaultSettings().usage,
  };
  await act(async () => {root.render(scopeTree(services, Probe)); await flush();});
  await act(async () => {void scope.reload('all'); await flush();});
  await act(async () => {loads[0]!.response.resolve(navigable(10, loads[0]!.query, 'initial')); await flush();});
  await act(async () => {void scope.loadMore(); await flush();});
  assert.equal(pageCalls, 1);
  await act(async () => {void scope.reload('all', {search: 'alpha', status: 'all'}, true); await flush();});
  await act(async () => {void scope.reload('all', {search: 'beta', status: 'error'}, true); await flush();});
  assert.deepEqual(loads[1]!.query.range, loads[0]!.query.range);
  assert.deepEqual(loads[2]!.query.range, loads[0]!.query.range);
  await act(async () => {loads[2]!.response.resolve(navigable(30, loads[2]!.query, 'beta')); await flush();});
  await act(async () => {
    loads[1]!.response.resolve(navigable(20, loads[1]!.query, 'alpha'));
    page.resolve({kind: 'activity', page: {revision: 'same-revision', queryIdentity: 'initial', logs: [{id: 'late', ts: 1, kind: 'model', provider: 'p', model: 'm', status: 'success', inputTokens: 0, outputTokens: 0}], nextCursor: null}});
    await flush();
  });
  assert.equal(scope.stats?.summary.totalRequests, 30);
  assert.equal(scope.stats?.navigation?.query.search, 'beta');
  assert.deepEqual(scope.stats?.logs, []);
  assert.equal(scope.state, 'ready');
  await act(async () => root.unmount());
});

it('revision change retains the complete screen, blocks paging, and refresh installs a new screen', async () => {
  const {root} = setupDom();
  let scope!: ReturnType<typeof useUsageStats>;
  const Probe = () => {scope = useUsageStats('all'); return null;};
  let revision = 'A'; let calls = 0;
  const services: UsageServices = {
    loadUsageStats: async (_range, query) => {assert.ok(query); const value = navigable(revision === 'A' ? 10 : 20, query, revision); value.navigation!.revision = revision; return value;},
    loadUsageActivity: async () => {calls++; return {kind: 'revision_changed'};},
    updateUsageSettings: async () => createDefaultSettings().usage,
  };
  await act(async () => {root.render(scopeTree(services, Probe)); await flush();});
  await act(async () => {await scope.reload('all');});
  await act(async () => {await scope.loadMore();});
  assert.equal(scope.state, 'stale'); assert.equal(scope.stats?.summary.totalRequests, 10);
  await act(async () => {await scope.loadMore();}); assert.equal(calls, 1);
  revision = 'B';
  await act(async () => {await scope.reload('all');});
  assert.equal(scope.state, 'ready'); assert.equal(scope.stats?.summary.totalRequests, 20);
  await act(async () => root.unmount());
});

it('capacity failure never retries and retains the original query until a complete replacement', async () => {
  const {root} = setupDom();
  let scope!: ReturnType<typeof useUsageStats>;
  const Probe = () => {scope = useUsageStats('all'); return null;};
  let fail = true; let calls = 0;
  const services: UsageServices = {
    loadUsageStats: async (_range, query) => {calls++; assert.ok(query); if (fail) return {kind: 'screen_response_too_large', section: 'pricing'}; return navigable(10, query, 'old');},
    loadUsageActivity: async () => {throw new Error('must not continue');},
    updateUsageSettings: async () => createDefaultSettings().usage,
  };
  await act(async () => {root.render(scopeTree(services, Probe)); await flush();});
  await act(async () => {await scope.reload('all');});
  assert.equal(calls, 1); assert.equal(scope.state, 'error'); assert.equal(Boolean(scope.stats), false);
  assert.deepEqual(scope.failure, {kind: 'screen_response_too_large', section: 'pricing'});
  assert.equal(scope.error, null, 'typed capacity is not flattened into an error string');
  fail = false;
  await act(async () => {await scope.reload('all', {search: 'old-filter', status: 'all'});});
  fail = true;
  await act(async () => {await scope.reload('all', {search: 'new-filter', status: 'error'}, true);});
  assert.equal(calls, 3); assert.equal(scope.state, 'error');
  assert.equal(scope.stats?.navigation?.query.search, 'old-filter');
  assert.equal(scope.stats?.summary.totalRequests, 10);
  await act(async () => {await scope.loadMore();});
  await act(async () => {root.render(scopeTree(services, Probe, 'hostB:1')); await flush();});
  assert.equal(scope.stats, null, 'Host replacement drops the retained result and tokens');
  await act(async () => root.unmount());
});

it('numbered pages are present initially and jumping to the last page keeps the same controls', async () => {
  const {container, root} = setupDom();
  const settings = mergeSettings(createDefaultSettings(), {
    usage: {range: 'all', activeTab: 'requests', showDetails: true},
  });
  const continuation = deferred<UsageScreenResult>();
  let calls = 0;
  const row = (id: string) => ({id, ts: 1, kind: 'model' as const, provider: 'p', model: id,
    inputTokens: 0, outputTokens: 0, status: 'success' as const});
  const services: UsageServices = {
    loadUsageStats: async (_range, query) => {
      assert.ok(query);
      return {...navigable(101, query, 'query'), logs: Array.from({length: 50}, (_, i) => row(`first-${i}`))};
    },
    loadUsageActivity: async () => {
      calls++;
      return calls === 1 ? continuation.promise : {kind: 'activity', page: {
        revision: 'same-revision', queryIdentity: 'query', nextCursor: null, logs: [row('last-page')],
      }};
    },
    updateUsageSettings: async () => settings.usage,
  };
  const button = (label: string) => {
    const value = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    assert.ok(value, `${label}: ${Array.from(container.querySelectorAll('button')).map(b => b.getAttribute('aria-label') || b.textContent).join(',')}`);
    return value;
  };
  await act(async () => {root.render(tree({active: true, settings, targetKey: 'host', services})); await flush();});
  assert.doesNotMatch(container.textContent ?? '', /Load more activity/);
  assert.ok(button('Go to page 1'));
  assert.ok(button('Go to page 2'));
  assert.ok(button('Go to page 3'));
  await act(async () => {button('Go to page 3').click(); await flush();});
  assert.equal(calls, 1);
  assert.equal(button('Go to next page').disabled, true);
  assert.match(container.textContent ?? '', /Loading page 1 of 3/);
  assert.match(container.textContent ?? '', /first-0/);
  await act(async () => {
    continuation.resolve({kind: 'activity', page: {revision: 'same-revision', queryIdentity: 'query',
      nextCursor: 'last', logs: Array.from({length: 50}, (_, i) => row(`middle-${i}`))}});
    await flush();
  });
  assert.match(container.textContent ?? '', /last-page/);
  assert.doesNotMatch(container.textContent ?? '', /first-0/);
  assert.equal(button('Go to next page').disabled, true);
  assert.equal(calls, 2);
  assert.ok(button('Go to page 1'));
  assert.ok(button('Go to page 2'));
  assert.ok(button('Go to page 3'));
  await act(async () => {button('Go to previous page').click(); await flush();});
  assert.match(container.textContent ?? '', /middle-0/);
  await act(async () => {button('Go to next page').click(); await flush();});
  assert.match(container.textContent ?? '', /last-page/);
  assert.equal(calls, 2, 'returning to a cached page does not fetch again');
  await act(async () => root.unmount());
});

it('debounces search edits, refreshes immediately, and cancels pending queries on unmount', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {container, root} = setupDom();
  let settings = mergeSettings(createDefaultSettings(), {
    usage: {range: 'all', activeTab: 'requests', showDetails: true},
  });
  const queries: UsageScreenQuery[] = [];
  const services: UsageServices = {
    loadUsageStats: async (_range, query) => {
      assert.ok(query);
      queries.push(query);
      return navigable(0, query, 'query');
    },
    updateUsageSettings: async (patch) => mergeSettings(settings, {usage: patch}).usage,
  };
  const render = async (search: string, targetKey = 'host') => {
    settings = mergeSettings(settings, {usage: {modelFilter: search}});
    await act(async () => {
      root.render(tree({active: true, settings, targetKey, services}));
      await flush();
    });
  };
  const tick = async (ms: number) => {
    await act(async () => {
      t.mock.timers.tick(ms);
      await flush();
    });
  };

  await render('');
  assert.equal(queries.length, 1, 'mount loads immediately');
  await render('a');
  await tick(200);
  await render('ab');
  await tick(249);
  assert.equal(queries.length, 1);
  await tick(1);
  assert.deepEqual(queries.map((query) => query.search), ['', 'ab']);
  assert.deepEqual(queries[1]!.range, queries[0]!.range, 'typing preserves time bounds');

  await render(' AB  ');
  await tick(250);
  assert.equal(queries.length, 2, 'an equivalent normalized search keeps the current screen');

  await render('abc');
  await act(async () => {
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh usage"]');
    assert.ok(refresh);
    refresh.click();
    await flush();
  });
  assert.equal(queries.at(-1)!.search, 'abc');
  await tick(250);
  assert.equal(queries.length, 3, 'refresh consumes the pending search');

  await render('host-search');
  await render('host-search', 'new-host');
  assert.equal(queries.length, 4, 'Host change bypasses debounce');
  await tick(250);
  assert.equal(queries.length, 4, 'old Host timer was cancelled');

  await render('unmounted', 'new-host');
  await act(async () => root.unmount());
  await tick(250);
  assert.equal(queries.length, 4, 'unmount cancels the pending query');
});

for (const failure of ['revision_changed', 'screen_response_too_large', 'filter_error'] as const) {
  it(`keeps cached navigation after ${failure}`, async () => {
    const {container, root} = setupDom();
    const settings = mergeSettings(createDefaultSettings(), {
      usage: {range: 'all', activeTab: 'requests', showDetails: true},
    });
    const row = (id: string) => ({
      id,
      ts: 1,
      kind: 'model' as const,
      provider: 'p',
      model: id,
      inputTokens: 0,
      outputTokens: 0,
      status: 'success' as const,
    });
    let calls = 0;
    const services: UsageServices = {
      loadUsageStats: async (_range, query) => {
        assert.ok(query);
        if (failure === 'filter_error' && query.status === 'error') throw new Error('filter failed');
        return {
          ...navigable(151, query, 'query'),
          logs: Array.from({length: 50}, (_, index) => row(`first-${index}`)),
        };
      },
      loadUsageActivity: async () => {
        calls++;
        if (calls > 1) {
          return failure === 'revision_changed'
            ? {kind: 'revision_changed'}
            : {kind: 'screen_response_too_large', section: 'activity_page'};
        }
        return {
          kind: 'activity',
          page: {
            revision: 'same-revision',
            queryIdentity: 'query',
            nextCursor: 'third',
            logs: Array.from({length: 50}, (_, index) => row(`second-${index}`)),
          },
        };
      },
      updateUsageSettings: async () => settings.usage,
    };
    const button = (label: string) => {
      const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      assert.ok(result, label);
      return result;
    };
    const click = async (label: string) => {
      await act(async () => {
        button(label).click();
        await flush();
      });
    };

    await act(async () => {
      root.render(tree({active: true, settings, targetKey: 'host', services}));
      await flush();
    });
    await click('Go to page 2');
    assert.match(container.textContent ?? '', /second-0/);
    if (failure === 'filter_error') {
      const filteredSettings = mergeSettings(settings, {usage: {status: 'error'}});
      await act(async () => {
        root.render(tree({active: true, settings: filteredSettings, targetKey: 'host', services}));
        await flush();
      });
    } else {
      await click('Go to page 3');
    }

    const expectedCalls = failure === 'filter_error' ? 1 : 2;
    assert.equal(calls, expectedCalls);
    assert.equal(button('Go to next page').disabled, true);
    assert.equal(button('Go to page 3').disabled, true);
    assert.equal(button('Go to page 4').disabled, true);
    assert.equal(button('Go to previous page').disabled, false);
    await click('Go to page 1');
    assert.match(container.textContent ?? '', /first-0/);
    assert.equal(button('Go to next page').disabled, false);
    await click('Go to next page');
    assert.match(container.textContent ?? '', /second-0/);
    await click('Go to previous page');
    assert.match(container.textContent ?? '', /first-0/);
    await click('Go to page 2');
    assert.match(container.textContent ?? '', /second-0/);
    assert.equal(calls, expectedCalls, 'cached navigation never requests another Host page');
    await act(async () => root.unmount());
  });
}
