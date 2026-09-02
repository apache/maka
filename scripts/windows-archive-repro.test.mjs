/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { archive } from 'app-builder-lib/out/targets/archive.js';
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js';

test('the Windows ZIP path produces identical bytes regardless of input modification time', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-archive-repro-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input');
  await mkdir(join(input, 'empty'), { recursive: true });
  const file = join(input, 'payload.txt');
  await writeFile(file, 'identical payload');
  const zip = join(root, 'payload.zip');
  const results = [];
  for (const date of [new Date('2024-01-01T00:00:00Z'), new Date('2024-02-02T00:00:00Z')]) {
    await utimes(file, date, date);
    await utimes(join(input, 'empty'), date, date);
    await archive('zip', zip, input, { withoutDir: true });
    const { stdout } = await promisify(execFile)(await getPath7za(), [
      'e',
      '-so',
      zip,
      'payload.txt',
    ]);
    assert.equal(stdout, 'identical payload');
    results.push(await readFile(zip));
    await rm(zip);
  }
  assert.ok(results[0].equals(results[1]), 'ZIP bytes changed with the input file timestamp');
});
