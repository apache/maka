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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import {
  appEntitlements,
  appIcons,
  appInfo,
  archiveIpa,
  decodeIconPng,
  extractSigningLeaf,
  signSimulatorApp,
  stageLocalizations,
  options,
  validateIpa,
  validateProfileCertificate,
  validateProfileExpiry,
} from './package-ios.mjs';

test('device and simulator use their own platform and deployment target', () => {
  for (const [target, platform, profile, triple] of [
    ['ios', 'iPhoneOS', 'release', 'aarch64-apple-ios'],
    ['ios-simulator', 'iPhoneSimulator', 'dev', 'aarch64-apple-ios-sim'],
  ]) {
    const settings = options(['--target', target, '--app-version', '1.2.3'], {});
    const info = appInfo(settings);
    assert.equal(settings.profile, profile);
    assert.equal(settings.triple, triple);
    assert.deepEqual(info.CFBundleSupportedPlatforms, [platform]);
    assert.equal(info.MinimumOSVersion, '15.0');
    assert.deepEqual(info.UIDeviceFamily, [1, 2]);
    assert.deepEqual(info['CFBundleIcons~ipad'].CFBundlePrimaryIcon.CFBundleIconFiles, [
      'AppIcon76',
      'AppIcon83.5',
    ]);
    assert.equal(info.CFBundleDevelopmentRegion, 'en');
    assert.deepEqual(info.CFBundleLocalizations, [
      'en',
      'zh-Hans',
      'zh-Hant',
      'zh-HK',
      'ja',
      'ko',
      'es',
      'fr',
      'de',
      'pt-BR',
      'ru',
      'it',
    ]);
    assert.equal(info.CFBundleExecutable, 'maka-ios-shell');
    assert.equal(info.CFBundleShortVersionString, '1.2.3');
    assert.deepEqual(info.CFBundleURLTypes[0].CFBundleURLSchemes, ['maka']);
    assert.equal(info.NSCameraUsageDescription, 'Scan a QR code to pair with your Maka Host.');
    assert.deepEqual(info.NSAppTransportSecurity, {
      NSAllowsLocalNetworking: true,
    });
  }
});

const iconSizes = {
  'AppIcon60@2x.png': 120,
  'AppIcon60@3x.png': 180,
  'AppIcon76@2x.png': 152,
  'AppIcon83.5@2x.png': 167,
};

function checkIcons(source, background) {
  const icons = appIcons(source);
  assert.deepEqual(icons.map(([name]) => name).sort(), Object.keys(iconSizes).sort());
  return icons.map(([name, png]) => {
    const size = iconSizes[name];
    assert.equal(png[25], 2, `${name} must be an RGB PNG`);
    const { width, height, pixels } = decodeIconPng(png);
    assert.deepEqual([width, height], [size, size], name);
    const pixel = (x, y) => {
      const i = (y * width + x) * 3;
      return [...pixels.subarray(i, i + 3)];
    };
    const edge = size - 1;
    for (const [x, y] of [
      [0, 0],
      [edge, 0],
      [0, edge],
      [edge, edge],
    ])
      assert.deepEqual(pixel(x, y), background, `${name} corner (${x}, ${y})`);
    return { size, pixel };
  });
}

test('bundled logo generates opaque RGB icons with blue corners at every iOS size', async () => {
  const source = await readFile(new URL('../../assets/logo.png', import.meta.url));
  checkIcons(source, [71, 163, 226]);
});

function roundedIconFixture() {
  const rows = [
    '....B...',
    '..####..',
    '.######.',
    '.##++##.',
    '.##++##.',
    '.######.',
    '..####..',
    '........',
  ];
  const colors = {
    '.': [0, 0, 0, 0],
    B: [30, 80, 180, 0],
    '#': [230, 120, 40, 255],
    '+': [230, 120, 40, 128],
  };
  const scanlines = Buffer.from(
    rows.flatMap((row) => {
      const rgba = [...row].flatMap((key) => colors[key]);
      // Use the PNG Sub filter to exercise a filtered source.
      return [1, ...rgba.map((value, i) => value - (i < 4 ? 0 : rgba[i - 4]))];
    }),
  );
  const chunk = (name, data) => {
    const tagAndData = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4);
    const crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(tagAndData));
    return Buffer.concat([length, tagAndData, crc]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.from([0, 0, 0, 8, 0, 0, 0, 8, 8, 6, 0, 0, 0])),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('rounded transparent icon samples top-middle RGB and composites partial alpha', () => {
  for (const { size, pixel } of checkIcons(roundedIconFixture(), [30, 80, 180])) {
    const middle = Math.floor(size / 2);
    assert.deepEqual(pixel(middle, middle), [130, 100, 110]);
    assert.deepEqual(pixel(middle, Math.floor(size / 4)), [230, 120, 40]);
  }
});

test('rejects half-configured signing without building', () => {
  assert.throws(
    () => options(['--target', 'ios', '--sign', 'Apple Development'], {}),
    /requires both/,
  );
  assert.throws(
    () =>
      options(['--target', 'ios'], {
        APPLE_IOS_PROVISIONING_PROFILE_PATH: '/tmp/profile',
      }),
    /requires both/,
  );
  const signed = options(
    ['--target', 'ios', '--sign', 'Apple Distribution', '--profile-file', '/tmp/profile'],
    {},
  );
  assert.deepEqual(signed.signing, {
    identity: 'Apple Distribution',
    provisioning: '/tmp/profile',
  });
  assert.equal(options(['--target', 'ios'], {}).signing, null);
});

test('validates target and simulator launch arguments', () => {
  assert.throws(() => options([], {}), /--target/);
  assert.throws(() => options(['--target', 'ios', '--run'], {}), /ios-simulator/);
  assert.throws(() => options(['--target', 'ios-simulator', '--device', 'phone'], {}), /--run/);
  assert.throws(
    () => options(['--target', 'ios-simulator', '--run', '--appearance', 'night'], {}),
    /light or dark/,
  );
  assert.throws(
    () => options(['--target', 'ios-simulator', '--run', '--pair-uri', 'https://other'], {}),
    /pairing URI/,
  );
  assert.throws(() => options(['--target', 'ios', '--app-version', '1.2.3-dev'], {}), /numeric/);
  assert.throws(
    () => options(['--target', 'ios', '--release', '--profile', 'dev'], {}),
    /cannot be combined/,
  );
  assert.equal(options(['--target', 'ios-simulator', '--release'], {}).profile, 'release');
});

test('uses the exact app identifier allowed by the provisioning profile', () => {
  const profile = {
    ApplicationIdentifierPrefix: ['TEAM'],
    Entitlements: {
      'application-identifier': 'TEAM.org.apache.*',
      'com.apple.developer.team-identifier': 'TEAM',
      'get-task-allow': true,
      'aps-environment': 'production',
    },
  };
  assert.deepEqual(appEntitlements(profile, 'org.apache.maka.ios'), {
    'application-identifier': 'TEAM.org.apache.maka.ios',
    'com.apple.developer.team-identifier': 'TEAM',
    'get-task-allow': true,
  });
  assert.throws(() => appEntitlements(profile, 'org.example.other'), /does not allow/);
  profile.Entitlements['beta-reports-active'] = true;
  assert.equal(appEntitlements(profile, 'org.apache.maka.ios')['beta-reports-active'], true);
  profile.Entitlements['beta-reports-active'] = false;
  assert.equal(
    Object.hasOwn(appEntitlements(profile, 'org.apache.maka.ios'), 'beta-reports-active'),
    false,
  );
});

test('ditto stages a standard Payload archive and a portable SHA-256 file', {
  skip: process.platform !== 'darwin' && 'ditto is an Apple tool',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-ios-package-test-'));
  try {
    const payload = join(dir, 'Payload');
    const app = join(payload, 'Maka.app');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'maka-ios-shell'), 'binary fixture', {
      mode: 0o755,
    });
    const ipa = join(dir, 'Maka-ios-arm64.ipa');
    await assert.rejects(archiveIpa(payload, ipa), /IPA missing Payload\/Maka.app\/Info.plist/);
    await rm(ipa);
    await writeFile(join(app, 'Info.plist'), '<fixture />');
    await assert.rejects(archiveIpa(payload, ipa), /IPA missing Payload\/Maka.app\/LICENSE/);
    await rm(ipa);
    await writeFile(join(app, 'LICENSE'), 'license fixture');
    await writeFile(join(app, 'NOTICE'), 'notice fixture');
    await archiveIpa(payload, ipa);
    validateIpa(ipa);
    const entries = execFileSync('unzip', ['-Z1', ipa], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(entries.sort(), [
      'Payload/',
      'Payload/Maka.app/',
      'Payload/Maka.app/Info.plist',
      'Payload/Maka.app/LICENSE',
      'Payload/Maka.app/NOTICE',
      'Payload/Maka.app/maka-ios-shell',
    ]);
    const digest = createHash('sha256')
      .update(await readFile(ipa))
      .digest('hex');
    assert.equal(await readFile(ipa + '.sha256', 'utf8'), `${digest}  Maka-ios-arm64.ipa\n`);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('rejects expired profiles and signing identities whose leaf is absent', () => {
  const now = Date.parse('2027-01-01T00:00:00Z');
  validateProfileExpiry('2027-01-02T00:00:00Z', now);
  assert.throws(() => validateProfileExpiry('2027-01-01T00:00:00Z', now), /expired/);
  assert.throws(() => validateProfileExpiry('not a date', now), /valid expiration/);
  const leaf = Buffer.from([1, 2, 3]);
  validateProfileCertificate([Buffer.from([2]), Buffer.from([1, 2, 3])], leaf);
  assert.throws(() => validateProfileCertificate([Buffer.from([0, 1])], leaf), /not listed/);
});

test('extracts the leaf certificate from a signed macOS binary', {
  skip: process.platform !== 'darwin',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-signing-leaf-'));
  try {
    const leaf = await extractSigningLeaf('/usr/bin/true', join(dir, 'leaf'));
    assert.ok(leaf.length > 0);
    assert.deepEqual(leaf, await readFile(join(dir, 'leaf0')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ad-hoc simulator signing produces no entitlements', {
  skip: process.platform !== 'darwin',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-signing-sim-'));
  try {
    const binary = join(dir, 'simulator-fixture');
    await copyFile('/usr/bin/true', binary);
    signSimulatorApp(binary);
    const entitlements = execFileSync('codesign', ['-d', '--entitlements', '-', binary], {
      encoding: 'utf8',
    });
    assert.equal(entitlements.trim(), '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stages localized network and camera prompts for every Apple bundle localization', {
  skip: process.platform !== 'darwin',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-localized-plist-'));
  try {
    await stageLocalizations(dir);
    const info = appInfo(options(['--target', 'ios', '--app-version', '1.2.3'], {}));
    const localizedDescription = (tag, field) =>
      execFileSync(
        'plutil',
        ['-extract', field, 'raw', '-o', '-', join(dir, tag + '.lproj', 'InfoPlist.strings')],
        { encoding: 'utf8' },
      ).trim();
    for (const field of ['NSLocalNetworkUsageDescription', 'NSCameraUsageDescription']) {
      assert.equal(localizedDescription('en', field), info[field]);
      for (const tag of info.CFBundleLocalizations.filter((tag) => tag !== 'en')) {
        const description = localizedDescription(tag, field);
        assert.ok(description, `${tag}: ${field} is empty`);
        assert.notEqual(description, info[field], `${tag}: ${field} fell back to English`);
      }
      assert.notEqual(localizedDescription('zh-HK', field), localizedDescription('zh-Hant', field));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
