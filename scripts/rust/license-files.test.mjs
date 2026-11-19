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
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { licenseFiles } from './license-files.mjs';

test('distribution notices retain a crate whose only license file is UNLICENSE', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-unlicense-'));
  try {
    const license = join(directory, 'UNLICENSE');
    await writeFile(
      license,
      'This is free and unencumbered software released into the public domain.',
    );
    await writeFile(join(directory, 'README.md'), 'Tray protocol implementation');
    await writeFile(join(directory, 'UNLICENSE.rs'), 'not a license document');
    assert.deepEqual(await licenseFiles(directory), [license]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('nested data licenses with a dot suffix are included in distribution notices', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-data-license-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nested = join(directory, 'src', 'emoji_picker');
  await mkdir(nested, { recursive: true });
  const license = join(nested, 'emoji.LICENSE.txt');
  await writeFile(license, 'Embedded emoji data license');
  await writeFile(join(nested, 'emoji.LICENSE.rs'), 'source code');
  assert.deepEqual(await licenseFiles(directory), [license]);
});
