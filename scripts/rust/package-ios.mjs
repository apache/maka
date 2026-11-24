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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { cargoBuild } from './cargo.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executable = 'maka-ios-shell';
const ipaName = 'Maka-ios-arm64.ipa';
const minimumOS = '15.0';
const targets = {
  ios: {
    triple: 'aarch64-apple-ios',
    platform: 'iPhoneOS',
    profile: 'release',
  },
  'ios-simulator': {
    triple: 'aarch64-apple-ios-sim',
    platform: 'iPhoneSimulator',
    profile: 'dev',
  },
};

export function options(args, env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: 'string' },
      profile: { type: 'string' },
      release: { type: 'boolean' },
      out: { type: 'string' },
      'app-version': { type: 'string' },
      'build-number': { type: 'string' },
      'bundle-id': { type: 'string' },
      sign: { type: 'string' },
      'sign-app': { type: 'string' },
      'profile-file': { type: 'string' },
      run: { type: 'boolean' },
      device: { type: 'string' },
      'pair-uri': { type: 'string' },
      'support-dir': { type: 'string' },
      appearance: { type: 'string' },
    },
  });
  if (!Object.hasOwn(targets, values.target))
    throw new Error('--target must be ios or ios-simulator');
  const target = targets[values.target];
  const simulator = values.target === 'ios-simulator';
  for (const [name, value] of Object.entries(values))
    if (value === '') throw new Error(`--${name} cannot be empty`);
  if (values.release && values.profile)
    throw new Error('--release and --profile cannot be combined');
  const launchOptions = ['device', 'pair-uri', 'support-dir', 'appearance'];
  if (!simulator && (values.run || launchOptions.some((key) => values[key])))
    throw new Error('Launch options require --target ios-simulator');
  if (!values.run && launchOptions.some((key) => values[key]))
    throw new Error('Simulator launch options require --run');
  if (values.appearance && !['light', 'dark'].includes(values.appearance))
    throw new Error('--appearance must be light or dark');
  if (values['pair-uri'] && !/^maka:\/\/pair\/v1\?payload=[A-Za-z0-9_-]+$/.test(values['pair-uri']))
    throw new Error('--pair-uri must be a Maka pairing URI');

  if (simulator && (values.sign || values['profile-file']))
    throw new Error('Simulator builds are always ad-hoc signed');
  const identity = !simulator && (values.sign ?? env.APPLE_IOS_SIGN_IDENTITY);
  const provisioning =
    !simulator && (values['profile-file'] ?? env.APPLE_IOS_PROVISIONING_PROFILE_PATH);
  if (Boolean(identity) !== Boolean(provisioning))
    throw new Error('iOS signing requires both a signing identity and a provisioning profile');

  if (values['sign-app'] && (simulator || !identity))
    throw new Error('--sign-app requires device signing credentials');
  const bundleId = values['bundle-id'] ?? 'org.apache.maka.ios';
  if (!/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(bundleId))
    throw new Error('--bundle-id must be a reverse-DNS identifier');
  const buildNumber = values['build-number'] ?? '1';
  if (!/^\d+(?:\.\d+){0,2}$/.test(buildNumber))
    throw new Error('--build-number must have one to three numeric components');
  if (values['app-version']) validateVersion(values['app-version']);
  return {
    ...target,
    simulator,
    profile: values.release ? 'release' : (values.profile ?? target.profile),
    out: resolve(values.out ?? join(root, 'dist', values.target)),
    appVersion: values['app-version'],
    buildNumber,
    bundleId,
    signApp: values['sign-app'] && resolve(values['sign-app']),
    signing: identity ? { identity, provisioning: resolve(provisioning) } : null,
    run: values.run,
    device: values.device,
    pairUri: values['pair-uri'],
    supportDir: values['support-dir'] && resolve(values['support-dir']),
    appearance: values.appearance,
  };
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('iOS app version must have exactly three numeric components');
}

function plist(value) {
  const xml = (value) => {
    if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`;
    if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
    if (Number.isInteger(value)) return `<integer>${value}</integer>`;
    if (typeof value === 'string') {
      const escaped = value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
      return `<string>${escaped}</string>`;
    }
    return `<dict>${Object.entries(value)
      .map(([key, item]) => `<key>${key}</key>${xml(item)}`)
      .join('')}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${xml(value)}
</plist>
`;
}

const icon = (name) => ({ CFBundlePrimaryIcon: { CFBundleIconFiles: [name] } });

export function appInfo({ platform, bundleId, appVersion, buildNumber }) {
  validateVersion(appVersion);
  return {
    CFBundleDevelopmentRegion: 'en',
    CFBundleName: 'Maka',
    CFBundleDisplayName: 'Maka',
    CFBundleExecutable: executable,
    CFBundleIdentifier: bundleId,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: appVersion,
    CFBundleVersion: buildNumber,
    CFBundleSupportedPlatforms: [platform],
    CFBundleIcons: icon('AppIcon60'),
    'CFBundleIcons~ipad': icon('AppIcon76'),
    UIDeviceFamily: [1, 2],
    MinimumOSVersion: minimumOS,
    UIApplicationSceneManifest: { UIApplicationSupportsMultipleScenes: false },
    UILaunchScreen: {},
    CADisableMinimumFrameDurationOnPhone: true,
    CFBundleURLTypes: [
      {
        CFBundleURLName: bundleId,
        CFBundleTypeRole: 'Editor',
        CFBundleURLSchemes: ['maka'],
      },
    ],
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    NSLocalNetworkUsageDescription: 'Connect to your Maka Host and discover a direct connection.',
  };
}

function command(bin, args, opts) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts,
  });
}

export function appEntitlements(profile, bundleId) {
  const allowed = profile.Entitlements ?? {};
  const prefix = profile.ApplicationIdentifierPrefix?.[0];
  const team = allowed['com.apple.developer.team-identifier'];
  if (!prefix || !team)
    throw new Error('Provisioning profile lacks an app identifier prefix or team');
  const appId = `${prefix}.${bundleId}`;
  const pattern = allowed['application-identifier'];
  if (
    typeof pattern !== 'string' ||
    (pattern.endsWith('*') ? !appId.startsWith(pattern.slice(0, -1)) : pattern !== appId)
  )
    throw new Error('Provisioning profile does not allow this bundle identifier');
  return {
    'application-identifier': appId,
    'com.apple.developer.team-identifier': team,
    'get-task-allow': allowed['get-task-allow'] === true,
  };
}

export async function extractSigningLeaf(binary, prefix) {
  command('codesign', ['-d', `--extract-certificates=${prefix}`, binary]);
  return readFile(prefix + '0');
}

export function signSimulatorApp(app) {
  command('codesign', ['--force', '--sign', '-', app]);
  command('codesign', ['--verify', '--strict', app]);
}

export function validateProfileExpiry(expiration, now = Date.now()) {
  const expires = Date.parse(expiration);
  if (!Number.isFinite(expires) || expires <= now)
    throw new Error('Provisioning profile is expired or lacks a valid expiration date');
}

export function validateProfileCertificate(certificates, leaf) {
  if (!certificates.some((candidate) => candidate.equals(leaf)))
    throw new Error('Signing leaf certificate is not listed in the provisioning profile');
}

async function signApp(app, signing, bundleId, staging) {
  const profile = join(app, 'embedded.mobileprovision');
  await copyFile(signing.provisioning, profile);
  const decoded = command('security', ['cms', '-D', '-i', profile]);
  // The full profile contains dates and certificate data, which aren't JSON values.
  const extract = (key, format = 'json') =>
    command('plutil', ['-extract', key, format, '-o', '-', '--', '-'], {
      input: decoded,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
  validateProfileExpiry(extract('ExpirationDate', 'raw').trim());
  const certificates = Array.from(
    extract('DeveloperCertificates', 'xml1').matchAll(/<data>([A-Za-z0-9+/=\s]+)<\/data>/g),
    ([, encoded]) => Buffer.from(encoded, 'base64'),
  );
  if (!certificates.length) throw new Error('Provisioning profile has no developer certificates');
  const info = {
    ApplicationIdentifierPrefix: JSON.parse(extract('ApplicationIdentifierPrefix')),
    Entitlements: JSON.parse(extract('Entitlements')),
  };
  const entitlements = join(staging, 'entitlements.plist');
  await writeFile(entitlements, plist(appEntitlements(info, bundleId)));
  command('codesign', ['--force', '--sign', signing.identity, '--entitlements', entitlements, app]);
  command('codesign', ['--verify', '--strict', app]);
  const cert = join(staging, 'leaf');
  validateProfileCertificate(certificates, await extractSigningLeaf(app, cert));
}

export function validateIpa(path) {
  const entries = new Set(command('unzip', ['-Z1', path]).trimEnd().split('\n'));
  for (const file of ['Info.plist', executable]) {
    const entry = `Payload/Maka.app/${file}`;
    if (!entries.has(entry)) throw new Error(`IPA missing ${entry}`);
  }
}

export async function archiveIpa(payload, path) {
  command('ditto', ['-c', '-k', '--norsrc', '--keepParent', payload, path]);
  validateIpa(path);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  await writeFile(`${path}.sha256`, `${digest.digest('hex')}  ${ipaName}\n`);
}

async function stageApp(app, binary, settings) {
  await mkdir(app, { recursive: true });
  await copyFile(binary, join(app, executable));
  await chmod(join(app, executable), 0o755);
  await writeFile(join(app, 'Info.plist'), plist(appInfo(settings)));
  for (const [size, name] of [
    [120, 'AppIcon60@2x'],
    [180, 'AppIcon60@3x'],
    [152, 'AppIcon76@2x'],
  ])
    command('sips', [
      '-z',
      String(size),
      String(size),
      join(root, 'assets/logo.png'),
      '--out',
      join(app, `${name}.png`),
    ]);
  command('plutil', ['-lint', join(app, 'Info.plist')]);
}

function launch(settings, app) {
  const simctl = (args, opts) => command('xcrun', ['simctl', ...args], opts);
  const runtimes = JSON.parse(simctl(['list', 'devices', 'available', '-j'])).devices;
  const devices = Object.entries(runtimes)
    .filter(([runtime]) => runtime.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-'))
    .flatMap(([, devices]) => devices);
  const choice = settings.device
    ? devices.filter(({ udid, name }) => udid === settings.device || name === settings.device)
    : devices.filter(({ state }) => state === 'Booted');
  const booted = choice.filter(({ state }) => state === 'Booted');
  const candidates = booted.length ? booted : choice;
  if (candidates.length !== 1)
    throw new Error(
      'Select exactly one available simulator with --device <udid>, or boot one first',
    );
  const { udid, state } = candidates[0];
  if (state === 'Shutdown') simctl(['boot', udid]);
  simctl(['bootstatus', udid, '-b']);
  if (settings.appearance) simctl(['ui', udid, 'appearance', settings.appearance]);
  simctl(['install', udid, app]);
  const env = { ...process.env };
  if (settings.supportDir) env.SIMCTL_CHILD_MAKA_IOS_SUPPORT_DIR = settings.supportDir;
  simctl(['launch', '--terminate-running-process', udid, settings.bundleId], {
    env,
  });
  if (settings.pairUri) {
    try {
      simctl(['openurl', udid, settings.pairUri], { stdio: 'ignore' });
    } catch (cause) {
      // Both the command arguments and simctl diagnostics may contain the invitation.
      throw new Error('Simulator could not open the pairing link', { cause });
    }
  }
}

async function main(args) {
  const settings = options(args);
  if (process.platform !== 'darwin') throw new Error('iOS packaging requires macOS with Xcode');
  if (!settings.appVersion)
    settings.appVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  validateVersion(settings.appVersion);
  if (settings.signing) await readFile(settings.signing.provisioning);
  console.log(
    settings.simulator
      ? 'Building ad-hoc signed simulator app'
      : settings.signing
        ? 'Building provisioned iOS IPA'
        : 'Building unsigned iOS IPA (requires signing before installation)',
  );
  let binary;
  if (!settings.signApp) {
    const built = await cargoBuild(
      [
        'build',
        '--locked',
        '-p',
        executable,
        '--bin',
        executable,
        '--target',
        settings.triple,
        '--profile',
        settings.profile,
      ],
      {
        cwd: root,
        command: process.env.CARGO || 'cargo',
        env: { ...process.env, IPHONEOS_DEPLOYMENT_TARGET: minimumOS },
      },
    );
    if (built.code !== 0) throw new Error(`iOS Rust build failed: ${built.signal ?? built.code}`);
    binary = built.executables.get(executable)?.path;
    if (!binary) throw new Error('Cargo did not report the iOS executable');
  }

  await mkdir(settings.out, { recursive: true });
  const staging = await mkdtemp(join(settings.out, '.maka-ios-'));
  try {
    const payload = join(staging, 'Payload');
    const app = join(payload, 'Maka.app');
    if (settings.signApp) {
      await mkdir(payload);
      command('ditto', [settings.signApp, app]);
      const info = join(app, 'Info.plist');
      const platforms = JSON.parse(
        command('plutil', ['-extract', 'CFBundleSupportedPlatforms', 'json', '-o', '-', info]),
      );
      if (platforms.length !== 1 || platforms[0] !== 'iPhoneOS')
        throw new Error('--sign-app requires an iPhoneOS app');
      const bundleId = command('plutil', [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        info,
      ]).trim();
      if (bundleId !== settings.bundleId) throw new Error('--sign-app bundle identifier mismatch');
    } else {
      await stageApp(app, binary, settings);
    }
    if (settings.simulator) {
      signSimulatorApp(app);
    } else {
      if (settings.signing) await signApp(app, settings.signing, settings.bundleId, staging);
      const ipa = join(staging, ipaName);
      await archiveIpa(payload, ipa);
      await rename(ipa, join(settings.out, ipaName));
      await rename(`${ipa}.sha256`, join(settings.out, `${ipaName}.sha256`));
      console.log(join(settings.out, ipaName));
    }
    const outputApp = join(settings.out, 'Maka.app');
    await rm(outputApp, { recursive: true, force: true });
    await rename(app, outputApp);
    console.log(outputApp);
    if (settings.run) launch(settings, outputApp);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
