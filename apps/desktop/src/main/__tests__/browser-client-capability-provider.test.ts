import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { IPage } from '@jackwener/opencli/types';
import { decodeClientCapabilityReplaceInput } from '@maka/runtime-host/protocol';
import { createDesktopBrowserCapabilityProvider } from '../browser/client-capability-provider.js';
import {
  type BrowserViewHost,
  provideBrowserViewHost,
} from '../browser/browser-host.js';
import {
  type BridgeLike,
  resetBrowserSessionsForTest,
  setBridgeFactoryForTest,
} from '../browser/session.js';

afterEach(() => {
  resetBrowserSessionsForTest();
  setBridgeFactoryForTest(null);
  provideBrowserViewHost(null);
});

test('Desktop Browser is exposed as a generic Client Capability offer', async () => {
  const released: string[] = [];
  const disposed: string[] = [];
  const bridge = new FakeBridge(browserPage());
  provideBrowserViewHost(browserHost(released, disposed));
  setBridgeFactoryForTest(() => bridge);
  const provider = createDesktopBrowserCapabilityProvider();
  const [offer] = provider.offers();
  assert.ok(offer);
  assert.doesNotThrow(() =>
    decodeClientCapabilityReplaceInput({
      registrationId: 'registration',
      offers: provider.offers(),
    }),
  );
  assert.equal(offer.offerId, 'desktop_browser');
  assert.deepEqual(
    offer.tools.map((tool) => tool.name),
    [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_wait',
      'browser_extract',
    ],
  );

  let accepted = false;
  const result = await provider.call(
    {
      kind: 'client.capability.call',
      invocationId: 'invocation',
      registrationId: 'registration',
      offerId: 'desktop_browser',
      serverId: 'desktop_browser',
      toolName: 'browser_snapshot',
      arguments: {},
      sessionId: 'session',
      turnId: 'turn',
      toolCallId: 'tool-call',
      cwd: '/tmp',
    },
    {
      signal: new AbortController().signal,
      accept: async () => {
        accepted = true;
      },
    },
  );
  assert.equal(accepted, true);
  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'https://example.test/\n\n[1] Example link' }],
  });
  await provider.close?.();
  await provider.close?.();
  assert.deepEqual(released, ['session']);
  assert.deepEqual(disposed, []);
  assert.equal(bridge.closeCalls, 1);
});

function browserHost(released: string[], disposed: string[]): BrowserViewHost {
  return {
    canDrive: () => true,
    resolveEndpoint: async () => ({ cdpEndpoint: 'ws://127.0.0.1:1/session' }),
    releaseSession: async (sessionId) => {
      released.push(sessionId);
    },
    disposeSession: async (sessionId) => {
      disposed.push(sessionId);
    },
  };
}

function browserPage(): IPage {
  return {
    snapshot: async () => '[1] Example link',
    getCurrentUrl: async () => 'https://example.test/',
  } as unknown as IPage;
}

class FakeBridge implements BridgeLike {
  closeCalls = 0;

  constructor(private readonly page: IPage) {}

  async connect(): Promise<IPage> {
    return this.page;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  async send(): Promise<unknown> {
    return {};
  }

  async waitForEvent(): Promise<unknown> {
    return {};
  }
}
