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
import { EventEmitter } from 'node:events';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generateNotices, verifyNotices } from './notices.mjs';

test('release notices reject changed dependency inputs and edited texts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-notices-check-'));
  const repository = new URL('../../', import.meta.url);
  try {
    const manifest = JSON.parse(
      await readFile(new URL('products/maka/cli/notices.json', repository), 'utf8'),
    );
    const files = [
      ...Object.keys(manifest.inputs),
      'products/maka/cli/notices.json',
      'products/maka/cli/THIRD_PARTY_NOTICES.txt',
    ];
    for (const name of files) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await copyFile(new URL(name, repository), join(root, name));
    }
    await verifyNotices(root);
    for (const name of [
      'Cargo.lock',
      'scripts/rust/notices-sources.json',
      'products/maka/cli/Cargo.toml',
      'products/maka/desktop-shell/Cargo.toml',
      'patches/zod+4.6.7.patch',
      'products/maka/bundle/scripts/build.mjs',
      'plugins/settings/settings/package.ts',
      'packages/plugin-sdk/src/contracts.ts',
    ]) {
      const original = await readFile(join(root, name));
      await writeFile(join(root, name), Buffer.concat([original, Buffer.from('\n ')]));
      await assert.rejects(verifyNotices(root), /notices are stale/);
      await writeFile(join(root, name), original);
    }
    await writeFile(
      join(root, 'products/maka/cli/THIRD_PARTY_NOTICES.txt'),
      'license inventory without notices',
    );
    await assert.rejects(verifyNotices(root), /notices are stale/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const licenseRevision = 'a'.repeat(40);
const licenseUrl = `https://raw.githubusercontent.com/owner/repo/${licenseRevision}/LICENSE`;
const licenseText = Buffer.from('Fixture license\r\nCopyright fixture\r\nAll rights reserved.\r\n');
const blobSha = (content) =>
  createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');

async function licenseDownload(t, options = {}) {
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const root = join(tmpdir(), 'maka-notices-generator-fixture');
  const stage = join(tmpdir(), 'maka-notices-generator-stage');
  const state = { raw: [], api: [], waits: [], writes: new Map() };
  const inputs = JSON.parse(
    await readFile(new URL('../../products/maka/cli/notices.json', import.meta.url), 'utf8'),
  ).inputs;
  const bundled = dirname(fileURLToPath(import.meta.resolve('ajv/dist/standalone/index.js')));
  const playwrightFiles = ['injected.js', 'LICENSE', 'NOTICE', 'ThirdPartyNotices.txt'];
  const urls = options.urls ?? [licenseUrl, licenseUrl];
  const sha = blobSha(licenseText);
  const entry = {
    type: 'file',
    path: 'LICENSE',
    encoding: 'base64',
    size: licenseText.length,
    content: licenseText.toString('base64'),
    sha,
    download_url: `https://raw.githubusercontent.com/canonical/renamed/${licenseRevision}/LICENSE`,
    ...options.entry,
  };
  const tree = {
    sha: 'b'.repeat(40),
    truncated: false,
    tree: [{ path: 'LICENSE', type: 'blob', mode: options.mode ?? '100644', sha }],
  };
  const roots = ['maka-cli', 'maka-desktop-shell', 'maka-python-runtime'].map((name) => ({
    id: name,
    name,
    source: null,
    manifest_path: join(root, 'products', name, 'Cargo.toml'),
  }));
  const metadata = {
    packages: [
      ...roots,
      {
        id: 'fixture',
        name: 'fixture',
        version: '1.0.0',
        license: 'MIT',
        authors: [],
        source: 'registry+fixture',
        manifest_path: join(root, 'registry', 'Cargo.toml'),
      },
    ],
    resolve: {
      nodes: [
        ...roots.map(({ id }) => ({
          id,
          deps: [{ pkg: 'fixture', dep_kinds: [{ kind: null }] }],
        })),
        { id: 'fixture', deps: [] },
      ],
    },
  };
  t.mock.method(fsPromises, 'readFile', async (name, encoding) => {
    let content;
    if (name === join(root, 'scripts/rust/notices-sources.json'))
      content = Buffer.from(JSON.stringify({ 'fixture@1.0.0': urls }));
    else if (name === join(root, 'third-party/playwright/upstream.json'))
      content = Buffer.from(
        JSON.stringify({
          registry_package: 'fixture-playwright',
          registry_version: '0',
          license: 'MIT',
          archive: { url: 'https://registry.invalid/fixture', sha256: 'f'.repeat(64) },
          files: Object.fromEntries(
            playwrightFiles.map((name) => [
              name,
              createHash('sha256').update(licenseText).digest('hex'),
            ]),
          ),
        }),
      );
    else if (name === join(stage, 'product/bundle-inputs.json')) content = Buffer.from('[]');
    else if (name === join(bundled, 'package.json'))
      content = Buffer.from(JSON.stringify({ name: 'fixture-js', version: '1', license: 'MIT' }));
    else if (
      name === join(bundled, 'LICENSE') ||
      playwrightFiles.some((file) => name === join(root, 'third-party/playwright', file)) ||
      Object.hasOwn(inputs, relative(root, name).replaceAll('\\', '/'))
    )
      content = licenseText;
    else assert.fail('Unexpected fixture read: ' + name);
    return encoding === 'utf8' ? content.toString('utf8') : content;
  });
  t.mock.method(fsPromises, 'glob', async function* () {});
  t.mock.method(fsPromises, 'readdir', async (name) => {
    if (name === bundled)
      return [{ name: 'LICENSE', isDirectory: () => false, isFile: () => true }];
    assert.equal(name, join(root, 'registry'));
    return [];
  });
  t.mock.method(fsPromises, 'mkdtemp', async () => stage);
  t.mock.method(fsPromises, 'rm', async (name) => assert.equal(name, stage));
  t.mock.method(fsPromises, 'writeFile', async (name, content) => {
    assert.ok(
      ['notices.json', 'THIRD_PARTY_NOTICES.txt'].some(
        (file) => name === join(root, 'products/maka/cli', file),
      ),
    );
    state.writes.set(name, content);
  });
  t.mock.method(globalThis, 'setTimeout', (resolveDelay, milliseconds) => {
    state.waits.push(milliseconds);
    queueMicrotask(resolveDelay);
    return 0;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(urls.includes(url));
    state.raw.push(url);
    if (options.raw) return new Response(licenseText);
    throw new Error('fixture raw reset ' + state.raw.length);
  });
  t.mock.method(childProcess, 'execFileSync', (command, args, config) => {
    assert.equal(config.cwd, root);
    if (command === 'cargo') {
      assert.equal(args[0], 'metadata');
      return JSON.stringify(metadata);
    }
    if (command === process.execPath) {
      assert.equal(args[0], 'products/maka/bundle/scripts/build.mjs');
      return '';
    }
    assert.equal(command, 'gh');
    state.api.push(args);
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
    assert.equal(args.length, 4);
    if (options.apiError) throw options.apiError;
    if (args[3] === `repos/owner/repo/contents/LICENSE?ref=${licenseRevision}`)
      return JSON.stringify(entry);
    assert.equal(args[3], `repos/owner/repo/git/trees/${licenseRevision}`);
    return JSON.stringify(tree);
  });
  t.mock.method(childProcess, 'spawn', (command, args, config) => {
    assert.equal(command, 'cargo');
    assert.equal(config.cwd, root);
    assert.deepEqual(args, [
      'build',
      '--locked',
      '-p',
      'maka-cli',
      '--bin',
      'maka',
      '--no-default-features',
      '--message-format=json',
    ]);
    const child = Object.assign(new EventEmitter(), {
      stdout: Readable.from([
        JSON.stringify({
          reason: 'compiler-artifact',
          target: { name: 'maka', kind: ['bin'] },
          executable: join(root, 'fixture-ui-compiler'),
        }) + '\n',
      ]),
    });
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  });
  syncBuiltinESMExports();
  try {
    await generateNotices(root);
  } catch (error) {
    state.error = error;
  }
  state.notices = state.writes.get(join(root, 'products/maka/cli/THIRD_PARTY_NOTICES.txt'));
  return state;
}

test('license downloads keep raw success free of API calls and memoize the URL', async (t) => {
  const state = await licenseDownload(t, { raw: true });
  assert.equal(state.error, undefined);
  assert.deepEqual(state.raw, [licenseUrl]);
  assert.deepEqual(state.api, []);
  assert.deepEqual(state.waits, []);
  assert.ok(state.notices.includes(licenseUrl));
  assert.ok(state.notices.includes(licenseText.toString().replaceAll('\r\n', '\n')));
});

test('license downloads bind API fallback to the original pinned path and ordinary blob', async (t) => {
  const state = await licenseDownload(t);
  assert.equal(state.error, undefined);
  assert.deepEqual(state.raw, [licenseUrl]);
  assert.deepEqual(
    state.api.map((args) => args[3]),
    [
      `repos/owner/repo/contents/LICENSE?ref=${licenseRevision}`,
      `repos/owner/repo/git/trees/${licenseRevision}`,
    ],
  );
  assert.deepEqual(state.waits, []);
  assert.ok(state.notices.includes(licenseUrl));
  assert.ok(!state.notices.includes('canonical/renamed'));
});

test('license downloads reject a wrong contents hash or a symlink at the pinned path', async (t) => {
  for (const [name, options] of [
    ['wrong hash', { entry: { sha: 'f'.repeat(40) } }],
    ['symlink', { mode: '120000' }],
  ])
    await t.test(name, async (t) => {
      const state = await licenseDownload(t, options);
      assert.match(state.error?.message, /License source failed/);
      assert.equal(state.writes.size, 0);
      assert.equal(state.raw.length, 3);
      assert.deepEqual(state.waits, [1000, 2000]);
      assert.equal(state.api.length, name === 'wrong hash' ? 1 : 2);
    });
});

test('license downloads keep unpinned URLs on the original raw retry path', async (t) => {
  const request = licenseUrl.replace(licenseRevision, 'main');
  const state = await licenseDownload(t, { urls: [request] });
  assert.match(state.error?.message, /License source failed/);
  assert.deepEqual(state.raw, [request, request, request]);
  assert.deepEqual(state.api, []);
  assert.deepEqual(state.waits, [1000, 2000]);
  assert.equal(state.writes.size, 0);
});

test('license downloads retain raw retries and all causes when API fallback fails', async (t) => {
  const apiError = new Error('fixture API denied');
  const state = await licenseDownload(t, { apiError });
  assert.equal(state.error.message, 'fixture@1.0.0: License source failed: ' + licenseUrl);
  assert.equal(state.raw.length, 3);
  assert.equal(state.api.length, 1);
  assert.deepEqual(state.waits, [1000, 2000]);
  assert.equal(state.writes.size, 0);
  const failure = state.error.errors[0].cause;
  assert.ok(failure.cause instanceof AggregateError);
  assert.deepEqual(
    failure.cause.errors.map((error) => error.message),
    ['fixture raw reset 1', 'fixture raw reset 2', 'fixture raw reset 3', 'fixture API denied'],
  );
  assert.equal(failure.cause.errors[3], apiError);
});
