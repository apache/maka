import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  isBundledNpmNodeVersionSupported,
  resolveBundledNpmDependencyProducer,
} from '../server/bundled-npm-dependency-producer.js';

test('admits only Node versions supported by the pinned npm runtime', () => {
  assert.equal(isBundledNpmNodeVersionSupported('22.22.1'), false);
  assert.equal(isBundledNpmNodeVersionSupported('22.22.2'), true);
  assert.equal(isBundledNpmNodeVersionSupported('23.99.0'), false);
  assert.equal(isBundledNpmNodeVersionSupported('24.14.9'), false);
  assert.equal(isBundledNpmNodeVersionSupported('24.15.0'), true);
  assert.equal(isBundledNpmNodeVersionSupported('25.0.0'), false);
  assert.equal(isBundledNpmNodeVersionSupported('26.0.0'), true);
  assert.equal(isBundledNpmNodeVersionSupported('invalid'), false);
});

test('runs the exact bundled npm runtime with scripts disabled', async (t) => {
  const fixture = await bundledNpmFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const producer = await resolveBundledNpmDependencyProducer({
    resourcesRoot: fixture.resourcesRoot,
    cacheRoot: fixture.cacheRoot,
    nodeExecutablePath: process.execPath,
  });
  assert.deepEqual(producer.nodeRuntime, {
    version: process.versions.node,
    abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  });
  const stagingRoot = join(fixture.root, 'staging');
  const outputRoot = join(stagingRoot, 'node_modules');
  await mkdir(outputRoot, { recursive: true });

  await producer.provision({
    identity: dependencyIdentity(),
    outputRoot,
    manifestBytes: Buffer.from('{"name":"fixture","packageManager":"npm@12.0.2"}\n'),
    lockfileBytes: Buffer.from('{"name":"fixture","lockfileVersion":3,"packages":{}}\n'),
  });

  assert.equal(await readFile(join(outputRoot, 'fixture-package', 'index.js'), 'utf8'), 'safe\n');
  const invocation = JSON.parse(
    await readFile(join(stagingRoot, 'invocation.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(invocation.ignoreScripts, true);
  assert.equal(invocation.audit, false);
  assert.equal(invocation.fund, false);
  assert.equal(invocation.registry, 'https://registry.npmjs.org/');
  assert.equal(invocation.userconfig, join(fixture.cacheRoot, 'home', 'npmrc'));
  assert.equal(invocation.globalconfig, join(fixture.cacheRoot, 'home', 'global-npmrc'));
});

test('revalidates the complete npm runtime before every provision', async (t) => {
  const fixture = await bundledNpmFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const producer = await resolveBundledNpmDependencyProducer({
    resourcesRoot: fixture.resourcesRoot,
    cacheRoot: fixture.cacheRoot,
    nodeExecutablePath: process.execPath,
  });
  await writeFile(fixture.cliPath, 'throw new Error("tampered");\n', 'utf8');
  const outputRoot = join(fixture.root, 'tampered-staging', 'node_modules');
  await mkdir(outputRoot, { recursive: true });

  await assert.rejects(
    producer.provision({
      identity: dependencyIdentity(),
      outputRoot,
      manifestBytes: Buffer.from('{"packageManager":"npm@12.0.2"}\n'),
      lockfileBytes: Buffer.from('{"lockfileVersion":3,"packages":{}}\n'),
    }),
    /integrity mismatch/u,
  );
});

test('rejects registry dependency entries without lockfile integrity evidence', async (t) => {
  const fixture = await bundledNpmFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const producer = await resolveBundledNpmDependencyProducer({
    resourcesRoot: fixture.resourcesRoot,
    cacheRoot: fixture.cacheRoot,
    nodeExecutablePath: process.execPath,
  });
  const outputRoot = join(fixture.root, 'unsafe-staging', 'node_modules');
  await mkdir(outputRoot, { recursive: true });

  await assert.rejects(
    producer.provision({
      identity: dependencyIdentity(),
      outputRoot,
      manifestBytes: Buffer.from('{"packageManager":"npm@12.0.2"}\n'),
      lockfileBytes: Buffer.from(
        '{"lockfileVersion":3,"packages":{"":{"name":"fixture"},"node_modules/pkg":{"version":"1.0.0","resolved":"https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"}}}\n',
      ),
    }),
    /unsafe dependency entry/u,
  );
});

function dependencyIdentity() {
  return {
    protocolVersion: 1 as const,
    environmentId: `sha256:${'1'.repeat(64)}` as const,
    manifestPath: 'package.json',
    manifestSha256: `sha256:${'2'.repeat(64)}` as const,
    lockfilePath: 'package-lock.json',
    lockfileSha256: `sha256:${'3'.repeat(64)}` as const,
    packageManagerName: 'npm' as const,
    packageManagerVersion: '12.0.2',
    nodeVersion: process.versions.node,
    nodeAbi: process.versions.modules ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
}

async function bundledNpmFixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-bundled-npm-producer-'));
  const resourcesRoot = join(root, 'resources');
  const npmRoot = join(resourcesRoot, 'npm');
  const cliPath = join(npmRoot, 'bin', 'npm-cli.js');
  const cacheRoot = join(root, 'cache');
  await mkdir(join(npmRoot, 'bin'), { recursive: true });
  await writeFile(join(npmRoot, 'LICENSE'), 'Artistic-2.0 fixture\n');
  await writeFile(
    join(npmRoot, 'package.json'),
    '{"name":"npm","version":"12.0.2","license":"Artistic-2.0"}\n',
  );
  await writeFile(
    cliPath,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      'const root = process.cwd();',
      "fs.mkdirSync(path.join(root, 'node_modules', 'fixture-package'), { recursive: true });",
      "fs.writeFileSync(path.join(root, 'node_modules', 'fixture-package', 'index.js'), 'safe\\n');",
      "fs.writeFileSync(path.join(root, 'invocation.json'), JSON.stringify({",
      "  ignoreScripts: args.includes('--ignore-scripts'),",
      "  audit: !args.includes('--no-audit'),",
      "  fund: !args.includes('--no-fund'),",
      '  registry: process.env.npm_config_registry,',
      '  userconfig: process.env.npm_config_userconfig,',
      '  globalconfig: process.env.npm_config_globalconfig,',
      '}));',
    ].join('\n'),
    'utf8',
  );
  const files = await Promise.all(
    ['LICENSE', 'bin/npm-cli.js', 'package.json'].map(async (path) => {
      const bytes = await readFile(join(npmRoot, ...path.split('/')));
      return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
    }),
  );
  const identity = JSON.stringify({
    protocol: 'maka_bundled_npm_runtime_identity_v1',
    npmVersion: '12.0.2',
    platform: process.platform,
    arch: process.arch,
    securityPatches: [
      {
        packageName: 'tar',
        fromVersion: '7.5.19',
        toVersion: '7.5.22',
        advisory: 'GHSA-r292-9mhp-454m',
      },
    ],
    files,
  });
  await writeFile(
    join(resourcesRoot, 'bundled-npm.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      protocol: 'maka_bundled_npm_runtime_v1',
      provider: 'desktop/npm-cli',
      npmVersion: '12.0.2',
      platform: process.platform,
      arch: process.arch,
      securityPatches: [
        {
          packageName: 'tar',
          fromVersion: '7.5.19',
          toVersion: '7.5.22',
          advisory: 'GHSA-r292-9mhp-454m',
        },
      ],
      runtimeRootRelativePath: 'npm',
      cliRelativePath: 'npm/bin/npm-cli.js',
      files,
      runtimeIdentitySha256: sha256(Buffer.from(identity)),
      distributionReady: true,
    })}\n`,
  );
  return { root, resourcesRoot, cacheRoot, cliPath };
}

function sha256(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
