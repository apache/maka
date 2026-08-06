import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareBundledNpm } from './prepare-bundled-npm.mjs';

test('prepares an exact file manifest for the bundled npm runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-bundled-npm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceNpmRoot = join(root, 'npm');
  const patchedTarRoot = join(root, 'patched-tar');
  const runtimeOutputRoot = join(root, 'runtime', 'npm');
  const outputPath = join(root, 'bundled-npm.json');
  await mkdir(join(sourceNpmRoot, 'bin'), { recursive: true });
  await mkdir(join(sourceNpmRoot, 'lib'), { recursive: true });
  await mkdir(join(sourceNpmRoot, 'node_modules', 'tar'), { recursive: true });
  await mkdir(patchedTarRoot, { recursive: true });
  await writeFile(
    join(sourceNpmRoot, 'package.json'),
    '{"name":"npm","version":"12.0.2","license":"Artistic-2.0"}\n',
  );
  await writeFile(join(sourceNpmRoot, 'LICENSE'), 'fixture license\n');
  await writeFile(join(sourceNpmRoot, 'bin', 'npm-cli.js'), 'import "../lib/cli.js";\n');
  await writeFile(join(sourceNpmRoot, 'lib', 'cli.js'), 'export default true;\n');
  await writeFile(
    join(sourceNpmRoot, 'node_modules', 'tar', 'package.json'),
    '{"name":"tar","version":"7.5.19"}\n',
  );
  await writeFile(join(patchedTarRoot, 'package.json'), '{"name":"tar","version":"7.5.22"}\n');
  await writeFile(join(patchedTarRoot, 'index.js'), 'export const patched = true;\n');

  const manifest = await prepareBundledNpm({
    sourceNpmRoot,
    patchedTarRoot,
    runtimeOutputRoot,
    outputPath,
    platform: 'linux',
    arch: 'x64',
  });

  assert.equal(manifest.npmVersion, '12.0.2');
  assert.deepEqual(manifest.securityPatches, [
    {
      packageName: 'tar',
      fromVersion: '7.5.19',
      toVersion: '7.5.22',
      advisory: 'GHSA-r292-9mhp-454m',
    },
  ]);
  assert.equal(manifest.cliRelativePath, 'npm/bin/npm-cli.js');
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    [
      'LICENSE',
      'bin/npm-cli.js',
      'lib/cli.js',
      'node_modules/tar/index.js',
      'node_modules/tar/package.json',
      'package.json',
    ],
  );
  assert.match(manifest.runtimeIdentitySha256, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), manifest);
});

test('rejects a bundled npm tree containing symbolic links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-bundled-npm-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceNpmRoot = join(root, 'npm');
  const patchedTarRoot = join(root, 'patched-tar');
  await mkdir(join(sourceNpmRoot, 'bin'), { recursive: true });
  await mkdir(join(sourceNpmRoot, 'node_modules', 'tar'), { recursive: true });
  await mkdir(patchedTarRoot, { recursive: true });
  await writeFile(
    join(sourceNpmRoot, 'package.json'),
    '{"name":"npm","version":"12.0.2","license":"Artistic-2.0"}\n',
  );
  await writeFile(join(sourceNpmRoot, 'LICENSE'), 'fixture license\n');
  await writeFile(join(sourceNpmRoot, 'bin', 'npm-cli.js'), 'console.log("npm");\n');
  await writeFile(
    join(sourceNpmRoot, 'node_modules', 'tar', 'package.json'),
    '{"name":"tar","version":"7.5.19"}\n',
  );
  await writeFile(join(patchedTarRoot, 'package.json'), '{"name":"tar","version":"7.5.22"}\n');
  const { symlink } = await import('node:fs/promises');
  await symlink(
    process.platform === 'win32' ? sourceNpmRoot : join(sourceNpmRoot, 'LICENSE'),
    join(sourceNpmRoot, 'linked-license'),
    process.platform === 'win32' ? 'junction' : undefined,
  );

  await assert.rejects(
    prepareBundledNpm({
      sourceNpmRoot,
      patchedTarRoot,
      runtimeOutputRoot: join(root, 'runtime', 'npm'),
      outputPath: join(root, 'manifest.json'),
    }),
    /regular files and directories/u,
  );
});
