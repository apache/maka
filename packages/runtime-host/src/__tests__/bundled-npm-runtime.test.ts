import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveBundledNpmRuntime } from '../server/bundled-npm-runtime.js';
import { runManagedNpmDependencyProvision } from '../server/managed-dependency-producer-process.js';

test('attests a strict packaged npm tree against every declared file', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.remove);

  const capability = await resolveBundledNpmRuntime({
    resourcesRoot: fixture.root,
  });

  assert.equal(capability.npmVersion, '12.0.2');
  assert.equal(capability.nodeVersion, process.versions.node);
  assert.equal(capability.nodeAbi, process.versions.modules);
  assert.equal(capability.platform, process.platform);
  assert.equal(capability.arch, process.arch);
  assert.equal(capability.npmRuntimeRoot, await realpath(join(fixture.root, 'npm')));
  assert.equal(
    capability.npmCliPath,
    await realpath(join(fixture.root, 'npm', 'bin', 'npm-cli.js')),
  );
  assert.match(capability.runtimeIdentitySha256, /^sha256:[a-f0-9]{64}$/u);
});

test('rejects a bundled npm file changed before attestation', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.remove);
  await writeFile(join(fixture.root, 'npm', 'bin', 'npm-cli.js'), 'tampered\n');

  await assert.rejects(
    resolveBundledNpmRuntime({ resourcesRoot: fixture.root }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'bundled_npm_integrity_mismatch',
  );
});

test('rejects undeclared files in the bundled npm tree', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.remove);
  await writeFile(join(fixture.root, 'npm', 'undeclared.js'), 'unexpected\n');

  await assert.rejects(
    resolveBundledNpmRuntime({ resourcesRoot: fixture.root }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'bundled_npm_integrity_mismatch',
  );
});

test('revalidates the full npm tree before every managed invocation', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.remove);
  const capability = await resolveBundledNpmRuntime({ resourcesRoot: fixture.root });
  await writeFile(join(fixture.root, 'npm', 'LICENSE'), 'changed after attestation\n');

  await assert.rejects(
    runManagedNpmDependencyProvision({
      runtime: capability,
      producerInput: undefined as never,
    }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'bundled_npm_integrity_mismatch',
  );
});

test('rejects a manifest for another platform before issuing capability', async (t) => {
  const fixture = await createFixture({
    platform: process.platform === 'win32' ? 'linux' : 'win32',
  });
  t.after(fixture.remove);

  await assert.rejects(
    resolveBundledNpmRuntime({ resourcesRoot: fixture.root }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'bundled_npm_platform_mismatch',
  );
});

test('classifies malformed manifest JSON as invalid evidence', async (t) => {
  const fixture = await createFixture();
  t.after(fixture.remove);
  await writeFile(join(fixture.root, 'bundled-npm.json'), '{not-json');

  await assert.rejects(
    resolveBundledNpmRuntime({ resourcesRoot: fixture.root }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'bundled_npm_manifest_invalid',
  );
});

async function createFixture(options: { readonly platform?: NodeJS.Platform } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-bundled-npm-runtime-'));
  const npmRoot = join(root, 'npm');
  await mkdir(join(npmRoot, 'bin'), { recursive: true });
  await Promise.all([
    writeFile(
      join(npmRoot, 'package.json'),
      '{"name":"npm","version":"12.0.2","license":"Artistic-2.0"}\n',
    ),
    writeFile(join(npmRoot, 'bin', 'npm-cli.js'), "console.log('fixture npm');\n"),
    writeFile(join(npmRoot, 'LICENSE'), 'Artistic License fixture\n'),
  ]);
  await writeFile(
    join(root, 'bundled-npm.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      protocol: 'maka_bundled_npm_runtime_v1',
      provider: 'desktop/npm-cli',
      npmVersion: '12.0.2',
      platform: options.platform ?? process.platform,
      arch: process.arch,
      runtimeRootRelativePath: 'npm',
      cliRelativePath: 'npm/bin/npm-cli.js',
      securityPatches: approvedSecurityPatches,
      files: [
        {
          path: 'LICENSE',
          bytes: 25,
          sha256: 'sha256:871a16ed3b8cf5ceaee50e01124761c4be8310cc9908820b8fde5953f4034f83',
        },
        {
          path: 'bin/npm-cli.js',
          bytes: 28,
          sha256: 'sha256:d104584f0a4ea5ead632bdbb4bb3aa6999600e33c92808bda4ce642aa53d5d6b',
        },
        {
          path: 'package.json',
          bytes: 59,
          sha256: 'sha256:1c0973dc9bec7dab061b42e164446693459ff4e192e233a33b6b2a86809e6e22',
        },
      ],
      distributionReady: true,
    })}\n`,
  );
  return {
    root,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

const approvedSecurityPatches = [
  {
    packageName: 'tar',
    fromVersion: '7.5.19',
    toVersion: '7.5.22',
    advisories: ['GHSA-r292-9mhp-454m'],
  },
  {
    packageName: 'brace-expansion',
    fromVersion: '5.0.7',
    toVersion: '5.0.9',
    advisories: ['GHSA-mh99-v99m-4gvg', 'GHSA-rgw5-rvv9-x895'],
  },
  {
    packageName: 'ip-address',
    fromVersion: '10.2.0',
    toVersion: '10.4.0',
    advisories: ['GHSA-mwp4-54f8-5fhr', 'GHSA-4xrf-jv44-h6hh', 'GHSA-22jq-vg5j-6vgg'],
  },
  {
    packageName: 'undici',
    fromVersion: '6.27.0',
    toVersion: '6.28.0',
    advisories: ['GHSA-8xcm-r25x-g524', 'GHSA-m8rv-5g2x-5cg5', 'GHSA-v3r7-h72x-cjcm'],
  },
] as const;
