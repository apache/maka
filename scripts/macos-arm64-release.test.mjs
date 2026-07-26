import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('../', import.meta.url);
const desktopRoot = new URL('../apps/desktop/', import.meta.url);
const signingEnvironment = {
  CSC_LINK: 'base64-certificate',
  CSC_KEY_PASSWORD: 'password',
  APPLE_API_KEY: '/tmp/AuthKey_TEST.p8',
  APPLE_API_KEY_ID: 'TESTKEY',
  APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
};

test('desktop packager has one explicit signed macOS arm64 DMG target', async () => {
  const { default: config } = await import(new URL('electron-builder.config.mjs', desktopRoot));

  assert.equal(config.appId, 'com.maka.desktop');
  assert.equal(config.productName, 'Maka');
  assert.equal(config.asar, true);
  assert.equal(config.artifactName, 'Maka-${version}-mac-${arch}.${ext}');
  assert.deepEqual(config.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.equal(config.mac.forceCodeSigning, true);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.mac.entitlements, 'build/entitlements.mac.plist');
  assert.equal(config.mac.entitlementsInherit, 'build/entitlements.mac.inherit.plist');
  assert.deepEqual(config.mac.binaries, ['Contents/Resources/tools/officecli']);
  assert.deepEqual(config.dmg, { writeUpdateInfo: false });
});

test('Electron is a build tool rather than a packaged application dependency', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', desktopRoot), 'utf8'));
  assert.equal(manifest.dependencies.electron, undefined);
  assert.equal(manifest.devDependencies.electron, '43.1.1');
});

test('renderer build inputs are not duplicated in the packaged Node runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', desktopRoot), 'utf8'));
  for (const dependency of [
    '@ant-design/icons-svg',
    '@fontsource-variable/geist',
    '@fontsource-variable/geist-mono',
    '@vitejs/plugin-react',
    'simple-icons',
    'vite',
  ]) {
    assert.equal(manifest.dependencies[dependency], undefined);
    assert.equal(typeof manifest.devDependencies[dependency], 'string');
  }
});

test('desktop packager ships only the release runtime resources', async () => {
  const { default: config } = await import(new URL('electron-builder.config.mjs', desktopRoot));

  assert.deepEqual(config.extraResources, [
    {
      from: 'bundled-tools.json',
      to: 'bundled-tools.json',
    },
    {
      from: 'resources/workers/filesystem-worker.js',
      to: 'workers/filesystem-worker.js',
    },
    {
      from: 'resources/tools/officecli',
      to: 'tools/officecli',
    },
    {
      from: '../../LICENSE',
      to: 'licenses/officecli/LICENSE',
    },
    {
      from: 'resources/licenses/officecli/ATTRIBUTION.md',
      to: 'licenses/officecli/ATTRIBUTION.md',
    },
  ]);
  assert.equal(
    config.extraResources.some(({ from }) => from.includes('cua-driver')),
    false,
  );
});

test('release package script runs the single arm64 pipeline in order', async () => {
  const { packageMacosArm64 } = await import(new URL('package-macos-arm64.mjs', import.meta.url));
  const calls = [];
  const removed = [];

  const result = await packageMacosArm64({
    platform: 'darwin',
    arch: 'arm64',
    env: signingEnvironment,
    run: async (command, args) => {
      calls.push([command, args]);
    },
    remove: async (path, options) => {
      removed.push([path, options]);
    },
    assertFile: async () => {},
  });

  assert.deepEqual(calls, [
    ['npm', ['run', 'prepare:officecli', '--', '--platform', 'darwin', '--arch', 'arm64']],
    ['npm', ['run', 'build']],
    ['npm', ['run', 'check:release']],
    ['npm', ['--workspace', '@maka/desktop', 'run', 'package:macos-arm64']],
  ]);
  assert.equal(removed.length, 1);
  assert.equal(removed[0][1].recursive, true);
  assert.equal(removed[0][1].force, true);
  assert.match(result, /apps\/desktop\/release\/Maka-0\.1\.0-mac-arm64\.dmg$/);
});

test('release package script refuses an unsupported host or incomplete signing identity', async () => {
  const { packageMacosArm64 } = await import(new URL('package-macos-arm64.mjs', import.meta.url));

  await assert.rejects(
    packageMacosArm64({
      platform: 'darwin',
      arch: 'x64',
      env: signingEnvironment,
    }),
    /Apple Silicon macOS host/,
  );
  await assert.rejects(
    packageMacosArm64({
      platform: 'darwin',
      arch: 'arm64',
      env: {},
    }),
    /CSC_LINK/,
  );
});

test('packaged app verification proves identity, notarization, resources, PTY, and renderer launch', async () => {
  const { verifyPackagedMacApp } = await import(
    new URL('verify-macos-arm64-dmg.mjs', import.meta.url)
  );
  const commands = [];
  const requiredPaths = [];
  const forbiddenPaths = [];
  const rendererLaunches = [];

  await verifyPackagedMacApp('/tmp/Maka.app', {
    run: async (command, args, options) => {
      commands.push([command, args, options]);
      if (command === 'plutil') {
        return args[1] === 'CFBundleIdentifier'
          ? { stdout: 'com.maka.desktop\n', stderr: '' }
          : args[1] === 'CFBundleShortVersionString'
            ? { stdout: '0.1.0\n', stderr: '' }
            : { stdout: 'Maka\n', stderr: '' };
      }
      if (command === 'lipo') {
        return { stdout: 'arm64\n', stderr: '' };
      }
      if (args[0] === '--version') {
        return { stdout: 'officecli 1.0.63\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    requirePath: async (path) => {
      requiredPaths.push(path);
    },
    forbidPath: async (path) => {
      forbiddenPaths.push(path);
    },
    smokeRenderer: async (executable, options) => {
      rendererLaunches.push([executable, options]);
    },
  });

  assert.equal(
    commands.some(
      ([command, args]) =>
        command === 'codesign' && args.includes('--deep') && args.includes('/tmp/Maka.app'),
    ),
    true,
  );
  assert.equal(
    commands.some(
      ([command, args]) =>
        command === 'spctl' && args.includes('--assess') && args.includes('/tmp/Maka.app'),
    ),
    true,
  );
  assert.equal(
    commands.some(
      ([command, args]) =>
        command === 'xcrun' && args[0] === 'stapler' && args.includes('/tmp/Maka.app'),
    ),
    true,
  );
  assert.equal(
    commands.some(
      ([command, args], index) =>
        command === '/tmp/Maka.app/Contents/MacOS/Maka' &&
        args[0] === '-e' &&
        args[1].includes("requireFromApp('node-pty')") &&
        commands[index][2]?.env?.ELECTRON_RUN_AS_NODE === '1',
    ),
    true,
  );
  assert.equal(
    requiredPaths.some((path) => path.endsWith('/Resources/app.asar')),
    true,
  );
  assert.equal(
    requiredPaths.some((path) => path.endsWith('/Resources/workers/filesystem-worker.js')),
    true,
  );
  assert.equal(
    forbiddenPaths.some((path) => path.endsWith('/Resources/bin/cua-driver')),
    true,
  );
  assert.equal(rendererLaunches.length, 1);
});

test('packaged app verification rejects a non-arm64 executable', async () => {
  const { verifyPackagedMacApp } = await import(
    new URL('verify-macos-arm64-dmg.mjs', import.meta.url)
  );

  await assert.rejects(
    verifyPackagedMacApp('/tmp/Maka.app', {
      run: async (command, args) => {
        if (command === 'plutil') {
          return args[1] === 'CFBundleIdentifier'
            ? { stdout: 'com.maka.desktop\n', stderr: '' }
            : args[1] === 'CFBundleShortVersionString'
              ? { stdout: '0.1.0\n', stderr: '' }
              : { stdout: 'Maka\n', stderr: '' };
        }
        if (command === 'lipo') {
          return { stdout: 'x86_64\n', stderr: '' };
        }
        return { stdout: 'officecli 1.0.63\n', stderr: '' };
      },
      requirePath: async () => {},
      forbidPath: async () => {},
      smokeRenderer: async () => {},
    }),
    /arm64/,
  );
});

test('one manual workflow packages, verifies, then creates one draft release from main', async () => {
  const workflow = await readFile(
    new URL('.github/workflows/release-macos-arm64.yml', repoRoot),
    'utf8',
  );

  assert.match(workflow, /^on:\n  workflow_dispatch:\s*$/m);
  assert.match(workflow, /permissions:\n  contents: write/);
  assert.match(workflow, /jobs:\n  release:/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /environment: release/);
  assert.match(workflow, /node-version: ['"]?24['"]?/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /\bmatrix:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.doesNotMatch(workflow, /^\s+workflow_call:/m);

  const jobHeader = workflow.slice(workflow.indexOf('jobs:'), workflow.indexOf('\n    steps:'));
  assert.doesNotMatch(jobHeader, /secrets\.|GH_TOKEN/);

  const packageStep = workflow.indexOf('npm run package:macos-arm64');
  const auditStep = workflow.indexOf('npm audit --omit=dev --audit-level=high');
  const verifyStep = workflow.indexOf('npm run verify:macos-arm64');
  const releaseStep = workflow.indexOf('gh release create');
  assert.ok(auditStep > 0);
  assert.ok(packageStep > auditStep);
  assert.ok(packageStep > 0);
  assert.ok(verifyStep > packageStep);
  assert.ok(releaseStep > verifyStep);
  assert.match(workflow, /gh release create[\s\S]*--draft/);
  assert.match(workflow, /--target "\$GITHUB_SHA"/);
  assert.match(workflow, /\$\{DMG_PATH\}\.sha256/);
});

test('the distributable includes OfficeCLI Apache-2.0 attribution', async () => {
  const license = await readFile(new URL('LICENSE', repoRoot), 'utf8');
  const attribution = await readFile(
    new URL('resources/licenses/officecli/ATTRIBUTION.md', desktopRoot),
    'utf8',
  );
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  assert.match(attribution, /OfficeCLI v1\.0\.63/);
  assert.match(attribution, /github\.com\/iOfficeAI\/OfficeCLI/);
  assert.match(attribution, /Copyright 2026 OfficeCli/);
});

test('generated release artifacts never enter source control', async () => {
  const gitignore = await readFile(new URL('.gitignore', repoRoot), 'utf8');
  assert.match(gitignore, /^apps\/desktop\/release\/$/m);
  assert.match(gitignore, /^apps\/desktop\/resources\/tools\/$/m);
});
