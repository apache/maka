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
import { type BridgeLike, resetBrowserSessionsForTest, setBridgeFactoryForTest } from '../browser/session.js';
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
    goto: async (url: string) => browser.navigate(cfg.afterGotoUrl ?? url),
    evaluate: async (js: string) => {
      if (js.includes('location.href')) return browser.url as never;
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
    currentUrl: () => browser.url,
    openOriginLease: (_sessionId, approvedUrl, kind) => {
      const lease = originLeases.open(approvedUrl, kind);
      cfg.onLeaseOpened?.(browser);
      return lease;
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

function run<P>(tool: MakaTool<P, string>, args: P): Promise<string> {
  return withBrowserOriginAdmission(
    { sessionId: 's1', url: 'https://example.com/approved?secret=grant' },
    () => Promise.resolve(tool.impl(args, ctx())) as Promise<string>,
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
      releaseComputerUseSession() {},
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
      },
    );
    assert.equal(resolved, 2);
    assert.deepEqual(result, {
      content: [
        {
          type: 'text',
          text: 'Navigated to https://other.example. Access to the new site requires approval on the next Browser call.',
        },
      ],
    });
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
    await assert.rejects(run(buildBrowserSnapshotTool(), {}), /only available inside the desktop app/);
  });
});
