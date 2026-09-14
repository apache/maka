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
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashSecret } from '../crypto.js';
import { loadWebAccess, saveWebAccess, type WebAccessFile } from '../store.js';

test('saveWebAccess writes mode 0600 JSON and loadWebAccess round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-web-access-'));
  const path = join(dir, 'web-access.json');
  const record: WebAccessFile = {
    version: 1,
    enabled: true,
    passphrase: await hashSecret('passphrase-12chars'),
    totpSecret: 'JBSWY3DPEHPK3PXP',
    recovery: [await hashSecret('ABCDE12345')],
    totpConfirmed: true,
  };
  await saveWebAccess(path, record);
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);
  const raw = JSON.parse(await readFile(path, 'utf8')) as WebAccessFile;
  assert.equal(raw.totpSecret, record.totpSecret);
  assert.deepEqual(await loadWebAccess(path), record);
});

test('loadWebAccess returns null when the file is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-web-access-'));
  assert.equal(await loadWebAccess(join(dir, 'missing.json')), null);
});

test('loadWebAccess defaults totpConfirmed to false when the field is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-web-access-'));
  const path = join(dir, 'web-access.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      enabled: false,
      passphrase: 'hashed',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      recovery: [],
    }),
  );
  const loaded = await loadWebAccess(path);
  assert.equal(loaded?.totpConfirmed, false);
});
