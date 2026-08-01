import assert from 'node:assert/strict';
import test from 'node:test';

const signingEnvironment = {
  CSC_LINK: 'base64-certificate',
  CSC_KEY_PASSWORD: 'password',
  APPLE_API_KEY: '/tmp/AuthKey_TEST.p8',
  APPLE_API_KEY_ID: 'TESTKEY',
  APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
};

test('release packaging refuses an unsupported host or incomplete signing identity', async () => {
  const { packageMacosArm64 } = await import(new URL('package-macos-arm64.mjs', import.meta.url));

  await assert.rejects(
    packageMacosArm64({ platform: 'darwin', arch: 'x64', env: signingEnvironment }),
    /Apple Silicon macOS host/,
  );
  await assert.rejects(
    packageMacosArm64({ platform: 'darwin', arch: 'arm64', env: {} }),
    /CSC_LINK/,
  );
});

test('packaged app verification covers trust, runtime resources, and renderer launch', async () => {
  const { verifyPackagedMacApp } = await import(
    new URL('verify-macos-arm64-dmg.mjs', import.meta.url)
  );
  const commands = [];
  const requiredPaths = [];
  const forbiddenPaths = [];
  const rendererLaunches = [];
  const workerLaunches = [];
  const run = async (command, args, options) => {
    commands.push([command, args, options]);
    if (command === 'plutil') {
      if (args[1] === 'CFBundleIdentifier') return { stdout: 'com.maka.desktop\n', stderr: '' };
      if (args[1] === 'CFBundleShortVersionString') return { stdout: '0.1.2\n', stderr: '' };
      return { stdout: 'Maka\n', stderr: '' };
    }
    if (command === 'lipo') return { stdout: 'arm64\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };

  await verifyPackagedMacApp('/tmp/Maka.app', {
    run,
    requirePath: async (path) => requiredPaths.push(path),
    forbidPath: async (path) => forbiddenPaths.push(path),
    smokeRenderer: async (...args) => rendererLaunches.push(args),
    smokeFilesystemWorker: async (...args) => workerLaunches.push(args),
  });

  for (const command of ['codesign', 'spctl', 'xcrun']) {
    assert.ok(
      commands.some(([actual]) => actual === command),
      `${command} must run`,
    );
  }
  assert.ok(requiredPaths.some((path) => path.endsWith('/Resources/app.asar')));
  assert.ok(requiredPaths.some((path) => path.endsWith('/Resources/workers/filesystem-worker.js')));
  assert.ok(requiredPaths.some((path) => path.endsWith('/Resources/licenses/maka/LICENSE')));
  assert.ok(forbiddenPaths.some((path) => path.endsWith('/Resources/bin/cua-driver')));
  assert.equal(rendererLaunches.length, 1);
  assert.equal(workerLaunches.length, 1);

  await assert.rejects(
    verifyPackagedMacApp('/tmp/Maka.app', {
      run: async (command, args) => {
        if (command === 'plutil') return run(command, args);
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
  assert.equal(
    isPackagedRendererUsable({
      readyState: 'complete',
      hasBridge: true,
      hasRoot: true,
      hasPreloadSkeleton: false,
      hasAppShell: true,
    }),
    true,
  );
});
