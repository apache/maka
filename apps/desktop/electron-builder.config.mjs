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
    {
      from: '../../LICENSE',
      to: 'licenses/maka/LICENSE',
    },
    {
      from: '../../NOTICE',
      to: 'licenses/maka/NOTICE',
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
    binaries: ['Contents/Resources/tools/officecli'],
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Maka uses the microphone only when you test or use voice input.',
      NSAppleEventsUsageDescription:
      'Maka may automate other applications when you explicitly run an agent task.',
    },
  },
  dmg: {
    writeUpdateInfo: true,
  },
  publish: [
    {
      provider: 'github',
      owner: 'Maka-Agent',
      repo: 'maka-agent',
    },
  ],
};
