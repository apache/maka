import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  assertNoDanglingSymlinks,
  assertOfficialNodeArchive,
  collectPackagedProductionDependencies,
  collectWorkspaceDependencyClosure,
  dependencyPatchPackageName,
  inspectNativeArtifacts,
  isMacosArm64MachO,
  listApplicableDependencyPatchNames,
  macosArm64CliWrapper,
} from './package-macos-arm64-cli.mjs';
import { releaseToolchainFromManifest, resolveReleaseIdentity } from './release-identity.mjs';
import {
  assertCliThirdPartyNotices,
  assertExpectedTuiExit,
  assertSafeCliArchiveEntries,
  isTuiReadyOutput,
  resolvePackagedRuntimeModelFactory,
} from './verify-macos-arm64-cli.mjs';

const execFileAsync = promisify(execFile);

const rootManifest = {
  version: '1.2.3',
  packageManager: 'npm@11.12.1',
  releaseToolchain: {
    node: '24.18.1',
    nodeDarwinArm64Archive: 'node-v24.18.1-darwin-arm64.tar.xz',
    nodeDarwinArm64Sha256: '1'.repeat(64),
  },
};
const desktopManifest = { version: '1.2.3' };
const cliManifest = { version: '1.2.3', bin: { maka: './dist/cli.js' } };

test('release identity is rooted in one version, command, tag, and source commit', () => {
  const identity = resolveReleaseIdentity({
    rootManifest,
    desktopManifest,
    cliManifest,
    ref: 'refs/heads/main',
    sha: 'a'.repeat(40),
  });
  assert.equal(identity.version, '1.2.3');
  assert.equal(identity.tag, 'v1.2.3');
  assert.equal(identity.cliArchive, 'apps/desktop/release/Maka-1.2.3-cli-mac-arm64.zip');
  assert.equal(
    identity.nodeSourceUrl,
    'https://nodejs.org/download/release/v24.18.1/node-v24.18.1-darwin-arm64.tar.xz',
  );
});

test('release identity fails before packaging on version, command, ref, or SHA drift', () => {
  const resolve = (overrides = {}) =>
    resolveReleaseIdentity({
      rootManifest,
      desktopManifest,
      cliManifest,
      ref: 'refs/heads/main',
      sha: 'a'.repeat(40),
      ...overrides,
    });
  assert.throws(() => resolve({ desktopManifest: { version: '1.2.4' } }), /Desktop version/);
  assert.throws(
    () =>
      resolve({
        cliManifest: {
          ...cliManifest,
          bin: { maka: './dist/cli.js', 'maka-agent': './dist/cli.js' },
        },
      }),
    /only public CLI command/,
  );
  assert.throws(() => resolve({ ref: 'refs/heads/feature' }), /refs\/heads\/main/);
  assert.throws(() => resolve({ sha: 'not-a-sha' }), /40-character/);
});

test('release toolchain pins the official archive and npm independently', () => {
  assert.deepEqual(releaseToolchainFromManifest(rootManifest), {
    nodeArchive: 'node-v24.18.1-darwin-arm64.tar.xz',
    nodeArchiveSha256: '1'.repeat(64),
    nodeSourceUrl: 'https://nodejs.org/download/release/v24.18.1/node-v24.18.1-darwin-arm64.tar.xz',
    nodeVersion: '24.18.1',
    npmVersion: '11.12.1',
  });
  assert.throws(
    () => releaseToolchainFromManifest({ ...rootManifest, packageManager: 'npm@latest' }),
    /exact npm version/,
  );
  assert.throws(
    () =>
      releaseToolchainFromManifest({
        ...rootManifest,
        releaseToolchain: { ...rootManifest.releaseToolchain, nodeDarwinArm64Sha256: 'bad' },
      }),
    /exact SHA-256/,
  );
});

test('workspace closure follows manifests and rejects missing local packages', () => {
  const manifests = new Map([
    ['maka-agent', { dependencies: { '@maka/core': '0.1.0', thirdParty: '1.0.0' } }],
    ['@maka/core', { dependencies: { '@maka/storage': '0.1.0' } }],
    ['@maka/storage', { dependencies: {} }],
    ['@maka/unrelated', { dependencies: {} }],
  ]);
  assert.deepEqual(collectWorkspaceDependencyClosure('maka-agent', manifests), [
    '@maka/core',
    '@maka/storage',
    'maka-agent',
  ]);
  manifests.get('@maka/core').dependencies['@maka/missing'] = '0.1.0';
  assert.throws(
    () => collectWorkspaceDependencyClosure('maka-agent', manifests),
    /not in workspaces/,
  );
});

test('the only launcher remains relocatable through an external symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-release-launcher-'));
  try {
    const archiveRoot = join(root, 'Maka-1.2.3-cli-mac-arm64');
    const binDirectory = join(archiveRoot, 'bin');
    const nodeDirectory = join(archiveRoot, 'libexec', 'node', 'bin');
    const externalDirectory = join(root, 'external');
    await Promise.all([
      mkdir(binDirectory, { recursive: true }),
      mkdir(nodeDirectory, { recursive: true }),
      mkdir(externalDirectory),
    ]);
    const launcher = join(binDirectory, 'maka');
    const fakeNode = join(nodeDirectory, 'node');
    await Promise.all([
      writeFile(launcher, macosArm64CliWrapper(), 'utf8'),
      writeFile(fakeNode, '#!/bin/sh\nprintf "%s\\n" "$1|$2"\n', 'utf8'),
    ]);
    await Promise.all([chmod(launcher, 0o755), chmod(fakeNode, 0o755)]);
    const externalLauncher = join(externalDirectory, 'maka');
    await symlink(launcher, externalLauncher);
    const result = await execFileAsync(externalLauncher, ['--version']);
    assert.match(
      result.stdout.trim(),
      /Maka-1\.2\.3-cli-mac-arm64\/bin\/\.\.\/libexec\/node_modules\/maka-agent\/dist\/cli\.js\|--version$/,
    );
    assert.doesNotMatch(result.stdout, /external\/\.\.\/libexec/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact symlinks must resolve inside the artifact and cannot dangle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-release-symlinks-'));
  const outside = await mkdtemp(join(tmpdir(), 'maka-release-outside-'));
  try {
    await mkdir(join(root, 'target'));
    await symlink('target', join(root, 'valid'));
    await assertNoDanglingSymlinks(root);
    await symlink(outside, join(root, 'escape'));
    await assert.rejects(assertNoDanglingSymlinks(root), /escapes the CLI artifact/);
    await rm(join(root, 'escape'));
    await symlink('missing', join(root, 'dangling'));
    await assert.rejects(assertNoDanglingSymlinks(root), /Dangling symlink/);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test('streaming smoke test resolves the exported runtime model-factory subpath', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-release-runtime-'));
  try {
    const cliRoot = join(root, 'libexec', 'node_modules', 'maka-agent');
    const runtimeRoot = join(root, 'libexec', 'node_modules', '@maka', 'runtime');
    await mkdir(join(runtimeRoot, 'dist'), { recursive: true });
    await mkdir(cliRoot, { recursive: true });
    await writeFile(join(cliRoot, 'package.json'), '{}\n');
    await writeFile(
      join(runtimeRoot, 'package.json'),
      `${JSON.stringify({
        name: '@maka/runtime',
        type: 'module',
        exports: { './model-factory': './dist/model-factory.js' },
      })}\n`,
    );
    await writeFile(
      join(runtimeRoot, 'dist', 'model-factory.js'),
      'export const getAIModel = () => {};\n',
    );

    assert.equal(
      resolvePackagedRuntimeModelFactory(root),
      await realpath(join(runtimeRoot, 'dist', 'model-factory.js')),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Node provenance and CLI notices are bound to exact digests and closures', async () => {
  await assert.doesNotReject(
    assertOfficialNodeArchive(
      '/tmp/node-v24.18.1-darwin-arm64.tar.xz',
      {
        nodeArchive: 'node-v24.18.1-darwin-arm64.tar.xz',
        nodeArchiveSha256: 'a'.repeat(64),
      },
      { hashFile: async () => 'a'.repeat(64) },
    ),
  );
  await assert.rejects(
    assertOfficialNodeArchive(
      '/tmp/node-v24.18.1-darwin-arm64.tar.xz',
      {
        nodeArchive: 'node-v24.18.1-darwin-arm64.tar.xz',
        nodeArchiveSha256: 'a'.repeat(64),
      },
      { hashFile: async () => 'b'.repeat(64) },
    ),
    /digest mismatch/,
  );
  const notice = 'Package: alpha@1.0.0\n\nPackage: beta@2.0.0\n';
  assert.doesNotThrow(() =>
    assertCliThirdPartyNotices(
      notice,
      { productionDependencies: ['alpha@1.0.0', 'beta@2.0.0'], thirdPartyNoticesSha256: 'digest' },
      'digest',
    ),
  );
  assert.throws(
    () =>
      assertCliThirdPartyNotices(
        notice,
        { productionDependencies: ['alpha@1.0.0'], thirdPartyNoticesSha256: 'digest' },
        'digest',
      ),
    /packaged production closure/,
  );
});

test('packaged dependency metadata follows manifests actually present on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-release-packages-'));
  try {
    await Promise.all([
      mkdir(join(root, 'alpha'), { recursive: true }),
      mkdir(join(root, '@scope', 'beta', 'node_modules', 'nested'), { recursive: true }),
      mkdir(join(root, 'maka-agent'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, 'alpha', 'package.json'), '{"name":"alpha","version":"1.0.0"}'),
      writeFile(
        join(root, '@scope', 'beta', 'package.json'),
        '{"name":"@scope/beta","version":"2.0.0"}',
      ),
      writeFile(
        join(root, '@scope', 'beta', 'node_modules', 'nested', 'package.json'),
        '{"name":"nested","version":"3.0.0"}',
      ),
      writeFile(
        join(root, 'maka-agent', 'package.json'),
        '{"name":"maka-agent","version":"1.2.3"}',
      ),
      writeFile(join(root, '.package-lock.json'), '{}'),
    ]);
    assert.deepEqual(await collectPackagedProductionDependencies(root, new Set(['maka-agent'])), [
      '@scope/beta@2.0.0',
      'alpha@1.0.0',
      'nested@3.0.0',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dependency patches are derived from packages present in the CLI closure', async () => {
  assert.equal(
    await dependencyPatchPackageName('@ai-sdk+provider-utils+5.0.25.patch'),
    '@ai-sdk/provider-utils',
  );
  assert.equal(
    await dependencyPatchPackageName('@astryxdesign+core+0.4.0.patch'),
    '@astryxdesign/core',
  );
  const root = await mkdtemp(join(tmpdir(), 'maka-release-patches-'));
  try {
    await mkdir(join(root, '@ai-sdk', 'provider-utils'), { recursive: true });
    assert.deepEqual(await listApplicableDependencyPatchNames(root), [
      '@ai-sdk+provider-utils+5.0.25.patch',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native artifact inspection discovers Mach-O and foreign payloads by content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-release-native-'));
  try {
    await Promise.all([
      writeFile(join(root, 'arm.node'), ''),
      writeFile(join(root, 'linux.node'), ''),
      writeFile(join(root, 'source.js'), ''),
    ]);
    const result = await inspectNativeArtifacts(root, {
      concurrency: 2,
      inspect: async (_command, args) => {
        if (args[1].endsWith('arm.node')) return { stdout: 'Mach-O 64-bit bundle arm64\n' };
        if (args[1].endsWith('linux.node')) return { stdout: 'ELF 64-bit LSB shared object\n' };
        return { stdout: 'ASCII text\n' };
      },
    });
    assert.deepEqual(result.machOBinaries, [join(root, 'arm.node')]);
    assert.deepEqual(result.foreignBinaries, [join(root, 'linux.node')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Mach-O acceptance binds both CPU architecture and target platform', () => {
  assert.equal(isMacosArm64MachO('arm64\n', ' platform MACOS\n'), true);
  assert.equal(isMacosArm64MachO('x86_64\n', ' platform MACOS\n'), false);
  assert.equal(isMacosArm64MachO('arm64\n', ' platform IOS\n'), false);
});

test('archive and TUI verification rejects traversal and false readiness', () => {
  assert.doesNotThrow(() =>
    assertSafeCliArchiveEntries(
      ['Maka-1-cli-mac-arm64/', 'Maka-1-cli-mac-arm64/bin/maka'],
      'Maka-1-cli-mac-arm64',
    ),
  );
  assert.throws(
    () => assertSafeCliArchiveEntries(['../escape'], 'Maka-1-cli-mac-arm64'),
    /Unsafe CLI archive entry/,
  );
  assert.equal(isTuiReadyOutput('Error loading /tmp/Maka-1-cli-mac-arm64/addon.node'), false);
  assert.equal(isTuiReadyOutput('陪你把事做完'), true);
  assert.throws(
    () =>
      assertExpectedTuiExit({
        ready: true,
        stopRequested: true,
        exitCode: 1,
        signal: 0,
        output: '陪你把事做完\ncrash',
      }),
    /crashed after startup/,
  );
});
