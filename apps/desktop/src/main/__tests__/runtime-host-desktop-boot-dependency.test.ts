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

test('the opt-in Desktop boot cannot load an embedded Interactive owner', async () => {
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
  const forbidden = [
    'apps/desktop/src/main/app-lifecycle.ts',
    'apps/desktop/src/main/boot.ts',
    'apps/desktop/src/main/embedded-bot-session-adapter.ts',
    'apps/desktop/src/main/execution-store-wiring.ts',
    'apps/desktop/src/main/sessions-ipc-main.ts',
    'apps/desktop/src/main/startup-safe-boundary-resume.ts',
  ];
  assert.deepEqual(forbidden.filter((path) => reached.has(normalize(path))), []);
  for (const required of [
    'apps/desktop/src/main/desktop-shell-presentation.ts',
    'apps/desktop/src/main/runtime-host-account-connection.ts',
    'apps/desktop/src/main/runtime-host-github-copilot-ipc-main.ts',
    'apps/desktop/src/main/runtime-host-oauth-ipc-main.ts',
  ]) {
    assert.equal(reached.has(normalize(required)), true, `${required} must be reachable`);
  }

  const source = await readFile(entrypoint, 'utf8');
  for (const factory of [
    'SessionManager',
    'createSessionStore',
    'openRuntimeEventPersistence',
    'openDesktopExecutionStoreWiring',
  ]) {
    assert.equal(source.includes(factory), false, `${factory} must stay outside Host-backed boot`);
  }
});
