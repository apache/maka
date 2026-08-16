import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { assertPackagedResources } from './verify-packaged-app.mjs';

test('requires bundled npm only for the current release contract', async () => {
  const currentPaths = [];
  await assertPackagedResources('resources', {
    requirePath: async (path) => currentPaths.push(path),
    forbidPath: async () => {},
  });
  assert.ok(currentPaths.includes(join('resources', 'bundled-npm.json')));
  assert.ok(currentPaths.includes(join('resources', 'npm', 'bin', 'npm-cli.js')));
  assert.ok(currentPaths.includes(join('resources', 'licenses', 'npm-cli', 'LICENSE')));

  const legacyPaths = [];
  await assertPackagedResources('resources', {
    requirePath: async (path) => legacyPaths.push(path),
    forbidPath: async () => {},
    requireBundledNpm: false,
  });
  assert.equal(legacyPaths.includes(join('resources', 'bundled-npm.json')), false);
  assert.equal(legacyPaths.includes(join('resources', 'npm', 'bin', 'npm-cli.js')), false);
  assert.equal(legacyPaths.includes(join('resources', 'licenses', 'npm-cli', 'LICENSE')), false);
});
