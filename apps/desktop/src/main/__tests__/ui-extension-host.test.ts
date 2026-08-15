import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { ExtensionUiContributionProjection } from '@maka/runtime-host/protocol';
import { selectUiSnapshots, UiExtensionSlot, UiExtensionSlotProvider } from '../../renderer/ui-extension-host.js';
import { withUiSandboxPolicy } from '../ui-extension-frame-document.js';
import { createUiExtensionFrameRequestHandler } from '../ui-extension-frame-protocol.js';
import { uiExtensionFrameUrl } from '../../renderer/ui-extension-frame-url.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

afterEach(() => {
  Object.assign(globalThis, originalGlobals);
});

describe('Desktop UI extension shell', () => {
  test('selects one deterministic root and ordered independent overlays', () => {
    const selected = selectUiSnapshots(null, [
      item('low', 'app.root', 1),
      item('overlay-b', 'app.overlay', 20),
      item('high', 'app.root', 100),
      item('overlay-a', 'app.overlay', 20),
      item('settings', 'app.slot', 30, 'settings.content'),
      item('conversation', 'app.slot', 40, 'conversation.header'),
    ]);
    assert.equal(selected.root.id, 'high');
    assert.deepEqual(selected.overlays.map(({ id }) => id), ['overlay-a', 'overlay-b']);
    assert.deepEqual(selected.slots.map(({ id }) => id), ['conversation', 'settings']);
  });

  test('updates one slot without remounting the official root', async () => {
    const { document, window } = parseHTML('<div id="root"></div>');
    Object.assign(globalThis, {
      document,
      window,
      HTMLElement: window.HTMLElement,
      HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const container = document.querySelector('#root');
    assert.ok(container);
    const root = createRoot(container);
    let mounts = 0;
    let unmounts = 0;
    function OfficialRootProbe() {
      useEffect(() => {
        mounts += 1;
        return () => {
          unmounts += 1;
        };
      }, []);
      return createElement('main', { 'data-official-root': true });
    }
    const render = async (revision: string) => {
      await act(async () => {
        root.render(
          createElement(
            UiExtensionSlotProvider,
            {
              contributions: [
                { ...item('status', 'app.slot', 10, 'conversation.header'), revision },
              ],
              onSafeMode: () => undefined,
            },
            createElement(OfficialRootProbe),
            createElement(UiExtensionSlot, { name: 'conversation.header' }),
          ),
        );
        await Promise.resolve();
      });
    };

    await render('1');
    await render('2');
    assert.equal(mounts, 1);
    assert.equal(unmounts, 0);
    assert.equal(container.querySelectorAll('iframe').length, 1);
    await act(async () => root.unmount());
    assert.equal(unmounts, 1);
  });

  test('injects an offline CSP by default and only opens declared network lanes', () => {
    const offline = withUiSandboxPolicy('<html><head></head><body>Hello</body></html>', false);
    assert.match(offline, /connect-src 'none'/);
    assert.match(offline, /frame-src 'none'/);
    assert.ok(offline.indexOf('Content-Security-Policy') < offline.indexOf('</head>'));
    const online = withUiSandboxPolicy('<main>Hello</main>', true);
    assert.match(online, /connect-src https: wss:/);
    assert.match(online, /form-action 'none'/);
  });

  test('injects the narrow Host SDK only for an admitted frame token', () => {
    const plain = withUiSandboxPolicy('<main>Hello</main>', false);
    assert.doesNotMatch(plain, /makaUI/);
    const bridged = withUiSandboxPolicy('<main>Hello</main>', false, 'test-token');
    assert.match(bridged, /maka-ui-bridge\/v1/);
    assert.match(bridged, /maka-ui-bridge-ready\/v1/);
    assert.match(bridged, /maka-ui-host-ready\/v1/);
    assert.match(bridged, /queued\.push/);
    assert.match(bridged, /setInterval\(announce,50\)/);
    assert.match(bridged, /clearInterval\(retry\)/);
    assert.match(bridged, /getState/);
    assert.match(bridged, /setState/);
    assert.match(bridged, /deleteState/);
    assert.match(bridged, /invoke/);
    assert.match(bridged, /session_list/);
    assert.match(bridged, /session_send/);
    assert.match(bridged, /session_stop/);
    assert.match(bridged, /safe_mode/);
    assert.match(bridged, /test-token/);
  });

  test('serves active UI bytes from an isolated scheme instead of srcdoc CSP inheritance', async () => {
    const token = '12345678-1234-4123-8123-123456789abc';
    const contribution = item('root', 'app.root', 1);
    const url = uiExtensionFrameUrl({
      scopeId: 'desktop-ui',
      bindingId: contribution.bindingId,
      extensionId: contribution.extensionId,
      revision: contribution.revision,
      contributionId: contribution.id,
      token,
    });
    const handler = createUiExtensionFrameRequestHandler(() => ({
      request: async () => ({
        scopeId: 'desktop-ui',
        digest: 'sha256-test',
        contributions: [{ ...contribution, hostState: true }],
      }),
    }));
    const response = await handler(new Request(url));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'unsafe-inline'/);
    assert.match(await response.text(), /makaUI/);
  });

  test('injects the emergency recovery bridge even without extension permissions', async () => {
    const token = '12345678-1234-4123-8123-123456789abc';
    const contribution = item('root', 'app.root', 1);
    const handler = createUiExtensionFrameRequestHandler(() => ({
      request: async () => ({
        scopeId: 'desktop-ui',
        digest: 'sha256-test',
        contributions: [contribution],
      }),
    }));
    const response = await handler(new Request(uiExtensionFrameUrl({
      scopeId: 'desktop-ui',
      bindingId: contribution.bindingId,
      extensionId: contribution.extensionId,
      revision: contribution.revision,
      contributionId: contribution.id,
      token,
    })));
    const document = await response.text();
    assert.match(document, /safe_mode/);
    assert.match(document, /makaUI/);
  });
});

function item(
  id: string,
  surface: 'app.root' | 'app.overlay' | 'app.slot',
  priority: number,
  slot?: string,
): ExtensionUiContributionProjection {
  return {
    bindingId: `binding-${id}`,
    extensionId: 'demo',
    revision: '1',
    id,
    surface,
    ...(slot ? { slot } : {}),
    priority,
    document: '<p>demo</p>',
    documentSha256: 'sha256',
    network: false,
  };
}
