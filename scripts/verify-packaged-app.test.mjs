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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createPackage } from '@electron/asar';
import {
  asarLookupPath,
  assertPackagedDependencyClosure,
  assertPackagedResources,
} from './verify-packaged-app.mjs';

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

test('legacy packaged resources require the historical bundled Git contract', async () => {
  const required = [];
  const forbidden = [];
  await assertPackagedResources('resources', {
    requirePath: async (path) => required.push(path),
    forbidPath: async (path) => forbidden.push(path),
    requireWindowsSandbox: false,
    bundledGitContract: 'legacy-required',
  });

  for (const path of [
    join('resources', 'bundled-git.json'),
    join('resources', 'licenses', 'dugite', 'LICENSE'),
    join('resources', 'licenses', 'git', 'LICENSE.txt'),
    join('resources', 'licenses', 'git', 'NOTICE.txt'),
    join('resources', 'licenses', 'git', 'SOURCE_OFFER.txt'),
  ]) {
    assert.equal(required.includes(path), true);
  }
  for (const path of [
    join('resources', 'git'),
    join('resources', 'bundled-git.json'),
    join('resources', 'licenses', 'dugite'),
    join('resources', 'licenses', 'git'),
  ]) {
    assert.equal(forbidden.includes(path), false);
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
