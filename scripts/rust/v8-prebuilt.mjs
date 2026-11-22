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
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execTar } from '../asf-source-release.mjs';
import { digest, readV8Entry, v8Files } from './v8-cache.mjs';

/** Pins are read from the verified Maka source, never from the download server. */
export async function downloadV8({ pin, directory, key, target }) {
  if (!/^[0-9a-f]{64}$/.test(pin?.sha256) || new URL(pin.url).protocol !== 'https:')
    throw new Error('Invalid V8 prebuilt pin');
  await mkdir(directory, { recursive: true });
  const archive = join(directory, 'bundle.tar.gz');
  const response = await fetch(pin.url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('V8 prebuilt download failed: HTTP ' + response.status + ' ' + pin.url);
  }
  const file = await open(archive, 'wx');
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 128 * 1024 * 1024) throw new Error('V8 prebuilt download exceeds 128 MiB');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
  } finally {
    await file.close();
  }
  if (hash.digest('hex') !== pin.sha256) throw new Error('V8 prebuilt SHA-256 mismatch');
  const files = v8Files(target);
  const list = execTar(archive, ['-tzf'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 60_000,
  });
  if (
    JSON.stringify(list.trim().split(/\r?\n/).sort()) !== JSON.stringify(Object.keys(files).sort())
  )
    throw new Error('V8 prebuilt contains unexpected archive entries');
  const kinds = execTar(archive, ['-tvzf'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 60_000,
  });
  if (
    kinds
      .trim()
      .split(/\r?\n/)
      .some((line) => !line.startsWith('-'))
  )
    throw new Error('V8 prebuilt entries must be regular files');
  const extracted = join(directory, 'files');
  await mkdir(extracted);
  // Extract to stdout individually: archive paths/links never control filesystem writes.
  for (const [name, limit] of Object.entries(files)) {
    const contents = execTar(archive, ['-xOzf', name], { maxBuffer: limit, timeout: 60_000 });
    if (!contents.length) throw new Error('Empty V8 prebuilt file: ' + name);
    await writeFile(join(extracted, name), contents, { flag: 'wx' });
  }
  const result = await readV8Entry(extracted, key, target);
  console.error('Using pinned V8 prebuilt: ' + key);
  return result;
}

/** Export only the validated bundle; promotion must use these exact archive bytes. */
export async function packV8({ directory, key, target, output, verifiedBy }) {
  if (!/^[0-9a-f]{64}$/.test(key) || !/^[a-z0-9_-]+$/.test(target))
    throw new Error('Invalid V8 prebuilt identity');
  const entry = join(resolve(directory), key);
  await readV8Entry(entry, key, target);
  await mkdir(output, { recursive: true });
  const name = 'v8-' + target + '-' + key + '.tar.gz';
  const archive = resolve(output, name);
  execTar(archive, ['-czf', '--format=ustar', '-C', entry, ...Object.keys(v8Files(target))], {
    timeout: 180_000,
  });
  const result = {
    key,
    target,
    archive: name,
    sha256: await digest(archive),
    ...(verifiedBy ? { verifiedBy } : {}),
  };
  await writeFile(join(output, key + '.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 6)
    throw new Error('Usage: v8-prebuilt.mjs <cache> <key> <target> <output>');
  const [, , directory, key, target, output] = process.argv;
  console.log(JSON.stringify(await packV8({ directory, key, target, output })));
}
