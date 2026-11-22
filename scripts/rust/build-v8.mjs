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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { rustTarget } from './build-cli.mjs';
import { cachedV8, v8CacheKey } from './v8-cache.mjs';
import { compileV8 } from './compile-v8.mjs';
import { downloadV8, packV8 } from './v8-prebuilt.mjs';

/** Build the locked V8 without its optional LGPL glibc implementation. */
export async function buildV8({ root, directory, cache, target, env, metadata }) {
  const configuration = await v8Configuration(root, target, metadata);
  const manifest = JSON.parse(await readFile(join(root, 'scripts/rust/v8-prebuilts.json'), 'utf8'));
  const pin = manifest[configuration.key];
  return cachedV8({
    directory: cache,
    key: configuration.key,
    target,
    build: () =>
      Object.hasOwn(manifest, configuration.key)
        ? downloadV8({
            pin,
            directory: join(directory, 'prebuilt'),
            key: configuration.key,
            target,
          })
        : compileV8({ ...configuration, directory, target, env }),
  });
}

async function v8Configuration(root, target, metadata) {
  const source = JSON.parse(await readFile(join(root, 'scripts/rust/v8-source.json'), 'utf8'));
  const pkg = metadata.packages.find((pkg) => pkg.name === 'v8');
  if (pkg?.version !== source.version) throw new Error('V8 source pin differs from Cargo.lock');
  const features = metadata.resolve.nodes
    .find((node) => node.id === pkg.id)
    .features.filter((name) => name !== 'default')
    .sort();
  return {
    source,
    features,
    key: await v8CacheKey({ source, target, features }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'cache-key': { type: 'boolean', default: false },
      pinned: { type: 'boolean', default: false },
      build: { type: 'boolean', default: false },
      target: { type: 'string' },
      cache: { type: 'string' },
      export: { type: 'string' },
    },
  });
  const modes = [values['cache-key'], values.pinned, values.build].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error(
      'Usage: build-v8.mjs (--cache-key | --pinned | --build --cache <dir> [--export <dir>]) [--target <triple>]',
    );
  }
  const root = resolve(import.meta.dirname, '../..');
  const target = values.target || rustTarget();
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      ['metadata', '--locked', '--format-version', '1', '--filter-platform', target],
      { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 600_000 },
    ),
  );
  const configuration = await v8Configuration(root, target, metadata);
  if (values['cache-key']) {
    console.log(configuration.key);
  } else if (values.pinned) {
    const manifest = JSON.parse(
      await readFile(join(root, 'scripts/rust/v8-prebuilts.json'), 'utf8'),
    );
    console.log(Object.hasOwn(manifest, configuration.key) ? 'true' : 'false');
  } else {
    const cacheDir = resolve(values.cache || join(process.env.CARGO_TARGET_DIR || 'target', 'v8'));
    const workDir = await mkdtemp(join(tmpdir(), 'maka-v8-build-'));
    try {
      await buildV8({
        root,
        directory: workDir,
        cache: cacheDir,
        target,
        env: process.env,
        metadata,
      });
      if (values.export) {
        await packV8({
          directory: cacheDir,
          key: configuration.key,
          target,
          output: resolve(values.export),
        });
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
