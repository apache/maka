import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const workingDirectory = process.cwd();
const repositoryRoot =
  basename(workingDirectory) === 'desktop' && basename(dirname(workingDirectory)) === 'apps'
    ? resolve(workingDirectory, '..', '..')
    : workingDirectory;
const entrypoint = join(
  repositoryRoot,
  'apps',
  'desktop',
  'src',
  'main',
  'runtime-host-boot.ts',
);

test('the production Desktop boot cannot construct an Interactive owner', async () => {
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [entrypoint],
    bundle: true,
    format: 'esm',
    metafile: true,
    packages: 'external',
    platform: 'node',
    write: false,
  });
  assert.ok(result.metafile);
  const reached = new Set(Object.keys(result.metafile.inputs).map(normalize));
  for (const required of [
    'apps/desktop/src/main/desktop-shell-presentation.ts',
    'apps/desktop/src/main/runtime-host-account-connection.ts',
    'apps/desktop/src/main/runtime-host-github-copilot-ipc-main.ts',
    'apps/desktop/src/main/runtime-host-oauth-ipc-main.ts',
  ]) {
    assert.equal(reached.has(normalize(required)), true, `${required} must be reachable`);
  }

  const forbiddenFactories = [
    'SessionManager',
    'RuntimeKernel',
    'createSessionStore',
    'createAgentRunStore',
    'createRuntimeEventStore',
    'openRuntimeEventPersistence',
    'openDesktopExecutionStoreWiring',
    'openInteractiveRuntimePolicyStoresForWrite',
    'tryAcquireInteractiveRootOwner',
  ];
  for (const path of reached) {
    if (!path.startsWith(normalize('apps/desktop/src/main/'))) continue;
    if (isE2eFixtureModule(path)) continue;
    const source = await readFile(resolve(repositoryRoot, path), 'utf8');
    for (const factory of forbiddenFactories) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\b${factory}\\b`, 'u'),
        `${path} must not reach Interactive owner ${factory}`,
      );
    }
  }
});

function isE2eFixtureModule(path: string): boolean {
  const relative = normalize(path).slice(normalize('apps/desktop/src/main/').length);
  return relative === 'e2e-fixture.ts' || relative.startsWith(normalize('e2e-fixture/'));
}
