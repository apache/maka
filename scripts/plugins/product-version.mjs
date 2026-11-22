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
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function field(hash, value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

// Keep framing and ordering identical to maka_packages::content_digest.
export function packageDigest(files) {
  const hash = createHash('sha256');
  for (const [path, content] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    field(hash, path);
    field(hash, content);
  }
  return `sha256-${hash.digest('hex')}`;
}

// Keep framing identical to application::product::fingerprint. Names sort as Rust UTF-8 strings.
export function productFingerprint(source, packages) {
  const hash = createHash('sha256').update('maka-product-v1\0');
  field(hash, source);
  for (const [name, digest] of [...packages].sort(([a], [b]) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    field(hash, name);
    field(hash, digest);
  }
  return `sha256-${hash.digest('hex')}`;
}

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...(await files(path, `${name}/`)));
    else if (entry.isFile()) result.push([name, await readFile(path)]);
    else throw new Error(`Product package must contain only regular files: ${path}`);
  }
  return result;
}

export async function writeProductVersion(destination, names) {
  const packages = await Promise.all(
    names.map(async (name) => [
      name,
      packageDigest(await files(resolve(destination, 'packages', name))),
    ]),
  );
  const source = await readFile(resolve(destination, 'authoring/composition.mjs'));
  const version = productFingerprint(source, packages);
  await writeFile(resolve(destination, 'product-version.txt'), version + '\n');
  return version;
}
