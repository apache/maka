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

/**
 * Browser tools: ref normalization, takeover note, browser_wait
 * argument validation, and each tool's output formatting driven end-to-end
 * through a fake view Host + fake CDP page (no Electron, no live browser).
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { IPage } from '@jackwener/opencli/types';
import type { BrowserVerificationResult } from '../browser/browser-verification.js';
import type { ComputerUseToolSet } from '@maka/runtime/computer-use-tools';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { withBrowserOriginAdmission } from '../browser/browser-origin-admission.js';
import {
  buildBrowserClickTool,
  buildBrowserExtractTool,
  buildBrowserNavigateTool,
  buildBrowserSnapshotTool,
  buildBrowserTypeTool,
  buildBrowserWaitTool,
  normalizeElementRef,
  readHtmlJs,
  takeoverNote,
} from '../browser/browser-tools.js';
import { type BridgeLike, resetBrowserSessionsForTest, revokeHiddenBrowserActions, setBridgeFactoryForTest } from '../browser/session.js';
import { createDesktopNativeCapabilityProvider } from '../runtime-host-native-capabilities.js';
import {
  type BrowserViewHost,
  provideBrowserViewHost,
} from '../browser/browser-host.js';
import { BrowserOriginLeaseTracker } from '../browser/browser-origin-lease.js';

type FakePageConfig = {
  url?: string;
  afterGotoUrl?: string;
  afterClickUrl?: string;
  afterFillUrl?: string;
  title?: string;
  locationError?: string;
  loading?: boolean;
  alive?: boolean;
  loadError?: { code: number };
  httpStatus?: number;
  load?: { navigationId: number; state: 'unknown' | 'loading' | 'completed' | 'failed' | 'stopped'; errorCode?: number };
  gotoImpl?: (browser: FakeBrowser, url: string) => Promise<void>;
  evaluateImpl?: (browser: FakeBrowser) => void;
  click?: { matches_n: number; match_level: 'exact' | 'stable' | 'reidentified' };
  fill?: { verified: boolean; actual: string; match_level: 'exact' | 'stable' | 'reidentified' };
  snapshot?: unknown;
  snapshotImpl?: (browser: FakeBrowser) => unknown | Promise<unknown>;
  extractHtml?: string;
  extractImpl?: (browser: FakeBrowser) => void;
  waitImpl?: (options: unknown, browser: FakeBrowser) => Promise<void>;
  onLeaseOpened?: (browser: FakeBrowser) => void;
  takeoverReloadImpl?: (browser: FakeBrowser) => void;
};

type FakeBrowser = {
  url: string;
  onNavigate?: (url: string) => void;
  navigate(url: string): void;
  clicks: number;
  fills: number;
  presses: number;
};

function createFakeBrowser(url: string): FakeBrowser {
  const browser: FakeBrowser = {
    url,
    navigate(nextUrl) {
      browser.url = nextUrl;
      browser.onNavigate?.(nextUrl);
    },
    clicks: 0,
    fills: 0,
    presses: 0,
  };
  return browser;
}

function makeFakePage(cfg: FakePageConfig, browser: FakeBrowser): IPage {
  return {
    getCurrentUrl: async () => browser.url || null,
    goto: async (url: string) => cfg.gotoImpl ? cfg.gotoImpl(browser, url) : browser.navigate(cfg.afterGotoUrl ?? url),
    evaluate: async (js: string) => {
      if (js.includes('location.href')) {
        if (cfg.locationError) throw new Error(cfg.locationError);
        cfg.evaluateImpl?.(browser);
        return (js.includes('document.title') ? { url: browser.url, title: cfg.title ?? '' } : browser.url) as never;
      }
      if (js.includes('document.title')) return (cfg.title ?? '') as never;
      if (js.includes('outerHTML')) {
        cfg.extractImpl?.(browser);
        return (cfg.extractHtml === undefined ? null : { html: cfg.extractHtml, truncated: false }) as never;
      }
      return '' as never;
    },
    snapshot: async () =>
      cfg.snapshotImpl ? cfg.snapshotImpl(browser) : (cfg.snapshot ?? '[1] link "Home"'),
    click: async () => {
      browser.clicks += 1;
      if (cfg.afterClickUrl) browser.navigate(cfg.afterClickUrl);
      return cfg.click ?? { matches_n: 1, match_level: 'exact' };
    },
    fillText: async () => {
      browser.fills += 1;
      if (cfg.afterFillUrl) browser.navigate(cfg.afterFillUrl);
      return cfg.fill
        ? { filled: true, verified: cfg.fill.verified, expected: '', actual: cfg.fill.actual, length: 0, matches_n: 1, match_level: cfg.fill.match_level }
        : { filled: true, verified: true, expected: '', actual: '', length: 0, matches_n: 1, match_level: 'exact' };
    },
    pressKey: async () => {
      browser.presses += 1;
    },
    wait: async (options: unknown) => {
      if (cfg.waitImpl) return cfg.waitImpl(options, browser);
    },
  } as unknown as IPage;
}

class FakeBridge implements BridgeLike {
  constructor(
    private readonly page: IPage,
    private readonly onReload?: () => void,
  ) {}
  async connect(): Promise<IPage> {
    return this.page;
  }
  async close(): Promise<void> {}
  async send(method: string): Promise<unknown> {
    if (method === 'Page.reload') this.onReload?.();
    return {};
  }
  async waitForEvent(): Promise<unknown> {
    return {};
  }
}

function install(cfg: FakePageConfig): FakeBrowser {
  const browser = createFakeBrowser(cfg.url ?? 'https://example.com/');
  const originLeases = new BrowserOriginLeaseTracker(() => browser.url);
  browser.onNavigate = (url) => originLeases.recordNavigation(url);
  const host: BrowserViewHost = {
    beginAction: () => undefined,
    currentUrl: () => browser.url,
    openOriginLease: (_sessionId, approvedUrl, kind) => {
      const lease = originLeases.open(approvedUrl, kind);
      cfg.onLeaseOpened?.(browser);
      return { ...lease, snapshot: () => ({ ...lease.snapshot(), document: {
        viewId: 'view-1', alive: cfg.alive ?? true, loading: cfg.loading ?? false,
        loadError: cfg.loadError ?? null, httpStatus: cfg.httpStatus ?? 200,
        load: cfg.load ?? { navigationId: 1, state: 'completed' },
      } }) };
    },
    canDrive: () => true,
    resolveEndpoint: async (id) => ({ cdpEndpoint: `ws://127.0.0.1:1/${id}` }),
    releaseSession: async () => {},
    disposeSession: async () => {},
  };
  provideBrowserViewHost(host);
  setBridgeFactoryForTest(
    () => new FakeBridge(makeFakePage(cfg, browser), () => cfg.takeoverReloadImpl?.(browser)),
  );
  return browser;
}

function ctx(): MakaToolContext {
  return {
    sessionId: 's1',
    turnId: 't1',
    cwd: '/tmp',
    toolCallId: 'c1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

async function run<P>(tool: MakaTool<P, string | BrowserVerificationResult>, args: P): Promise<string> {
  const result = await runRaw(tool, args);
  return typeof result === 'string' ? result : result.summary;
}

function runRaw<P, R>(tool: MakaTool<P, R>, args: P, signal?: AbortSignal): Promise<R> {
  return withBrowserOriginAdmission(
    { sessionId: 's1', url: 'https://example.com/approved?secret=grant' },
    () => Promise.resolve(tool.impl(args, { ...ctx(), ...(signal ? { abortSignal: signal } : {}) })),
  );
}

afterEach(() => {
  resetBrowserSessionsForTest();
  setBridgeFactoryForTest(null);
  provideBrowserViewHost(null);
});

describe('browser tool helpers', () => {
  it('normalizeElementRef unwraps a bracketed ref and passes selectors through', () => {
    assert.equal(normalizeElementRef('[12]'), '12');
    assert.equal(normalizeElementRef('  [3] '), '3');
    assert.equal(normalizeElementRef('42'), '42');
    assert.equal(normalizeElementRef('.btn.primary'), '.btn.primary');
    assert.equal(normalizeElementRef('[data-id="x"]'), '[data-id="x"]');
  });

  it('takeoverNote appears only after a takeover reload', () => {
    assert.equal(takeoverNote({ takeoverReloaded: false }), '');
    assert.match(takeoverNote({ takeoverReloaded: true }), /reloaded once/);
  });
});

describe('browser tool execution', () => {
  it('does not report Loaded when observing the destination loses the connection', async () => {
    install({ locationError: 'CDP connection closed' });
    const output = await run(buildBrowserNavigateTool(), { url: 'https://example.com/preview' });
    assert.doesNotMatch(output, /Loaded/);
    const result = await runRaw(buildBrowserNavigateTool(), { url: 'https://example.com/preview' });
    assert.equal(result.status, 'failed');
    assert.equal(result.loaded, false);
    assert.equal(result.url, null);
  });

  it('discards a snapshot that spans a same-Origin navigation', async () => {
    install({ snapshotImpl: (browser) => {
      browser.navigate('https://example.com/replacement');
      return 'stale document evidence';
    } });
    const output = await run(buildBrowserSnapshotTool(), {});
    assert.doesNotMatch(output, /stale document evidence/);
  });

  it('navigate rejects a non-web URL before connecting', async () => {
    install({});
    await assert.rejects(run(buildBrowserNavigateTool(), { url: 'file:///etc/passwd' }), /Not a navigable URL/);
  });

  it('navigate returns only a sanitized destination after a cross-Origin redirect', async () => {
    install({
      url: 'https://old.example/',
      afterGotoUrl: 'https://other.example/reset/redirect-secret?token=private#account',
      title: 'Private destination title',
    });
    const out = await run(buildBrowserNavigateTool(), { url: 'https://example.com/start' });
    assert.equal(
      out,
      'Navigated to https://other.example. Access to the new site requires approval on the next Browser call.',
    );
    assert.doesNotMatch(out, /Private destination title|reset|redirect-secret|token|account/);
  });

  it('click returns only the new URL after cross-Origin navigation', async () => {
    install({
      url: 'https://example.com/start',
      afterClickUrl: 'https://other.example/reset/click-secret?token=private#account',
    });
    const out = await run(buildBrowserClickTool(), { ref: '[1]' });
    assert.equal(
      out,
      'Navigated to https://other.example. Access to the new site requires approval on the next Browser call.',
    );
    assert.doesNotMatch(out, /Clicked|matched|reset|click-secret|token|account/);

    resetBrowserSessionsForTest();
    install({
      url: 'https://example.com/start',
      afterClickUrl: 'file:///reset/local-secret',
    });
    const nonWebOut = await run(buildBrowserClickTool(), { ref: '[1]' });
    assert.equal(
      nonWebOut,
      'Navigated to an unapproved page. Access to the new site requires approval on the next Browser call.',
    );
    assert.doesNotMatch(nonWebOut, /file|reset|local-secret/);
  });

  it('covers the Provider second-check → first page await gap end to end', async () => {
    install({
      snapshot: 'private snapshot',
      onLeaseOpened: (state) => state.navigate('https://other.example/private?token=secret'),
    });
    const computerUseTools = [] as unknown as ComputerUseToolSet;
    computerUseTools.clearSession = () => undefined;
    computerUseTools.sessionEvents = {} as ComputerUseToolSet['sessionEvents'];
    let resolved = 0;
    const provider = createDesktopNativeCapabilityProvider({
      browserTools: [buildBrowserSnapshotTool()],
      resolveBrowserUrl: () => {
        resolved += 1;
        return 'https://example.com/approved';
      },
      releaseBrowserSession() {},
      computerUseTools,
      releaseDesktopInteractionSession() {},
    });
    assert.ok(provider.call);
    if (!provider.call) return;
    const result = await provider.call(
      {
        kind: 'client.capability.call',
        invocationId: 'invocation-1',
        registrationId: 'registration-1',
        offerId: 'desktop_browser',
        serverId: 'desktop_browser',
        toolName: 'browser_snapshot',
        arguments: {},
        sessionId: 's1',
        turnId: 't1',
        toolCallId: 'c1',
        cwd: '/tmp',
      },
      {
        signal: new AbortController().signal,
        accept: async () => undefined,
        requestInteraction: async () => assert.fail('Unexpected provider interaction'),
      },
    );
    assert.equal(resolved, 2);
    assert.equal(result.outcome, 'error');
    assert.deepEqual(result.content, []);
    const evidence = result.structuredContent as BrowserVerificationResult;
    assert.equal(evidence.status, 'invalidated');
    assert.equal(evidence.loaded, false);
    assert.equal(evidence.url, null);
    assert.equal(evidence.summary, 'Navigated to https://other.example. Access to the new site requires approval on the next Browser call.');
    assert.doesNotMatch(JSON.stringify(result), /private snapshot|token/);
  });

  it('discards a snapshot when the page crosses Origin and returns to the approved site', async () => {
    install({
      snapshotImpl: (browser) => {
        browser.navigate('https://other.example/reset/first-violated-secret?token=secret');
        browser.navigate('https://example.com/back');
        return 'private snapshot';
      },
    });
    const out = await run(buildBrowserSnapshotTool(), {});
    assert.equal(
      out,
      'Navigated to https://other.example. Access to the new site requires approval on the next Browser call.',
    );
    assert.doesNotMatch(out, /private snapshot|reset|first-violated-secret|token/);
  });

  it('covers an A→B→A takeover reload before the first mutating page call', async () => {
    const browser = install({
      takeoverReloadImpl: (state) => {
        state.navigate('https://other.example/reset/reload-secret?token=secret');
        state.navigate('https://example.com/back');
      },
    });
    const out = await run(buildBrowserClickTool(), { ref: '[1]' });
    assert.equal(
      out,
      'Navigated to https://other.example. Access to the new site requires approval on the next Browser call.',
    );
    assert.equal(browser.clicks, 0);
    assert.doesNotMatch(out, /reset|reload-secret|token/);
  });

  it('does not press Enter when filling navigates away from the approved Origin', async () => {
    const browser = install({
      afterFillUrl: 'https://other.example/login?token=private#form',
    });
    const out = await run(buildBrowserTypeTool(), { ref: '[2]', text: 'hello', submit: true });
    assert.equal(
      out,
      'Navigated to https://other.example. Access to the new site requires approval on the next Browser call.',
    );
    assert.equal(browser.fills, 1);
    assert.equal(browser.presses, 0);
    assert.doesNotMatch(out, /hello|token|form/);
  });

  it('returns only a sanitized URL after same-Origin click navigation', async () => {
    install({ afterClickUrl: 'https://example.com/next?token=private#section' });
    const out = await run(buildBrowserClickTool(), { ref: '[1]' });
    assert.equal(out, 'Navigated to https://example.com/next.');
    assert.doesNotMatch(out, /Clicked|matched|token|section/);
  });


  it('type reports verification failure with the actual content', async () => {
    install({ fill: { verified: false, actual: 'partial', match_level: 'exact' } });
    const out = await run(buildBrowserTypeTool(), { ref: '[2]', text: 'hello', submit: true });
    assert.match(out, /then pressed Enter/);
    assert.match(out, /Not verified/);
    assert.match(out, /"partial"/);
  });

  it('wait requires exactly one of text/selector/time', async () => {
    install({});
    await assert.rejects(run(buildBrowserWaitTool(), {}), /exactly one/);
    await assert.rejects(run(buildBrowserWaitTool(), { text: 'a', time: 1 }), /exactly one/);
    await assert.rejects(run(buildBrowserWaitTool(), { text: '   ' }), /non-empty/);
  });

  it('extract fails clearly when a selector matches nothing', async () => {
    install({ url: 'https://example.com/' }); // extractHtml undefined => page returns null
    await assert.rejects(run(buildBrowserExtractTool(), { selector: '#missing' }), /No element matches selector/);
  });

  it('extract page-side script swallows an invalid selector instead of throwing', () => {
    // The fake IPage above ignores the selector, so the SyntaxError only fires
    // in a real DOM. Drive the generated page script directly against a stub
    // whose querySelector throws on a malformed selector (real browsers do):
    // it must return null, which the impl maps to the friendly "No element
    // matches selector" message rather than a raw DOMException.
    const doc = {
      body: { outerHTML: '<body>ok</body>' },
      querySelector(sel: string) {
        if (sel === '[12]') throw new Error("'[12]' is not a valid selector");
        return null;
      },
    };
    const exec = (selector: unknown): unknown =>
      new Function('document', `return ${readHtmlJs(JSON.stringify(selector))};`)(doc);
    assert.equal(exec('[12]'), null); // invalid selector → null, not a throw
    assert.equal(exec('#missing'), null); // valid-but-absent → null (unchanged)
    assert.deepEqual(exec(null), { html: '<body>ok</body>', truncated: false }); // no selector → body
  });

  it('a tool fails with a clear message when no host is injected', async () => {
    // no install(): host stays null
    const result = await runRaw(buildBrowserNavigateTool(), { url: 'https://example.com/' });
    assert.equal(result.status, 'unsupported');
    assert.equal(result.opened, false);
    assert.equal(result.preflight?.surface, 'unsupported');
  });
});

describe('structured browser verification', () => {
  for (const failed of [false, true]) {
    it(`publishes actual Browser result through Client Capability structuredContent (${failed ? 'failure' : 'success'})`, async () => {
      install({ title: 'Preview 5235', ...(failed ? { httpStatus: 404 } : {}) });
      const computerUseTools = [] as unknown as ComputerUseToolSet;
      computerUseTools.clearSession = () => undefined;
      computerUseTools.sessionEvents = {} as ComputerUseToolSet['sessionEvents'];
      const provider = createDesktopNativeCapabilityProvider({
        browserTools: [buildBrowserNavigateTool()],
        resolveBrowserUrl: () => 'https://example.com/preview',
        releaseBrowserSession() {}, computerUseTools, releaseDesktopInteractionSession() {},
      });
      const result = await provider.call!({
        kind: 'client.capability.call', invocationId: 'i1', registrationId: 'r1',
        offerId: 'desktop_browser', serverId: 'desktop_browser', toolName: 'browser_navigate',
        arguments: { url: 'https://example.com/preview' },
        sessionId: 's1', turnId: 't1', toolCallId: 'c1', cwd: '/tmp',
      }, {
        signal: new AbortController().signal, accept: async () => undefined,
        requestInteraction: async () => assert.fail('Unexpected interaction'),
      });
      assert.equal(result.outcome, failed ? 'error' : 'success');
      assert.deepEqual(result.content, []);
      const evidence = result.structuredContent as BrowserVerificationResult;
      assert.equal(evidence.kind, 'browser_verification');
      assert.equal(evidence.loaded, !failed);
      assert.equal(evidence.title, failed ? null : 'Preview 5235');
      assert.equal(evidence.status, failed ? 'failed' : 'completed');
    });
  }

  it('returns load evidence and a stable document identity without exposing a preview capability', async () => {
    const token = 'a'.repeat(64);
    const url = `https://example.com/${token}/index.html?secret=private#fragment`;
    install({ title: 'Preview 5235', snapshot: `PREVIEW_READY_5235 ${url} [1] button "0"` });
    const navigation = await runRaw(buildBrowserNavigateTool(), { url });
    assert.equal(navigation.status, 'completed');
    assert.equal(navigation.opened, true);
    assert.equal(navigation.loaded, true);
    assert.equal(navigation.title, 'Preview 5235');
    assert.equal(navigation.matchesRequestedUrl, true);
    assert.equal(navigation.preflight?.surface, 'verified');
    assert.equal(navigation.preflight?.capabilities.find((c) => c.id === 'url_schemes')?.status, 'unsupported');
    const before = await runRaw(buildBrowserSnapshotTool(), {});
    const click = await runRaw(buildBrowserClickTool(), { ref: '[1]' });
    const after = await runRaw(buildBrowserSnapshotTool(), {});
    assert.equal(before.documentId, navigation.documentId);
    assert.equal(after.documentId, before.documentId);
    assert.equal(click.click?.interaction, 'not_verified');
    // No fake counter mutation: only a real browser may prove the HTML script worked.
    assert.equal(before.snapshot, after.snapshot);
    assert.doesNotMatch(JSON.stringify([navigation, before, click, after]), new RegExp(`${token}|secret=|private|fragment`));
  });

  it('does not relabel an old page as a newly loaded target', async () => {
    install({ gotoImpl: async () => {} });
    const result = await runRaw(buildBrowserNavigateTool(), { url: 'https://example.com/new' });
    assert.equal(result.status, 'unknown');
    assert.equal(result.error?.code, 'no_document_commit');
    assert.equal(result.url, null);
    assert.equal(result.opened, false);
  });

  for (const config of [{ loadError: { code: -102 } }, { httpStatus: 404 }, { httpStatus: 500 }]) {
    it(`rejects controller load failure ${JSON.stringify(config)}`, async () => {
      install(config);
      const result = await runRaw(buildBrowserNavigateTool(), { url: 'https://example.com/preview' });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'load_failed');
      assert.deepEqual(result.evidence, ['loadError' in config ? 'controller_load_error' : 'controller_http_status']);
      assert.equal(result.opened, false);
      assert.equal(result.loaded, false);
      assert.equal(result.title, null);
      assert.equal(buildBrowserNavigateTool().resultOutcome?.(result), 'error');
    });
  }

  it('reports the swallowed goto load-event timeout honestly when the controller is still loading', async () => {
    install({ loading: true });
    const result = await runRaw(buildBrowserNavigateTool(), { url: 'https://example.com/slow' });
    assert.equal(result.status, 'timeout');
    assert.equal(result.opened, false);
    assert.equal(result.loaded, false);
  });

  for (const [state, status, errorCode] of [
    ['failed', 'failed', -354], ['stopped', 'invalidated', -3], ['unknown', 'unknown', undefined],
    ['loading', 'unknown', undefined],
  ] as const) {
    for (const action of ['navigate', 'snapshot', 'click'] as const) {
      it(`${action} rejects a readable non-loading document with ${state} load evidence`, async () => {
        const browser = install({ loading: false, load: { navigationId: 2, state, errorCode } });
        const result = action === 'navigate'
          ? await runRaw(buildBrowserNavigateTool(), { url: 'https://example.com/preview' })
          : action === 'snapshot' ? await runRaw(buildBrowserSnapshotTool(), {})
          : await runRaw(buildBrowserClickTool(), { ref: '1' });
        assert.equal(result.status, status);
        assert.equal(result.opened, false);
        assert.equal(result.loaded, false);
        assert.equal(result.documentId, undefined);
        assert.equal(browser.clicks, 0);
      });
    }
  }

  it('invalidates observation when a new navigation starts before committing', async () => {
    const config: FakePageConfig = { evaluateImpl: () => {
      config.load = { navigationId: 2, state: 'loading' };
    } };
    install(config);
    const result = await runRaw(buildBrowserSnapshotTool(), {});
    assert.equal(result.status, 'invalidated');
    assert.equal(result.loaded, false);
    assert.equal(result.snapshot, undefined);
  });

  it('discards a snapshot spanning an entire same-URL reload even before an epoch update', async () => {
    const config: FakePageConfig = { snapshotImpl: () => {
      config.load = { navigationId: 2, state: 'completed' };
      return 'old document snapshot';
    } };
    install(config);
    const result = await runRaw(buildBrowserSnapshotTool(), {});
    assert.notEqual(result.status, 'completed');
    assert.equal(result.loaded, false);
    assert.equal(result.snapshot, undefined);
  });

  it('bounds a goto that never settles using the existing session deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    install({ gotoImpl: async () => { started(); await new Promise(() => {}); } });
    const pending = runRaw(buildBrowserNavigateTool(), { url: 'https://example.com/slow' });
    await entered;
    t.mock.timers.tick(35_000);
    const result = await pending;
    assert.equal(result.status, 'timeout');
    assert.equal(result.loaded, false);
    t.mock.timers.reset();
  });

  it('preserves cancellation instead of reporting a verification finding', async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    install({ gotoImpl: async () => { started(); await new Promise(() => {}); } });
    const controller = new AbortController();
    const pending = runRaw(buildBrowserNavigateTool(), { url: 'https://example.com/slow' }, controller.signal);
    await entered;
    controller.abort();
    await assert.rejects(pending, /canceled/);
  });

  it('consumes unknown preflight reasons without attempting navigation', async () => {
    let navigated = false;
    install({ gotoImpl: async () => { navigated = true; } });
    const result = await runRaw(buildBrowserNavigateTool({
      guiSurfaceAvailable: () => true,
      browserDrivable: () => false,
      probeLoopback: () => assert.fail('Navigation does not introduce a listener probe'),
    }), { url: 'https://example.com/' });
    assert.equal(result.status, 'unknown');
    assert.equal(result.preflight?.surface, 'unknown');
    assert.equal(result.opened, false);
    assert.equal(navigated, false);
  });

  it('discards snapshot evidence when the page closes during observation', async () => {
    const config: FakePageConfig = { snapshotImpl: () => {
      config.alive = false;
      return 'closed page evidence';
    } };
    install(config);
    const result = await runRaw(buildBrowserSnapshotTool(), {});
    assert.equal(result.status, 'invalidated');
    assert.equal(result.snapshot, undefined);
    assert.equal(result.documentId, undefined);
    assert.equal(result.loaded, false);
  });

  it('invalidates navigation evidence when visibility admission is revoked', async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    install({ gotoImpl: async () => { started(); await new Promise(() => {}); } });
    const pending = runRaw(buildBrowserNavigateTool(), { url: 'https://example.com/slow' });
    await entered;
    revokeHiddenBrowserActions(() => false);
    const result = await pending;
    assert.equal(result.status, 'invalidated');
    assert.equal(result.error?.code, 'view_revoked');
    assert.equal(result.documentId, undefined);
    assert.equal(result.loaded, false);
  });

  it('marks an actual same-Origin redirect as observed rather than echoing the request', async () => {
    install({ afterGotoUrl: 'https://example.com/final', title: 'Final' });
    const result = await runRaw(buildBrowserNavigateTool(), { url: 'https://example.com/start' });
    assert.equal(result.url, 'https://example.com/final');
    assert.equal(result.matchesRequestedUrl, false);
  });

  it('does not export raw CDP errors containing a bearer URL', async () => {
    const token = 'b'.repeat(64);
    install({ locationError: `Error observing https://example.com/${token}/index.html?secret=private` });
    const result = await runRaw(buildBrowserNavigateTool(), { url: 'https://example.com/preview' });
    assert.equal(result.status, 'failed');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${token}|private|secret=`));
  });
});
