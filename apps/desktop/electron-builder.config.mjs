/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { readFileSync } from 'node:fs';
import { resolveProductManifestIdentity } from '../../scripts/product-release-identity.mjs';

function readManifest(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
}

const { runtimeHostSetupPackage } = resolveProductManifestIdentity({
  rootManifest: readManifest('../../package.json'),
  desktopManifest: readManifest('./package.json'),
  cliManifest: readManifest('../../packages/cli/package.json'),
});

export default {
  appId: 'com.maka.desktop',
  productName: 'Maka',
  artifactName: 'Maka-${version}-mac-${arch}.${ext}',
  asar: true,
  extraMetadata: { runtimeHostSetupPackage },
  directories: {
    output: 'release',
  },
  // `files` names what to include; the production dependency closure of
  // `package.json` comes along automatically. Renderer-only packages are kept
  // out of that closure by living in `devDependencies` — vite bundles them into
  // `dist-renderer`, so a second copy of their sources in `app.asar` is never
  // loaded. A hand-written exclude list was tried first and could not hold: it
  // has to name every transitive package too, and it silently went stale.
  //
  // `@xterm/headless` stays a dependency on purpose — `@maka/runtime` imports
  // it for the PTY stack, so only the renderer-side xterm packages moved.
  files: [
    'dist/**/*',
    'dist-renderer/**/*',
    'package.json',
    '!**/__tests__/**',
    // FakeBackend and the Desktop E2E candidate bootstrap live under
    // `test-only/`; they must not reach a packaged app.
    '!**/test-only/**',
    // `build:main` emits renderer sources as tsc side-files so main's tests can
    // import a few helpers. The main process reaches exactly one of them at
    // runtime — the cursor overlay engine — while the rest import `react`,
    // `@maka/ui` and `@astryxdesign/core`, which the renderer now bundles
    // instead of shipping under `node_modules`. Shipping those files would put
    // ESM in the archive whose static imports cannot resolve.
    '!dist/renderer/**',
    'dist/renderer/computer-use-overlay/**',
  ],
  extraResources: [
    {
      from: 'bundled-tools.json',
      to: 'bundled-tools.json',
    },
    {
      // The app icon is read at runtime by the BrowserWindow `icon` option, and
      // `files` above does not carry `assets/`. Electron reports the missing
      // file as an empty image rather than an error, so without this the
      // packaged app just draws no window icon.
      from: 'assets',
      to: 'assets',
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
      owner: 'apache',
      repo: 'maka',
    },
  ],
};
