import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openManagedWorkspaceOwner } from '@maka/storage/managed-workspace-owner';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { resolveBundledNpmRuntime } from '../server/bundled-npm-runtime.js';
import { createManagedNpmDependencyEnvironmentProducer } from '../server/managed-npm-dependency-producer.js';
import { createRuntimeHostWorkspaceExecutionComposition } from '../server/workspace-execution-composition.js';

const execFileAsync = promisify(execFile);

test('production composition acquires, reads, and drains an attested dependency environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-dependency-composition-'));
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createSource(join(root, 'source'));
  const resourcesRoot = await createNpmFixture(join(root, 'resources'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
  let composition: ReturnType<typeof createRuntimeHostWorkspaceExecutionComposition> | undefined;
  try {
    const gitExecutable = await findGitExecutable();
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutable,
        expectedSha256: await sha256File(gitExecutable),
      },
      dependencyEnvironmentProducer: createManagedNpmDependencyEnvironmentProducer(
        await resolveBundledNpmRuntime({ resourcesRoot }),
      ),
      filesystemWorker: {
        async execute(input) {
          assert.equal(input.operation.kind, 'read');
          assert.equal(input.operation.path.startsWith(sourceRoot), false);
          return { kind: 'read', content: await readFile(input.operation.path, 'utf8') };
        },
      },
    });
    composition = createRuntimeHostWorkspaceExecutionComposition({
      managedOwner: owner,
      executionStores: stores,
    });
    const profile = await composition.openManagedWorkspace(
      {
        repositoryId: 'repository_11111111111111111111111111111111',
        workspaceId: 'workspace_22222222222222222222222222222222',
        workspaceEpochId: 'epoch_33333333333333333333333333333333',
        workspaceInstanceId: 'instance_44444444444444444444444444444444',
        sourceRoot,
      },
      { provisioning: 'dependency_environment_v1' },
    );

    assert.deepEqual(
      await composition.executeReadOnly(profile, {
        kind: 'read',
        path: 'node_modules/fixture-package/index.js',
      }),
      { kind: 'read', content: 'module.exports = "maka-owned";\n' },
    );
    composition.beginDrain();
    await composition.close();
    assert.equal(composition.state, 'closed');
  } finally {
    await composition?.close().catch(() => undefined);
    await stores.sessionStore.close?.();
    await rootOwner.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function createSource(sourceRoot: string): Promise<string> {
  await mkdir(sourceRoot, { recursive: true });
  await git(sourceRoot, 'init', '--quiet');
  await Promise.all([
    writeFile(
      join(sourceRoot, 'package.json'),
      '{"name":"fixture","version":"1.0.0","packageManager":"npm@12.0.2"}\n',
    ),
    writeFile(
      join(sourceRoot, 'package-lock.json'),
      '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n',
    ),
    writeFile(join(sourceRoot, '.gitignore'), 'node_modules/\n.maka-workspace.json\n'),
  ]);
  await git(sourceRoot, 'add', 'package.json', 'package-lock.json', '.gitignore');
  await git(
    sourceRoot,
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=test@maka.invalid',
    'commit',
    '--quiet',
    '-m',
    'dependency baseline',
  );
  const attached = join(sourceRoot, 'node_modules', 'fixture-package');
  await mkdir(attached, { recursive: true });
  await writeFile(join(attached, 'index.js'), 'module.exports = "attached";\n');
  return await realpath(sourceRoot);
}

async function createNpmFixture(resourcesRoot: string): Promise<string> {
  const npmRoot = join(resourcesRoot, 'npm');
  const cli = Buffer.from(
    "const fs=require('node:fs');fs.mkdirSync('node_modules/fixture-package',{recursive:true});fs.writeFileSync('node_modules/fixture-package/index.js','module.exports = \\\"maka-owned\\\";\\n');\n",
  );
  const packageJson = Buffer.from('{"name":"npm","version":"12.0.2","license":"Artistic-2.0"}\n');
  const license = Buffer.from('Artistic License fixture\n');
  await mkdir(join(npmRoot, 'bin'), { recursive: true });
  await Promise.all([
    writeFile(join(npmRoot, 'bin', 'npm-cli.js'), cli),
    writeFile(join(npmRoot, 'package.json'), packageJson),
    writeFile(join(npmRoot, 'LICENSE'), license),
  ]);
  await writeFile(
    join(resourcesRoot, 'bundled-npm.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      protocol: 'maka_bundled_npm_runtime_v1',
      provider: 'desktop/npm-cli',
      npmVersion: '12.0.2',
      platform: process.platform,
      arch: process.arch,
      runtimeRootRelativePath: 'npm',
      cliRelativePath: 'npm/bin/npm-cli.js',
      securityPatches: approvedSecurityPatches,
      files: [
        manifestFile('LICENSE', license),
        manifestFile('bin/npm-cli.js', cli),
        manifestFile('package.json', packageJson),
      ],
      distributionReady: true,
    })}\n`,
  );
  return resourcesRoot;
}

function manifestFile(path: string, bytes: Buffer) {
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function findGitExecutable(): Promise<string> {
  const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [
    'git',
  ]);
  const first = stdout
    .split(/\r?\n/u)
    .find((line) => line.trim())
    ?.trim();
  if (!first) throw new Error('Git executable is unavailable');
  return await realpath(first);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function sha256(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
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
