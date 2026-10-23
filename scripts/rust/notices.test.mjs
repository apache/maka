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
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { verifyNotices } from './notices.mjs';

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
      'patches/zod+4.6.5.patch',
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
