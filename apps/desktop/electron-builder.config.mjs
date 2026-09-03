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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  resolveDesktopBuildVersion,
  resolveRuntimeHostSetupPackage,
} from '../../scripts/desktop-nightly.mjs';
import { workspaceReleaseManifest } from '../../scripts/release-cli-file-policy.mjs';
import { resolveProductManifestIdentity } from '../../scripts/product-release-identity.mjs';

function readManifest(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
}

// Some license files below ship inside third-party packages that apps/desktop
// depends on (electron, @fontsource-variable/geist*). Locate each package by
// resolving its manifest rather than assuming its node_modules location:
// `../../node_modules/<pkg>` only resolves when the installer hoists these
// packages to the workspace root, but they are declared in apps/desktop, not
// the root. electron-builder logs a warning and still exits 0 when a `from`
// path is missing, so a non-hoisting layout would silently drop the notices
// (verify-packaged-app.mjs then fails far from the cause). resolve() finds the
// package wherever the installer placed it — hoisted or nested.
const require = createRequire(import.meta.url);
function resolvePackageFile(packageName, relativePath) {
  return join(dirname(require.resolve(`${packageName}/package.json`)), relativePath);
}

async function stageReleaseManifests({ packager }) {
  const stage = await packager.info.tempDirManager.createTempDir({
    prefix: 'maka-release-manifests',
  });
  for (const name of ['mcp', 'runtime', 'runtime-host']) {
    const directory = join(stage, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify(workspaceReleaseManifest(readManifest(`../../packages/${name}/package.json`)), null, 2)}\n`,
    );
  }
  packager.config.files.push({ from: stage, to: 'node_modules/@maka' });
}

const rootManifest = readManifest('../../package.json');
const { runtimeHostSetupPackage } = resolveProductManifestIdentity({
  rootManifest,
  desktopManifest: readManifest('./package.json'),
  cliManifest: readManifest('../../packages/cli/package.json'),
});

const baseDesktopBuilderConfig = {
  appId: 'com.maka.desktop',
  productName: 'Maka',
  artifactName: 'Maka-${version}-mac-${arch}.${ext}',
  asar: true,
  beforePack: stageReleaseManifests,
  extraMetadata: { runtimeHostSetupPackage, makaUpdateChannel: 'release' },
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
    '!node_modules/@maka/{mcp,runtime,runtime-host}/package.json',
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
      // The app icon is read at runtime by the BrowserWindow `icon` option
      // and by the permission-overlay card, and `files` above does not carry
      // `assets/`. Electron reports the missing file as an empty image rather
      // than an error, so without this the packaged app just draws no window
      // icon; `assertPackagedResources` requires it on current builds.
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
    {
      from: '../../native/runtime-host-peer/target/release/maka_runtime_host_peer.node',
      to: 'runtime-host-peer/maka_runtime_host_peer.node',
    },
    {
      from: '../../packages/cli/RUNTIME_HOST_PEER_THIRD_PARTY_NOTICES.txt',
      to: 'licenses/runtime-host-peer/THIRD_PARTY_NOTICES.txt',
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
      from: resolvePackageFile('electron', 'dist/LICENSE'),
      to: 'licenses/electron/LICENSE',
    },
    {
      from: resolvePackageFile('electron', 'dist/LICENSES.chromium.html'),
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
      from: resolvePackageFile('@fontsource-variable/geist', 'LICENSE'),
      to: 'licenses/renderer/GEIST_LICENSE.txt',
    },
    {
      from: resolvePackageFile('@fontsource-variable/geist-mono', 'LICENSE'),
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
  // No `target` here, or in `win`/`linux` below: electron-builder ignores the
  // command line's architecture flags for any target the configuration names
  // (targetFactory.computeArchToTargetNamesMap only falls back to the CLI when
  // `target.arch` is absent, and returns the CLI map untouched when the CLI
  // named targets). Declaring targets in both places lets them disagree, and a
  // configured `arch` silently wins — which would build every architecture on
  // every runner. The packaging scripts in package.json name the target and the
  // architecture together and are the single authority for both.
  mac: {
    category: 'public.app-category.productivity',
    // The bundle icon is what Finder, Launchpad and the installer show, and
    // none of those run our code — so it cannot follow the user's choice and
    // has to be the shipped default. `assets/icon.png` is the original mascot
    // mark, which is still selectable as the `default` id but is no longer the
    // default; pointing the bundle at it would leave every surface outside the
    // running app on the old artwork. Kept in step with `DEFAULT_APP_ICON` by
    // a test in scripts/verify-packaged-app-icons.test.mjs.
    icon: 'assets/app-icons/sky.png',
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
    title: 'Maka Installer',
    // Relative to electron-builder's default buildResources directory (build/).
    background: 'background.png',
    window: { width: 540, height: 380 },
    iconSize: 112,
    iconTextSize: 16,
    contents: [
      { x: 130, y: 190, type: 'file' },
      { x: 410, y: 190, type: 'link', path: '/Applications' },
    ],
    sign: true,
    // Stapling the notarization ticket after electron-builder exits changes the
    // DMG bytes. macOS updates use the ZIP, so do not publish a stale DMG hash
    // in latest-mac.yml.
    writeUpdateInfo: false,
  },
  win: {
    artifactName: 'Maka-${version}-win-${arch}.${ext}',
    // Same reason as `mac.icon` above: the .exe, the installer and the
    // shortcut are drawn by the OS from this file, not by us.
    icon: 'assets/app-icons/sky.png',
    // No Authenticode certificate yet. Being unsigned is the absence of one:
    // electron-builder skips signing when no certificate is configured, and
    // `forceCodeSigning` is left off so that skip is not an error. Nothing here
    // turns update signature verification off, because nothing has to: without a
    // certificate there is no publisher name to put in app-update.yml, and
    // electron-updater skips the check when there is none. Adding a certificate
    // is then the whole change — the verification follows it.
  },
  linux: {
    // `${arch}` is not the Node architecture name here: electron-builder maps it
    // through builder-util's getArtifactArchName, so x64 becomes `x86_64` for the
    // AppImage and `amd64` for the deb. scripts/desktop-release-targets.mjs
    // records those names and a test pins them to electron-builder's own mapping.
    artifactName: 'Maka-${version}-linux-${arch}.${ext}',
    // Same reason as `mac.icon` above: the launcher entry and the window
    // decoration are drawn by the desktop environment from this file, not by
    // the running app, so it cannot follow the user's icon choice.
    icon: 'assets/app-icons/sky.png',
    category: 'Development',
    // Without this electron-builder names the binary after the npm package, and
    // this one is scoped: `@maka/desktop` sanitizes to `@makadesktop`, which is
    // not a name a desktop entry's `Exec=` can launch. Only Linux derives an
    // executable name this way, which is why macOS and Windows never showed it.
    executableName: 'maka',
    // Electron takes its app_id — the window's WM_CLASS — from `desktopName` in
    // the manifest, while the desktop entry's `StartupWMClass` falls back to the
    // product name when that field is absent. `Maka` and `maka` never match, so
    // the desktop environment cannot link a running window to the installed
    // launcher: generic icon, and pinning it does nothing. Setting both keeps
    // the entry's filename and the app_id derived from the same string.
    syncDesktopName: true,
    // fpm refuses to build a deb without a maintainer, and the field must
    // carry an address. The project list is the only stable one; no individual
    // owns the package.
    maintainer: 'Apache Maka (incubating) <dev@maka.apache.org>',
  },
  nsis: {
    // Everything stays at the one-click per-user defaults; the include only
    // adds the Abort-path pre-upgrade backup/rollback (and its test-only
    // deterministic failpoint) — see build/installer.nsh for the mechanism
    // and its exit-code contract with verify-windows-installer-rollback.mjs.
    include: 'build/installer.nsh',
  },
  publish: [
    {
      provider: 'github',
      owner: 'apache',
      repo: 'maka',
    },
  ],
};

export function resolveDesktopBuilderConfig(environment = process.env) {
  const nightlyVersion = environment.MAKA_DESKTOP_NIGHTLY_VERSION?.trim();
  if (!nightlyVersion) return baseDesktopBuilderConfig;
  const version = resolveDesktopBuildVersion(rootManifest.version, environment);
  return {
    ...baseDesktopBuilderConfig,
    extraMetadata: {
      ...baseDesktopBuilderConfig.extraMetadata,
      version,
      runtimeHostSetupPackage: resolveRuntimeHostSetupPackage(rootManifest.version, environment),
      makaUpdateChannel: 'nightly',
    },
    publish: [{ provider: 'github', owner: 'apache', repo: 'maka', channel: 'dev' }],
  };
}

export default resolveDesktopBuilderConfig();
