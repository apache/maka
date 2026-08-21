import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { desktopAssetPath, desktopAssetRoot } from '../desktop-assets.js';

test('a packaged build reads assets from the copy beside the app', () => {
  const resourcesPath = join('/Applications', 'Maka.app', 'Contents', 'Resources');
  assert.equal(desktopAssetRoot({ isPackaged: true, resourcesPath }), resourcesPath);
  assert.equal(
    desktopAssetPath({ isPackaged: true, resourcesPath }, 'assets', 'icon.png'),
    join(resourcesPath, 'assets', 'icon.png'),
  );
});

test('a dev run keeps resolving the repo layout, not the resources path', () => {
  const root = desktopAssetRoot({ isPackaged: false, resourcesPath: '/unused' });
  assert.ok(root.endsWith(join('apps', 'desktop')), `${root} should point at apps/desktop`);
});
