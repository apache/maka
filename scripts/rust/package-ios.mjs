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
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import localeManifest from '../../locales.manifest.json' with { type: 'json' };
import { cargoBuild } from './cargo.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executable = 'maka-ios-shell';
const legalResources = ['LICENSE', 'NOTICE'];
const ipaName = 'Maka-ios-arm64.ipa';
const minimumOS = '15.0';
const localizedUsageDescriptions = {
  NSLocalNetworkUsageDescription: 'Connect to your Maka Host and discover a direct connection.',
  NSCameraUsageDescription: 'Scan a QR code to pair with your Maka Host.',
};
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

const icon = (...names) => ({ CFBundlePrimaryIcon: { CFBundleIconFiles: names } });

export function appInfo({ platform, bundleId, appVersion, buildNumber }) {
  validateVersion(appVersion);
  return {
    CFBundleDevelopmentRegion: localeManifest.defaultLocale,
    CFBundleLocalizations: localeManifest.locales.map(({ appleLocalization }) => appleLocalization),
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
    'CFBundleIcons~ipad': icon('AppIcon76', 'AppIcon83.5'),
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
    ...localizedUsageDescriptions,
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
    ...(allowed['beta-reports-active'] === true ? { 'beta-reports-active': true } : {}),
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
  for (const file of ['Info.plist', executable, ...legalResources]) {
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

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(left, up, upperLeft) {
  const p = left + up - upperLeft;
  const a = Math.abs(p - left);
  const b = Math.abs(p - up);
  const c = Math.abs(p - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

export function decodeIconPng(png) {
  if (
    png.length < 33 ||
    !png.subarray(0, 8).equals(pngSignature) ||
    png.readUInt32BE(8) !== 13 ||
    png.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('Invalid app icon PNG header');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25];
  if (
    !width ||
    !height ||
    png[24] !== 8 ||
    (colorType !== 2 && colorType !== 6) ||
    png[26] !== 0 ||
    png[27] !== 0 ||
    png[28] !== 0
  )
    throw new Error('App icon must be a non-interlaced 8-bit RGB or RGBA PNG');

  const channels = colorType === 6 ? 4 : 3;
  const idat = [];
  let ended = false;
  for (let offset = 8; offset + 12 <= png.length; ) {
    const size = png.readUInt32BE(offset);
    const end = offset + 8 + size;
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (end + 4 > png.length || crc32(png.subarray(offset + 4, end)) !== png.readUInt32BE(end))
      throw new Error(`Invalid app icon PNG chunk: ${type}`);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, end));
    if (type === 'tRNS') throw new Error('App icon PNG does not support a transparency key');
    if (type === 'IEND') {
      ended = true;
      break;
    }
    offset = end + 4;
  }
  if (!ended || !idat.length) throw new Error('Incomplete app icon PNG');

  const stride = width * channels;
  const length = (stride + 1) * height;
  const rows = inflateSync(Buffer.concat(idat), { maxOutputLength: length });
  if (rows.length !== length) throw new Error('Invalid app icon PNG data length');
  const pixels = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    const filter = rows[row];
    if (filter > 4) throw new Error(`Invalid app icon PNG filter: ${filter}`);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= channels ? pixels[i - channels] : 0;
      const up = y ? pixels[i - stride] : 0;
      const upperLeft = y && x >= channels ? pixels[i - stride - channels] : 0;
      let prediction = 0;
      switch (filter) {
        case 1:
          prediction = left;
          break;
        case 2:
          prediction = up;
          break;
        case 3:
          prediction = (left + up) >> 1;
          break;
        case 4:
          prediction = paeth(left, up, upperLeft);
          break;
      }
      pixels[i] = rows[row + 1 + x] + prediction;
    }
  }
  return { width, height, channels, pixels };
}

function pngChunk(type, data) {
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function resizeRgbIcon({ pixels, width, height, channels }, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = size * 3 + 1;
  const rows = Buffer.alloc(stride * size);
  // Average the exact source area covered by each output pixel.
  for (let y = 0; y < size; y++) {
    const top = y * height;
    const bottom = top + height;
    for (let x = 0; x < size; x++) {
      const left = x * width;
      const right = left + width;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = Math.floor(top / size); sy * size < bottom; sy++) {
        const dy = Math.min(bottom, (sy + 1) * size) - Math.max(top, sy * size);
        for (let sx = Math.floor(left / size); sx * size < right; sx++) {
          const weight = dy * (Math.min(right, (sx + 1) * size) - Math.max(left, sx * size));
          const i = (sy * width + sx) * channels;
          r += pixels[i] * weight;
          g += pixels[i + 1] * weight;
          b += pixels[i + 2] * weight;
        }
      }
      const area = width * height;
      const i = y * stride + 1 + x * 3;
      rows[i] = Math.round(r / area);
      rows[i + 1] = Math.round(g / area);
      rows[i + 2] = Math.round(b / area);
    }
  }
  return Buffer.concat([
    pngSignature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function appIcons(source) {
  const image = decodeIconPng(source);
  const { pixels, channels, width } = image;
  if (channels === 4) {
    // The logo stores its background RGB at the top center even where alpha is zero.
    const topMiddle = Math.floor(width / 2) * channels;
    const background = [...pixels.subarray(topMiddle, topMiddle + 3)];
    for (let i = 0; i < pixels.length; i += channels) {
      const alpha = pixels[i + 3];
      if (alpha === 255) continue;
      for (let c = 0; c < 3; c++)
        pixels[i + c] = Math.round((pixels[i + c] * alpha + background[c] * (255 - alpha)) / 255);
    }
  }
  return [
    [120, 'AppIcon60@2x'],
    [180, 'AppIcon60@3x'],
    [152, 'AppIcon76@2x'],
    [167, 'AppIcon83.5@2x'],
  ].map(([size, name]) => [`${name}.png`, resizeRgbIcon(image, size)]);
}

export async function stageLocalizations(app) {
  const catalogs = new Map();
  const directory = join(root, 'products/maka/ios-shell/locales');
  for (const { tag } of localeManifest.locales) {
    catalogs.set(tag, JSON.parse(await readFile(join(directory, tag + '.json'), 'utf8')));
  }
  for (const { tag, appleLocalization, fallbacks } of localeManifest.locales) {
    const descriptions = {};
    for (const [field, message] of Object.entries(localizedUsageDescriptions)) {
      const name = [tag, ...fallbacks].find((locale) =>
        Object.hasOwn(catalogs.get(locale), message),
      );
      if (!name) throw new Error(`Missing ${field} for ${tag}`);
      descriptions[field] = catalogs.get(name)[message];
    }
    const directory = join(app, `${appleLocalization}.lproj`);
    await mkdir(directory);
    await writeFile(join(directory, 'InfoPlist.strings'), plist(descriptions));
  }
}

async function stageApp(app, binary, settings) {
  await mkdir(app, { recursive: true });
  await copyFile(binary, join(app, executable));
  await chmod(join(app, executable), 0o755);
  for (const file of legalResources) await copyFile(join(root, file), join(app, file));
  await writeFile(join(app, 'Info.plist'), plist(appInfo(settings)));
  await stageLocalizations(app);
  for (const [name, png] of appIcons(await readFile(join(root, 'assets/logo.png'))))
    await writeFile(join(app, name), png);
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
    } catch {
      // Both the command arguments and simctl diagnostics may contain the invitation.
      throw new Error('Simulator could not open the pairing link');
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
