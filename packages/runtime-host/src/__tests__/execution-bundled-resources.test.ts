import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveExecutionBundledResourcesRoot } from '../server/execution-bundled-resources.js';
import { startExecutionRuntimeHostCandidate } from '../server/execution-candidate.js';

test('admits bundled resources only from packaged Electron identity', () => {
  assert.equal(
    resolveExecutionBundledResourcesRoot({
      electronVersion: '43.2.0',
      defaultApp: false,
      resourcesPath: '/Applications/Maka.app/Contents/Resources',
    }),
    '/Applications/Maka.app/Contents/Resources',
  );
  assert.equal(
    resolveExecutionBundledResourcesRoot({
      electronVersion: '43.2.0',
      defaultApp: true,
      resourcesPath: '/electron/Resources',
    }),
    undefined,
  );
  assert.equal(
    resolveExecutionBundledResourcesRoot({ resourcesPath: '/ambient/resources' }),
    undefined,
  );
});

test('candidate refuses bundled npm without the paired managed Git authority', async () => {
  await assert.rejects(
    startExecutionRuntimeHostCandidate({
      rootPath: '/unused',
      expectedRootId: 'a'.repeat(64),
      bundledNpmResourcesRoot: '/untrusted/npm',
    }),
    /requires managed workspace Git authority/u,
  );
});

test('candidate attests bundled npm before acquiring the operational root', async () => {
  await assert.rejects(
    startExecutionRuntimeHostCandidate({
      rootPath: '/must-not-be-opened',
      expectedRootId: 'a'.repeat(64),
      managedWorkspaceGitRuntime: {
        executablePath: process.execPath,
        expectedSha256: `sha256:${'0'.repeat(64)}`,
      },
      bundledNpmResourcesRoot: '/missing/bundled/resources',
    }),
    (error) =>
      error instanceof Error &&
      error.name === 'BundledNpmRuntimeError' &&
      error.message === 'Bundled npm runtime is unavailable',
  );
});
