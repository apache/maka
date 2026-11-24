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
import {
  appEntitlements,
  appInfo,
  archiveIpa,
  extractSigningLeaf,
  signSimulatorApp,
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
    assert.equal(info.CFBundleExecutable, 'maka-ios-shell');
    assert.equal(info.CFBundleShortVersionString, '1.2.3');
    assert.deepEqual(info.CFBundleURLTypes[0].CFBundleURLSchemes, ['maka']);
    assert.deepEqual(info.NSAppTransportSecurity, {
      NSAllowsLocalNetworking: true,
    });
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
    await archiveIpa(payload, ipa);
    validateIpa(ipa);
    const entries = execFileSync('unzip', ['-Z1', ipa], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(entries.sort(), [
      'Payload/',
      'Payload/Maka.app/',
      'Payload/Maka.app/Info.plist',
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
