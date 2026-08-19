import { readFileSync } from 'node:fs';

const cliManifest = JSON.parse(
  readFileSync(new URL('../../packages/cli/package.json', import.meta.url), 'utf8'),
);
if (
  cliManifest.name !== 'maka-agent' ||
  typeof cliManifest.version !== 'string' ||
  !/^[0-9][0-9A-Za-z.+-]*$/u.test(cliManifest.version)
) {
  throw new Error('Desktop packaging requires a valid Maka CLI release identity');
}

export default {
  appId: 'com.maka.desktop',
  productName: 'Maka',
  artifactName: 'Maka-${version}-mac-${arch}.${ext}',
  asar: true,
  extraMetadata: {
    runtimeHostSetupPackage: `maka-agent@${cliManifest.version}`,
  },
  directories: {
    output: 'release',
  },
  files: [
    'dist/**/*',
    'dist-renderer/**/*',
    'package.json',
    '!**/__tests__/**',
    // FakeBackend and the Desktop E2E candidate bootstrap live under
    // `test-only/`; they must not reach a packaged app.
    '!**/test-only/**',
  ],
  extraResources: [
    {
      from: '../../node_modules/dugite/git',
      to: 'git',
    },
    {
      from: 'bundled-git.json',
      to: 'bundled-git.json',
    },
    {
      from: 'bundled-tools.json',
      to: 'bundled-tools.json',
    },
    {
      // Menu bar status item art. Without this the packaged app resolves an
      // empty NativeImage and Electron silently shows no icon at all.
      from: 'resources/status',
      to: 'status',
    },
    {
      from: 'resources/workers/filesystem-worker.js',
      to: 'workers/filesystem-worker.js',
    },
    ...(process.platform === 'win32'
      ? [
          {
            from: 'resources/windows-sandbox/maka-windows-sandbox.exe',
            to: 'windows-sandbox/maka-windows-sandbox.exe',
          },
          {
            from: 'resources/licenses/cargo/THIRD_PARTY_NOTICES.txt',
            to: 'licenses/cargo/THIRD_PARTY_NOTICES.txt',
          },
        ]
      : []),
    {
      from: '../../LICENSE',
      to: 'licenses/maka/LICENSE',
    },
    {
      from: '../../node_modules/dugite/LICENSE',
      to: 'licenses/dugite/LICENSE',
    },
    {
      from: 'resources/licenses/git/NOTICE.txt',
      to: 'licenses/git/NOTICE.txt',
    },
    {
      from: 'resources/licenses/git/LICENSE.txt',
      to: 'licenses/git/LICENSE.txt',
    },
    {
      from: 'resources/licenses/git/SOURCE_OFFER.txt',
      to: 'licenses/git/SOURCE_OFFER.txt',
    },
    {
      from: '../../NOTICE',
      to: 'licenses/maka/NOTICE',
    },
    {
      // Incubator policy requires every release archive to carry a DISCLAIMER
      // or DISCLAIMER-WIP. Shipping it beside LICENSE and NOTICE is what makes
      // the repository-root file reach the DMG, the ZIP and the Windows
      // installer; `assertPackagedResources` then requires it on both paths.
      from: '../../DISCLAIMER-WIP',
      to: 'licenses/maka/DISCLAIMER-WIP',
    },
    {
      from: '../../node_modules/electron/dist/LICENSE',
      to: 'licenses/electron/LICENSE',
    },
    {
      from: '../../node_modules/electron/dist/LICENSES.chromium.html',
      to: 'licenses/electron/LICENSES.chromium.html',
    },
    {
      from: 'resources/licenses/npm/THIRD_PARTY_NOTICES.txt',
      to: 'licenses/npm/THIRD_PARTY_NOTICES.txt',
    },
    {
      from: 'src/renderer/public/THIRD_PARTY_LICENSES.txt',
      to: 'licenses/renderer/THIRD_PARTY_LICENSES.txt',
    },
    {
      from: '../../node_modules/@fontsource-variable/geist/LICENSE',
      to: 'licenses/renderer/GEIST_LICENSE.txt',
    },
    {
      from: '../../node_modules/@fontsource-variable/geist-mono/LICENSE',
      to: 'licenses/renderer/GEIST_MONO_LICENSE.txt',
    },
    {
      from: 'resources/licenses/renderer/ANT_DESIGN_ICONS_LICENSE.txt',
      to: 'licenses/renderer/ANT_DESIGN_ICONS_LICENSE.txt',
    },
    {
      from: 'resources/licenses/renderer/TDESIGN_ICONS_LICENSE.txt',
      to: 'licenses/renderer/TDESIGN_ICONS_LICENSE.txt',
    },
    {
      from: 'resources/licenses/renderer/ALLOGO_LICENSE.txt',
      to: 'licenses/renderer/ALLOGO_LICENSE.txt',
    },
    {
      from: 'resources/licenses/renderer/SEMI_ICONS_LICENSE.txt',
      to: 'licenses/renderer/SEMI_ICONS_LICENSE.txt',
    },
    {
      from: '../../LICENSE',
      to: 'licenses/renderer/MINGCUTE_APACHE_LICENSE.txt',
    },
    {
      // Vendored copy of the installed tarball's LICENSE (CC0-1.0): the
      // package hoists to different node_modules depths across majors.
      from: 'resources/licenses/renderer/SIMPLE_ICONS_LICENSE.md',
      to: 'licenses/renderer/SIMPLE_ICONS_LICENSE.md',
    },
  ],
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    category: 'public.app-category.productivity',
    icon: 'assets/icon.png',
    forceCodeSigning: true,
    hardenedRuntime: true,
    notarize: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    extendInfo: {
      NSAppleEventsUsageDescription:
      'Maka may automate other applications when you explicitly run an agent task.',
    },
  },
  dmg: {
    sign: true,
    // Stapling the notarization ticket after electron-builder exits changes the
    // DMG bytes. macOS updates use the ZIP, so do not publish a stale DMG hash
    // in latest-mac.yml.
    writeUpdateInfo: false,
  },
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ],
    artifactName: 'Maka-${version}-win-${arch}.${ext}',
    icon: 'assets/icon.png',
    // No Authenticode certificate yet. Being unsigned is the absence of one:
    // electron-builder skips signing when no certificate is configured, and
    // `forceCodeSigning` is left off so that skip is not an error. Nothing here
    // turns update signature verification off, because nothing has to: without a
    // certificate there is no publisher name to put in app-update.yml, and
    // electron-updater skips the check when there is none. Adding a certificate
    // is then the whole change — the verification follows it.
  },
  publish: [
    {
      provider: 'github',
      owner: 'Maka-Agent',
      repo: 'maka-agent',
    },
  ],
};
