import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

test('prepares an exact patched manifest and audit lock for bundled npm', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.remove);
  const runtimeOutputRoot = join(fixture.root, 'runtime', 'npm');
  const outputPath = join(fixture.root, 'runtime', 'bundled-npm.json');
  const auditRoot = join(fixture.root, 'runtime', 'audit');

  const manifest = await prepareBundledNpm({
    ...fixture.inputs,
    runtimeOutputRoot,
    outputPath,
    auditRoot,
    platform: 'linux',
    arch: 'x64',
  });

  assert.equal(manifest.npmVersion, '12.0.2');
  assert.deepEqual(
    manifest.securityPatches.map(({ packageName, fromVersion, toVersion }) => [
      packageName,
      fromVersion,
      toVersion,
    ]),
    patches,
  );
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), manifest);
  for (const [name, , version] of patches) {
    const packageManifest = JSON.parse(
      await readFile(join(runtimeOutputRoot, 'node_modules', name, 'package.json'), 'utf8'),
    );
    assert.equal(packageManifest.version, version);
  }
  const auditLock = JSON.parse(await readFile(join(auditRoot, 'package-lock.json'), 'utf8'));
  for (const [name, , version] of patches) {
    assert.equal(auditLock.packages[`node_modules/npm/node_modules/${name}`].version, version);
  }
});

test('rejects symlink or junction input before publication', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.remove);
  await symlink(
    process.platform === 'win32'
      ? fixture.inputs.sourceNpmRoot
      : join(fixture.inputs.sourceNpmRoot, 'LICENSE'),
    join(fixture.inputs.sourceNpmRoot, 'redirect'),
    process.platform === 'win32' ? 'junction' : undefined,
  );

  await assert.rejects(
    prepareBundledNpm({
      ...fixture.inputs,
      runtimeOutputRoot: join(fixture.root, 'runtime', 'npm'),
      outputPath: join(fixture.root, 'runtime', 'bundled-npm.json'),
    }),
    /regular files and directories/u,
  );
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-prepare-bundled-npm-'));
  const sourceNpmRoot = join(root, 'npm');
  const patchedPackagesRoot = join(root, 'patched');
  const sourceLockPath = join(root, 'package-lock.json');
  await mkdir(join(sourceNpmRoot, 'bin'), { recursive: true });
  await Promise.all([
    writeFile(
      join(sourceNpmRoot, 'package.json'),
      '{"name":"npm","version":"12.0.2","license":"Artistic-2.0"}\n',
    ),
    writeFile(join(sourceNpmRoot, 'LICENSE'), 'fixture license\n'),
    writeFile(join(sourceNpmRoot, 'bin', 'npm-cli.js'), 'console.log("npm");\n'),
  ]);
  const lockPackages = { 'node_modules/npm': { version: '12.0.2' } };
  for (const [name, fromVersion, toVersion] of patches) {
    const sourceRoot = join(sourceNpmRoot, 'node_modules', name);
    const patchedRoot = join(patchedPackagesRoot, name);
    await Promise.all([
      mkdir(sourceRoot, { recursive: true }),
      mkdir(patchedRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(sourceRoot, 'package.json'),
        `${JSON.stringify({ name, version: fromVersion })}\n`,
      ),
      writeFile(
        join(patchedRoot, 'package.json'),
        `${JSON.stringify({ name, version: toVersion })}\n`,
      ),
      writeFile(join(patchedRoot, 'index.js'), 'export const patched = true;\n'),
    ]);
    lockPackages[`node_modules/npm/node_modules/${name}`] = { version: fromVersion };
    lockPackages[`node_modules/${name}`] = {
      version: toVersion,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${toVersion}.tgz`,
      integrity: 'sha512-Zml4dHVyZQ==',
    };
  }
  await writeFile(
    sourceLockPath,
    `${JSON.stringify({ lockfileVersion: 3, packages: lockPackages })}\n`,
  );
  return {
    root,
    inputs: { sourceNpmRoot, patchedPackagesRoot, sourceLockPath },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
