#!/usr/bin/env node
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

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const BUNDLE_ID = 'org.apache.maka.ios';
const APP_NAME = 'Maka';
const EXEC_NAME = 'maka-ios';

function parseArgs(argv) {
  const opts = {
    target: 'simulator',
    device: 'iPhone 18 Pro',
    pairUri: '',
    supportDir: '',
    buildOnly: false,
    release: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' && argv[i + 1]) opts.target = argv[++i];
    else if (a === '--device' && argv[i + 1]) opts.device = argv[++i];
    else if (a === '--pair-uri' && argv[i + 1]) opts.pairUri = argv[++i];
    else if (a === '--support-dir' && argv[i + 1]) opts.supportDir = argv[++i];
    else if (a === '--build-only') opts.buildOnly = true;
    else if (a === '--release') opts.release = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node run-ios.mjs [--target simulator|catalyst] [--device "iPhone 18 Pro"] [--pair-uri "maka://pair/v1?..."] [--support-dir DIR] [--release] [--build-only]',
      );
      process.exit(0);
    }
  }
  if (opts.target !== 'simulator' && opts.target !== 'catalyst') {
    throw new Error(`unsupported --target '${opts.target}' (use simulator or catalyst)`);
  }
  return opts;
}

function infoPlist(target) {
  const platformKeys =
    target === 'catalyst'
      ? `    <key>UIDeviceFamily</key><array><integer>6</integer></array>
    <key>LSMinimumSystemVersion</key><string>11.0</string>`
      : `    <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
    <key>MinimumOSVersion</key><string>15.0</string>
    <key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
    <key>UILaunchScreen</key><dict/>
    <key>CADisableMinimumFrameDurationOnPhone</key><true/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>${EXEC_NAME}</string>
    <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
    <key>CFBundleName</key><string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.2.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>UIApplicationSupportsMultipleScenes</key><false/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key><true/>
    </dict>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key><string>${BUNDLE_ID}.pair</string>
            <key>CFBundleURLSchemes</key>
            <array><string>maka</string></array>
        </dict>
    </array>
${platformKeys}
</dict>
</plist>
`;
}

function buildBinary(triple, release) {
  const cargoCmd = spawnSync('which', ['mbx']).status === 0 ? 'mbx' : 'cargo';
  const args = [
    'build',
    '--locked',
    '--target',
    triple,
    '-p',
    'maka-ios-shell',
    '--bin',
    EXEC_NAME,
  ];
  if (release) args.push('--release');
  console.log(`[maka-ios] Building ${triple} via ${cargoCmd}...`);
  execFileSync(cargoCmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      IPHONEOS_DEPLOYMENT_TARGET: '15.0',
    },
  });
  const profile = release ? 'release' : 'debug';
  const binPath = path.join(repoRoot, 'target', triple, profile, EXEC_NAME);
  if (!fs.existsSync(binPath)) {
    throw new Error(`built binary not found at ${binPath}`);
  }
  return binPath;
}

function installBinaryAtomic(src, dest) {
  const tmp = dest + '.tmp';
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
}

function codesignApp(appDir) {
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', appDir], {
    stdio: 'inherit',
  });
}

function pickSimulatorUdid(preferredName) {
  const raw = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(raw);
  const all = [];
  for (const [runtime, devices] of Object.entries(parsed.devices || {})) {
    if (!runtime.includes('iOS')) continue;
    for (const d of devices) {
      if (d.isAvailable) all.push(d);
    }
  }
  if (all.length === 0) {
    throw new Error(
      'No available iOS Simulator device found. Run: xcodebuild -downloadPlatform iOS',
    );
  }
  const booted = all.find((d) => d.state === 'Booted');
  if (booted) return booted;
  const exact = all.find((d) => d.name === preferredName);
  if (exact) return exact;
  const iphone = all.find((d) => d.name.includes('iPhone'));
  return iphone || all[0];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const triple = opts.target === 'catalyst' ? 'aarch64-apple-ios-macabi' : 'aarch64-apple-ios-sim';
  const binPath = buildBinary(triple, opts.release);

  const outRoot = path.join(repoRoot, 'target', 'ios-bundle', opts.target);
  const appDir = path.join(outRoot, 'MakaIos.app');

  if (opts.target === 'catalyst') {
    const contentsDir = path.join(appDir, 'Contents');
    const macosDir = path.join(contentsDir, 'MacOS');
    fs.mkdirSync(macosDir, { recursive: true });
    fs.writeFileSync(path.join(contentsDir, 'Info.plist'), infoPlist('catalyst'));
    installBinaryAtomic(binPath, path.join(macosDir, EXEC_NAME));
    codesignApp(appDir);
    console.log(`[maka-ios] Packaged Mac Catalyst app: ${appDir}`);
    if (opts.buildOnly) return;

    const env = { ...process.env };
    if (opts.pairUri) env.MAKA_IOS_PAIR_URI = opts.pairUri;
    if (opts.supportDir) env.MAKA_IOS_SUPPORT_DIR = opts.supportDir;
    const child = spawn(path.join(macosDir, EXEC_NAME), [], {
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(`[maka-ios] Launched Mac Catalyst app (pid ${child.pid})`);
    return;
  }

  // iOS Simulator bundle (flat .app)
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'Info.plist'), infoPlist('simulator'));
  installBinaryAtomic(binPath, path.join(appDir, EXEC_NAME));
  codesignApp(appDir);
  console.log(`[maka-ios] Packaged iOS Simulator app: ${appDir}`);
  if (opts.buildOnly) return;

  const device = pickSimulatorUdid(opts.device);
  console.log(`[maka-ios] Using Simulator: ${device.name} (${device.udid})`);
  if (device.state !== 'Booted') {
    execFileSync('xcrun', ['simctl', 'boot', device.udid], { stdio: 'inherit' });
  }
  const openedSim =
    spawnSync(
      'open',
      ['-b', 'com.apple.iphonesimulator', '--args', '-CurrentDeviceUDID', device.udid],
      {
        stdio: 'ignore',
      },
    ).status === 0;
  if (!openedSim) {
    const devDir = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' }).stdout?.trim();
    const hub = devDir ? path.resolve(devDir, '../Applications/DeviceHub.app') : '';
    if (hub && fs.existsSync(hub)) {
      spawnSync('open', [hub], { stdio: 'ignore' });
    } else {
      console.warn(
        '[maka-ios] Simulator window app not found; continuing headless on booted device.',
      );
    }
  }
  execFileSync('xcrun', ['simctl', 'bootstatus', device.udid, '-b'], { stdio: 'inherit' });
  execFileSync('xcrun', ['simctl', 'install', device.udid, appDir], { stdio: 'inherit' });

  const launchEnv = { ...process.env };
  if (opts.pairUri) launchEnv.SIMCTL_CHILD_MAKA_IOS_PAIR_URI = opts.pairUri;
  if (opts.supportDir) launchEnv.SIMCTL_CHILD_MAKA_IOS_SUPPORT_DIR = opts.supportDir;

  spawnSync('xcrun', ['simctl', 'terminate', device.udid, BUNDLE_ID], {
    stdio: 'ignore',
  });
  execFileSync('xcrun', ['simctl', 'launch', device.udid, BUNDLE_ID], {
    stdio: 'inherit',
    env: launchEnv,
  });
  console.log(`[maka-ios] Launched ${BUNDLE_ID} on ${device.name}`);
}

main();
