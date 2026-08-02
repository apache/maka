import assert from 'node:assert/strict';
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
