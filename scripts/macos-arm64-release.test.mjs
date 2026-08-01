import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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

test('standalone CLI release has stable paths, aliases, and an Apple Silicon host gate', async () => {
  const {
    assertMacosArm64CliHost,
    macosArm64CliInstallArgs,
    macosArm64CliWrapper,
    packageMacosArm64Cli,
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

  const paths = resolveMacosArm64CliArtifactPaths('1.2.3');
  const installArgs = macosArm64CliInstallArgs('/staging');
  assert.ok(paths.archivePath.endsWith('/Maka-1.2.3-cli-mac-arm64.tar.gz'));
  assert.equal(paths.checksumPath, `${paths.archivePath}.sha256`);
  assert.equal(installArgs[0], 'ci');
  assert.deepEqual(installArgs.slice(1, 3), ['--prefix', '/staging']);
  assert.ok(installArgs.includes('--workspace'));
  assert.ok(installArgs.includes('maka-agent'));
  assert.match(macosArm64CliWrapper(), /libexec\/node\/bin\/node/);
  assert.match(macosArm64CliWrapper(), /maka-agent\/dist\/cli\.js/);
  assert.match(macosArm64CliWrapper(), /"\$@"/);
});

test('release workflow verifies and uploads both terminal artifacts', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release-macos-arm64.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /npm run package:macos-arm64-cli/);
  assert.match(workflow, /npm run verify:macos-arm64-cli/);
  assert.match(workflow, /steps\.release\.outputs\.cli/);
  assert.match(workflow, /steps\.release\.outputs\.cli \}\}\.sha256/);
});

test('renderer readiness rejects the static preload skeleton', async () => {
  const { isPackagedRendererUsable } = await import(
    new URL('verify-macos-arm64-dmg.mjs', import.meta.url)
  );
  assert.equal(
    isPackagedRendererUsable({
      readyState: 'complete',
      hasBridge: true,
      hasRoot: true,
      hasPreloadSkeleton: true,
      hasAppShell: false,
    }),
    false,
  );
});
