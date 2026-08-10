import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FILESYSTEM_WORKER_PROTOCOL_VERSION } from '../packages/runtime/dist/filesystem-worker/protocol.js';

const signingEnvironment = {
  CSC_LINK: 'base64-certificate',
  CSC_KEY_PASSWORD: 'password',
  APPLE_API_KEY: '/tmp/AuthKey_TEST.p8',
  APPLE_API_KEY_ID: 'TESTKEY',
  APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
};

test('the packaged filesystem worker smoke uses the runtime protocol version', async () => {
  const { smokePackagedFilesystemWorker } = await import(
    new URL('verify-macos-arm64-dmg.mjs', import.meta.url)
  );
  const workingDirectory = await mkdtemp(join(tmpdir(), 'maka-filesystem-worker-smoke-'));

  try {
    await smokePackagedFilesystemWorker('/tmp/Maka', '/tmp/filesystem-worker.js', {
      workingDirectory,
      run: async (_command, _args, options) => {
        const request = JSON.parse(options.input);
        assert.equal(request.version, FILESYSTEM_WORKER_PROTOCOL_VERSION);
        await writeFile(request.operation.path, request.operation.content, 'utf8');
        return {
          stdout: JSON.stringify({
            version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            result: { kind: 'write', ok: true, path: request.operation.path, bytes: 25 },
          }),
          stderr: '',
        };
      },
    });
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});

test('release tooling fails closed on unsupported hosts, signing, and architecture', async () => {
  const desktopManifest = JSON.parse(
    await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'),
  );
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
          if (args[1] === 'CFBundleShortVersionString') {
            return { stdout: `${desktopManifest.version}\n` };
          }
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

test('the packaged app is checked for every unsigned helper that could still be in a tree', async () => {
  // `apps/desktop/resources/bin` is gitignored, so removing a helper from the
  // repository does not remove it from the machine of anyone who prepared it
  // once. Dropping its forbid alongside the source is how a leftover ad-hoc
  // binary gets into a build that then fails notarization as a whole.
  const { verifyPackagedMacApp } = await import(
    new URL('verify-macos-arm64-dmg.mjs', import.meta.url)
  );
  const desktopManifest = JSON.parse(
    await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'),
  );
  const forbidden = [];
  // Everything before the forbids has to pass, so the run that fails is the
  // architecture check that comes after them.
  await assert.rejects(
    verifyPackagedMacApp('/tmp/Maka.app', {
      run: async (command, args) => {
        if (command === 'plutil') {
          if (args[1] === 'CFBundleIdentifier') return { stdout: 'com.maka.desktop\n' };
          if (args[1] === 'CFBundleShortVersionString') {
            return { stdout: `${desktopManifest.version}\n` };
          }
          return { stdout: 'Maka\n' };
        }
        if (command === 'lipo') return { stdout: 'x86_64\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      requirePath: async () => {},
      forbidPath: async (path) => {
        forbidden.push(path);
      },
      smokeRenderer: async () => {},
    }),
    /arm64/,
  );
  for (const helper of ['cua-driver', 'maka-cu', 'officecli']) {
    assert.ok(
      forbidden.some((path) => path.replaceAll('\\', '/').endsWith(`/${helper}`)),
      `${helper} is not among the paths the packaged app is checked against`,
    );
  }
});
