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
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { previewVersion, releaseNativeCli } from './release-cli.mjs';
import {
  previewTargets,
  publishPreviewRelease,
  readNativePreviewRelease,
  readPreviewRelease,
} from './publish-cli.mjs';
import { packLauncher } from './pack-launcher.mjs';

test('prepared release binds its source and recovers partial publication and missing tags', async (t) => {
  const stage = await mkdtemp(join(tmpdir(), 'maka launcher release '));
  try {
    const version = '0.2.0-rust-preview.1';
    const root = 'apache-maka-0.2.0-incubating';
    const sourceRoot = join(stage, root);
    await mkdir(join(sourceRoot, 'packages/cli/bin'), { recursive: true });
    for (const file of ['package.json', 'README.md', 'README.zh-CN.md', 'bin/maka.mjs']) {
      await copyFile(
        join(import.meta.dirname, '../../packages/cli', file),
        join(sourceRoot, 'packages/cli', file),
      );
    }
    for (const [file, content] of Object.entries({
      'package.json': JSON.stringify({ name: 'maka', version: '0.2.0', license: 'Apache-2.0' }),
      'package-lock.json': JSON.stringify({
        version: '0.2.0',
        lockfileVersion: 3,
        packages: { '': { version: '0.2.0' } },
      }),
      LICENSE: 'Apache License, Version 2.0\n',
      NOTICE: 'Apache Maka\n',
      DISCLAIMER: 'Apache Maka is undergoing incubation.\n',
    }))
      await writeFile(join(sourceRoot, file), content);
    const archive = root + '-src.tar.gz';
    execFileSync('tar', ['-czf', join(stage, archive), '-C', stage, root]);
    const sha512 = createHash('sha512')
      .update(await readFile(join(stage, archive)))
      .digest('hex');
    await writeFile(join(stage, archive + '.sha512'), `${sha512}  ${archive}\n`);
    const source = { archive, version: '0.2.0', sha512 };
    await mkdir(join(stage, 'package'));
    for (const target of previewTargets) {
      const name = '@maka-agent/cli-' + target;
      const archive = 'maka-agent-cli-' + target + '-' + version + '.tgz';
      await writeFile(
        join(stage, 'package/package.json'),
        JSON.stringify({
          name,
          version,
          makaSource: source,
          publishConfig: { tag: 'rust-preview' },
        }),
      );
      execFileSync('tar', ['-czf', join(stage, archive), '-C', stage, 'package']);
      const integrity =
        'sha512-' +
        createHash('sha512')
          .update(await readFile(join(stage, archive)))
          .digest('base64');
      await writeFile(
        join(stage, target + '.json'),
        JSON.stringify({ name, version, target, archive, integrity }),
      );
    }
    await assert.rejects(readPreviewRelease(stage), /ENOENT/);
    const receipt = await packLauncher(stage);
    const packages = await readPreviewRelease(stage);
    assert.deepEqual(
      packages.map(({ name }) => name),
      [...previewTargets.map((target) => '@maka-agent/cli-' + target), '@maka-agent/cli'],
    );
    const packed = join(stage, receipt.archive);
    const files = execFileSync('tar', ['-tzf', packed], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .sort();
    assert.deepEqual(
      files,
      [
        'package/DISCLAIMER',
        'package/LICENSE',
        'package/NOTICE',
        'package/README.md',
        'package/README.zh-CN.md',
        'package/bin/maka.mjs',
        'package/package.json',
      ].sort(),
    );
    assert.equal(
      execFileSync('tar', ['-xOf', packed, 'package/DISCLAIMER'], { encoding: 'utf8' }),
      await readFile(join(sourceRoot, 'DISCLAIMER'), 'utf8'),
    );
    assert.equal(
      execFileSync('tar', ['-xOf', packed, 'package/bin/maka.mjs'], { encoding: 'utf8' }),
      await readFile(join(sourceRoot, 'packages/cli/bin/maka.mjs'), 'utf8'),
    );
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', packed, 'package/package.json'], { encoding: 'utf8' }),
    );
    assert.deepEqual(
      manifest.optionalDependencies,
      Object.fromEntries(previewTargets.map((target) => ['@maka-agent/cli-' + target, version])),
    );
    assert.match(manifest.description, /Unofficial experimental.*not an ASF release/);
    const readme = execFileSync('tar', ['-xOf', packed, 'package/README.md'], { encoding: 'utf8' });
    assert.ok(readme.includes(await readFile(join(sourceRoot, 'DISCLAIMER'), 'utf8')));
    assert.match(
      readme,
      /not an official Apache Software Foundation release and is not approved, endorsed or supported by the ASF/,
    );
    assert.match(
      readme,
      /The `latest` tags remain empty placeholders, including the separate `maka-agent` package\. They contain no CLI, runtime, dependencies or install scripts\./,
    );
    assert.deepEqual(manifest.makaSource, source);
    await publicationRecovery(t, stage, packages);
    await writeFile(packed, 'tampered');
    await assert.rejects(readPreviewRelease(stage), /integrity differs/);
    await writeFile(join(stage, archive), 'tampered source');
    await assert.rejects(packLauncher(stage), /SHA-512 mismatch/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

async function publicationRecovery(t, directory, packages) {
  const versions = new Map();
  const tags = new Map();
  const uploads = [];
  const originalExec = childProcess.execFileSync;
  let fail = true;
  let raced = false;
  let tagReads = 0;
  let pendingVisibility = 6;
  // Advance confirmation waits without making this registry simulation sleep.
  const delay = t.mock.method(globalThis, 'setTimeout', (resolveDelay) => {
    queueMicrotask(resolveDelay);
    return 0;
  });
  const fetch = t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/-/package/')) {
      const name = decodeURIComponent(path.slice('/-/package/'.length, -'/dist-tags'.length));
      if (raced && ++tagReads > packages.length) tags.set(name, '0.2.0-rust-preview.999');
      return new Response(JSON.stringify(tags.has(name) ? { 'rust-preview': tags.get(name) } : {}));
    }
    const pkg = packages.find((pkg) => path === '/' + pkg.name + '/' + pkg.version);
    assert.ok(pkg, 'only fixture registry paths may be read');
    if (versions.has(pkg.name) && pkg.name === packages[0].name && pendingVisibility > 0) {
      pendingVisibility -= 1;
      return new Response('', { status: 404 });
    }
    return versions.has(pkg.name)
      ? new Response(JSON.stringify({ dist: { integrity: versions.get(pkg.name) } }))
      : new Response('', { status: 404 });
  });
  const exec = t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command === 'tar') return originalExec(command, args, options);
    assert.equal(command, 'npm');
    if (args[0] === 'publish') {
      const pkg = packages.find((pkg) => pkg.archive === join(options.cwd, args[1]));
      assert.ok(pkg, 'publish uses a cwd and basename even when the directory has spaces');
      assert.ok(!versions.has(pkg.name), 'accepted immutable versions are never uploaded again');
      versions.set(pkg.name, pkg.integrity);
      uploads.push(pkg.name);
      if (fail && uploads.length === 2) {
        fail = false;
        throw new Error('lost publication response');
      }
      tags.set(pkg.name, pkg.version);
    } else {
      assert.deepEqual(args.slice(0, 2), ['dist-tag', 'add']);
      const pkg = packages.find((pkg) => pkg.name + '@' + pkg.version === args[2]);
      assert.ok(pkg);
      assert.equal(versions.get(pkg.name), pkg.integrity);
      tags.set(pkg.name, pkg.version);
    }
    return '';
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(publishPreviewRelease(directory), /lost publication response/);
    await publishPreviewRelease(directory);
    assert.deepEqual(
      uploads,
      packages.map((pkg) => pkg.name),
    );
    assert.deepEqual([...tags].sort(), packages.map((pkg) => [pkg.name, pkg.version]).sort());
    tags.delete('@maka-agent/cli');
    await publishPreviewRelease(directory);
    assert.equal(tags.get('@maka-agent/cli'), packages[0].version);
    tags.set('@maka-agent/cli', '0.2.0-rust-preview.999');
    await assert.rejects(publishPreviewRelease(directory), /backwards/);
    assert.equal(tags.get('@maka-agent/cli'), '0.2.0-rust-preview.999');
    assert.equal(uploads.length, packages.length);
    versions.clear();
    tags.clear();
    raced = true;
    await assert.rejects(publishPreviewRelease(directory), /backwards/);
    assert.equal(
      uploads.length,
      packages.length,
      'a tag advanced after preflight prevents the first publication',
    );
  } finally {
    fetch.mock.restore();
    exec.mock.restore();
    delay.mock.restore();
    syncBuiltinESMExports();
  }
}

test('publication rejects incomplete, mixed-source, or modified platform sets before writing npm', async () => {
  const stage = await mkdtemp(join(tmpdir(), 'maka-publication-'));
  try {
    const version = '0.2.0-rust-preview.1';
    const source = {
      archive: 'apache-maka-0.2.0-incubating-src.tar.gz',
      version: '0.2.0',
      sha512: 'a'.repeat(128),
    };
    await mkdir(join(stage, 'package'));
    async function pack(target, origin = source) {
      const name = '@maka-agent/cli-' + target;
      const archive = 'maka-agent-cli-' + target + '-' + version + '.tgz';
      await writeFile(
        join(stage, 'package/package.json'),
        JSON.stringify({
          name,
          version,
          makaSource: origin,
          publishConfig: { tag: 'rust-preview' },
        }),
      );
      execFileSync('tar', ['-czf', join(stage, archive), '-C', stage, 'package']);
      const integrity =
        'sha512-' +
        createHash('sha512')
          .update(await readFile(join(stage, archive)))
          .digest('base64');
      await writeFile(
        join(stage, target + '.json'),
        JSON.stringify({ name, version, target, archive, integrity }),
      );
    }
    await pack(previewTargets[0]);
    await assert.rejects(readNativePreviewRelease(stage), /ENOENT/);
    for (const target of previewTargets.slice(1)) await pack(target);
    assert.equal((await readNativePreviewRelease(stage)).length, 3);
    await pack(previewTargets[2], { ...source, sha512: 'b'.repeat(128) });
    await assert.rejects(readNativePreviewRelease(stage), /same source archive/);
    await pack(previewTargets[2]);
    await writeFile(
      join(stage, 'maka-agent-cli-' + previewTargets[0] + '-' + version + '.tgz'),
      'changed',
    );
    await assert.rejects(readNativePreviewRelease(stage), /integrity differs/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('preview builds have distinct package versions without changing the source version', () => {
  assert.equal(previewVersion('0.2.0', '20260916.1'), '0.2.0-rust-preview.20260916.1');
  assert.equal(previewVersion('0.2.0', '20260916.2'), '0.2.0-rust-preview.20260916.2');
  assert.equal(previewVersion('0.2.0', '123.2.gabc123'), '0.2.0-rust-preview.123.2.gabc123');
  for (const buildId of [undefined, '', '01', '1..2', '1+sha', 'a/b', 'a'.repeat(256)]) {
    assert.throws(
      () => previewVersion('0.2.0', buildId),
      /build-id|release version|256 characters/,
    );
  }
  assert.throws(() => previewVersion('0.2.0-beta', '1'), /stable source version/);
});

test('source identity failures cannot reach dependency installation or compilation', async () => {
  const stage = await mkdtemp(join(tmpdir(), 'maka-source-release-test-'));
  try {
    const name = 'apache-maka-1.2.3-incubating';
    const sourceRoot = join(stage, name);
    await mkdir(join(sourceRoot, 'src'), { recursive: true });
    const files = {
      LICENSE: 'Apache-2.0\n',
      NOTICE: 'Apache Maka\n',
      DISCLAIMER: 'Apache Maka is undergoing incubation.\n',
      'package.json': JSON.stringify({ name: 'maka', version: '1.2.3', license: 'Apache-2.0' }),
      'package-lock.json': JSON.stringify({
        version: '1.2.3',
        lockfileVersion: 3,
        packages: { '': { version: '1.2.3' } },
      }),
      'Cargo.toml': '[package]\nname = "maka-cli"\nversion = "0.0.0"\nedition = "2024"\n',
      'src/main.rs': 'fn main() {}\n',
    };
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(sourceRoot, path), content);
    }
    const source = join(stage, name + '-src.tar.gz');
    execFileSync('tar', ['-czf', source, '-C', stage, name]);
    const digest = createHash('sha512')
      .update(await readFile(source))
      .digest('hex');
    await writeFile(source + '.sha512', digest + '  ' + name + '-src.tar.gz\n');
    const args = {
      buildId: '1',
      source,
      target: 'linux-x64-gnu',
      // Deliberately absent: source identity must fail before any of these is used.
      notices: join(stage, 'notices'),
      validator: join(stage, 'validator'),
      output: join(stage, 'output'),
    };
    await assert.rejects(releaseNativeCli(args), /Native CLI version does not match/);
    await writeFile(source, 'changed since the checksum was created');
    await assert.rejects(releaseNativeCli(args), /SHA-512 mismatch/);
    await assert.rejects(releaseNativeCli({ ...args, target: 'toString' }), /supported target/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});
