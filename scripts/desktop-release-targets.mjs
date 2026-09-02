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

import { linuxUpdateMetadataName } from './desktop-update-contract.mjs';

const MACOS_ARCHITECTURES = Object.freeze(['arm64', 'x64']);
const LINUX_ARCHITECTURES = Object.freeze(['x64', 'arm64']);

/**
 * `${arch}` in a Linux `artifactName` is the packaging ecosystem's spelling, not
 * the Node one: builder-util's getArtifactArchName rewrites x64 to `x86_64` for
 * an AppImage and to `amd64` for a deb, and leaves arm64 alone. Recorded here
 * because these names are what every other step looks for; the mapping itself is
 * pinned to electron-builder's own function by desktop-release-targets.test.mjs.
 */
const LINUX_ARTIFACT_ARCHITECTURES = Object.freeze({
  x64: Object.freeze({ AppImage: 'x86_64', deb: 'amd64' }),
  arm64: Object.freeze({ AppImage: 'arm64', deb: 'arm64' }),
});

/**
 * Every Desktop packaging runner, for either publication channel. A target is
 * one runner: `payloads` is what it uploads, `advertised` is the subset its
 * update feed offers, and `checksums` is the subset a formal release publishes
 * a `.sha256` beside. A checksum is issued only for a payload the platform's
 * verify script has opened and accepted, and the macOS script opens the DMG
 * alone — the ZIP is exercised end to end by the autoupdate verification, which
 * issues none — so the set is recorded here rather than derived from `payloads`.
 *
 * `feed` is per runner. On macOS that is not the name clients read: both
 * architectures build one feed between them, so the packaging step names each
 * one after its architecture and publication merges them back.
 */
export function desktopReleaseTargets(version, { nightly }) {
  const channel = nightly ? 'dev' : 'latest';
  const windowsExe = `Maka-${version}-win-x64.exe`;
  const windowsZip = `Maka-${version}-win-x64.zip`;
  return [
    ...MACOS_ARCHITECTURES.map((arch) => {
      const dmg = `Maka-${version}-mac-${arch}.dmg`;
      const zip = `Maka-${version}-mac-${arch}.zip`;
      return {
        name: `macos-${arch}`,
        platform: 'macos',
        arch,
        payloads: [dmg, zip, `${zip}.blockmap`],
        feed: `${channel}-mac-${arch}.yml`,
        advertised: [zip],
        checksums: [dmg],
      };
    }),
    {
      name: 'windows-x64',
      platform: 'windows',
      arch: 'x64',
      payloads: [windowsExe, `${windowsExe}.blockmap`, windowsZip],
      feed: `${channel}.yml`,
      advertised: [windowsExe],
      checksums: [windowsExe, windowsZip],
    },
    ...LINUX_ARCHITECTURES.map((arch) => {
      const names = LINUX_ARTIFACT_ARCHITECTURES[arch];
      const appImage = `Maka-${version}-linux-${names.AppImage}.AppImage`;
      const deb = `Maka-${version}-linux-${names.deb}.deb`;
      // Neither Linux distributable has a sidecar blockmap: electron-builder
      // appends the AppImage's block map to the AppImage itself, and fpm targets
      // have none at all.
      return {
        name: `linux-${arch}`,
        platform: 'linux',
        arch,
        payloads: [appImage, deb],
        feed: linuxUpdateMetadataName(arch, nightly),
        advertised: [appImage, deb],
        checksums: [appImage, deb],
      };
    }),
  ];
}

/**
 * The feeds a client actually reads. macOS is the one platform whose targets
 * collapse into a single feed; the rest publish what their runner produced.
 */
export function desktopPublishedFeeds(version, { nightly }) {
  const targets = desktopReleaseTargets(version, { nightly });
  const macos = targets.filter((target) => target.platform === 'macos');
  return [
    {
      name: `${nightly ? 'dev' : 'latest'}-mac.yml`,
      advertised: macos.flatMap((target) => target.advertised),
      mergedFrom: macos.map((target) => target.feed),
    },
    ...targets
      .filter((target) => target.platform !== 'macos')
      .map((target) => ({ name: target.feed, advertised: target.advertised, mergedFrom: null })),
  ];
}
