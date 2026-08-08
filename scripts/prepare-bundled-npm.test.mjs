import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareBundledNpm } from './prepare-bundled-npm.mjs';

const patches = [
  ['tar', '7.5.19', '7.5.22'],
  ['brace-expansion', '5.0.7', '5.0.9'],
  ['ip-address', '10.2.0', '10.4.0'],
  ['undici', '6.27.0', '6.28.0'],
];

test('prepares an exact file manifest for the bundled npm runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-bundled-npm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceNpmRoot = join(root, 'npm');
  const patchedPackagesRoot = join(root, 'patched-packages');
  const runtimeOutputRoot = join(root, 'runtime', 'npm');
  const outputPath = join(root, 'bundled-npm.json');
  await mkdir(join(sourceNpmRoot, 'bin'), { recursive: true });
  await mkdir(join(sourceNpmRoot, 'lib'), { recursive: true });
  await createPatchFixtures(root, sourceNpmRoot, patchedPackagesRoot);
  await writeFile(
    join(sourceNpmRoot, 'package.json'),
    '{"name":"npm","version":"12.0.2","license":"Artistic-2.0"}\n',
  );
  await writeFile(join(sourceNpmRoot, 'LICENSE'), 'fixture license\n');
  await writeFile(join(sourceNpmRoot, 'bin', 'npm-cli.js'), 'import "../lib/cli.js";\n');
  await writeFile(join(sourceNpmRoot, 'lib', 'cli.js'), 'export default true;\n');
  const manifest = await prepareBundledNpm({
    sourceNpmRoot,
    patchedPackagesRoot,
    runtimeOutputRoot,
    outputPath,
    sourceLockPath: join(root, 'package-lock.json'),
    platform: 'linux',
    arch: 'x64',
  });

  assert.equal(manifest.npmVersion, '12.0.2');
  assert.equal(manifest.securityPatches.length, 4);
  assert.deepEqual(
    manifest.securityPatches.map(({ packageName, fromVersion, toVersion }) => [
      packageName,
      fromVersion,
      toVersion,
    ]),
    patches,
  );
  assert.equal(manifest.cliRelativePath, 'npm/bin/npm-cli.js');
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    [
      'LICENSE',
      'bin/npm-cli.js',
      'lib/cli.js',
      'node_modules/brace-expansion/index.js',
      'node_modules/brace-expansion/package.json',
      'node_modules/ip-address/index.js',
      'node_modules/ip-address/package.json',
      'node_modules/tar/index.js',
      'node_modules/tar/package.json',
      'node_modules/undici/index.js',
      'node_modules/undici/package.json',
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
  const patchedPackagesRoot = join(root, 'patched-packages');
  await mkdir(join(sourceNpmRoot, 'bin'), { recursive: true });
  await createPatchFixtures(root, sourceNpmRoot, patchedPackagesRoot);
  await writeFile(
    join(sourceNpmRoot, 'package.json'),
    '{"name":"npm","version":"12.0.2","license":"Artistic-2.0"}\n',
  );
  await writeFile(join(sourceNpmRoot, 'LICENSE'), 'fixture license\n');
  await writeFile(join(sourceNpmRoot, 'bin', 'npm-cli.js'), 'console.log("npm");\n');
  const { symlink } = await import('node:fs/promises');
  await symlink(
    process.platform === 'win32' ? sourceNpmRoot : join(sourceNpmRoot, 'LICENSE'),
    join(sourceNpmRoot, 'linked-license'),
    process.platform === 'win32' ? 'junction' : undefined,
  );

  await assert.rejects(
    prepareBundledNpm({
      sourceNpmRoot,
      patchedPackagesRoot,
      runtimeOutputRoot: join(root, 'runtime', 'npm'),
      outputPath: join(root, 'manifest.json'),
      sourceLockPath: join(root, 'package-lock.json'),
    }),
    /regular files and directories/u,
  );
});

async function createPatchFixtures(root, sourceNpmRoot, patchedPackagesRoot) {
  const lockPackages = {};
  for (const [name, fromVersion, toVersion] of patches) {
    const sourceRoot = join(sourceNpmRoot, 'node_modules', name);
    const patchedRoot = join(patchedPackagesRoot, name);
    await Promise.all([
      mkdir(sourceRoot, { recursive: true }),
      mkdir(patchedRoot, { recursive: true }),
    ]);
    await writeFile(
      join(sourceRoot, 'package.json'),
      `${JSON.stringify({ name, version: fromVersion })}\n`,
    );
    await writeFile(
      join(patchedRoot, 'package.json'),
      `${JSON.stringify({ name, version: toVersion })}\n`,
    );
    await writeFile(join(patchedRoot, 'index.js'), 'export const patched = true;\n');
    lockPackages[`node_modules/${name}`] = {
      version: toVersion,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${toVersion}.tgz`,
      integrity: 'sha512-Zml4dHVyZQ==',
    };
  }
  lockPackages['node_modules/npm'] = { version: '12.0.2' };
  for (const [name, fromVersion] of patches) {
    lockPackages[`node_modules/npm/node_modules/${name}`] = { version: fromVersion };
  }
  await writeFile(
    join(root, 'package-lock.json'),
    `${JSON.stringify({ lockfileVersion: 3, packages: lockPackages })}\n`,
  );
}
