export default {
  appId: 'com.maka.desktop',
  productName: 'Maka',
  artifactName: 'Maka-${version}-mac-${arch}.${ext}',
  asar: true,
  directories: {
    output: 'release',
  },
  files: ['dist/**/*', 'dist-renderer/**/*', 'package.json', '!**/__tests__/**'],
  extraResources: [
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
    {
      from: '../../LICENSE',
      to: 'licenses/maka/LICENSE',
    },
    {
      from: '../../NOTICE',
      to: 'licenses/maka/NOTICE',
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
      from: 'node_modules/simple-icons/LICENSE.md',
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
      NSMicrophoneUsageDescription:
        'Maka uses the microphone only when you test or use voice input.',
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
  publish: [
    {
      provider: 'github',
      owner: 'Maka-Agent',
      repo: 'maka-agent',
    },
  ],
};
