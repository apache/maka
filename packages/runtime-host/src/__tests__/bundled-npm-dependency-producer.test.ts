import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    nodeExecutablePath: fixture.nodeExecutablePath,
  });
  assert.deepEqual(producer.nodeRuntime, {
    version: process.versions.node,
    abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  });
  assert.equal(producer.capability.kind, 'hermetic_dependency_builder_v1');
  assert.match(producer.capability.runtimeIdentitySha256, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(producer.capability.runtimeIdentitySha256, fixture.runtimeIdentitySha256);
  assert.equal(producer.capability.network, 'registry_https_only');
  assert.equal(producer.capability.filesystem, 'maka_owned_staging_only');
  assert.equal(producer.capability.secrets, 'none');
  assert.equal(producer.capability.childProcess, 'verified_runtime_only');
  const stagingRoot = join(fixture.root, 'staging');
  const outputRoot = join(stagingRoot, 'node_modules');
  await createProducerStaging(stagingRoot);

  await producer.provision({
    identity: dependencyIdentity(),
    outputRoot,
    scratchRoot: join(stagingRoot, '.maka-runtime'),
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
  assert.equal(invocation.userconfig, join(stagingRoot, '.maka-runtime', 'home', 'npmrc'));
  assert.equal(invocation.globalconfig, join(stagingRoot, '.maka-runtime', 'home', 'global-npmrc'));
  assert.equal(invocation.temp, join(stagingRoot, '.maka-runtime', 'temp'));
  assert.equal(invocation.compileCache, join(stagingRoot, '.maka-runtime', 'node-compile-cache'));
});

test('revalidates the complete npm runtime before every provision', async (t) => {
  const fixture = await bundledNpmFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const producer = await resolveBundledNpmDependencyProducer({
    resourcesRoot: fixture.resourcesRoot,
    nodeExecutablePath: fixture.nodeExecutablePath,
  });
  await writeFile(fixture.cliPath, 'throw new Error("tampered");\n', 'utf8');
  const outputRoot = join(fixture.root, 'tampered-staging', 'node_modules');
  await createProducerStaging(dirname(outputRoot));

  await assert.rejects(
    producer.provision({
      identity: dependencyIdentity(),
      outputRoot,
      scratchRoot: join(dirname(outputRoot), '.maka-runtime'),
      manifestBytes: Buffer.from('{"packageManager":"npm@12.0.2"}\n'),
      lockfileBytes: Buffer.from('{"lockfileVersion":3,"packages":{}}\n'),
    }),
    /integrity mismatch/u,
  );
});

test('rejects Node runtime drift before provisioning', async (t) => {
  const fixture = await bundledNpmFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const producer = await resolveBundledNpmDependencyProducer({
    resourcesRoot: fixture.resourcesRoot,
    nodeExecutablePath: fixture.nodeExecutablePath,
  });
  await writeFile(fixture.nodeExecutablePath, 'tampered node runtime\n', 'utf8');
  const outputRoot = join(fixture.root, 'node-tampered-staging', 'node_modules');
  await createProducerStaging(dirname(outputRoot));

  await assert.rejects(
    producer.provision({
      identity: dependencyIdentity(),
      outputRoot,
      scratchRoot: join(dirname(outputRoot), '.maka-runtime'),
      manifestBytes: Buffer.from('{"packageManager":"npm@12.0.2"}\n'),
      lockfileBytes: Buffer.from('{"lockfileVersion":3,"packages":{}}\n'),
    }),
    /Node runtime integrity mismatch/u,
  );
});

test('rejects registry dependency entries without lockfile integrity evidence', async (t) => {
  const fixture = await bundledNpmFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const producer = await resolveBundledNpmDependencyProducer({
    resourcesRoot: fixture.resourcesRoot,
    nodeExecutablePath: fixture.nodeExecutablePath,
  });
  const outputRoot = join(fixture.root, 'unsafe-staging', 'node_modules');
  await createProducerStaging(dirname(outputRoot));

  await assert.rejects(
    producer.provision({
      identity: dependencyIdentity(),
      outputRoot,
      scratchRoot: join(dirname(outputRoot), '.maka-runtime'),
      manifestBytes: Buffer.from('{"packageManager":"npm@12.0.2"}\n'),
      lockfileBytes: Buffer.from(
        '{"lockfileVersion":3,"packages":{"":{"name":"fixture"},"node_modules/pkg":{"version":"1.0.0","resolved":"https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"}}}\n',
      ),
    }),
    /unsafe dependency entry/u,
  );
});

test('aborts the owned npm process and keeps temp state inside staging', async (t) => {
  const fixture = await bundledNpmFixture('slow');
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const producer = await resolveBundledNpmDependencyProducer({
    resourcesRoot: fixture.resourcesRoot,
    nodeExecutablePath: fixture.nodeExecutablePath,
  });
  const projectRoot = join(fixture.root, 'abort-staging');
  const outputRoot = join(projectRoot, 'node_modules');
  const scratchRoot = join(projectRoot, '.maka-runtime');
  await createProducerStaging(projectRoot);
  const controller = new AbortController();
  const task = producer.provision({
    identity: dependencyIdentity(),
    outputRoot,
    scratchRoot,
    manifestBytes: Buffer.from('{"name":"fixture","packageManager":"npm@12.0.2"}\n'),
    lockfileBytes: Buffer.from('{"name":"fixture","lockfileVersion":3,"packages":{}}\n'),
    abortSignal: controller.signal,
  });
  await waitForFile(join(projectRoot, 'started'));
  controller.abort();
  await assert.rejects(task, /aborted/u);
  assert.equal(await readFile(join(projectRoot, 'temp-path'), 'utf8'), join(scratchRoot, 'temp'));
});

test('kills provisioning when the staging tree exceeds its configured quota', async (t) => {
  const fixture = await bundledNpmFixture('large');
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const producer = await resolveBundledNpmDependencyProducer({
    resourcesRoot: fixture.resourcesRoot,
    nodeExecutablePath: fixture.nodeExecutablePath,
    maxProvisionBytes: 1024,
  });
  const projectRoot = join(fixture.root, 'quota-staging');
  const outputRoot = join(projectRoot, 'node_modules');
  await createProducerStaging(projectRoot);
  await assert.rejects(
    producer.provision({
      identity: dependencyIdentity(),
      outputRoot,
      scratchRoot: join(projectRoot, '.maka-runtime'),
      manifestBytes: Buffer.from('{"name":"fixture","packageManager":"npm@12.0.2"}\n'),
      lockfileBytes: Buffer.from('{"name":"fixture","lockfileVersion":3,"packages":{}}\n'),
    }),
    /filesystem quota/u,
  );
});

test('counts empty files toward the provisioning entry quota', async (t) => {
  const fixture = await bundledNpmFixture('many');
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const producer = await resolveBundledNpmDependencyProducer({
    resourcesRoot: fixture.resourcesRoot,
    nodeExecutablePath: fixture.nodeExecutablePath,
    maxProvisionEntries: 20,
  });
  const projectRoot = join(fixture.root, 'entry-quota-staging');
  await createProducerStaging(projectRoot);
  await assert.rejects(
    producer.provision({
      identity: dependencyIdentity(),
      outputRoot: join(projectRoot, 'node_modules'),
      scratchRoot: join(projectRoot, '.maka-runtime'),
      manifestBytes: Buffer.from('{"name":"fixture","packageManager":"npm@12.0.2"}\n'),
      lockfileBytes: Buffer.from('{"name":"fixture","lockfileVersion":3,"packages":{}}\n'),
    }),
    /filesystem quota/u,
  );
});

test('rejects a pre-positioned scratch symlink or junction before npm starts', async (t) => {
  const fixture = await bundledNpmFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const producer = await resolveBundledNpmDependencyProducer({
    resourcesRoot: fixture.resourcesRoot,
    nodeExecutablePath: fixture.nodeExecutablePath,
  });
  const projectRoot = join(fixture.root, 'redirected-staging');
  const scratchRoot = join(projectRoot, '.maka-runtime');
  const outsideRoot = join(fixture.root, 'outside');
  await Promise.all([
    mkdir(join(projectRoot, 'node_modules'), { recursive: true }),
    mkdir(scratchRoot, { recursive: true }),
    mkdir(outsideRoot, { recursive: true }),
  ]);
  await symlink(
    outsideRoot,
    join(scratchRoot, 'home'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  await assert.rejects(
    producer.provision({
      identity: dependencyIdentity(),
      outputRoot: join(projectRoot, 'node_modules'),
      scratchRoot,
      manifestBytes: Buffer.from('{"name":"fixture","packageManager":"npm@12.0.2"}\n'),
      lockfileBytes: Buffer.from('{"name":"fixture","lockfileVersion":3,"packages":{}}\n'),
    }),
    /scratch entry was not created by this provision/u,
  );
  await assert.rejects(readFile(join(outsideRoot, 'npmrc'), 'utf8'), { code: 'ENOENT' });
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
    producerRuntimeIdentitySha256: `sha256:${'4'.repeat(64)}` as const,
    producerPolicyIdentitySha256: `sha256:${'5'.repeat(64)}` as const,
    policyVersion: 'managed_dependency_environment_v1' as const,
  };
}

async function createProducerStaging(projectRoot: string): Promise<void> {
  await Promise.all([
    mkdir(join(projectRoot, 'node_modules'), { recursive: true }),
    mkdir(join(projectRoot, '.maka-runtime'), { recursive: true }),
  ]);
}

async function bundledNpmFixture(mode: 'normal' | 'slow' | 'large' | 'many' = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'maka-bundled-npm-producer-'));
  const resourcesRoot = join(root, 'resources');
  const npmRoot = join(resourcesRoot, 'npm');
  const cliPath = join(npmRoot, 'bin', 'npm-cli.js');
  const cacheRoot = join(root, 'cache');
  const nodeExecutablePath = join(root, process.platform === 'win32' ? 'node.exe' : 'node');
  await copyFile(process.execPath, nodeExecutablePath);
  if (process.platform !== 'win32') await chmod(nodeExecutablePath, 0o755);
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
      ...(mode === 'slow'
        ? [
            "fs.writeFileSync(path.join(root, 'started'), '1');",
            "fs.writeFileSync(path.join(root, 'temp-path'), process.env.TEMP || process.env.TMPDIR);",
            'setInterval(() => {}, 1000);',
          ]
        : []),
      ...(mode === 'large'
        ? [
            "fs.writeFileSync(path.join(root, 'oversized'), Buffer.alloc(4096));",
            'setInterval(() => {}, 1000);',
          ]
        : []),
      ...(mode === 'many'
        ? [
            "const many = path.join(root, 'many-empty-files');",
            'fs.mkdirSync(many, { recursive: true });',
            "for (let index = 0; index < 100; index += 1) fs.writeFileSync(path.join(many, String(index)), '');",
            'setInterval(() => {}, 1000);',
          ]
        : []),
      "fs.mkdirSync(path.join(root, 'node_modules', 'fixture-package'), { recursive: true });",
      "fs.writeFileSync(path.join(root, 'node_modules', 'fixture-package', 'index.js'), 'safe\\n');",
      "fs.writeFileSync(path.join(root, 'invocation.json'), JSON.stringify({",
      "  ignoreScripts: args.includes('--ignore-scripts'),",
      "  audit: !args.includes('--no-audit'),",
      "  fund: !args.includes('--no-fund'),",
      '  registry: process.env.npm_config_registry,',
      '  userconfig: process.env.npm_config_userconfig,',
      '  globalconfig: process.env.npm_config_globalconfig,',
      '  temp: process.env.TEMP || process.env.TMPDIR,',
      '  compileCache: process.env.NODE_COMPILE_CACHE,',
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
    securityPatches: securityPatches(),
    files,
  });
  const runtimeIdentitySha256 = sha256(Buffer.from(identity));
  await writeFile(
    join(resourcesRoot, 'bundled-npm.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      protocol: 'maka_bundled_npm_runtime_v1',
      provider: 'desktop/npm-cli',
      npmVersion: '12.0.2',
      platform: process.platform,
      arch: process.arch,
      securityPatches: securityPatches(),
      runtimeRootRelativePath: 'npm',
      cliRelativePath: 'npm/bin/npm-cli.js',
      files,
      runtimeIdentitySha256,
      distributionReady: true,
    })}\n`,
  );
  return {
    root,
    resourcesRoot,
    cacheRoot,
    cliPath,
    nodeExecutablePath,
    runtimeIdentitySha256,
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function securityPatches() {
  return [
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
  ];
}

function sha256(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
