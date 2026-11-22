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

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compareProductReleaseVersions, parseProductReleaseVersion } from '../release-version.mjs';
import { npmSpawnOptions } from '../npm-spawn.mjs';
import { execTar } from '../asf-source-release.mjs';

// Publish the Windows component before Linux can expose it to WSL users.
export const previewTargets = ['win32-x64', 'darwin-arm64', 'linux-x64-gnu'];

/** Validate the complete set before the first external write; npm has no multi-package transaction. */
export async function readNativePreviewRelease(directory) {
  const packages = [];
  for (const target of previewTargets) {
    const receipt = JSON.parse(await readFile(join(directory, target + '.json'), 'utf8'));
    const { name, version, integrity } = receipt;
    if (
      name !== '@maka-agent/cli-' + target ||
      receipt.target !== target ||
      !parseProductReleaseVersion(version).prerelease.join('.').startsWith('rust-preview.')
    ) {
      throw new Error('Invalid native preview receipt');
    }
    const filename = 'maka-agent-cli-' + target + '-' + version + '.tgz';
    if (basename(receipt.archive) !== filename) throw new Error('Native archive name differs');
    const archive = resolve(directory, filename);
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (integrity !== 'sha512-' + hash.digest('base64'))
      throw new Error('Native archive integrity differs');
    const manifest = JSON.parse(
      execTar(archive, ['-xOf', 'package/package.json'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 30_000,
      }),
    );
    if (
      manifest.name !== name ||
      manifest.version !== version ||
      !/^[a-f0-9]{128}$/.test(manifest.makaSource?.sha512 ?? '') ||
      manifest.publishConfig?.tag !== 'rust-preview'
    )
      throw new Error('Native package provenance differs');
    if (
      packages.length &&
      (version !== packages[0].version ||
        JSON.stringify(manifest.makaSource) !== JSON.stringify(packages[0].source))
    ) {
      throw new Error('All platforms must come from the same source archive and build identifier');
    }
    packages.push({ name, version, archive, integrity, source: manifest.makaSource });
  }
  return packages;
}

export async function readPreviewRelease(directory) {
  directory = resolve(directory);
  const packages = await readNativePreviewRelease(directory);
  const receipt = JSON.parse(await readFile(join(directory, 'launcher.json'), 'utf8'));
  const version = packages[0].version;
  const filename = `maka-agent-cli-${version}.tgz`;
  if (
    receipt.name !== '@maka-agent/cli' ||
    receipt.version !== version ||
    receipt.archive !== filename
  ) {
    throw new Error('Invalid native launcher receipt');
  }
  const archive = join(directory, filename);
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (receipt.integrity !== 'sha512-' + hash.digest('base64')) {
    throw new Error('Launcher archive integrity differs');
  }
  const manifest = JSON.parse(
    execTar(archive, ['-xOf', 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    }),
  );
  const expected = Object.fromEntries(packages.map(({ name }) => [name, version]));
  const entries = (value) => Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (
    manifest.name !== '@maka-agent/cli' ||
    manifest.version !== version ||
    manifest.bin?.maka !== 'bin/maka.mjs' ||
    manifest.publishConfig?.tag !== 'rust-preview' ||
    JSON.stringify(entries(manifest.optionalDependencies)) !== JSON.stringify(entries(expected)) ||
    JSON.stringify(manifest.makaSource) !== JSON.stringify(packages[0].source)
  ) {
    throw new Error('Launcher does not match its native platform set');
  }
  return [...packages, { ...receipt, archive, source: packages[0].source }];
}

async function metadata(path) {
  const response = await fetch('https://registry.npmjs.org/' + path, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('npm registry query failed: ' + response.status);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('npm metadata exceeds limit');
  return JSON.parse(text);
}

export async function publishPreviewRelease(directory, { provenance = false } = {}) {
  const packages = await readPreviewRelease(directory);
  // Preflight every platform before publishing any. Existing matching immutable
  // versions are a successful retry, never grounds to upload different bytes.
  for (const pkg of packages) {
    const existing = await metadata(pkg.name + '/' + pkg.version);
    if (existing && existing.dist?.integrity !== pkg.integrity)
      throw new Error('Published version has different bytes: ' + pkg.name);
    pkg.published = Boolean(existing);
    const tags = await metadata('-/package/' + pkg.name.replace('/', '%2f') + '/dist-tags');
    if (
      tags?.['rust-preview'] &&
      compareProductReleaseVersions(tags['rust-preview'], pkg.version) > 0
    ) {
      throw new Error('Refusing to move rust-preview backwards: ' + pkg.name);
    }
  }
  for (const pkg of packages) {
    // Re-read immediately before moving a tag: another publisher may have
    // advanced it since preflight. Immutable versions alone are not discovery.
    const tagsPath = '-/package/' + pkg.name.replace('/', '%2f') + '/dist-tags';
    const tags = await metadata(tagsPath);
    if (
      tags?.['rust-preview'] &&
      compareProductReleaseVersions(tags['rust-preview'], pkg.version) > 0
    ) {
      throw new Error('Refusing to move rust-preview backwards: ' + pkg.name);
    }
    if (!pkg.published) {
      execFileSync(
        'npm',
        [
          'publish',
          basename(pkg.archive),
          '--tag',
          'rust-preview',
          '--access',
          'public',
          '--ignore-scripts',
          ...(provenance ? ['--provenance'] : []),
        ],
        npmSpawnOptions({ cwd: dirname(pkg.archive), stdio: 'inherit', timeout: 180_000 }),
      );
    }
    if (tags?.['rust-preview'] !== pkg.version) {
      execFileSync(
        'npm',
        [
          'dist-tag',
          'add',
          pkg.name + '@' + pkg.version,
          'rust-preview',
          '--registry',
          'https://registry.npmjs.org/',
        ],
        npmSpawnOptions({ stdio: 'inherit', timeout: 180_000 }),
      );
    }
    let verified = false;
    // npm acknowledges uploads before asynchronous processing exposes versions
    // and tags. Allow about ten minutes without re-uploading accepted bytes.
    const confirmationAttempts = 25;
    for (let attempt = 0; attempt < confirmationAttempts; attempt++) {
      const [observed, tags] = await Promise.all([
        metadata(pkg.name + '/' + pkg.version),
        metadata(tagsPath),
      ]);
      if (observed?.dist?.integrity === pkg.integrity && tags?.['rust-preview'] === pkg.version) {
        verified = true;
        break;
      }
      if (attempt + 1 < confirmationAttempts) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, Math.min(30_000, 1000 * 2 ** attempt)),
        );
      }
    }
    if (!verified)
      throw new Error('Publication is unconfirmed; retry this same artifact set: ' + pkg.name);
    console.log(pkg.name + '@' + pkg.version + ' verified');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      publish: { type: 'boolean', default: false },
      provenance: { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1)
    throw new Error('Usage: publish-cli.mjs <artifact-directory> [--publish] [--provenance]');
  if (values.publish) await publishPreviewRelease(positionals[0], values);
  else console.log(JSON.stringify(await readPreviewRelease(positionals[0])));
}
