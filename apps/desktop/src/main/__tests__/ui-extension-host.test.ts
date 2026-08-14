import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ExtensionUiContributionProjection } from '@maka/runtime-host/protocol';
import {
  selectUiSnapshots,
} from '../../renderer/ui-extension-host.js';
import {
  withUiSandboxPolicy,
} from '../ui-extension-frame-document.js';
import { createUiExtensionFrameRequestHandler } from '../ui-extension-frame-protocol.js';
import { uiExtensionFrameUrl } from '../../renderer/ui-extension-frame-url.js';

describe('Desktop UI extension shell', () => {
  test('selects one deterministic root and ordered independent overlays', () => {
    const selected = selectUiSnapshots(null, [
      item('low', 'app.root', 1),
      item('overlay-b', 'app.overlay', 20),
      item('high', 'app.root', 100),
      item('overlay-a', 'app.overlay', 20),
    ]);
    assert.equal(selected.root.id, 'high');
    assert.deepEqual(selected.overlays.map(({ id }) => id), ['overlay-a', 'overlay-b']);
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
});

function item(
  id: string,
  surface: 'app.root' | 'app.overlay',
  priority: number,
): ExtensionUiContributionProjection {
  return {
    bindingId: `binding-${id}`,
    extensionId: 'demo',
    revision: '1',
    id,
    surface,
    rootMode: 'replace',
    priority,
    document: '<p>demo</p>',
    documentSha256: 'sha256',
    network: false,
  };
}
