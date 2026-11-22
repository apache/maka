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
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  lstat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

export async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Compatibility identity, not a byte-reproducibility claim for every host tool. */
export async function v8CacheKey({ source, target, features }) {
  const recipe = {};
  // Hash the executed producer, which may differ from an older source candidate.
  for (const file of ['compile-v8.mjs', 'v8-notices.mjs', 'license-files.mjs'])
    recipe[file] = await digest(new URL(file, import.meta.url));
  return createHash('sha256')
    .update(JSON.stringify({ source, target, features: [...new Set(features)].sort(), recipe }))
    .digest('hex');
}

/** Fixed regular files; limits apply before reading or extracting their contents. */
export function v8Files(target) {
  return {
    [target.includes('windows') ? 'rusty_v8.lib' : 'librusty_v8.a']: 512 * 1024 * 1024,
    'src_binding.rs': 4 * 1024 * 1024,
    'THIRD_PARTY_NOTICES.txt': 16 * 1024 * 1024,
    'receipt.json': 16 * 1024,
  };
}

export async function readV8Entry(directory, key, target) {
  try {
    for (const [name, limit] of Object.entries(v8Files(target))) {
      const file = await lstat(join(directory, name));
      if (!file.isFile() || file.size === 0 || file.size > limit)
        throw new Error('Invalid V8 bundle file: ' + name);
    }
    const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
    if (receipt.key !== key) throw new Error('identity differs');
    const [archive, bindings, notices] = Object.keys(v8Files(target));
    for (const name of [archive, bindings, notices]) {
      if (receipt.files?.[name] !== (await digest(join(directory, name))))
        throw new Error(name + ' digest differs');
    }
    return {
      environment: {
        RUSTY_V8_ARCHIVE: join(directory, archive),
        RUSTY_V8_SRC_BINDING_PATH: join(directory, bindings),
      },
      notices: await readFile(join(directory, notices), 'utf8'),
    };
  } catch (cause) {
    throw new Error('Invalid V8 cache entry; remove it and retry: ' + directory, { cause });
  }
}

/** A trusted build cache always keeps the library, bindings and notices together. */
export async function cachedV8({ directory, key, target, build }) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid V8 cache key');
  const entry = join(directory, key);
  const [archive, ...rest] = Object.keys(v8Files(target));
  const files = [archive, ...rest.filter((name) => name !== 'receipt.json')];
  const read = (path) => readV8Entry(path, key, target);
  const existing = await stat(entry).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing) {
    const result = await read(entry);
    console.error('Reusing verified V8 cache: ' + key);
    return result;
  }
  console.error('Preparing V8 cache: ' + key);
  const built = await build();
  await mkdir(directory, { recursive: true });
  const stage = await mkdtemp(join(directory, '.building-'));
  try {
    await copyFile(built.environment.RUSTY_V8_ARCHIVE, join(stage, archive));
    await copyFile(built.environment.RUSTY_V8_SRC_BINDING_PATH, join(stage, 'src_binding.rs'));
    await writeFile(join(stage, 'THIRD_PARTY_NOTICES.txt'), built.notices);
    const hashes = {};
    for (const file of files) {
      if (!(await stat(join(stage, file))).size) throw new Error('Empty V8 cache file: ' + file);
      hashes[file] = await digest(join(stage, file));
    }
    await writeFile(join(stage, 'receipt.json'), JSON.stringify({ key, files: hashes }) + '\n');
    await read(stage);
    try {
      await rename(stage, entry);
    } catch (error) {
      // Another successful producer may already have admitted this exact key.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      if (!(await stat(entry).catch(() => undefined))) throw error;
    }
    return await read(entry);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
