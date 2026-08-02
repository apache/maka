import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

const signingEnvironment = {
  CSC_LINK: 'base64-certificate',
  CSC_KEY_PASSWORD: 'password',
  APPLE_API_KEY: '/tmp/AuthKey_TEST.p8',
  APPLE_API_KEY_ID: 'TESTKEY',
  APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
};

test('release tooling fails closed on unsupported hosts, signing, and architecture', async () => {
  const { packageMacosArm64 } = await import(new URL('package-macos-arm64.mjs', import.meta.url));
  const { verifyPackagedMacApp } = await import(
    new URL('verify-macos-arm64-dmg.mjs', import.meta.url)
  );

  await assert.rejects(
    packageMacosArm64({ platform: 'darwin', arch: 'x64', env: signingEnvironment }),
    /Apple Silicon macOS host/,
  );
  await assert.rejects(
    packageMacosArm64({ platform: 'darwin', arch: 'arm64', env: {} }),
    /CSC_LINK/,
  );

  await assert.rejects(
    verifyPackagedMacApp('/tmp/Maka.app', {
      run: async (command, args) => {
        if (command === 'plutil') {
          if (args[1] === 'CFBundleIdentifier') return { stdout: 'com.maka.desktop\n' };
          if (args[1] === 'CFBundleShortVersionString') return { stdout: '0.1.2\n' };
          return { stdout: 'Maka\n' };
        }
        if (command === 'lipo') return { stdout: 'x86_64\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      requirePath: async () => {},
      forbidPath: async () => {},
      smokeRenderer: async () => {},
    }),
    /arm64/,
  );
});

test('standalone CLI derives its workspace and pinned toolchain invariants', async () => {
  const {
    assertMacosArm64CliHost,
    assertOfficialNodeRuntime,
    assertReleaseSigningEnvironment,
    collectWorkspaceDependencyClosure,
    macosArm64CliInstallArgs,
    packageMacosArm64Cli,
    releaseToolchainFromManifest,
    resolveMacosArm64CliArtifactPaths,
  } = await import(new URL('package-macos-arm64-cli.mjs', import.meta.url));
  const { verifyMacosArm64Cli } = await import(
    new URL('verify-macos-arm64-cli.mjs', import.meta.url)
  );

  assert.doesNotThrow(() => assertMacosArm64CliHost('darwin', 'arm64'));
  assert.throws(() => assertMacosArm64CliHost('darwin', 'x64'), /Apple Silicon macOS host/);
  await assert.rejects(
    packageMacosArm64Cli({ platform: 'linux', arch: 'x64' }),
    /Apple Silicon macOS host/,
  );
  await assert.rejects(
    verifyMacosArm64Cli('/missing', { platform: 'linux', arch: 'x64' }),
    /Apple Silicon macOS host/,
  );

  assert.deepEqual(
    releaseToolchainFromManifest({
      packageManager: 'npm@11.12.1',
      releaseToolchain: { node: '24.18.1' },
    }),
    { nodeVersion: '24.18.1', npmVersion: '11.12.1' },
  );
  assert.throws(
    () => releaseToolchainFromManifest({ packageManager: 'npm@latest' }),
    /exact releaseToolchain\.node/,
  );

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

  const installArgs = macosArm64CliInstallArgs();
  assert.equal(installArgs[0], 'ci');
  assert.equal(installArgs.includes('--prefix'), false);
  assert.ok(installArgs.includes('maka-agent'));
  assert.ok(resolveMacosArm64CliArtifactPaths('1.2.3').archivePath.endsWith('.zip'));

  assert.doesNotThrow(() =>
    assertOfficialNodeRuntime({
      actualVersion: '24.18.1',
      expectedVersion: '24.18.1',
      architectures: 'arm64\n',
      signature:
        'flags=0x10000(runtime)\nAuthority=Developer ID Application: Node.js Foundation (HX7739G8FX)',
      linkedLibraries: [
        '/System/Library/Frameworks/Security.framework/Versions/A/Security',
        '/usr/lib/libSystem.B.dylib',
      ],
    }),
  );
  assert.throws(
    () =>
      assertOfficialNodeRuntime({
        actualVersion: '24.18.1',
        expectedVersion: '24.18.1',
        architectures: 'arm64\n',
        signature:
          'flags=0x10000(runtime)\nAuthority=Developer ID Application: Node.js Foundation (HX7739G8FX)',
        linkedLibraries: ['@rpath/libnode.147.dylib', '/opt/homebrew/opt/libuv/lib/libuv.1.dylib'],
      }),
    /not self-contained/,
  );
  assert.throws(() => assertReleaseSigningEnvironment({}), /CSC_LINK/);
  assert.doesNotThrow(() => assertReleaseSigningEnvironment(signingEnvironment));
});

test('CLI release rejects unsafe archives, false TUI readiness, and crash exits', async () => {
  const { assertAcceptedNotarization } = await import(
    new URL('package-macos-arm64-cli.mjs', import.meta.url)
  );
  const { assertExpectedTuiExit, assertSafeCliArchiveEntries, isTuiReadyOutput } = await import(
    new URL('verify-macos-arm64-cli.mjs', import.meta.url)
  );

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
  assert.throws(
    () =>
      assertSafeCliArchiveEntries(['Maka-1-cli-mac-arm64/libexec/._node'], 'Maka-1-cli-mac-arm64'),
    /Unsafe CLI archive entry/,
  );

  assert.equal(isTuiReadyOutput('Error loading /tmp/Maka-1-cli-mac-arm64/addon.node'), false);
  assert.equal(isTuiReadyOutput('无法启动 Maka：还没有可用的模型连接。'), false);
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
  assert.doesNotThrow(() =>
    assertExpectedTuiExit({
      ready: true,
      stopRequested: true,
      exitCode: 0,
      signal: 0,
      output: '陪你把事做完',
    }),
  );
  assert.doesNotThrow(() => assertAcceptedNotarization('{"status":"Accepted"}'));
  assert.throws(() => assertAcceptedNotarization('{"status":"Invalid"}'), /status Invalid/);
});

test('CLI staging removes test output and rejects dangling symlinks', async () => {
  const { assertNoDanglingSymlinks, pruneTestArtifacts } = await import(
    new URL('package-macos-arm64-cli.mjs', import.meta.url)
  );
  const root = await mkdtemp(join(tmpdir(), 'maka-cli-unit-'));
  try {
    const dist = join(root, 'dist');
    await mkdir(join(dist, '__tests__'), { recursive: true });
    await Promise.all([
      writeFile(join(dist, 'index.js'), 'export {};\n'),
      writeFile(join(dist, 'feature.test.js'), 'throw new Error();\n'),
      writeFile(join(dist, '__tests__', 'fixture.js'), 'throw new Error();\n'),
    ]);
    await pruneTestArtifacts(dist);
    await access(join(dist, 'index.js'));
    await assert.rejects(access(join(dist, 'feature.test.js')), { code: 'ENOENT' });
    await assert.rejects(access(join(dist, '__tests__')), { code: 'ENOENT' });

    await mkdir(join(root, 'target'));
    await symlink('target', join(root, 'valid-link'));
    await assertNoDanglingSymlinks(root);
    await symlink('missing', join(root, 'dangling-link'));
    await assert.rejects(assertNoDanglingSymlinks(root), /Dangling symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release workflow pins the toolchain and gates CLI publication on signing', async () => {
  const workflow = parseYaml(
    await readFile(
      new URL('../.github/workflows/release-macos-arm64.yml', import.meta.url),
      'utf8',
    ),
  );
  const steps = workflow.jobs.release.steps;
  const setupNode = steps.find((step) => step.name === 'Set up Node.js');
  const packageCli = steps.find(
    (step) => step.name === 'Package signed and notarized standalone CLI and TUI',
  );
  const verifyCli = steps.find((step) => step.name === 'Verify the standalone CLI and TUI');
  const release = steps.find((step) => step.name === 'Create draft GitHub Release');
  const cleanupIndex = steps.findIndex(
    (step) => step.name === 'Remove the temporary notarization key',
  );

  assert.equal(setupNode.with['node-version'], '24.18.1');
  assert.equal(packageCli.env.MAKA_CLI_RELEASE_SIGNING, '1');
  assert.equal(verifyCli.env.MAKA_CLI_REQUIRE_RELEASE_SIGNING, '1');
  assert.match(release.run, /steps\.release\.outputs\.cli/);
  assert.match(release.run, /steps\.release\.outputs\.cli \}\}\.sha256/);
  assert.ok(cleanupIndex > steps.indexOf(verifyCli));
});
