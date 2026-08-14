import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ExtensionUiContributionProjection } from '@maka/runtime-host/protocol';
import {
  selectUiSnapshots,
  withUiSandboxPolicy,
} from '../../renderer/ui-extension-host.js';

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
    assert.match(bridged, /getState/);
    assert.match(bridged, /setState/);
    assert.match(bridged, /deleteState/);
    assert.match(bridged, /invoke/);
    assert.match(bridged, /test-token/);
  });
});

function item(id: string, surface: 'app.root' | 'app.overlay', priority: number): ExtensionUiContributionProjection {
  return {
    bindingId: `binding-${id}`,
    extensionId: 'demo',
    revision: '1',
    id,
    surface,
    priority,
    document: '<p>demo</p>',
    documentSha256: 'sha256',
    network: false,
  };
}
