import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openManagedWorkspaceOwner } from '@maka/storage/managed-workspace-owner';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { resolveBundledNpmRuntime } from '../server/bundled-npm-runtime.js';
import { createManagedNpmDependencyEnvironmentProducer } from '../server/managed-npm-dependency-producer.js';
import { createManagedWorkspaceInspectionTool } from '../server/managed-workspace-inspection-tool.js';
import { createRuntimeHostWorkspaceExecutionComposition } from '../server/workspace-execution-composition.js';

const execFileAsync = promisify(execFile);
const crashChildEntrypoint = fileURLToPath(
  new URL('./fixtures/managed-workspace-inspection-crash-child.js', import.meta.url),
);

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
    const tool = createManagedWorkspaceInspectionTool(composition);

    const result = await tool.impl(
      { kind: 'read', path: 'node_modules/semver/package.json' },
      {
        sessionId: 'session_11111111111111111111111111111111',
        turnId: 'turn_22222222222222222222222222222222',
        toolCallId: 'call_33333333333333333333333333333333',
        cwd: sourceRoot,
        abortSignal: new AbortController().signal,
        emitOutput() {},
      },
    );
    assert.equal(result.kind, 'managed_workspace_inspection_v1');
    assert.equal(result.result.kind, 'read');
    if (result.result.kind !== 'read') throw new Error('Expected managed Read result');
    assert.equal(JSON.parse(result.result.content).version, '7.7.3');
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

test('replays one managed inspection after a real Host crash at durable dependency receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-inspection-crash-'));
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createSource(join(root, 'source'));
  const resourcesRoot = await createNpmFixture(join(root, 'resources'));
  let rootOwner: Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>;
  let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
  let composition: ReturnType<typeof createRuntimeHostWorkspaceExecutionComposition> | undefined;
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [crashChildEntrypoint], {
        env: {
          ...process.env,
          MAKA_MANAGED_INSPECTION_CRASH_STORAGE_ROOT: storageRoot,
          MAKA_MANAGED_INSPECTION_CRASH_SOURCE_ROOT: sourceRoot,
          MAKA_MANAGED_INSPECTION_CRASH_RESOURCES_ROOT: resourcesRoot,
        },
        windowsHide: true,
      }),
      (error: unknown) => error instanceof Error && 'code' in error && Number(error.code) === 73,
    );

    const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
    rootOwner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(rootOwner);
    stores = await openInteractiveExecutionStoresForWrite(rootOwner.lease);
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
          return { kind: 'read', content: await readFile(input.operation.path, 'utf8') };
        },
      },
    });
    composition = createRuntimeHostWorkspaceExecutionComposition({
      managedOwner: owner,
      executionStores: stores,
    });
    const result = await createManagedWorkspaceInspectionTool(composition).impl(
      { kind: 'read', path: 'node_modules/semver/package.json' },
      {
        sessionId: 'session_11111111111111111111111111111111',
        turnId: 'turn_22222222222222222222222222222222',
        toolCallId: 'call_33333333333333333333333333333333',
        cwd: sourceRoot,
        abortSignal: new AbortController().signal,
        emitOutput() {},
      },
    );

    assert.equal(result.kind, 'managed_workspace_inspection_v1');
    assert.equal(result.result.kind, 'read');
    if (result.result.kind !== 'read') throw new Error('Expected managed Read result');
    assert.equal(JSON.parse(result.result.content).version, '7.7.3');
    const dependencyRoot = join(storageRoot, 'managed-workspaces', 'dependency-environments');
    assert.deepEqual(await readdir(join(dependencyRoot, '.staging')), []);
    assert.equal(
      (await readdir(dependencyRoot, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory() && entry.name !== '.staging',
      ).length,
      1,
    );
    assert.equal(await countFilesNamed(join(storageRoot, 'managed-workspaces'), 'binding.json'), 1);
    assert.equal(
      await countFilesNamed(join(storageRoot, 'managed-workspaces'), 'baseline-receipt.json'),
      1,
    );
    const binNames = await findDirectoryEntriesNamed(dependencyRoot, '.bin');
    assert.equal(binNames.length, 1);
    assert.ok(
      (await readdir(binNames[0])).some((name) =>
        process.platform === 'win32' ? name === 'semver.cmd' : name === 'semver',
      ),
    );
  } finally {
    composition?.beginDrain();
    await composition?.close().catch(() => undefined);
    await stores?.sessionStore.close?.();
    await rootOwner?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function countFilesNamed(root: string, expectedName: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) count += await countFilesNamed(path, expectedName);
    else if (entry.isFile() && entry.name === expectedName) count += 1;
  }
  return count;
}

async function findDirectoryEntriesNamed(root: string, expectedName: string): Promise<string[]> {
  const matches: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === expectedName) matches.push(path);
    else matches.push(...(await findDirectoryEntriesNamed(path, expectedName)));
  }
  return matches;
}

async function createSource(sourceRoot: string): Promise<string> {
  await mkdir(sourceRoot, { recursive: true });
  await git(sourceRoot, 'init', '--quiet');
  await Promise.all([
    writeFile(
      join(sourceRoot, 'package.json'),
      `${JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        private: true,
        packageManager: 'npm@12.0.2',
        dependencies: { semver: '7.7.3' },
      })}\n`,
    ),
    writeFile(
      join(sourceRoot, 'package-lock.json'),
      `${JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'fixture',
            version: '1.0.0',
            dependencies: { semver: '7.7.3' },
          },
          'node_modules/semver': {
            version: '7.7.3',
            resolved: 'https://registry.npmjs.org/semver/-/semver-7.7.3.tgz',
            integrity:
              'sha512-SdsKMrI9TdgjdweUSR9MweHA4EJ8YxHn8DFaDisvhVlUOe4BF1tLD7GAj0lIqWVl+dPb/rExr0Btby5loQm20Q==',
            bin: { semver: 'bin/semver.js' },
          },
        },
      })}\n`,
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
  const attached = join(sourceRoot, 'node_modules', 'semver');
  await mkdir(attached, { recursive: true });
  await writeFile(join(attached, 'package.json'), '{"name":"semver","version":"0.0.0-attached"}\n');
  return await realpath(sourceRoot);
}

async function createNpmFixture(resourcesRoot: string): Promise<string> {
  const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const patchedPackagesRoot = join(resourcesRoot, '.patched-inputs');
  await mkdir(patchedPackagesRoot, { recursive: true });
  for (const packageName of ['tar', 'brace-expansion', 'ip-address', 'undici']) {
    await cp(
      await realpath(join(repositoryRoot, 'node_modules', packageName)),
      join(patchedPackagesRoot, packageName),
      { recursive: true },
    );
  }
  const preparationModule = (await import(
    pathToFileURL(join(repositoryRoot, 'scripts', 'prepare-bundled-npm.mjs')).href
  )) as {
    prepareBundledNpm(input: Record<string, unknown>): Promise<unknown>;
  };
  try {
    await preparationModule.prepareBundledNpm({
      sourceNpmRoot: await realpath(join(repositoryRoot, 'node_modules', 'npm')),
      patchedPackagesRoot,
      runtimeOutputRoot: join(resourcesRoot, 'npm'),
      outputPath: join(resourcesRoot, 'bundled-npm.json'),
      auditRoot: join(resourcesRoot, 'audit'),
      sourceLockPath: join(repositoryRoot, 'package-lock.json'),
      platform: process.platform,
      arch: process.arch,
    });
  } finally {
    await rm(patchedPackagesRoot, { recursive: true, force: true });
  }
  return resourcesRoot;
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

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
}
