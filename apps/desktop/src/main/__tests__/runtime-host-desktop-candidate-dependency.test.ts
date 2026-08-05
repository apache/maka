import assert from 'node:assert/strict';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const workingDirectory = process.cwd();
const repositoryRoot =
  basename(workingDirectory) === 'desktop' && basename(dirname(workingDirectory)) === 'apps'
    ? resolve(workingDirectory, '..', '..')
    : workingDirectory;
const candidateEntrypoint = join(
  repositoryRoot,
  'apps',
  'desktop',
  'src',
  'main',
  'runtime-host-desktop-candidate.ts',
);

test('the Desktop Host candidate cannot reach an embedded Runtime owner', async () => {
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [candidateEntrypoint],
    bundle: true,
    format: 'esm',
    metafile: true,
    packages: 'external',
    platform: 'node',
    write: false,
  });
  assert.ok(result.metafile);

  const reached = new Set(Object.keys(result.metafile.inputs).map(normalize));
  const forbiddenModules = [
    'apps/desktop/src/main/app-lifecycle.ts',
    'apps/desktop/src/main/boot.ts',
    'apps/desktop/src/main/embedded-bot-session-adapter.ts',
    'apps/desktop/src/main/execution-store-wiring.ts',
    'apps/desktop/src/main/sessions-ipc-main.ts',
    'apps/desktop/src/main/startup-safe-boundary-resume.ts',
  ];
  assert.deepEqual(
    forbiddenModules.filter((path) => reached.has(normalize(path))),
    [],
  );

  const externalImports = Object.values(result.metafile.inputs).flatMap(({ imports }) =>
    imports.filter(({ external }) => external).map(({ path }) => path),
  );
  assert.deepEqual(
    externalImports.filter(
      (path) =>
        path === '@maka/runtime' ||
        path.startsWith('@maka/runtime/') ||
        path === '@maka/storage' ||
        path.startsWith('@maka/storage/'),
    ),
    [],
  );
});
