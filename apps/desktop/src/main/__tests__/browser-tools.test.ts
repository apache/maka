/**
 * Browser tools: ref normalization, takeover note, browser_wait
 * argument validation, and each tool's output formatting driven end-to-end
 * through a fake view Host + fake CDP page (no Electron, no live browser).
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { IPage } from '@jackwener/opencli/types';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
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
import { type BrowserViewHost, provideBrowserViewHost } from '../browser/browser-host.js';

type FakePageConfig = {
  url?: string;
  title?: string;
  click?: { matches_n: number; match_level: 'exact' | 'stable' | 'reidentified' };
  fill?: { verified: boolean; actual: string; match_level: 'exact' | 'stable' | 'reidentified' };
  snapshot?: unknown;
  extractHtml?: string;
  waitImpl?: (options: unknown) => Promise<void>;
};

function makeFakePage(cfg: FakePageConfig): IPage {
  return {
    getCurrentUrl: async () => cfg.url ?? null,
    goto: async () => {},
    evaluate: async (js: string) => {
      if (js.includes('location.href')) return (cfg.url ?? '') as never;
      if (js.includes('document.title')) return (cfg.title ?? '') as never;
      if (js.includes('outerHTML')) {
        return (cfg.extractHtml === undefined ? null : { html: cfg.extractHtml, truncated: false }) as never;
      }
      return '' as never;
    },
    snapshot: async () => cfg.snapshot ?? '[1] link "Home"',
    click: async () => cfg.click ?? { matches_n: 1, match_level: 'exact' },
    fillText: async () =>
      cfg.fill
        ? { filled: true, verified: cfg.fill.verified, expected: '', actual: cfg.fill.actual, length: 0, matches_n: 1, match_level: cfg.fill.match_level }
        : { filled: true, verified: true, expected: '', actual: '', length: 0, matches_n: 1, match_level: 'exact' },
    pressKey: async () => {},
    wait: async (options: unknown) => {
      if (cfg.waitImpl) return cfg.waitImpl(options);
    },
  } as unknown as IPage;
}

class FakeBridge implements BridgeLike {
  constructor(private readonly page: IPage) {}
  async connect(): Promise<IPage> {
    return this.page;
  }
  async close(): Promise<void> {}
  async send(): Promise<unknown> {
    return {};
  }
  async waitForEvent(): Promise<unknown> {
    return {};
  }
}

function install(cfg: FakePageConfig): void {
  const host: BrowserViewHost = {
    canDrive: () => true,
    resolveEndpoint: async (id) => ({ cdpEndpoint: `ws://127.0.0.1:1/${id}` }),
    releaseSession: async () => {},
    disposeSession: async () => {},
  };
  provideBrowserViewHost(host);
  setBridgeFactoryForTest(() => new FakeBridge(makeFakePage(cfg)));
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
  return Promise.resolve(tool.impl(args, ctx())) as Promise<string>;
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
