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
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  cargoLicenseRecord,
  generateNotices,
  verifyNotices,
  verifyReviewedNotices,
} from './notices.mjs';
import { buildCli, rustTarget } from './build-cli.mjs';
import { nativeCliTargets } from './pack-cli.mjs';

const text = 'Fixture license text. '.repeat(8);
const targets = Object.values(nativeCliTargets).map(({ os, cpu }) => rustTarget(os, cpu));
const registry = 'registry+https://github.com/rust-lang/crates.io-index';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'maka-notice-components-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(path, content) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const json = (path, value) => put(path, JSON.stringify(value));
  await json('package.json', { name: 'fixture', private: true });
  await json('scripts/rust/notices-sources.json', {});
  await mkdir(join(root, 'products/maka/cli'), { recursive: true });
  const playwright = {
    registry_package: 'playwright',
    registry_version: '1.0.0',
    license: 'Apache-2.0',
    archive: { url: 'https://example.test/playwright-1.0.0.tgz', sha256: 'a'.repeat(64) },
    files: {},
  };
  for (const file of ['injected.js', 'LICENSE', 'NOTICE', 'ThirdPartyNotices.txt']) {
    await put('third-party/playwright/' + file, text);
    playwright.files[file] = createHash('sha256').update(text).digest('hex');
  }
  await json('third-party/playwright/upstream.json', playwright);
  const lock = { packages: {} };
  for (const name of ['ajv', 'semver']) {
    await json(`node_modules/${name}/package.json`, { name, version: '1.0.0', license: 'MIT' });
    await put(`node_modules/${name}/LICENSE`, text);
    await put(`node_modules/${name}/dist/standalone/index.js`, 'export {};');
    lock.packages['node_modules/' + name] = {
      version: '1.0.0',
      resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
      integrity: 'sha512-fixture',
    };
  }
  await json('package-lock.json', lock);
  const roots = ['maka-cli', 'maka-desktop-shell', 'maka-python-runtime'].map((name) => ({
    id: name,
    name,
    manifest_path: join(root, 'products', name, 'Cargo.toml'),
  }));
  const libraries = ['a', 'b', 'linux', 'windows', 'intel-mac'].map((name) => ({
    id: name,
    name,
    version: '1.0.0',
    license: 'MIT',
    authors: ['Fixture Author'],
    source: registry,
    manifest_path: join(root, 'registry', name, 'Cargo.toml'),
  }));
  for (const pkg of libraries) await put(`registry/${pkg.name}/LICENSE`, text);
  const cargoReads = [];
  const run = (command, args) => {
    assert.equal(command, 'cargo');
    cargoReads.push(args);
    const triple = args[args.indexOf('--filter-platform') + 1];
    const selected = libraries.filter(
      ({ name }) =>
        name === 'a' ||
        (name === 'b' && triple.startsWith('aarch64')) ||
        (name === 'linux' && triple.includes('linux')) ||
        (name === 'windows' && triple.includes('windows')) ||
        (name === 'intel-mac' && triple === 'x86_64-apple-darwin'),
    );
    return JSON.stringify({
      packages: [...roots, ...selected],
      resolve: {
        nodes: [...roots, ...selected].map((pkg) => ({
          id: pkg.id,
          deps: roots.includes(pkg)
            ? selected.map((pkg) => ({ pkg: pkg.id, dep_kinds: [{ kind: null }] }))
            : [],
        })),
      },
    });
  };
  const bundleInputs = join(root, 'bundle-inputs.json');
  await json('bundle-inputs.json', [join(root, 'products/workbench/Settings.tsx')]);
  const options = { bundleInputs, env: {}, run };
  await generateNotices(root, options);
  return { root, options, libraries, lock, put, json, cargoReads };
}

test('source-only edits keep reviewed coverage; newly bundled locked packages do not', async (t) => {
  const { root, options, put, json } = await fixture(t);
  const manifest = await readFile(join(root, 'products/maka/cli/notices.json'));
  await put('packages/plugin-sdk/src/contracts.ts', '// changed first-party types\n');
  await put('products/workbench/Settings.tsx', '// changed labels and layout\n');
  await verifyNotices(root, options);
  assert.deepEqual(await readFile(join(root, 'products/maka/cli/notices.json')), manifest);
  // The lock and install already contained this package when the snapshot was reviewed.
  await json('bundle-inputs.json', [join(root, 'node_modules/semver/dist/standalone/index.js')]);
  await assert.rejects(verifyNotices(root, options), /npm:semver@1.0.0/);
  await json('bundle-inputs.json', []);
  await verifyNotices(root, { ...options, target: 'x86_64-unknown-linux-gnu' });
  await put('products/maka/cli/THIRD_PARTY_NOTICES.txt', 'edited reviewed document');
  await assert.rejects(verifyNotices(root, options), /notice document changed/);
});

test('actual license files, declarations, sources and supplements are independently checked', async (t) => {
  const { root, options, libraries, lock, put, json } = await fixture(t);
  for (const [field, value] of [
    ['license', 'Apache-2.0'],
    ['source', 'registry+https://other.test/index'],
    ['version', '1.0.1'],
  ]) {
    const original = libraries[0][field];
    libraries[0][field] = value;
    await assert.rejects(verifyNotices(root, options), /component or license data/);
    libraries[0][field] = original;
  }
  await put('registry/a/LICENSE', text + ' amended');
  await assert.rejects(verifyNotices(root, options), /cargo:a@1.0.0/);
  await put('registry/a/LICENSE', text);
  await put('registry/a/NOTICE', 'Additional terms');
  await assert.rejects(verifyNotices(root, options), /cargo:a@1.0.0/);
  await rm(join(root, 'registry/a/NOTICE'));
  await verifyNotices(root, options);
  await json('scripts/rust/notices-sources.json', {
    'a@1.0.0': [{ file: 'extra.txt', source: 'https://example.test/extra' }],
  });
  await put('extra.txt', text);
  await generateNotices(root, options);
  await put('extra.txt', text + ' changed');
  await assert.rejects(verifyNotices(root, options), /cargo:a@1.0.0/);
  await put('extra.txt', text);
  await json('scripts/rust/notices-sources.json', {
    'a@1.0.0': [{ file: 'extra.txt', source: 'https://example.test/different-source' }],
  });
  await assert.rejects(verifyNotices(root, options), /cargo:a@1.0.0/);
  await json('scripts/rust/notices-sources.json', {});
  await generateNotices(root, options);
  for (const [field, value] of [
    ['resolved', 'https://other.test/ajv-1.0.0.tgz'],
    ['integrity', 'sha512-other'],
  ]) {
    const entry = lock.packages['node_modules/ajv'];
    const original = entry[field];
    entry[field] = value;
    await json('package-lock.json', lock);
    await assert.rejects(verifyNotices(root, options), /npm:ajv@1.0.0/);
    entry[field] = original;
  }
  await json('package-lock.json', lock);
  await put('node_modules/ajv/LICENSE', text + ' changed');
  await assert.rejects(verifyNotices(root, options), /npm:ajv@1.0.0/);
});

test('one target accepts reviewed platform union and conflicting installed duplicates fail', async (t) => {
  const { root, options, lock, json } = await fixture(t);
  await verifyNotices(root, { ...options, target: 'x86_64-unknown-linux-gnu' });
  await verifyNotices(root, { ...options, target: 'aarch64-unknown-linux-gnu' });
  const duplicate = 'node_modules/parent/node_modules/ajv';
  await cp(join(root, 'node_modules/ajv'), join(root, duplicate), { recursive: true });
  lock.packages[duplicate] = { ...lock.packages['node_modules/ajv'] };
  await json('package-lock.json', lock);
  await json('bundle-inputs.json', [join(root, duplicate, 'dist/standalone/index.js')]);
  await verifyNotices(root, options);
  await writeFile(join(root, duplicate, 'LICENSE'), text + ' modified duplicate');
  await assert.rejects(verifyNotices(root, options), /Conflicting installed license data/);
  await assert.rejects(verifyNotices(root, { env: {} }), /bundle input manifest is required/);
});

test('real Cargo build output supplies the bundle that the notice gate rejects', async (t) => {
  const { root, options, put } = await fixture(t);
  const names = ['maka-cli', 'maka-desktop-shell', 'maka-python-runtime'];
  await put(
    'Cargo.toml',
    '[workspace]\nresolver="3"\nmembers=' +
      JSON.stringify(names.map((name) => 'products/' + name)) +
      '\n',
  );
  for (const name of names) {
    await put(
      `products/${name}/Cargo.toml`,
      `[package]\nname="${name}"\nversion="1.0.0"\nedition="2024"\n` +
        (name === 'maka-cli' ? '[[bin]]\nname="maka"\npath="src/main.rs"\n' : ''),
    );
    await put(
      `products/${name}/src/${name === 'maka-cli' ? 'main' : 'lib'}.rs`,
      name === 'maka-cli' ? 'fn main() {}\n' : '',
    );
  }
  const inputs = JSON.stringify([join(root, 'node_modules/semver/dist/standalone/index.js')]);
  const recordedBundle = join(root, 'built-bundle-path.txt');
  await put(
    'products/maka-cli/build.rs',
    `fn main() {
    let product = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("product");
    std::fs::create_dir_all(&product).unwrap();
    std::fs::write(product.join("bundle-inputs.json"), r#"${inputs}"#).unwrap();
    std::fs::write(${JSON.stringify(recordedBundle)}, product.join("bundle-inputs.json").to_str().unwrap()).unwrap();
  }`,
  );
  childProcess.execFileSync('cargo', ['generate-lockfile', '--offline'], { cwd: root });
  const target = join(root, 'custom Cargo output');
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: target,
    CARGO_NET_OFFLINE: 'true',
    CARGO_INCREMENTAL: '0',
    CARGO_BUILD_JOBS: '2',
    CARGO_BUILD_TARGET: rustTarget(),
    MAKA_CUA_BUILD_MODE: 'native',
  };
  const { bundleInputs } = await buildCli({ repositoryRoot: root, desktop: false, env });
  assert.equal(
    await realpath(bundleInputs),
    await realpath(await readFile(recordedBundle, 'utf8')),
  );
  assert.deepEqual(JSON.parse(await readFile(bundleInputs, 'utf8')), JSON.parse(inputs));
  await assert.rejects(
    verifyNotices(root, {
      ...options,
      run: undefined,
      bundleInputs,
      target: rustTarget(),
      env,
    }),
    /npm:semver@1.0.0/,
  );
});

test('generation and PR coverage retain all five Cargo platforms', async (t) => {
  const { root, options, json, cargoReads, libraries } = await fixture(t);
  await generateNotices(root, { ...options, target: 'aarch64-apple-darwin' });
  cargoReads.length = 0;
  await verifyReviewedNotices(root, options);
  assert.deepEqual(
    cargoReads.map((args) => args.at(-1)),
    targets,
  );
  for (const name of ['linux', 'windows', 'intel-mac']) {
    const pkg = libraries.find((pkg) => pkg.name === name);
    pkg.license = 'Apache-2.0';
    await assert.rejects(verifyReviewedNotices(root, options), new RegExp(`cargo:${name}@1.0.0`));
    pkg.license = 'MIT';
  }
  const manifest = JSON.parse(await readFile(join(root, 'products/maka/cli/notices.json')));
  delete manifest.components[`cargo:windows@1.0.0 ${registry}`];
  await json('products/maka/cli/notices.json', manifest);
  await assert.rejects(verifyReviewedNotices(root, options), /cargo:windows@1.0.0/);
});

test('nested data licenses retain the package license from its pinned upstream root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-nested-notice-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = join(root, 'src', 'emoji_picker');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'emoji.LICENSE.txt'), text);
  const provenance = { repository: 'https://github.com/longbridge/nsh', revision: 'a'.repeat(40) };
  const record = await cargoLicenseRecord(
    root,
    {
      name: 'nsh-base',
      version: '0.5.0',
      license: 'Apache-2.0',
      authors: [],
      manifest_path: join(root, 'Cargo.toml'),
    },
    {},
    provenance,
  );
  assert.deepEqual(
    record.files.map(({ path }) => path),
    ['src/emoji_picker/emoji.LICENSE.txt'],
  );
  assert.equal(record.texts[0].content, text);
  assert.deepEqual(record.upstream, { repository: 'longbridge/nsh', revision: 'a'.repeat(40) });
  const declared = await cargoLicenseRecord(
    root,
    {
      name: 'data',
      version: '1.0.0',
      license: 'MIT',
      authors: [],
      manifest_path: join(root, 'Cargo.toml'),
      license_file: join(nested, 'emoji.LICENSE.txt'),
    },
    {},
    provenance,
  );
  assert.equal(declared.upstream, undefined);
});

test('vendored records use each manifest origin and exclude untracked Maka additions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-vendor-origins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vendor = join(root, 'third-party', 'nsh');
  const fork = { repository: 'https://github.com/M4n5ter/nsh', revision: 'a'.repeat(40) };
  const current = { repository: 'https://github.com/longbridge/nsh', revision: 'b'.repeat(40) };
  const metadata = {
    ...fork,
    files: { 'crates/base/Cargo.toml': 'hash', 'third-party/sixel/Cargo.toml': 'hash' },
    file_sources: { 'crates/base/Cargo.toml': current, 'third-party/sixel/Cargo.toml': fork },
  };
  const metadataPath = join(vendor, 'upstream.json');
  const base = join(vendor, 'crates', 'base');
  const sixel = join(vendor, 'third-party', 'sixel');
  await mkdir(join(base, 'src'), { recursive: true });
  await mkdir(sixel, { recursive: true });
  await writeFile(join(base, 'src', 'emoji.LICENSE.txt'), text);
  await writeFile(join(sixel, 'LICENSE'), text);
  await writeFile(metadataPath, JSON.stringify(metadata));
  const pkg = (name, directory) => ({
    name,
    version: '0.5.0',
    license: 'Apache-2.0',
    authors: [],
    manifest_path: join(directory, 'Cargo.toml'),
  });
  const updated = await cargoLicenseRecord(root, pkg('base', base), {});
  assert.ok(updated.id.includes(`${current.repository}#${current.revision}`));
  assert.ok(updated.texts[0].source.includes(`${current.repository}#${current.revision}`));
  assert.deepEqual(updated.upstream, { repository: 'longbridge/nsh', revision: current.revision });
  const retained = await cargoLicenseRecord(root, pkg('sixel', sixel), {});
  assert.ok(retained.id.includes(`${fork.repository}#${fork.revision}`));
  assert.equal(
    await cargoLicenseRecord(root, pkg('terminal', join(vendor, 'crates', 'terminal')), {}),
    undefined,
  );
  delete metadata.file_sources['crates/base/Cargo.toml'];
  await writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(
    cargoLicenseRecord(root, pkg('base', base), {}),
    /Missing pinned file source for crates\/base\/Cargo.toml/,
  );
  delete metadata.file_sources;
  await writeFile(metadataPath, JSON.stringify(metadata));
  const singleOrigin = await cargoLicenseRecord(root, pkg('base', base), {});
  assert.ok(singleOrigin.id.includes(`${fork.repository}#${fork.revision}`));
});
