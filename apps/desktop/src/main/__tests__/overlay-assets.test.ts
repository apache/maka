import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveOverlayAssetDir } from '../overlay-assets.js';

test('overlay assets resolve from bundled and tsc layouts', () => {
  const dist = '/workspace/apps/desktop/dist';
  for (const modulePath of [
    `${dist}/main/main.js`,
    `${dist}/main/overlay-assets.js`,
  ]) {
    assert.equal(resolveOverlayAssetDir(pathToFileURL(modulePath).href), `${dist}/overlay`);
  }
});

test('overlay assets preserve the caller-relative fallback', () => {
  const moduleUrl = pathToFileURL('/workspace/apps/desktop/build/main/computer-use/pip-electron.js');
  assert.equal(resolveOverlayAssetDir(moduleUrl.href), '/workspace/apps/desktop/build/overlay');
});
