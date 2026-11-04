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
import { syncBuiltinESMExports } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { generateNotices, verifyNotices, verifyReviewedNotices } from './notices.mjs';
import { buildCli, rustTarget } from './build-cli.mjs';
import { nativeCliTargets } from './pack-cli.mjs';

const text = 'Fixture license text. '.repeat(8);
const targets = Object.values(nativeCliTargets).map(({ os, cpu }) => rustTarget(os, cpu));
const runtimeSupplements = Object.fromEntries(
  targets.map((target) => [
    `deno-runtime@1.0.0/${target}`,
    [{ file: `reviewed-${target}.txt`, source: `https://example.test/deno-runtime/${target}` }],
  ]),
);
const runtimeText = (target) => `Controlled Deno runtime 1.0.0\nTarget: ${target}\n${text}`;
const runtimeInput = (root, target) => ({
  target,
  oarRuntimeNotices: join(root, `actual-${target}.txt`),
});
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
  await json('scripts/rust/notices-sources.json', {
    ...runtimeSupplements,
  });
  for (const target of targets) {
    await put(`reviewed-${target}.txt`, runtimeText(target));
    await put(`actual-${target}.txt`, runtimeText(target));
  }
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
  for (const name of ['ajv', 'semver', 'deno', '@botiverse/oar']) {
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
  const libraries = ['a', 'b'].map((name) => ({
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
  const originalExec = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command !== 'cargo') return originalExec(command, args, options);
    cargoReads.push(args);
    const triple = args[args.indexOf('--filter-platform') + 1];
    const selected = triple.startsWith('aarch64') ? libraries : libraries.slice(0, 1);
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
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const bundleInputs = join(root, 'bundle-inputs.json');
  await json('bundle-inputs.json', [join(root, 'products/workbench/Settings.tsx')]);
  const oarBundleInputs = join(root, 'oar-inputs.json');
  await json('oar-inputs.json', {
    inputs: { 'node_modules/@botiverse/oar/dist/standalone/index.js': {} },
  });
  const options = { bundleInputs, oarBundleInputs, env: {} };
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
  await verifyNotices(root, { ...options, ...runtimeInput(root, 'x86_64-unknown-linux-gnu') });
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
    ...runtimeSupplements,
    'a@1.0.0': [{ file: 'extra.txt', source: 'https://example.test/extra' }],
  });
  await put('extra.txt', text);
  await generateNotices(root, options);
  await put('extra.txt', text + ' changed');
  await assert.rejects(verifyNotices(root, options), /cargo:a@1.0.0/);
  await put('extra.txt', text);
  await json('scripts/rust/notices-sources.json', {
    ...runtimeSupplements,
    'a@1.0.0': [{ file: 'extra.txt', source: 'https://example.test/different-source' }],
  });
  await assert.rejects(verifyNotices(root, options), /cargo:a@1.0.0/);
  await json('scripts/rust/notices-sources.json', {
    ...runtimeSupplements,
  });
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
  await verifyNotices(root, { ...options, ...runtimeInput(root, 'x86_64-unknown-linux-gnu') });
  await verifyNotices(root, { ...options, ...runtimeInput(root, 'aarch64-unknown-linux-gnu') });
  await generateNotices(root, { ...options, ...runtimeInput(root, 'x86_64-unknown-linux-gnu') });
  await assert.rejects(
    verifyNotices(root, { ...options, ...runtimeInput(root, 'aarch64-unknown-linux-gnu') }),
    /cargo:b@1.0.0/,
  );
  await generateNotices(root, options);
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
  await put(
    'scripts/oar/build.mjs',
    `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const output = process.argv[process.argv.indexOf('--output') + 1];
    const target = process.argv[process.argv.indexOf('--target') + 1];
    await mkdir(output, {recursive:true});
    await writeFile(join(output, 'maka-oar-worker' + (target.includes('windows') ? '.exe' : '')), 'worker');
  `,
  );
  t.mock.restoreAll();
  syncBuiltinESMExports();
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
  await put(
    'products/maka-cli/build.rs',
    `fn main() {
    let product = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("product");
    std::fs::create_dir_all(&product).unwrap();
    std::fs::write(product.join("bundle-inputs.json"), r#"${inputs}"#).unwrap();
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
  assert.ok(bundleInputs.startsWith(target));
  assert.deepEqual(JSON.parse(await readFile(bundleInputs, 'utf8')), JSON.parse(inputs));
  await assert.rejects(
    verifyNotices(root, { ...options, bundleInputs, ...runtimeInput(root, rustTarget()), env }),
    /npm:semver@1.0.0/,
  );
});

test('worker inputs and Deno licenses are included in the reviewed closure', async (t) => {
  const { root, options, put, json } = await fixture(t);
  const notices = await readFile(join(root, 'products/maka/cli/THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(notices, /@botiverse\/oar@1.0.0/);
  assert.match(notices, /deno@1.0.0/);
  await json('oar-inputs.json', { inputs: { 'node_modules/semver/dist/standalone/index.js': {} } });
  await assert.rejects(verifyNotices(root, options), /npm:semver@1.0.0/);
  await json('oar-inputs.json', { inputs: {} });
  await put('node_modules/deno/LICENSE', text + ' amended runtime license');
  await assert.rejects(verifyNotices(root, options), /npm:deno@1.0.0/);
  await assert.rejects(
    verifyNotices(root, { ...options, oarBundleInputs: undefined }),
    /OAR bundle input manifest/,
  );
});

test('Deno MIT alone cannot satisfy the runtime third-party license gate', async (t) => {
  const { root, options, json } = await fixture(t);
  await json('scripts/rust/notices-sources.json', {});
  await assert.rejects(
    verifyNotices(root, options),
    /runtime third-party notices have not been reviewed/,
  );
});

test('release requires the actual target document and rejects stale runtime licensing inputs', async (t) => {
  const { root, options, put, json, cargoReads } = await fixture(t);
  const target = 'aarch64-apple-darwin';
  const actual = { ...options, ...runtimeInput(root, target) };
  await verifyNotices(root, actual);
  const readsBeforeFailures = cargoReads.length;
  await assert.rejects(
    verifyNotices(root, { ...actual, oarRuntimeNotices: undefined }),
    /Actual built runtime notices are required/,
  );
  await put(`actual-${target}.txt`, runtimeText('x86_64-unknown-linux-gnu'));
  await assert.rejects(verifyNotices(root, actual), /Built runtime notices differ/);
  await put(
    `actual-${target}.txt`,
    runtimeText(target) + ' changed source/Cargo/V8/toolchain notice',
  );
  await assert.rejects(verifyNotices(root, actual), /Built runtime notices differ/);
  await put(`actual-${target}.txt`, runtimeText(target));
  assert.equal(
    cargoReads.length,
    readsBeforeFailures,
    'runtime validation precedes Cargo metadata',
  );
  const onlyMac = {
    [`deno-runtime@1.0.0/${target}`]: runtimeSupplements[`deno-runtime@1.0.0/${target}`],
  };
  await json('scripts/rust/notices-sources.json', onlyMac);
  await verifyNotices(root, actual);
  const readsWithMacReview = cargoReads.length;
  await assert.rejects(
    verifyNotices(root, { ...options, ...runtimeInput(root, 'x86_64-unknown-linux-gnu') }),
    /have not been reviewed for x86_64-unknown-linux-gnu/,
  );
  await assert.rejects(generateNotices(root, options), /have not been reviewed/);
  assert.equal(cargoReads.length, readsWithMacReview, 'missing targets never fetch metadata');
  await put(`reviewed-${target}.txt`, runtimeText('x86_64-unknown-linux-gnu'));
  await assert.rejects(
    verifyNotices(root, actual),
    /Reviewed runtime notice version\/target mismatch/,
  );
});

test('single-target notice commands require both the target and actual runtime document', () => {
  for (const args of [
    ['check', '--target', 'aarch64-apple-darwin'],
    ['generate', '--oar-runtime-notices', 'runtime.txt'],
  ]) {
    const result = childProcess.spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./notices.mjs', import.meta.url)), ...args],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--target and --oar-runtime-notices must be supplied together/);
  }
});

test('PR coverage checks only registered targets without granting release or full-generation approval', async (t) => {
  const { root, options, json, cargoReads, libraries } = await fixture(t);
  const target = 'aarch64-apple-darwin';
  await json('scripts/rust/notices-sources.json', {
    [`deno-runtime@1.0.0/${target}`]: runtimeSupplements[`deno-runtime@1.0.0/${target}`],
  });
  await generateNotices(root, { ...options, ...runtimeInput(root, target) });
  cargoReads.length = 0;
  await verifyReviewedNotices(root, options);
  assert.deepEqual(
    cargoReads.map((args) => args.at(-1)),
    [target],
  );
  const previousReads = cargoReads.length;
  await assert.rejects(verifyNotices(root, { ...options, target }), /Actual built runtime notices/);
  await assert.rejects(generateNotices(root, options), /have not been reviewed/);
  assert.equal(cargoReads.length, previousReads);
  libraries[0].license = 'Apache-2.0';
  await assert.rejects(verifyReviewedNotices(root, options), /component or license data/);
});

test('PR coverage rejects removed, changed, newly registered and empty runtime review sets', async (t) => {
  const { root, options, json, put } = await fixture(t);
  const target = 'aarch64-apple-darwin';
  const onlyMac = {
    [`deno-runtime@1.0.0/${target}`]: runtimeSupplements[`deno-runtime@1.0.0/${target}`],
  };
  await json('scripts/rust/notices-sources.json', onlyMac);
  await generateNotices(root, { ...options, ...runtimeInput(root, target) });
  await put(`reviewed-${target}.txt`, runtimeText(target) + ' altered');
  await assert.rejects(verifyReviewedNotices(root, options), /component or license data/);
  await put(`reviewed-${target}.txt`, runtimeText(target));
  await json('scripts/rust/notices-sources.json', runtimeSupplements);
  await assert.rejects(verifyReviewedNotices(root, options), /component or license data/);
  await json('scripts/rust/notices-sources.json', {});
  await assert.rejects(verifyReviewedNotices(root, options), /have not been reviewed/);
  await json('products/maka/cli/notices.json', { components: {} });
  await assert.rejects(verifyReviewedNotices(root, options), /No reviewed runtime targets/);
  await assert.rejects(
    verifyReviewedNotices(root, { ...options, target }),
    /does not accept build inputs/,
  );
});
