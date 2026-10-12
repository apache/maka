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
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { createPackage } from '@electron/asar';
import {
  FileMatcher,
  getMainFileMatchers,
  getNodeModuleFileMatcher,
} from 'app-builder-lib/out/fileMatcher.js';
import { NodeModuleCopyHelper } from 'app-builder-lib/out/util/NodeModuleCopyHelper.js';
import { computeFileSets } from 'app-builder-lib/out/util/appFileCopier.js';
import { doMergeConfigs } from 'app-builder-lib/out/util/config/config.js';
import { resolveDesktopBuilderConfig } from '../apps/desktop/electron-builder.config.mjs';
import {
  asarLookupPath,
  assertPackagedDependencyClosure,
  assertPackagedResources,
  stopChild,
} from './verify-packaged-app.mjs';

test('stopChild waits for a process that ignores SIGTERM to exit before returning', {
  skip: process.platform === 'win32',
}, async (t) => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.on('SIGTERM', () => {});
    process.send('ready');
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  });
  await once(child, 'message');
  await stopChild(child);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(child.exitCode, null);
  // A child already terminated by a signal is also stopped, even though its
  // numeric exitCode is null; stopping it again must not wait for another exit.
  await stopChild(child);
});

test('stopChild reports the pid when a child never exits after SIGKILL', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  let outcome;
  const stopped = stopChild(child).then(
    () => {
      outcome = 'resolved';
    },
    (error) => {
      outcome = error;
    },
  );
  assert.deepEqual(signals, ['SIGTERM']);
  t.mock.timers.tick(5_000);
  await new Promise(setImmediate);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  t.mock.timers.tick(9_999);
  await new Promise(setImmediate);
  assert.equal(outcome, undefined, 'wait for exit throughout the SIGKILL grace period');
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.ok(outcome instanceof Error, 'an unresponsive child must reject within 10 seconds');
  assert.match(outcome.message, /12345.*10_?000ms.*SIGKILL/);
  assert.equal(child.listenerCount('exit'), 0);
  await stopped;
});

test('Windows file rules keep test code and renderer side-files out of the app', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-app-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeFiles = [
    'package.json',
    'dist/main/index.js',
    'dist-renderer/index.html',
    'dist/renderer/computer-use-overlay/index.js',
  ];
  for (const name of [
    ...runtimeFiles,
    'dist/main/__tests__/about.test.js',
    'dist/main/test-only/bootstrap.js',
    'dist/renderer/agent-graph-panel.js',
    'scripts/plugins/codex-app-server-executor/index.mjs',
  ]) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, name);
  }
  // Config normalization runs before file matching in electron-builder.
  const base = resolveDesktopBuilderConfig({});
  const config = doMergeConfigs([{ ...base, files: [...base.files] }]);
  const packager = {
    config,
    projectDir: root,
    buildResourcesDir: 'build',
    debugLogger: { isEnabled: false },
  };
  const platformPackager = { info: packager };
  const output = join(root, 'release');
  const matchers = getMainFileMatchers(
    root,
    output,
    (s) => s,
    config.win,
    platformPackager,
    output,
    false,
  );
  const sets = await computeFileSets(matchers, null, platformPackager, false);
  const files = [
    ...new Set(
      sets.flatMap((set) => set.files).map((file) => relative(root, file).replaceAll('\\', '/')),
    ),
  ];
  assert.deepEqual(files.sort(), runtimeFiles.sort());
});

test('Desktop packaging keeps node-pty runtime files without its build intermediates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-pty-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleRoot = join(root, 'node_modules', 'node-pty');
  const runtimeFiles = [
    'package.json',
    'LICENSE',
    'lib/index.js',
    'lib/worker/conoutSocketWorker.js',
    'build/Release/conpty.node',
    'build/Release/conpty_console_list.node',
    'build/Release/pty.node',
    'build/Release/spawn-helper',
    'build/Release/conpty/conpty.dll',
    'build/Release/conpty/OpenConsole.exe',
    'prebuilds/win32-x64/conpty.node',
    'prebuilds/win32-x64/conpty/conpty.dll',
    'prebuilds/win32-x64/conpty/OpenConsole.exe',
  ];
  const buildFiles = [
    'build/conpty.vcxproj',
    'build/conpty.vcxproj.filters',
    'build/Release/conpty.exp',
    'build/Release/conpty.iobj',
    'build/Release/conpty.ipdb',
    'build/Release/obj/conpty/conpty.tlog/CL.command.1.tlog',
    'build/Release/obj/conpty/conpty.node.recipe',
    'node-addon-api/node_addon_api_except.vcxproj',
    'node-addon-api/Release/obj/node_addon_api_except/n.nativecodeanalysis.xml',
  ];
  for (const name of [...runtimeFiles, ...buildFiles]) {
    const path = join(moduleRoot, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, name);
  }
  const base = resolveDesktopBuilderConfig({});
  const config = doMergeConfigs([{ ...base, files: [...base.files] }]);
  const packager = {
    config,
    appInfo: { type: 'module' },
    debugLogger: { isEnabled: false },
    getWorkspaceRoot: async () => root,
  };
  const destination = join(root, 'output');
  const mainMatcher = getNodeModuleFileMatcher(root, destination, (s) => s, config.win, packager);
  const matcher = new FileMatcher(moduleRoot, destination, (s) => s, mainMatcher.patterns);
  const copier = new NodeModuleCopyHelper(matcher, packager);
  const files = await copier.collectNodeModules(
    { name: 'node-pty', dir: moduleRoot },
    [],
    join('node_modules', 'node-pty'),
  );
  assert.deepEqual(
    files.map((file) => relative(moduleRoot, file).replaceAll('\\', '/')).sort(),
    runtimeFiles.sort(),
  );
});

test('packaged resources forbid the retired bundled Git distribution', async () => {
  const required = [];
  const forbidden = [];
  await assertPackagedResources('resources', {
    requirePath: async (path) => required.push(path),
    forbidPath: async (path) => forbidden.push(path),
    requireWindowsSandbox: false,
  });

  for (const path of [
    join('resources', 'git'),
    join('resources', 'bundled-git.json'),
    join('resources', 'licenses', 'dugite'),
    join('resources', 'licenses', 'git'),
  ]) {
    assert.equal(required.includes(path), false);
    assert.equal(forbidden.includes(path), true);
  }
});

test('the upgrade baseline keeps the Git absence rule while relaxing newer resources', async () => {
  const required = [];
  const forbidden = [];
  await assertPackagedResources('resources', {
    requirePath: async (path) => required.push(path),
    forbidPath: async (path) => forbidden.push(path),
    requireWindowsSandbox: false,
    requireDisclaimer: false,
    requireCanonicalIcon: false,
    requireAppIconCatalog: false,
    requireDirectPeerArtifact: false,
    requireMjsFilesystemWorker: false,
  });

  // A pinned baseline may predate any of these; none of them may be demanded
  // of bytes that were correct when they shipped.
  for (const path of [
    join('resources', 'workers', 'filesystem-worker.mjs'),
    join('resources', 'assets', 'icon.png'),
    join('resources', 'licenses', 'maka', 'DISCLAIMER-WIP'),
    join('resources', 'runtime-host-peer', 'maka_runtime_host_peer.node'),
    join('resources', 'licenses', 'runtime-host-peer', 'THIRD_PARTY_NOTICES.txt'),
  ]) {
    assert.equal(required.includes(path), false);
  }
  // Git is not one of them: no published build still carries it.
  for (const path of [
    join('resources', 'git'),
    join('resources', 'bundled-git.json'),
    join('resources', 'licenses', 'dugite'),
    join('resources', 'licenses', 'git'),
  ]) {
    assert.equal(required.includes(path), false);
    assert.equal(forbidden.includes(path), true);
  }
});

describe('asarLookupPath', () => {
  // The archive stores `/`-joined paths, but `@electron/asar` resolves a lookup
  // by splitting it on `path.sep`. Passing an archive path straight through
  // therefore works on macOS and Linux and silently finds nothing on Windows,
  // which is how this shipped green from a mac and failed the Windows lane.
  test('leaves archive paths alone where the separator already matches', () => {
    assert.equal(asarLookupPath('dist/main/app-ipc-main.js', '/'), 'dist/main/app-ipc-main.js');
  });

  test('localizes every segment for a Windows separator', () => {
    assert.equal(asarLookupPath('dist/main/app-ipc-main.js', '\\'), 'dist\\main\\app-ipc-main.js');
  });

  test('resolves a real archive path under a Windows separator', () => {
    // Mirrors `@electron/asar`'s own descent so the assertion fails on any
    // platform rather than only on the one that has the bug.
    const header = {
      files: { dist: { files: { main: { files: { 'app-ipc-main.js': { size: 1 } } } } } },
    };
    const descend = (path, separator) =>
      path
        .split(separator)
        .filter(Boolean)
        .reduce((node, part) => node?.files?.[part], header);

    assert.ok(descend(asarLookupPath('dist/main/app-ipc-main.js', '\\'), '\\'));
    assert.equal(descend('dist/main/app-ipc-main.js', '\\'), undefined);
  });
});

// The closure assertion must judge the artifact by its own contents. These
// fixtures build a real `resources/` layout — an actual asar carrying both a
// node_modules tree and the renderer's bundled-package record, plus a shipped
// notices file — because the regressions this guards against were verifiers
// that read part of their evidence from the checkout.

const roots = [];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An ICNS archive carrying `slots` verbatim, so a test can state the exact
 *  entry shape a generator produced without shipping a binary fixture. */
function icnsWith(slots) {
  const entries = slots.map(([type, payload]) => {
    const entry = Buffer.alloc(8 + payload.length);
    entry.write(type, 0, 'latin1');
    entry.writeUInt32BE(entry.length, 4);
    payload.copy(entry, 8);
    return entry;
  });
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'latin1');
  header.writeUInt32BE(header.length + body.length, 4);
  return Buffer.concat([header, body]);
}

/** Packs one ARGB plane the ICNS way: runs of 3-130 equal bytes, literals of up to 128. */
function packIcnsPlane(plane) {
  const packed = [];
  for (let i = 0; i < plane.length; ) {
    let run = 1;
    while (run < 130 && i + run < plane.length && plane[i + run] === plane[i]) run += 1;
    if (run >= 3) {
      packed.push(0x80 + run - 3, plane[i]);
      i += run;
      continue;
    }
    let end = i + 1;
    while (
      end < plane.length &&
      end - i < 128 &&
      !(plane[end] === plane[end + 1] && plane[end] === plane[end + 2])
    ) {
      end += 1;
    }
    packed.push(end - i - 1, ...plane.subarray(i, end));
    i = end;
  }
  return Buffer.from(packed);
}

/** A real `ic04`/`ic05` payload, which `iconutil` unpacks to a `side` px image:
 *  a transparent border around opaque gradients, so it holds runs and literals. */
function argbPayload(side) {
  const planes = [0, 1, 2, 3].map((channel) => {
    const plane = Buffer.alloc(side * side);
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const edge = x === 0 || y === 0 || x === side - 1 || y === side - 1;
        plane[y * side + x] =
          channel === 0 ? (edge ? 0 : 255) : (channel * 60 + x * 7 + y * 3) & 0xff;
      }
    }
    return packIcnsPlane(plane);
  });
  return Buffer.concat([Buffer.from('ARGB', 'latin1'), ...planes]);
}

/** One PNG chunk, with its CRC. */
function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** A real 8-bit RGBA PNG of a `width` × `height` image. `rows` and `filter`
 *  let a test write fewer scanlines than IHDR declares or an unknown filter. */
function pngImage(width, height = width, { rows = height, filter = 0 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const scanline = Buffer.alloc(1 + width * 4, 0x7f);
  scanline[0] = filter;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: rows }, () => scanline)))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const RENDERABLE_ICNS = icnsWith([
  ['ic04', argbPayload(16)],
  ['ic05', argbPayload(32)],
  ['ic07', pngImage(128)],
  ['ic13', pngImage(256)],
]);

const PTY_PACKAGES = ['@xterm/headless', '@xterm/addon-unicode11'];
const COVERING_NOTICES = 'Header\n\nPackage: react@19.2.0\nDeclared license: MIT\n';

async function makeResources({
  asarPackages = PTY_PACKAGES,
  bundled = ['react'],
  notices = COVERING_NOTICES,
  rendererLicenses = [],
  // Files placed under `dist/` inside the archive, so the bare-import scan
  // has shipped code to read.
  distFiles = {},
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-closure-'));
  roots.push(root);
  const stage = join(root, 'stage');
  for (const entry of asarPackages) {
    // `name` or `name@version` — the archive's manifest is what the verifier
    // compares against the closure, so a fixture has to be able to ship one
    // that disagrees.
    const at = entry.lastIndexOf('@');
    const [name, version] =
      at > 0 ? [entry.slice(0, at), entry.slice(at + 1)] : [entry, '0.0.0-fixture'];
    const directory = join(stage, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name, version })}\n`);
  }
  for (const [relative, contents] of Object.entries(distFiles)) {
    const target = join(stage, 'dist', ...relative.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  if (bundled !== null) {
    await mkdir(join(stage, 'dist-renderer'), { recursive: true });
    await writeFile(
      join(stage, 'dist-renderer', 'bundled-npm-packages.json'),
      `${JSON.stringify(bundled)}\n`,
    );
  }
  const resources = join(root, 'resources');
  await mkdir(join(resources, 'licenses', 'npm'), { recursive: true });
  await createPackage(stage, join(resources, 'app.asar'));
  await writeFile(join(resources, 'licenses', 'npm', 'THIRD_PARTY_NOTICES.txt'), notices);
  for (const relativePath of rendererLicenses) {
    const path = join(resources, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'license text\n');
  }
  return resources;
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const FIXTURE_VERSION = '0.0.0-fixture';
const allowlistOf = (entries) =>
  new Map(
    entries.map((entry) => {
      const at = entry.lastIndexOf('@');
      return at > 0
        ? [entry.slice(0, at), new Set([entry.slice(at + 1)])]
        : [entry, new Set([FIXTURE_VERSION])];
    }),
  );

const options = {
  collectClosure: () => [{ name: 'react', version: '19.2.0' }],
  collectPackagedAllowlist: () => allowlistOf(PTY_PACKAGES),
};

test('accepts the Intel Mach-O architecture for an x64 package', async () => {
  const { verifyPackagedMacApp } = await import('./verify-macos-dmg.mjs');
  const asarPackages = await Promise.all(
    PTY_PACKAGES.map(async (name) => {
      const manifest = JSON.parse(
        await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'),
      );
      return `${name}@${manifest.version}`;
    }),
  );
  const resources = await makeResources({
    asarPackages,
    notices: await readFile(
      new URL('../apps/desktop/resources/licenses/npm/THIRD_PARTY_NOTICES.txt', import.meta.url),
      'utf8',
    ),
    rendererLicenses: [
      'licenses/renderer/GEIST_LICENSE.txt',
      'licenses/renderer/GEIST_MONO_LICENSE.txt',
    ],
  });
  await writeFile(
    join(resources, 'app-update.yml'),
    'provider: github\nowner: apache\nrepo: maka\nchannel: dev\nupdaterCacheDirName: "@makadesktop-updater"\n',
  );
  await writeFile(join(resources, 'icon.icns'), RENDERABLE_ICNS);
  const version = '0.2.0-dev.14.20260902';
  const app = join(dirname(resources), 'Maka.app');
  await mkdir(join(app, 'Contents'), { recursive: true });
  await rename(resources, join(app, 'Contents', 'Resources'));
  // The archive and update configuration are real; macOS command output and
  // app launches are the system boundaries this portable test substitutes.
  await verifyPackagedMacApp(app, {
    expectedArch: 'x64',
    channel: 'nightly',
    environment: { MAKA_DESKTOP_NIGHTLY_VERSION: version },
    requirePath: async () => {},
    smokeFilesystemWorker: async () => {},
    smokeRenderer: async () => {},
    run: async (command, args) => {
      if (command === 'plutil') {
        const values = {
          CFBundleIdentifier: 'com.maka.desktop',
          CFBundleShortVersionString: version,
          CFBundleExecutable: 'Maka',
        };
        assert.ok(Object.hasOwn(values, args[1]));
        return { stdout: `${values[args[1]]}\n` };
      }
      if (command === 'lipo') return { stdout: 'x86_64\n' };
      if (
        ['codesign', 'spctl', 'xcrun', join(app, 'Contents', 'MacOS', 'Maka')].includes(command)
      ) {
        return { stdout: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });
});

describe('assertRenderableAppIcon', () => {
  const withIcon = async (t, icns) => {
    const resources = await mkdtemp(join(tmpdir(), 'maka-icon-'));
    t.after(() => rm(resources, { recursive: true, force: true }));
    await writeFile(join(resources, 'icon.icns'), icns);
    return resources;
  };

  test('accepts an icon whose small sizes are stored as ARGB', async (t) => {
    const { assertRenderableAppIcon } = await import('./verify-macos-dmg.mjs');
    await assertRenderableAppIcon(await withIcon(t, RENDERABLE_ICNS));
  });

  test('rejects PNG data in the legacy slots macOS does not decode', async (t) => {
    const { assertRenderableAppIcon } = await import('./verify-macos-dmg.mjs');
    // The shape electron-builder 26.15.2-26.15.3 produced: every size present,
    // the large ones fine, and 16px/32px unreadable where a person sees them.
    const resources = await withIcon(
      t,
      icnsWith([
        ['icp4', pngImage(16)],
        ['icp5', pngImage(32)],
        ['ic07', pngImage(128)],
      ]),
    );
    await assert.rejects(assertRenderableAppIcon(resources), /16x16 \(icp4\), 32x32 \(icp5\)/);
  });

  test('rejects an icon that carries no small sizes at all', async (t) => {
    const { assertRenderableAppIcon } = await import('./verify-macos-dmg.mjs');
    const resources = await withIcon(t, icnsWith([['ic07', pngImage(128)]]));
    await assert.rejects(assertRenderableAppIcon(resources), /missing the sizes/);
  });

  test('rejects small sizes whose ARGB planes do not unpack to the full image', async (t) => {
    const { assertRenderableAppIcon } = await import('./verify-macos-dmg.mjs');
    const whole = argbPayload(16);
    for (const ic04 of [
      // The empty and one-byte payloads the review reproduced.
      Buffer.alloc(0),
      Buffer.from([0x80]),
      // The last packed token cut short.
      whole.subarray(0, whole.length - 1),
      // Bytes left over once all four planes are full.
      Buffer.concat([whole, Buffer.from([0x00, 0xff])]),
      // The right planes behind the wrong magic.
      Buffer.concat([Buffer.from('PNGX', 'latin1'), whole.subarray(4)]),
      // 1024 bytes in all, as the review built it, but a run spills four
      // bytes of the first plane into the second: planes of 260, 252, 256
      // and 256, which macOS draws with every plane after the first shifted.
      Buffer.from([
        ...Buffer.from('ARGB'),
        0xff,
        1,
        0xff,
        1,
        0xff,
        2,
        0xf7,
        2,
        0xff,
        3,
        0xfb,
        3,
        0xff,
        4,
        0xfb,
        4,
      ]),
    ]) {
      const resources = await withIcon(
        t,
        icnsWith([
          ['ic04', ic04],
          ['ic05', argbPayload(32)],
        ]),
      );
      await assert.rejects(
        assertRenderableAppIcon(resources),
        /small sizes macOS cannot decode: 16x16 \(ic04\)\./,
      );
    }
  });

  test('rejects PNG art at the wrong size for its slot', async (t) => {
    const { assertRenderableAppIcon } = await import('./verify-macos-dmg.mjs');
    // The retina slots as the toolset electron-builder 26.15.3 pinned wrote
    // them, and art that is not square.
    const resources = await withIcon(
      t,
      icnsWith([
        ['ic04', argbPayload(16)],
        ['ic05', argbPayload(32)],
        ['ic13', pngImage(512)],
        ['ic14', pngImage(1024)],
        ['ic11', pngImage(32, 16)],
      ]),
    );
    await assert.rejects(
      assertRenderableAppIcon(resources),
      new RegExp(
        'ic11 holds 32x16 where macOS expects 32x32; ' +
          'ic13 holds 512x512 where macOS expects 256x256; ' +
          'ic14 holds 1024x1024 where macOS expects 512x512\\.',
      ),
    );
  });

  test('rejects PNG art that does not decode', async (t) => {
    const { assertRenderableAppIcon } = await import('./verify-macos-dmg.mjs');
    const whole = pngImage(128);
    const signatureAndHeader = whole.subarray(0, 33);
    const end = pngChunk('IEND', Buffer.alloc(0));
    const badCrc = Buffer.from(whole);
    badCrc[29] ^= 0xff;
    const overlong = Buffer.from(whole);
    overlong.writeUInt32BE(1, whole.length - 12);
    for (const ic07 of [
      // A signature and IHDR alone, as the review's fixture was.
      signatureAndHeader,
      badCrc,
      // Bytes after IEND.
      Buffer.concat([whole, Buffer.from([0])]),
      // A chunk longer than what is left.
      overlong,
      // IHDR not first, and one byte short.
      Buffer.concat([PNG_SIGNATURE, pngChunk('pHYs', Buffer.alloc(9)), whole.subarray(8)]),
      Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', whole.subarray(16, 28)), whole.subarray(33)]),
      // IDAT that does not inflate.
      Buffer.concat([signatureAndHeader, pngChunk('IDAT', Buffer.from('not deflate')), end]),
      // A scanline short, and an unknown row filter.
      pngImage(128, 128, { rows: 127 }),
      pngImage(128, 128, { filter: 5 }),
    ]) {
      const resources = await withIcon(
        t,
        icnsWith([
          ['ic04', argbPayload(16)],
          ['ic05', argbPayload(32)],
          ['ic07', ic07],
        ]),
      );
      await assert.rejects(
        assertRenderableAppIcon(resources),
        /PNG art macOS cannot draw: ic07 does not decode\./,
      );
    }
  });

  test('refuses to guess at a truncated entry instead of looping on it', async (t) => {
    const { assertRenderableAppIcon } = await import('./verify-macos-dmg.mjs');
    for (const length of [0, 1_000]) {
      const icns = icnsWith([['ic04', argbPayload(16)]]);
      icns.writeUInt32BE(length, 12);
      await assert.rejects(assertRenderableAppIcon(await withIcon(t, icns)), /unusable length/);
    }
  });

  test('rejects an archive whose header does not match its entries', async (t) => {
    const { assertRenderableAppIcon } = await import('./verify-macos-dmg.mjs');
    const understated = Buffer.from(RENDERABLE_ICNS);
    understated.writeUInt32BE(8, 4);
    await assert.rejects(
      assertRenderableAppIcon(await withIcon(t, understated)),
      new RegExp(`declares 8 bytes but holds ${understated.length}\\.`),
    );
    // Bytes after the last entry that are too few to be another one.
    const padded = Buffer.concat([RENDERABLE_ICNS, Buffer.from([0, 0, 0])]);
    padded.writeUInt32BE(padded.length, 4);
    await assert.rejects(
      assertRenderableAppIcon(await withIcon(t, padded)),
      /ends inside an entry header/,
    );
  });
});

describe('assertPackagedDependencyClosure', () => {
  test('accepts an artifact whose asar, bundle record, and shipped notices match', async () => {
    const resources = await makeResources();
    await assertPackagedDependencyClosure(resources, options);
  });

  test('rejects a stale shipped notice even though the checkout copy is complete', async () => {
    // The checkout's own THIRD_PARTY_NOTICES.txt covers react — that is what
    // check:third-party-notices enforces — so a verifier reading from the
    // checkout would pass this artifact. Only the shipped copy is stale.
    const resources = await makeResources({
      notices: 'Header\n\nPackage: something-else@1.0.0\nDeclared license: MIT\n',
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /shipped THIRD_PARTY_NOTICES\.txt is missing packages the artifact ships: react@19\.2\.0/,
    );
  });

  test('rejects a notice entry whose version is not the shipped one', async () => {
    const resources = await makeResources({
      notices: 'Header\n\nPackage: react@18.0.0\nDeclared license: MIT\n',
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /react@19\.2\.0/,
    );
  });

  test('rejects a permitted package shipped at a version the closure does not declare', async () => {
    // Names alone matched, so an archive carrying react@18 against a closure
    // declaring react@19 passed — a name that belongs at a version that does
    // not, which is the shape a substitution takes.
    const resources = await makeResources({
      asarPackages: [...PTY_PACKAGES, 'react@18.3.1'],
      bundled: ['react'],
    });
    await assert.rejects(
      assertPackagedDependencyClosure(resources, {
        ...options,
        collectPackagedAllowlist: () => allowlistOf([...PTY_PACKAGES, 'react@19.2.0']),
      }),
      /outside the production closure: react@18\.3\.1/u,
    );
  });

  test('rejects shipped code importing a package the closure allows but the archive lacks', async () => {
    // Being in the closure was accepted as proof the import resolves. It is
    // not: only the archive can answer that, and an allowed-but-absent
    // package is exactly the ERR_MODULE_NOT_FOUND this check exists for.
    const resources = await makeResources({
      asarPackages: PTY_PACKAGES,
      distFiles: { 'main/app.js': "import QRCode from 'qrcode';\n" },
    });
    await assert.rejects(
      assertPackagedDependencyClosure(resources, {
        ...options,
        collectPackagedAllowlist: () => allowlistOf([...PTY_PACKAGES, 'qrcode@1.5.4']),
      }),
      /importing packages it does not carry: qrcode/u,
    );
  });

  test('rejects a leak hidden inside a nested node_modules', async () => {
    // npm nests a second copy under a package on version conflict; a walk that
    // stops at the top level certifies an archive it has not fully inspected.
    const resources = await makeResources({
      asarPackages: [...PTY_PACKAGES, '@xterm/headless/node_modules/left-pad'],
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /app\.asar carries packages outside the production closure: left-pad/,
    );
  });

  test('rejects any package outside the production closure, transitive ones included', async () => {
    // The old check compared the archive against the declared renderer roots,
    // so a renderer-only transitive package (never a root) could leak back in
    // silently. The allowlist is the production closure, so anything else —
    // root or transitive — is a leak.
    const resources = await makeResources({
      asarPackages: [...PTY_PACKAGES, 'lodash-es'],
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /app\.asar carries packages outside the production closure: lodash-es/,
    );
  });

  test('rejects an asar trimmed past what the PTY stack loads', async () => {
    const resources = await makeResources({ asarPackages: ['@xterm/addon-unicode11'] });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /missing @xterm\/headless/,
    );
  });

  test('rejects a bundle record naming a package the closure does not declare', async () => {
    // The record is written by the vite build from the real module graph, so
    // this is the failure a package entering through a new path (a CSS import,
    // an asset chain) produces until it is declared.
    const resources = await makeResources({ bundled: ['react', 'left-pad'] });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /renderer bundle carries packages outside the declared closure: left-pad/,
    );
  });

  test('rejects an artifact with no bundle record at all', async () => {
    const resources = await makeResources({ bundled: null });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /does not carry dist-renderer\/bundled-npm-packages\.json/,
    );
  });

  test('asset-licensed packages need their shipped license file, not an npm notice', async () => {
    const closure = () => [
      { name: 'react', version: '19.2.0' },
      { name: '@fontsource-variable/geist', version: '5.3.0' },
    ];
    const withLicense = await makeResources({
      bundled: ['react', '@fontsource-variable/geist'],
      rendererLicenses: [join('licenses', 'renderer', 'GEIST_LICENSE.txt')],
    });
    await assertPackagedDependencyClosure(withLicense, { ...options, collectClosure: closure });

    const withoutLicense = await makeResources({
      bundled: ['react', '@fontsource-variable/geist'],
    });
    await assert.rejects(
      () =>
        assertPackagedDependencyClosure(withoutLicense, { ...options, collectClosure: closure }),
      /shipped license file for @fontsource-variable\/geist is missing/,
    );
  });
});

// The resource list is contract, not implementation: the permission overlay
// reads `assets/icon.png` at runtime, so a current build that drops it ships
// a regression the app cannot report. The check is driven through the
// injectable `requirePath`, so it needs no packaging and no platform.
describe('assertPackagedResources', () => {
  const resources = join('fake', 'resources');
  const iconPath = join(resources, 'assets', 'icon.png');
  const requirePathMissing = (absent) => async (path) => {
    if (path === absent) throw new Error(`MISSING ${path}`);
  };
  const forbidPath = async () => {};

  test('a current build must carry the canonical icon', async () => {
    await assert.rejects(
      () =>
        assertPackagedResources(resources, {
          requirePath: requirePathMissing(iconPath),
          forbidPath,
          requireWindowsSandbox: false,
        }),
      /MISSING .*icon\.png/,
    );
  });

  test('a legacy baseline predating the packaged icon is not required to carry it', async () => {
    await assertPackagedResources(resources, {
      requirePath: requirePathMissing(iconPath),
      forbidPath,
      requireWindowsSandbox: false,
      requireDisclaimer: false,
      requireCanonicalIcon: false,
    });
  });
});
