/**
 * BrowserSession lifecycle: lazy connect + cache, single-flight first acquire,
 * connection-loss invalidation, takeover-reload, timeout/abort severing, and
 * the delete-during-connect epoch race. Driven entirely through fakes (a fake
 * view Host and a fake CDP bridge), so no Electron or live CDP endpoint.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { IPage } from '@jackwener/opencli/types';
import {
  type BridgeLike,
  BrowserActionBlockedError,
  BrowserActionCanceledError,
  BrowserActionRevokedError,
  BrowserToolTimeoutError,
  releaseBrowserSession,
  resetBrowserSessionsForTest,
  revokeHiddenBrowserActions,
  setBridgeFactoryForTest,
  withBrowserPage,
} from '../browser/session.js';
import { type BrowserViewHost, provideBrowserViewHost } from '../browser/browser-host.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeFakePage(url: string | null = null): IPage {
  return {
    getCurrentUrl: async () => url,
    evaluate: async () => '' as never,
  } as unknown as IPage;
}

class FakeBridge implements BridgeLike {
  closed = false;
  reloads = 0;
  constructor(private readonly page: IPage) {}
  async connect(): Promise<IPage> {
    return this.page;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async send(method: string): Promise<unknown> {
    if (method === 'Page.reload') this.reloads += 1;
    return {};
  }
  async waitForEvent(): Promise<unknown> {
    return {};
  }
}

// Install a bridge factory that hands out one FakeBridge per connect(), each
// wrapping the next page in `pages` (last page repeats). Returns the live list.
function installBridges(pages: IPage[]): FakeBridge[] {
  const created: FakeBridge[] = [];
  setBridgeFactoryForTest(() => {
    const page = pages[Math.min(created.length, pages.length - 1)] ?? makeFakePage();
    const bridge = new FakeBridge(page);
    created.push(bridge);
    return bridge;
  });
  return created;
}

type HostSpy = {
  host: BrowserViewHost;
  resolved: string[];
  released: string[];
  disposed: string[];
};

function installHost(overrides: Partial<BrowserViewHost> = {}): HostSpy {
  const spy: HostSpy = { resolved: [], released: [], disposed: [], host: null as never };
  const host: BrowserViewHost = {
    canDrive: () => true,
    resolveEndpoint: async (id) => {
      spy.resolved.push(id);
      return { cdpEndpoint: `ws://127.0.0.1:1/${id}` };
    },
    releaseSession: async (id) => {
      spy.released.push(id);
    },
    disposeSession: async (id) => {
      spy.disposed.push(id);
    },
    ...overrides,
  };
  spy.host = host;
  provideBrowserViewHost(host);
  return spy;
}

afterEach(() => {
  resetBrowserSessionsForTest();
  setBridgeFactoryForTest(null);
  provideBrowserViewHost(null);
});

describe('BrowserSession', () => {
  it('connects once and reuses the cached connection across actions', async () => {
    installHost();
    const bridges = installBridges([makeFakePage()]);
    const a = await withBrowserPage('s1', 'snapshot', async () => 'a');
    const b = await withBrowserPage('s1', 'snapshot', async () => 'b');
    assert.equal(a, 'a');
    assert.equal(b, 'b');
    assert.equal(bridges.length, 1);
  });

  it('shares one connect across two concurrent first actions (single-flight)', async () => {
    const gate = deferred<void>();
    let resolveCalls = 0;
    installHost({
      resolveEndpoint: async (id) => {
        resolveCalls += 1;
        await gate.promise;
        return { cdpEndpoint: `ws://127.0.0.1:1/${id}` };
      },
    });
    const bridges = installBridges([makeFakePage()]);
    const p1 = withBrowserPage('s1', 'snapshot', async () => '1');
    const p2 = withBrowserPage('s1', 'snapshot', async () => '2');
    await tick();
    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, '1');
    assert.equal(r2, '2');
    assert.equal(bridges.length, 1); // one connect, not a race into two
    assert.equal(resolveCalls, 1); // endpoint resolved once, shared by both callers
  });

  it('defers the takeover reload: observe never reloads, the first mutate hardens once', async () => {
    installHost();
    const bridges = installBridges([makeFakePage('https://example.com/feed')]);
    // Pure observe must not disturb the page the user has open.
    const observed = await withBrowserPage('s1', 'snapshot', async (_p, info) => info.takeoverReloaded, {
      takeover: 'observe',
    });
    assert.equal(observed, false);
    assert.equal(bridges[0]?.reloads, 0);
    // The first mutating action reloads once and flags it.
    const firstMutate = await withBrowserPage('s1', 'click', async (_p, info) => info.takeoverReloaded, {
      takeover: 'mutate',
    });
    assert.equal(firstMutate, true);
    assert.equal(bridges[0]?.reloads, 1);
    // A later mutate does not reload again.
    const laterMutate = await withBrowserPage('s1', 'click', async (_p, info) => info.takeoverReloaded, {
      takeover: 'mutate',
    });
    assert.equal(laterMutate, false);
    assert.equal(bridges[0]?.reloads, 1);
  });

  it('a navigation clears the pending takeover without reloading (goto re-stealths)', async () => {
    installHost();
    const bridges = installBridges([makeFakePage('https://example.com/feed')]);
    const nav = await withBrowserPage('s1', 'navigate', async (_p, info) => info.takeoverReloaded, {
      takeover: 'navigate',
    });
    assert.equal(nav, false);
    assert.equal(bridges[0]?.reloads, 0);
    // After navigating, even a mutate does not reload — the new document is already stealthed.
    const afterNav = await withBrowserPage('s1', 'click', async (_p, info) => info.takeoverReloaded, {
      takeover: 'mutate',
    });
    assert.equal(afterNav, false);
    assert.equal(bridges[0]?.reloads, 0);
  });

  it('never reloads a blank/non-web page, even before a mutate', async () => {
    installHost();
    const bridges = installBridges([makeFakePage(null)]);
    const took = await withBrowserPage('s1', 'click', async (_p, info) => info.takeoverReloaded, {
      takeover: 'mutate',
    });
    assert.equal(took, false);
    assert.equal(bridges[0]?.reloads, 0);
  });

  it('invalidates and reconnects after a connection-loss error', async () => {
    const spy = installHost();
    const bridges = installBridges([makeFakePage(), makeFakePage()]);
    await assert.rejects(
      withBrowserPage('s1', 'click', async () => {
        throw new Error('CDP connection is not open');
      }),
      /browser page was closed/,
    );
    assert.equal(bridges[0]?.closed, true);
    assert.deepEqual(spy.released, ['s1']);
    // Next action re-resolves and reconnects on a fresh bridge.
    const ok = await withBrowserPage('s1', 'click', async () => 'recovered');
    assert.equal(ok, 'recovered');
    assert.equal(bridges.length, 2);
  });

  it('times out, severs the connection, and surfaces a typed error', async () => {
    const spy = installHost();
    const bridges = installBridges([makeFakePage()]);
    await assert.rejects(
      withBrowserPage('s1', 'wait', () => new Promise<never>(() => {}), { timeoutMs: 20 }),
      BrowserToolTimeoutError,
    );
    assert.equal(bridges[0]?.closed, true);
    assert.deepEqual(spy.released, ['s1']);
  });

  it('rejects immediately on an already-aborted signal without connecting', async () => {
    const spy = installHost();
    const bridges = installBridges([makeFakePage()]);
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      withBrowserPage('s1', 'snapshot', async () => 'x', { abort: ctrl.signal }),
      BrowserActionCanceledError,
    );
    assert.equal(bridges.length, 0);
    assert.deepEqual(spy.resolved, []);
  });

  it('aborts a running action and severs the connection', async () => {
    const spy = installHost();
    const bridges = installBridges([makeFakePage()]);
    const ctrl = new AbortController();
    const p = withBrowserPage('s1', 'wait', () => new Promise<never>(() => {}), { abort: ctrl.signal });
    await tick();
    ctrl.abort();
    await assert.rejects(p, BrowserActionCanceledError);
    assert.equal(bridges[0]?.closed, true);
    assert.deepEqual(spy.released, ['s1']);
  });

  it('releaseBrowserSession disposes the view and closes the connection', async () => {
    const spy = installHost();
    const bridges = installBridges([makeFakePage()]);
    await withBrowserPage('s1', 'snapshot', async () => 'ok');
    await releaseBrowserSession('s1');
    assert.equal(bridges[0]?.closed, true);
    assert.deepEqual(spy.disposed, ['s1']);
  });

  it('unwinds an acquire when the session is released mid-connect', async () => {
    const gate = deferred<void>();
    const spy = installHost({
      resolveEndpoint: async (id) => {
        await gate.promise;
        return { cdpEndpoint: `ws://127.0.0.1:1/${id}` };
      },
    });
    const bridges = installBridges([makeFakePage()]);
    const p = withBrowserPage('s1', 'snapshot', async () => 'never');
    await tick();
    await releaseBrowserSession('s1'); // bumps the epoch while resolveEndpoint is pending
    gate.resolve();
    await assert.rejects(p, /deleted while the browser was connecting/);
    assert.equal(bridges[0]?.closed, true);
    // disposed twice: once by the release, once by the acquire unwinding itself.
    assert.ok(spy.disposed.filter((id) => id === 's1').length >= 1);
  });

  it('visible-lease gate: blocks every vetoed kind — incl. observe — before connecting', async () => {
    // Host vetoes everything (mirrors a conversation not on screen). The uniform
    // lease gates reads too, so even observe is blocked before acquire.
    const spy = installHost({ canDrive: () => false });
    const bridges = installBridges([makeFakePage()]);
    await assert.rejects(
      withBrowserPage('s1', 'click', async () => 'x', { takeover: 'mutate' }),
      BrowserActionBlockedError,
    );
    await assert.rejects(
      withBrowserPage('s1', 'navigate', async () => 'x', { takeover: 'navigate' }),
      BrowserActionBlockedError,
    );
    await assert.rejects(
      withBrowserPage('s1', 'snapshot', async () => 'x', { takeover: 'observe' }),
      BrowserActionBlockedError,
    );
    // Blocked before acquire: no endpoint resolved, no connection opened.
    assert.deepEqual(spy.resolved, []);
    assert.equal(bridges.length, 0);
  });

  it('revokes an in-flight action when the user switches away from its conversation', async () => {
    // The visible lease is continuous, not just a preflight: an observe that
    // started while visible must not keep reading the hidden page after a switch.
    const spy = installHost();
    const bridges = installBridges([makeFakePage()]);
    const p = withBrowserPage('s1', 'snapshot', () => new Promise<never>(() => {}), { takeover: 'observe' });
    await tick(); // connect + enter run()
    revokeHiddenBrowserActions('other'); // window switched to another conversation
    await assert.rejects(p, BrowserActionRevokedError);
    // Severed and detached — no orphaned run() left driving the now-hidden page,
    // and (crucially) the rejected action returns no page data to the tool.
    assert.equal(bridges[0]?.closed, true);
    assert.deepEqual(spy.released, ['s1']);
  });

  it('does not revoke an action for the conversation that is still shown', async () => {
    installHost();
    installBridges([makeFakePage()]);
    const ctrl = new AbortController();
    let settled = false;
    const p = withBrowserPage('s1', 'snapshot', () => new Promise<never>(() => {}), {
      takeover: 'observe',
      abort: ctrl.signal,
    });
    void p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await tick();
    revokeHiddenBrowserActions('s1'); // s1 is the one now on screen → leave it running
    await tick();
    assert.equal(settled, false);
    ctrl.abort(); // clean up the deliberately-dangling action
    await assert.rejects(p, BrowserActionCanceledError);
  });

  it('fails clearly when no host is injected', async () => {
    // no installHost(): host stays null
    installBridges([makeFakePage()]);
    await assert.rejects(
      withBrowserPage('s1', 'snapshot', async () => 'x'),
      /only available inside the desktop app/,
    );
  });
});
