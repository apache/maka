import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { resolveExecutionBundledResourcesRoot } from '../server/execution-bundled-resources.js';
import { startExecutionRuntimeHostCandidate } from '../server/execution-candidate.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

test('admits bundled resources only from a paired packaged Electron bootstrap', () => {
  assert.equal(
    resolveExecutionBundledResourcesRoot(
      {
        electronVersion: '43.2.0',
        defaultApp: false,
        resourcesPath: '/Applications/Maka.app/Contents/Resources',
        parentPid: 42,
      },
      {
        kind: 'maka_packaged_candidate_bootstrap_v1',
        parentPid: 42,
        resourcesRoot: '/Applications/Maka.app/Contents/Resources',
      },
    ),
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
  assert.throws(
    () =>
      resolveExecutionBundledResourcesRoot(
        {
          electronVersion: '43.2.0',
          resourcesPath: '/Applications/Maka.app/Contents/Resources',
          parentPid: 42,
        },
        {
          kind: 'maka_packaged_candidate_bootstrap_v1',
          parentPid: 42,
          resourcesRoot: '/tmp/forged-resources',
        },
      ),
    /does not match the Electron resource root/u,
  );
  assert.equal(
    resolveExecutionBundledResourcesRoot({ resourcesPath: '/ambient/resources' }),
    undefined,
  );
});

test('the public Desktop issuer refuses development Electron Node mode', async () => {
  const electronPath = require('electron') as string;
  const { stdout } = await execFileAsync(
    electronPath,
    [fileURLToPath(new URL('./fixtures/execution-bundled-resources-child.js', import.meta.url))],
    {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );

  const observed = JSON.parse(stdout) as {
    defaultApp: boolean | null;
    resourcesPath: string | null;
    authorityIssued: boolean;
    resolved: string | null;
  };
  assert.equal(observed.defaultApp, null);
  assert.ok(observed.resourcesPath);
  assert.equal(observed.authorityIssued, false);
  assert.equal(observed.resolved, null);
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
